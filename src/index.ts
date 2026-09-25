import { boundedMetadata, CHALLENGE_TTL_SECONDS, constantTimeEqual, decodeCursor, encodeCursor, isRecord, MAX_JSON_BYTES, PLAN_PRESETS, readInt, readString, slugify } from "./core";
import { decryptLicenseKey, encryptLicenseKey, hmacHex, issueAdminSession, newLicenseKey, randomToken, verifyAdminSession, verifyPasswordHash } from "./crypto";
import { LicenseCoordinator } from "./coordinator";
import type { CoordinatorRequest, Env, LicenseRow } from "./types";

export { LicenseCoordinator };

const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(value, headers === undefined ? { status } : { status, headers });
const publicRejected = (status = 400, headers?: HeadersInit) => json({ ok: false, error: "request_rejected" }, status, headers);

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_JSON_BYTES) throw new Error("body_too_large");
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new Error("json_required");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_JSON_BYTES) throw new Error("body_too_large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("invalid_json");
  }
  if (!isRecord(parsed)) throw new Error("invalid_json");
  return parsed;
}

async function adminAuthorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return false;
  if (typeof env.ADMIN_API_TOKEN === "string" && env.ADMIN_API_TOKEN.length > 0 && constantTimeEqual(token, env.ADMIN_API_TOKEN)) return true;
  return verifyAdminSession(env.ADMIN_SESSION_SECRET, env.ADMIN_USERNAME, token);
}

function adminAuthConfigured(env: Env): boolean {
  return [env.ADMIN_USERNAME, env.ADMIN_PASSWORD_HASH, env.ADMIN_PASSWORD_SALT, env.ADMIN_SESSION_SECRET]
    .every((value) => typeof value === "string" && value.length > 0);
}

async function adminLogin(request: Request, env: Env): Promise<Response> {
  const client = request.headers.get("cf-connecting-ip") ?? "local";
  const outcome = await env.ADMIN_LOGIN_RATE_LIMITER.limit({ key: client });
  if (!outcome.success) return json({ error: "rate_limited" }, 429, { "retry-after": "60" });
  try {
    const body = await readJson(request);
    const username = readString(body, "username", { min: 1, max: 128 })!;
    const password = readString(body, "password", { min: 1, max: 256 })!;
    const usernameValid = constantTimeEqual(username, env.ADMIN_USERNAME);
    const passwordValid = await verifyPasswordHash(password, env.ADMIN_PASSWORD_SALT, env.ADMIN_PASSWORD_HASH);
    if (!usernameValid || !passwordValid) return json({ error: "invalid_credentials" }, 401);
    const session = await issueAdminSession(env.ADMIN_SESSION_SECRET, env.ADMIN_USERNAME);
    return json({ token: session.token, expires_at: session.expiresAt });
  } catch {
    return json({ error: "invalid_credentials" }, 401);
  }
}

async function audit(
  env: Env,
  requestId: string,
  eventType: string,
  projectId: string | null,
  licenseId: string | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_events (id, project_id, license_id, event_type, actor, request_id, details, created_at) VALUES (?, ?, ?, ?, 'admin', ?, ?, ?)",
  ).bind(crypto.randomUUID(), projectId, licenseId, eventType, requestId, JSON.stringify(details), Math.floor(Date.now() / 1000)).run();
}

function coordinator(env: Env, digest: string): DurableObjectStub {
  return env.LICENSE_COORDINATOR.get(env.LICENSE_COORDINATOR.idFromName(digest));
}

