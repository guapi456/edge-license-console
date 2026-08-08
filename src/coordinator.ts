import { SESSION_TTL_SECONDS } from "./core";
import { hmacHex, randomToken, verifyEd25519 } from "./crypto";
import type { CoordinatorRequest, Env, LicenseRow, PublicSuccess } from "./types";

interface ChallengeRow {
  token_hash: string;
  license_id: string;
  project_id: string;
  device_id_hash: string;
  device_public_key: string | null;
  challenge: string;
  expires_at: number;
  used_at: number | null;
  require_device_signature: number;
  project_status: "enabled" | "disabled";
}

interface DeviceRow {
  id: string;
  status: "active" | "revoked";
}

interface SessionRow extends LicenseRow {
  session_expires_at: number;
  device_row_id: string;
  device_status: "active" | "revoked";
  stored_device_token_hash: string;
  device_public_key: string | null;
  require_device_signature: number;
  validation_challenge: string;
  project_status: "enabled" | "disabled";
}

const rejected = () => Response.json({ ok: false, error: "request_rejected" }, { status: 400 });

export class LicenseCoordinator implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    let input: CoordinatorRequest;
    try {
      input = (await request.json()) as CoordinatorRequest;
    } catch {
      return rejected();
    }

    return this.state.blockConcurrencyWhile(async () => {
      if (input.action === "activate") return this.activate(input);
      if (input.action === "validate") return this.validate(input);
      if (input.action === "deactivate") return this.deactivate(input);
      return rejected();
    });
  }

  private async activate(input: CoordinatorRequest): Promise<Response> {
    if (!input.challengeToken || !input.deviceId) return rejected();
    const challengeHash = await hmacHex(this.env.KEY_PEPPER, input.challengeToken);
    const deviceIdHash = await hmacHex(this.env.KEY_PEPPER, input.deviceId);
    const challenge = await this.env.DB.prepare(
      `SELECT c.*, p.require_device_signature, p.status AS project_status
       FROM challenges c JOIN projects p ON p.id = c.project_id
       WHERE c.token_hash = ? AND c.license_id = ? AND c.project_id = ?`,
    ).bind(challengeHash, input.licenseId, input.projectId).first<ChallengeRow>();
    if (!challenge || challenge.project_status !== "enabled" || challenge.used_at !== null || challenge.expires_at < input.now || challenge.device_id_hash !== deviceIdHash) {
      return rejected();
    }

    if (challenge.require_device_signature === 1) {
      const publicKey = input.devicePublicKey ?? challenge.device_public_key;
      if (!publicKey || publicKey !== challenge.device_public_key || !input.signature) return rejected();
      const message = `${challenge.challenge}.${input.deviceId}.${input.projectId}`;
      if (!(await verifyEd25519(publicKey, input.signature, message))) return rejected();
    }

    const license = await this.env.DB.prepare("SELECT * FROM licenses WHERE id = ? AND project_id = ?")
      .bind(input.licenseId, input.projectId).first<LicenseRow>();
    if (!license || license.status !== "enabled" || (license.expires_at !== null && license.expires_at <= input.now)) {
      return rejected();
    }

    const existing = await this.env.DB.prepare(
      "SELECT id, status FROM license_devices WHERE license_id = ? AND device_id_hash = ?",
    ).bind(license.id, deviceIdHash).first<DeviceRow>();
    const activeCount = await this.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM license_devices WHERE license_id = ? AND status = 'active'",
    ).bind(license.id).first<{ count: number }>();
    if ((!existing || existing.status !== "active") && (activeCount?.count ?? 0) >= license.max_devices) return rejected();

    const deviceRowId = existing?.id ?? crypto.randomUUID();
    const deviceToken = randomToken();
    const deviceTokenHash = await hmacHex(this.env.KEY_PEPPER, deviceToken);
    const sessionToken = randomToken();
    const sessionHash = await hmacHex(this.env.KEY_PEPPER, sessionToken);
    const validationChallenge = randomToken();
    const activationId = crypto.randomUUID();
    const provisionalExpiry = input.now + license.duration_seconds;
    const sessionExpiry = Math.min(license.expires_at ?? provisionalExpiry, input.now + SESSION_TTL_SECONDS);

    await this.env.DB.batch([
      this.env.DB.prepare("UPDATE challenges SET used_at = ? WHERE token_hash = ? AND used_at IS NULL")
        .bind(input.now, challengeHash),
      this.env.DB.prepare(
        `INSERT INTO license_devices
           (id, license_id, device_id_hash, device_token_hash, device_public_key, status, first_seen_at, last_seen_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL)
         ON CONFLICT(license_id, device_id_hash) DO UPDATE SET
           device_token_hash = excluded.device_token_hash,
           device_public_key = excluded.device_public_key,
           status = 'active', last_seen_at = excluded.last_seen_at, revoked_at = NULL`,
      ).bind(deviceRowId, license.id, deviceIdHash, deviceTokenHash, challenge.device_public_key, input.now, input.now),
      this.env.DB.prepare("DELETE FROM sessions WHERE device_id = ?").bind(deviceRowId),
      this.env.DB.prepare(
        "INSERT INTO activations (id, license_id, device_id, created_at) VALUES (?, ?, ?, ?)",
      ).bind(activationId, license.id, deviceRowId, input.now),
      this.env.DB.prepare(
        "INSERT INTO sessions (token_hash, license_id, device_id, expires_at, created_at, last_seen_at, validation_challenge) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(sessionHash, license.id, deviceRowId, sessionExpiry, input.now, input.now, validationChallenge),
    ]);

    const activated = await this.env.DB.prepare("SELECT expires_at FROM licenses WHERE id = ?")
      .bind(license.id).first<{ expires_at: number }>();
    await this.audit(input, "license.activated", { device_id: deviceRowId });
    const output: PublicSuccess = {
      ok: true,
      license_id: license.id,
      expires_at: activated?.expires_at ?? provisionalExpiry,
      session_token: sessionToken,
      device_token: deviceToken,
      validation_challenge: validationChallenge,
      signature_payload: `validate.${validationChallenge}.${input.projectId}`,
      signature_required: challenge.require_device_signature === 1,
    };
    return Response.json(output);
  }

  private async validate(input: CoordinatorRequest): Promise<Response> {
    if (!input.sessionToken || !input.deviceToken) return rejected();
    const sessionHash = await hmacHex(this.env.KEY_PEPPER, input.sessionToken);
    const suppliedDeviceHash = await hmacHex(this.env.KEY_PEPPER, input.deviceToken);
    const row = await this.env.DB.prepare(
      `SELECT l.*, s.expires_at AS session_expires_at, s.device_id AS device_row_id,
              d.status AS device_status, d.device_token_hash AS stored_device_token_hash,
              d.device_public_key, p.require_device_signature, p.status AS project_status, s.validation_challenge
       FROM sessions s
       JOIN licenses l ON l.id = s.license_id
       JOIN license_devices d ON d.id = s.device_id
       JOIN projects p ON p.id = l.project_id
       WHERE s.token_hash = ? AND l.id = ? AND l.project_id = ?`,
    ).bind(sessionHash, input.licenseId, input.projectId).first<SessionRow>();
    if (!row || row.project_status !== "enabled" || row.status !== "enabled" || row.device_status !== "active" ||
        row.stored_device_token_hash !== suppliedDeviceHash || row.session_expires_at <= input.now ||
        row.expires_at === null || row.expires_at <= input.now) return rejected();

    if (row.require_device_signature === 1) {
      if (!input.signature || !row.device_public_key) return rejected();
      const message = `validate.${row.validation_challenge}.${input.projectId}`;
      if (!(await verifyEd25519(row.device_public_key, input.signature, message))) return rejected();
    }

    const nextToken = randomToken();
    const nextHash = await hmacHex(this.env.KEY_PEPPER, nextToken);
    const nextValidationChallenge = randomToken();
    const nextExpiry = Math.min(row.expires_at, input.now + SESSION_TTL_SECONDS);
    await this.env.DB.batch([
      this.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(sessionHash),
      this.env.DB.prepare(
        "INSERT INTO sessions (token_hash, license_id, device_id, expires_at, created_at, last_seen_at, validation_challenge) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(nextHash, row.id, row.device_row_id, nextExpiry, input.now, input.now, nextValidationChallenge),
      this.env.DB.prepare("UPDATE license_devices SET last_seen_at = ? WHERE id = ?").bind(input.now, row.device_row_id),
    ]);
    return Response.json({
      ok: true,
      license_id: row.id,
      expires_at: row.expires_at,
      session_token: nextToken,
      validation_challenge: nextValidationChallenge,
      signature_payload: `validate.${nextValidationChallenge}.${input.projectId}`,
      signature_required: row.require_device_signature === 1,
    });
  }

  private async deactivate(input: CoordinatorRequest): Promise<Response> {
    if (!input.sessionToken || !input.deviceToken) return rejected();
    const sessionHash = await hmacHex(this.env.KEY_PEPPER, input.sessionToken);
    const deviceTokenHash = await hmacHex(this.env.KEY_PEPPER, input.deviceToken);
    const row = await this.env.DB.prepare(
      `SELECT s.device_id FROM sessions s JOIN license_devices d ON d.id = s.device_id
       WHERE s.token_hash = ? AND s.license_id = ? AND d.device_token_hash = ?`,
    ).bind(sessionHash, input.licenseId, deviceTokenHash).first<{ device_id: string }>();
    if (!row) return rejected();
    await this.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(sessionHash).run();
    await this.audit(input, "session.deactivated", { device_id: row.device_id });
    return Response.json({ ok: true });
  }

  private async audit(input: CoordinatorRequest, eventType: string, details: Record<string, unknown>): Promise<void> {
    await this.env.DB.prepare(
      "INSERT INTO audit_events (id, project_id, license_id, event_type, actor, request_id, details, created_at) VALUES (?, ?, ?, ?, 'public', ?, ?, ?)",
    ).bind(crypto.randomUUID(), input.projectId, input.licenseId, eventType, input.requestId, JSON.stringify(details), input.now).run();
  }
}