async function callCoordinator(env: Env, digest: string, input: CoordinatorRequest): Promise<Response> {
  return coordinator(env, digest).fetch("https://license-coordinator.internal/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

async function publicChallenge(request: Request, env: Env, requestId: string): Promise<Response> {
  try {
    const body = await readJson(request);
    const projectId = readString(body, "project_id", { max: 128 })!;
    const licenseKey = readString(body, "license_key", { min: 20, max: 128 })!;
    const deviceId = readString(body, "device_id", { min: 1, max: 512 })!;
    const devicePublicKey = readString(body, "device_public_key", { min: 40, max: 64, optional: true });
    const keyDigest = await hmacHex(env.KEY_PEPPER, licenseKey);
    const license = await env.DB.prepare(
      `SELECT l.*, p.require_device_signature FROM licenses l JOIN projects p ON p.id = l.project_id
       WHERE l.key_digest = ? AND l.project_id = ? AND p.status = 'enabled'`,
    ).bind(keyDigest, projectId).first<LicenseRow & { require_device_signature: number }>();
    const now = Math.floor(Date.now() / 1000);
    if (!license || license.status !== "enabled" || (license.expires_at !== null && license.expires_at <= now)) return publicRejected();
    if (license.require_device_signature === 1 && !devicePublicKey) return publicRejected();

    const challengeToken = randomToken();
    const challenge = randomToken();
    const tokenHash = await hmacHex(env.KEY_PEPPER, challengeToken);
    const deviceIdHash = await hmacHex(env.KEY_PEPPER, deviceId);
    const expiresAt = now + CHALLENGE_TTL_SECONDS;
    await env.DB.prepare(
      `INSERT INTO challenges
       (token_hash, license_id, project_id, device_id_hash, device_public_key, challenge, expires_at, used_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).bind(tokenHash, license.id, projectId, deviceIdHash, devicePublicKey ?? null, challenge, expiresAt, now).run();
    await env.DB.prepare(
      "INSERT INTO audit_events (id, project_id, license_id, event_type, actor, request_id, details, created_at) VALUES (?, ?, ?, 'challenge.issued', 'public', ?, '{}', ?)",
    ).bind(crypto.randomUUID(), projectId, license.id, requestId, now).run();
    return json({
      ok: true,
      challenge_token: challengeToken,
      challenge,
      expires_at: expiresAt,
      signature_payload: `${challenge}.${deviceId}.${projectId}`,
      signature_required: license.require_device_signature === 1,
    });
  } catch {
    return publicRejected();
  }
}

async function publicActivate(request: Request, env: Env, requestId: string): Promise<Response> {
  try {
    const body = await readJson(request);
    const projectId = readString(body, "project_id", { max: 128 })!;
    const licenseKey = readString(body, "license_key", { min: 20, max: 128 })!;
    const deviceId = readString(body, "device_id", { min: 1, max: 512 })!;
    const challengeToken = readString(body, "challenge_token", { min: 32, max: 128 })!;
    const devicePublicKey = readString(body, "device_public_key", { min: 40, max: 64, optional: true });
    const signature = readString(body, "signature", { min: 80, max: 128, optional: true });
    const keyDigest = await hmacHex(env.KEY_PEPPER, licenseKey);
    const license = await env.DB.prepare("SELECT * FROM licenses WHERE key_digest = ? AND project_id = ?")
      .bind(keyDigest, projectId).first<LicenseRow>();
    if (!license) return publicRejected();
    return await callCoordinator(env, keyDigest, {
      action: "activate", requestId, licenseId: license.id, projectId,
      now: Math.floor(Date.now() / 1000), challengeToken, deviceId,
      ...(devicePublicKey ? { devicePublicKey } : {}),
      ...(signature ? { signature } : {}),
    });
  } catch {
    return publicRejected();
  }
}

async function publicSessionAction(request: Request, env: Env, requestId: string, action: "validate" | "deactivate"): Promise<Response> {
  try {
    const body = await readJson(request);
    const projectId = readString(body, "project_id", { max: 128 })!;
    const sessionToken = readString(body, "session_token", { min: 32, max: 128 })!;
    const deviceToken = readString(body, "device_token", { min: 32, max: 128 })!;
    const signature = readString(body, "signature", { min: 80, max: 128, optional: true });
    const sessionHash = await hmacHex(env.KEY_PEPPER, sessionToken);
    const row = await env.DB.prepare(
      `SELECT l.id, l.key_digest FROM sessions s JOIN licenses l ON l.id = s.license_id
       WHERE s.token_hash = ? AND l.project_id = ?`,
    ).bind(sessionHash, projectId).first<{ id: string; key_digest: string }>();
    if (!row) return publicRejected();
    return await callCoordinator(env, row.key_digest, {
      action, requestId, licenseId: row.id, projectId, sessionToken, deviceToken,
      ...(signature ? { signature } : {}),
      now: Math.floor(Date.now() / 1000),
    });
  } catch {
    return publicRejected();
  }
}

async function createProject(request: Request, env: Env, requestId: string): Promise<Response> {
  const body = await readJson(request);
  const name = readString(body, "name", { max: 100 })!;
  const slug = slugify(readString(body, "slug", { max: 64, optional: true }) ?? name);
  const description = readString(body, "description", { max: 240, optional: true }) ?? "";
  const requireSignature = body.require_device_signature === true ? 1 : 0;
  if (body.require_device_signature !== undefined && typeof body.require_device_signature !== "boolean") {
    throw new Error("invalid_require_device_signature");
  }
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const statements = [
    env.DB.prepare(
      "INSERT INTO projects (id, name, slug, description, status, require_device_signature, created_at, updated_at) VALUES (?, ?, ?, ?, 'enabled', ?, ?, ?)",
    ).bind(id, name, slug, description, requireSignature, now, now),
  ];
  for (const [preset, config] of Object.entries(PLAN_PRESETS)) {
    statements.push(env.DB.prepare(
      "INSERT INTO plans (id, project_id, name, preset, duration_seconds, max_devices, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), id, config.name, preset, config.durationSeconds, config.maxDevices, now, now));
  }
  await env.DB.batch(statements);
  await audit(env, requestId, "project.created", id, null, { slug });
  return json({ id, name, slug, description, status: "enabled", require_device_signature: requireSignature === 1 }, 201);
}

async function listProjects(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT p.*, COUNT(DISTINCT pl.id) AS plan_count, COUNT(DISTINCT l.id) AS license_count
     FROM projects p LEFT JOIN plans pl ON pl.project_id = p.id LEFT JOIN licenses l ON l.project_id = p.id
     GROUP BY p.id ORDER BY p.created_at DESC`,
  ).all();
  return json({ items: result.results });
}

async function patchProject(request: Request, env: Env, requestId: string, projectId: string): Promise<Response> {
  const body = await readJson(request);
  const current = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(projectId).first<Record<string, unknown>>();
  if (!current) return json({ error: "not_found" }, 404);
  const name = readString(body, "name", { max: 100, optional: true }) ?? String(current.name);
  const slug = body.slug === undefined ? String(current.slug) : slugify(readString(body, "slug", { max: 64 })!);
  const description = readString(body, "description", { max: 240, optional: true }) ?? String(current.description ?? "");
  const status = readString(body, "status", { max: 16, optional: true }) ?? String(current.status ?? "enabled");
  if (status !== "enabled" && status !== "disabled") throw new Error("invalid_status");
  const required = body.require_device_signature === undefined
    ? Number(current.require_device_signature)
    : body.require_device_signature === true ? 1 : body.require_device_signature === false ? 0 : -1;
  if (required < 0) throw new Error("invalid_require_device_signature");
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "UPDATE projects SET name = ?, slug = ?, description = ?, status = ?, require_device_signature = ?, updated_at = ? WHERE id = ?",
  ).bind(name, slug, description, status, required, now, projectId).run();
  await audit(env, requestId, "project.updated", projectId, null);
  return json({ id: projectId, name, slug, description, status, require_device_signature: required === 1 });
}

async function deleteProject(env: Env, requestId: string, projectId: string): Promise<Response> {
  const current = await env.DB.prepare(
    `SELECT p.id, p.name, p.slug,
       (SELECT COUNT(*) FROM plans WHERE project_id = p.id) AS plan_count,
       (SELECT COUNT(*) FROM licenses WHERE project_id = p.id) AS license_count
     FROM projects p WHERE p.id = ?`,
  ).bind(projectId).first<{ id: string; name: string; slug: string; plan_count: number; license_count: number }>();
  if (!current) return json({ error: "not_found" }, 404);

  const now = Math.floor(Date.now() / 1000);
  const details = JSON.stringify({
    deleted_project_id: current.id,
    name: current.name,
    slug: current.slug,
    plan_count: Number(current.plan_count),
    license_count: Number(current.license_count),
  });
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE license_id IN (SELECT id FROM licenses WHERE project_id = ?)").bind(projectId),
    env.DB.prepare("DELETE FROM challenges WHERE project_id = ?").bind(projectId),
    env.DB.prepare("DELETE FROM activations WHERE license_id IN (SELECT id FROM licenses WHERE project_id = ?)").bind(projectId),
    env.DB.prepare("DELETE FROM license_devices WHERE license_id IN (SELECT id FROM licenses WHERE project_id = ?)").bind(projectId),
    env.DB.prepare("DELETE FROM licenses WHERE project_id = ?").bind(projectId),
    env.DB.prepare("DELETE FROM plans WHERE project_id = ?").bind(projectId),
    env.DB.prepare("DELETE FROM audit_events WHERE project_id = ?").bind(projectId),
    env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(projectId),
    env.DB.prepare(
      "INSERT INTO audit_events (id, project_id, license_id, event_type, actor, request_id, details, created_at) VALUES (?, NULL, NULL, 'project.deleted', 'admin', ?, ?, ?)",
    ).bind(crypto.randomUUID(), requestId, details, now),
  ]);
  return json({
    ok: true,
    id: current.id,
    name: current.name,
    deleted_plans: Number(current.plan_count),
    deleted_licenses: Number(current.license_count),
  });
}

async function createPlan(request: Request, env: Env, requestId: string): Promise<Response> {
  const body = await readJson(request);
  const projectId = readString(body, "project_id", { max: 128 })!;
  const preset = readString(body, "preset", { max: 32, optional: true });
  let durationSeconds: number;
  let maxDevices: number;
  let name: string;
  if (preset) {
    const config = PLAN_PRESETS[preset as keyof typeof PLAN_PRESETS];
    if (!config) throw new Error("invalid_preset");
    durationSeconds = config.durationSeconds;
    maxDevices = readInt(body, "max_devices", { min: 1, max: 100, optional: true }) ?? config.maxDevices;
    name = readString(body, "name", { max: 100, optional: true }) ?? config.name;
  } else {
    durationSeconds = readInt(body, "duration_seconds", { min: 60, max: 315360000 })!;
    maxDevices = readInt(body, "max_devices", { min: 1, max: 100, optional: true }) ?? 1;
    name = readString(body, "name", { max: 100 })!;
  }
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO plans (id, project_id, name, preset, duration_seconds, max_devices, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(id, projectId, name, preset ?? null, durationSeconds, maxDevices, now, now).run();
  await audit(env, requestId, "plan.created", projectId, null, { plan_id: id });
  return json({ id, project_id: projectId, name, preset: preset ?? null, duration_seconds: durationSeconds, max_devices: maxDevices }, 201);
}

async function listPlans(url: URL, env: Env): Promise<Response> {
  const projectId = url.searchParams.get("project_id");
  const query = projectId
    ? env.DB.prepare("SELECT * FROM plans WHERE project_id = ? ORDER BY created_at DESC").bind(projectId)
    : env.DB.prepare("SELECT * FROM plans ORDER BY created_at DESC");
  const result = await query.all();
  return json({ presets: PLAN_PRESETS, items: result.results });
}

async function patchPlan(request: Request, env: Env, requestId: string, planId: string): Promise<Response> {
  const current = await env.DB.prepare("SELECT * FROM plans WHERE id = ?").bind(planId).first<Record<string, unknown>>();
  if (!current) return json({ error: "not_found" }, 404);
  const body = await readJson(request);
  const name = readString(body, "name", { max: 100, optional: true }) ?? String(current.name);
  const durationSeconds = readInt(body, "duration_seconds", { min: 60, max: 315360000, optional: true }) ?? Number(current.duration_seconds);
  const maxDevices = readInt(body, "max_devices", { min: 1, max: 100, optional: true }) ?? Number(current.max_devices);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "UPDATE plans SET name = ?, preset = NULL, duration_seconds = ?, max_devices = ?, updated_at = ? WHERE id = ?",
  ).bind(name, durationSeconds, maxDevices, now, planId).run();
  await audit(env, requestId, "plan.updated", String(current.project_id), null, { plan_id: planId });
  return json({ id: planId, project_id: current.project_id, name, preset: null, duration_seconds: durationSeconds, max_devices: maxDevices });
}

async function batchLicenses(request: Request, env: Env, requestId: string): Promise<Response> {
  const body = await readJson(request);
  const projectId = readString(body, "project_id", { max: 128 })!;
  const count = readInt(body, "count", { min: 1, max: 100, optional: true }) ?? 1;
  const planId = readString(body, "plan_id", { max: 128, optional: true });
  let durationSeconds: number;
  let maxDevices: number;
  if (planId) {
    const plan = await env.DB.prepare("SELECT duration_seconds, max_devices FROM plans WHERE id = ? AND project_id = ?")
      .bind(planId, projectId).first<{ duration_seconds: number; max_devices: number }>();
    if (!plan) throw new Error("invalid_plan_id");
    durationSeconds = plan.duration_seconds;
    maxDevices = readInt(body, "max_devices", { min: 1, max: 100, optional: true }) ?? plan.max_devices;
  } else {
    const custom = body.custom_plan;
    if (!isRecord(custom)) throw new Error("invalid_custom_plan");
    durationSeconds = readInt(custom, "duration_seconds", { min: 60, max: 315360000 })!;
    maxDevices = readInt(custom, "max_devices", { min: 1, max: 100, optional: true }) ?? 1;
  }
  const metadata = boundedMetadata(body.metadata);
  const now = Math.floor(Date.now() / 1000);
  const returned: Array<{ id: string; key: string; display_hint: string }> = [];
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < count; i++) {
    const key = newLicenseKey();
    const id = crypto.randomUUID();
    const digest = await hmacHex(env.KEY_PEPPER, key);
    const encrypted = await encryptLicenseKey(env.LICENSE_KEY_ENCRYPTION_SECRET, key, `${id}:${projectId}`);
    const displayHint = `ELC-...${key.slice(-6)}`;
    returned.push({ id, key, display_hint: displayHint });
    statements.push(env.DB.prepare(
      `INSERT INTO licenses
       (id, project_id, plan_id, key_digest, key_ciphertext, key_iv, key_encryption_version, display_hint, status, duration_seconds, max_devices, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'enabled', ?, ?, ?, ?, ?)`,
    ).bind(id, projectId, planId ?? null, digest, encrypted.ciphertext, encrypted.iv, displayHint, durationSeconds, maxDevices, metadata, now, now));
  }
  await env.DB.batch(statements);
  await audit(env, requestId, "licenses.generated", projectId, null, { count, plan_id: planId ?? null });
  return json({ items: returned, raw_keys_returned_once: true }, 201);
}

async function listLicenses(url: URL, env: Env): Promise<Response> {
  const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
  if (!Number.isSafeInteger(requestedLimit)) throw new Error("invalid_limit");
  const limit = Math.min(Math.max(requestedLimit, 1), 100);
  const conditions: string[] = [];
  const bindings: unknown[] = [];
  const status = url.searchParams.get("status");
  if (status && !["active", "enabled", "disabled", "expired", "unused"].includes(status)) throw new Error("invalid_status");
  const now = Math.floor(Date.now() / 1000);
  if (status === "active" || status === "enabled") conditions.push(`l.status = 'enabled' AND l.activated_at IS NOT NULL AND (l.expires_at IS NULL OR l.expires_at > ${now})`);
  if (status === "disabled") conditions.push("l.status = 'disabled'");
  if (status === "expired") conditions.push(`l.expires_at IS NOT NULL AND l.expires_at <= ${now}`);
  if (status === "unused") conditions.push("l.status = 'enabled' AND l.activated_at IS NULL");
  for (const [param, column] of [["project_id", "l.project_id"]] as const) {
    const value = url.searchParams.get(param);
    if (value) { conditions.push(`${column} = ?`); bindings.push(value); }
  }
  const query = url.searchParams.get("q");
  if (query) {
    const searchConditions = ["l.display_hint LIKE ? ESCAPE '\\'", "l.metadata LIKE ? ESCAPE '\\'"];
    const escaped = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    bindings.push(escaped, escaped);
    if (/^ELC-[A-Za-z0-9_-]{32}$/.test(query)) {
      searchConditions.push("l.key_digest = ?");
      bindings.push(await hmacHex(env.KEY_PEPPER, query));
    }
    conditions.push(`(${searchConditions.join(" OR ")})`);
  }
  const cursor = url.searchParams.get("cursor");
  if (cursor) {
    const [createdAt, id] = decodeCursor(cursor);
    conditions.push("(l.created_at < ? OR (l.created_at = ? AND l.id < ?))");
    bindings.push(createdAt, createdAt, id);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await env.DB.prepare(
    `SELECT l.id, l.project_id, l.plan_id, l.display_hint, l.key_ciphertext, l.key_iv, l.key_encryption_version,
            CASE
              WHEN l.status = 'disabled' THEN 'disabled'
              WHEN l.expires_at IS NOT NULL AND l.expires_at <= ${now} THEN 'expired'
              WHEN l.activated_at IS NULL THEN 'unused'
              ELSE 'active'
            END AS status,
            l.duration_seconds, l.max_devices,
            l.activated_at, l.expires_at, l.metadata, l.created_at, l.updated_at,
            COUNT(CASE WHEN d.status = 'active' THEN 1 END) AS active_devices
     FROM licenses l LEFT JOIN license_devices d ON d.license_id = l.id
     ${where} GROUP BY l.id ORDER BY l.created_at DESC, l.id DESC LIMIT ?`,
  ).bind(...bindings, limit + 1).all<Record<string, unknown>>();
  const rows = result.results ?? [];
  const hasMore = rows.length > limit;
  const items: Array<Record<string, unknown>> = await Promise.all(rows.slice(0, limit).map(async (row) => {
    let key: string | null = null;
    if (typeof row.key_ciphertext === "string" && typeof row.key_iv === "string") {
      try {
        key = await decryptLicenseKey(
          env.LICENSE_KEY_ENCRYPTION_SECRET,
          row.key_ciphertext,
          row.key_iv,
          `${String(row.id)}:${String(row.project_id)}`,
        );
      } catch {
        key = null;
      }
    }
    const { key_ciphertext: _ciphertext, key_iv: _iv, key_encryption_version: _version, ...visible } = row;
    return {
      ...visible,
      key,
      key_recoverable: key !== null,
      metadata: JSON.parse(String(row.metadata ?? "{}")) as unknown,
    };
  }));
  const last = items.at(-1);
  return json({
    items,
    next_cursor: hasMore && last ? encodeCursor(Number(last.created_at), String(last.id)) : null,
  });
}

async function listDevices(env: Env, licenseId: string): Promise<Response> {
  const license = await env.DB.prepare("SELECT id FROM licenses WHERE id = ?").bind(licenseId).first();
  if (!license) return json({ error: "not_found" }, 404);
  const result = await env.DB.prepare(
    `SELECT id, status, first_seen_at, last_seen_at, revoked_at,
            CASE WHEN device_public_key IS NULL THEN 0 ELSE 1 END AS has_public_key
     FROM license_devices WHERE license_id = ? ORDER BY first_seen_at DESC`,
  ).bind(licenseId).all();
  return json({ items: result.results });
}

function readLicenseIds(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 100) throw new Error("invalid_ids");
  const ids = body.ids.map((value) => {
    if (typeof value !== "string" || value.length < 1 || value.length > 128) throw new Error("invalid_ids");
    return value;
  });
  if (new Set(ids).size !== ids.length) throw new Error("invalid_ids");
  return ids;
}

async function deleteLicenses(env: Env, requestId: string, licenseIds: string[]): Promise<Response> {
  const placeholders = licenseIds.map(() => "?").join(",");
  const current = await env.DB.prepare(
    `SELECT id, project_id, display_hint FROM licenses WHERE id IN (${placeholders})`,
  ).bind(...licenseIds).all<{ id: string; project_id: string; display_hint: string }>();
  if (current.results.length !== licenseIds.length) {
    const found = new Set(current.results.map((item) => item.id));
    return json({ error: "not_found", missing_ids: licenseIds.filter((id) => !found.has(id)) }, 404);
  }

  const now = Math.floor(Date.now() / 1000);
  const details = JSON.stringify({
    count: current.results.length,
    licenses: current.results.map((item) => ({ id: item.id, project_id: item.project_id, display_hint: item.display_hint })),
  });
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sessions WHERE license_id IN (${placeholders})`).bind(...licenseIds),
    env.DB.prepare(`DELETE FROM challenges WHERE license_id IN (${placeholders})`).bind(...licenseIds),
    env.DB.prepare(`DELETE FROM activations WHERE license_id IN (${placeholders})`).bind(...licenseIds),
    env.DB.prepare(`DELETE FROM license_devices WHERE license_id IN (${placeholders})`).bind(...licenseIds),
    env.DB.prepare(`DELETE FROM licenses WHERE id IN (${placeholders})`).bind(...licenseIds),
    env.DB.prepare(
      "INSERT INTO audit_events (id, project_id, license_id, event_type, actor, request_id, details, created_at) VALUES (?, NULL, NULL, 'licenses.deleted', 'admin', ?, ?, ?)",
    ).bind(crypto.randomUUID(), requestId, details, now),
  ]);
  return json({ ok: true, deleted: current.results.length, ids: licenseIds });
}

async function batchDeleteLicenses(request: Request, env: Env, requestId: string): Promise<Response> {
  return deleteLicenses(env, requestId, readLicenseIds(await readJson(request)));
}

async function setLicenseStatus(env: Env, requestId: string, licenseId: string, status: "enabled" | "disabled"): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const current = await env.DB.prepare("SELECT project_id FROM licenses WHERE id = ?").bind(licenseId).first<{ project_id: string }>();
  if (!current) return json({ error: "not_found" }, 404);
  await env.DB.prepare("UPDATE licenses SET status = ?, updated_at = ? WHERE id = ?").bind(status, now, licenseId).run();
  if (status === "disabled") await env.DB.prepare("DELETE FROM sessions WHERE license_id = ?").bind(licenseId).run();
  await audit(env, requestId, `license.${status}`, current.project_id, licenseId);
  return json({ id: licenseId, status });
}

async function resetDevices(env: Env, requestId: string, licenseId: string): Promise<Response> {
  const current = await env.DB.prepare("SELECT project_id FROM licenses WHERE id = ?").bind(licenseId).first<{ project_id: string }>();
  if (!current) return json({ error: "not_found" }, 404);
  const now = Math.floor(Date.now() / 1000);
  const devices = await env.DB.prepare("SELECT id FROM license_devices WHERE license_id = ? AND status = 'active'")
    .bind(licenseId).all<{ id: string }>();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE license_id = ?").bind(licenseId),
    env.DB.prepare("UPDATE license_devices SET status = 'revoked', revoked_at = ? WHERE license_id = ? AND status = 'active'").bind(now, licenseId),
  ]);
  await audit(env, requestId, "license.devices_reset", current.project_id, licenseId, { count: devices.results.length });
  return json({ ok: true, revoked_devices: devices.results.length });
}

async function revokeDevice(env: Env, requestId: string, licenseId: string, deviceId: string): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT l.project_id FROM license_devices d JOIN licenses l ON l.id = d.license_id WHERE d.id = ? AND l.id = ?",
  ).bind(deviceId, licenseId).first<{ project_id: string }>();
  if (!row) return json({ error: "not_found" }, 404);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE device_id = ?").bind(deviceId),
    env.DB.prepare("UPDATE license_devices SET status = 'revoked', revoked_at = ? WHERE id = ?").bind(now, deviceId),
  ]);
  await audit(env, requestId, "device.revoked", row.project_id, licenseId, { device_id: deviceId });
  return json({ ok: true, device_id: deviceId, status: "revoked" });
}

async function listAudit(url: URL, env: Env): Promise<Response> {
  const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
  if (!Number.isSafeInteger(requestedLimit)) throw new Error("invalid_limit");
  const limit = Math.min(Math.max(requestedLimit, 1), 100);
  const projectId = url.searchParams.get("project_id");
  const result = projectId
    ? await env.DB.prepare("SELECT * FROM audit_events WHERE project_id = ? ORDER BY created_at DESC LIMIT ?").bind(projectId, limit).all<Record<string, unknown>>()
    : await env.DB.prepare("SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?").bind(limit).all<Record<string, unknown>>();
  return json({ items: result.results.map((row) => ({ ...row, details: JSON.parse(String(row.details ?? "{}")) as unknown })) });
}

async function getStats(env: Env): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const stats = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM projects) AS projects,
       (SELECT COUNT(*) FROM licenses) AS total_licenses,
       (SELECT COUNT(*) FROM licenses WHERE status = 'enabled' AND (expires_at IS NULL OR expires_at > ?)) AS active_licenses,
       (SELECT COUNT(*) FROM license_devices WHERE status = 'active') AS bound_devices`,
  ).bind(now).first();
  return json({ stats });
}

async function patchLicense(request: Request, env: Env, requestId: string, licenseId: string): Promise<Response> {
  const body = await readJson(request);
  const status = readString(body, "status", { max: 16 })!;
  if (status !== "enabled" && status !== "disabled") throw new Error("invalid_status");
  return setLicenseStatus(env, requestId, licenseId, status);
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();

  if (path.startsWith("/api/public/")) {
    const client = request.headers.get("cf-connecting-ip") ?? "local";
    const outcome = await env.PUBLIC_RATE_LIMITER.limit({ key: `${client}:${path}` });
    if (!outcome.success) return publicRejected(429, { "retry-after": "60" });
  }

  if (path === "/api/public/challenge" && request.method === "POST") return publicChallenge(request, env, requestId);
  if (path === "/api/public/activate" && request.method === "POST") return publicActivate(request, env, requestId);
  if (path === "/api/public/validate" && request.method === "POST") return publicSessionAction(request, env, requestId, "validate");
  if (path === "/api/public/deactivate" && request.method === "POST") return publicSessionAction(request, env, requestId, "deactivate");

  if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);
  if (!path.startsWith("/api/admin/")) return json({ error: "not_found" }, 404);
  if (path === "/api/admin/login" && request.method === "POST") return adminLogin(request, env);
  if (!await adminAuthorized(request, env)) return json({ error: "unauthorized" }, 401);

  if (path === "/api/admin/stats" && request.method === "GET") return getStats(env);
  if (path === "/api/admin/projects" && request.method === "POST") return createProject(request, env, requestId);
  if (path === "/api/admin/projects" && request.method === "GET") return listProjects(env);
  const projectMatch = path.match(/^\/api\/admin\/projects\/([^/]+)$/);
  if (projectMatch && request.method === "PATCH") return patchProject(request, env, requestId, projectMatch[1]!);
  if (projectMatch && request.method === "DELETE") return deleteProject(env, requestId, projectMatch[1]!);
  if (path === "/api/admin/plans" && request.method === "POST") return createPlan(request, env, requestId);
  if (path === "/api/admin/plans" && request.method === "GET") return listPlans(url, env);
  const planMatch = path.match(/^\/api\/admin\/plans\/([^/]+)$/);
  if (planMatch && request.method === "PATCH") return patchPlan(request, env, requestId, planMatch[1]!);
  if (path === "/api/admin/licenses/batch" && request.method === "POST") return batchLicenses(request, env, requestId);
  if (path === "/api/admin/licenses/delete-batch" && request.method === "POST") return batchDeleteLicenses(request, env, requestId);
  if (path === "/api/admin/licenses" && request.method === "GET") return listLicenses(url, env);
  const licenseMatch = path.match(/^\/api\/admin\/licenses\/([^/]+)$/);
  if (licenseMatch && request.method === "PATCH") return patchLicense(request, env, requestId, licenseMatch[1]!);
  if (licenseMatch && request.method === "DELETE") return deleteLicenses(env, requestId, [licenseMatch[1]!]);
  const licenseAction = path.match(/^\/api\/admin\/licenses\/([^/]+)\/(enable|disable|reset-devices)$/);
  if (licenseAction && request.method === "POST") {
    if (licenseAction[2] === "reset-devices") return resetDevices(env, requestId, licenseAction[1]!);
    return setLicenseStatus(env, requestId, licenseAction[1]!, licenseAction[2] === "enable" ? "enabled" : "disabled");
  }
  const devicesMatch = path.match(/^\/api\/admin\/licenses\/([^/]+)\/devices$/);
  if (devicesMatch && request.method === "GET") return listDevices(env, devicesMatch[1]!);
  const deviceAction = path.match(/^\/api\/admin\/licenses\/([^/]+)\/devices\/([^/]+)\/revoke$/);
  if (deviceAction && request.method === "POST") return revokeDevice(env, requestId, deviceAction[1]!, deviceAction[2]!);
  if (path === "/api/admin/audit" && request.method === "GET") return listAudit(url, env);
  return json({ error: "not_found" }, 404);
}

function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers();
  const origin = request.headers.get("origin");
  const allowed = new Set((env.TRUSTED_ORIGINS ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  if (origin && allowed.has(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
    headers.set("access-control-allow-headers", "Authorization, Content-Type");
    headers.set("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
    headers.set("access-control-max-age", "600");
  }
  return headers;
}

function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get("origin");
  if (!origin || origin === new URL(request.url).origin) return true;
  return new Set((env.TRUSTED_ORIGINS ?? "").split(",").map((item) => item.trim()).filter(Boolean)).has(origin);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/public/") && !env.KEY_PEPPER) return publicRejected();
    if (url.pathname.startsWith("/api/admin/") && (!env.KEY_PEPPER || !adminAuthConfigured(env))) return json({ error: "server_misconfigured" }, 500);
    if (url.pathname.startsWith("/api/") && !originAllowed(request, env)) {
      return url.pathname.startsWith("/api/public/") ? publicRejected(403) : json({ error: "origin_forbidden" }, 403);
    }
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      const headers = corsHeaders(request, env);
      return new Response(null, { status: headers.has("access-control-allow-origin") ? 204 : 403, headers });
    }
    try {
      const response = await route(request, env);
      const headers = new Headers(response.headers);
      corsHeaders(request, env).forEach((value, key) => headers.set(key, value));
      headers.set("x-content-type-options", "nosniff");
      headers.set("referrer-policy", "no-referrer");
      headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
      headers.set("x-frame-options", "DENY");
      if (!url.pathname.startsWith("/api/")) {
        headers.set("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      }
      headers.set("cache-control", url.pathname.startsWith("/api/") ? "no-store" : headers.get("cache-control") ?? "public, max-age=60");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      if (url.pathname.startsWith("/api/public/")) return publicRejected();
      const raw = error instanceof Error ? error.message : "request_failed";
      const isClientError = raw.startsWith("invalid_") || raw === "body_too_large" || raw === "json_required" || raw === "invalid_json";
      return json({ error: isClientError ? raw : "request_failed" }, isClientError ? 400 : 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM challenges WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)").bind(now, now - 3600),
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    ]);
  },
} satisfies ExportedHandler<Env>;
