import { generateKeyPairSync, sign } from "node:crypto";

const baseUrl = (process.env.BASE_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
let adminToken = process.env.ADMIN_TOKEN;
const adminUsername = process.env.ADMIN_USERNAME;
const adminPassword = process.env.ADMIN_PASSWORD;
if (!adminToken && (!adminUsername || !adminPassword)) {
  throw new Error("Set ADMIN_TOKEN or ADMIN_USERNAME and ADMIN_PASSWORD before running the smoke test");
}

async function request(path, { method = "GET", body, admin = false } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(admin ? { authorization: `Bearer ${adminToken}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  return { status: response.status, payload };
}

let badLoginBlocked = null;
if (adminUsername && adminPassword) {
  const badLogin = await request("/api/admin/login", { method: "POST", body: { username: adminUsername, password: `${adminPassword}-wrong` } });
  badLoginBlocked = badLogin.status;
  const login = await request("/api/admin/login", { method: "POST", body: { username: adminUsername, password: adminPassword } });
  if (login.status !== 200 || typeof login.payload.token !== "string") throw new Error(`admin login failed: ${JSON.stringify(login)}`);
  adminToken = login.payload.token;
}

function deviceIdentity() {
  const pair = generateKeyPairSync("ed25519");
  const spki = pair.publicKey.export({ type: "spki", format: "der" });
  return {
    privateKey: pair.privateKey,
    publicKey: Buffer.from(spki.subarray(spki.length - 32)).toString("base64url"),
  };
}

const suffix = Date.now().toString(36);
const created = await request("/api/admin/projects", {
  method: "POST",
  admin: true,
  body: {
    name: `Signed smoke ${suffix}`,
    slug: `signed-smoke-${suffix}`,
    description: "Automated post-deploy verification",
    require_device_signature: true,
  },
});
if (created.status !== 201) throw new Error(`project create failed: ${JSON.stringify(created)}`);
const project = created.payload;

const plans = await request(`/api/admin/plans?project_id=${encodeURIComponent(project.id)}`, { admin: true });
const presets = plans.payload.items.map((item) => item.preset).filter(Boolean);
const expectedPresets = ["annual", "daily", "monthly", "quarterly", "weekly"];
if (JSON.stringify([...presets].sort()) !== JSON.stringify(expectedPresets)) {
  throw new Error(`preset mismatch: ${JSON.stringify(presets)}`);
}
const daily = plans.payload.items.find((item) => item.preset === "daily");

const issued = await request("/api/admin/licenses/batch", {
  method: "POST",
  admin: true,
  body: { project_id: project.id, plan_id: daily.id, count: 1, max_devices: 1 },
});
if (issued.status !== 201) throw new Error(`license issue failed: ${JSON.stringify(issued)}`);
const license = issued.payload.items[0];
const listed = await request(`/api/admin/licenses?q=${encodeURIComponent(license.key)}`, { admin: true });
const listedLicense = listed.payload.items.find((item) => item.id === license.id);
const listedKeyRecoverable = listed.status === 200 && listedLicense?.key === license.key && listedLicense?.key_recoverable === true;

async function activate(deviceId, keys, targetLicense = license) {
  const challenge = await request("/api/public/challenge", {
    method: "POST",
    body: {
      project_id: project.id,
      license_key: targetLicense.key,
      device_id: deviceId,
      device_public_key: keys.publicKey,
    },
  });
  if (challenge.status !== 200) return challenge;
  const signature = sign(null, Buffer.from(challenge.payload.signature_payload), keys.privateKey).toString("base64url");
  return request("/api/public/activate", {
    method: "POST",
    body: {
      project_id: project.id,
      license_key: targetLicense.key,
      device_id: deviceId,
      device_public_key: keys.publicKey,
      challenge_token: challenge.payload.challenge_token,
      signature,
    },
  });
}

const keysA = deviceIdentity();
const activationA = await activate("smoke-device-a", keysA);
const unsignedValidation = await request("/api/public/validate", {
  method: "POST",
  body: {
    project_id: project.id,
    session_token: activationA.payload.session_token,
    device_token: activationA.payload.device_token,
  },
});
const validationSignature = sign(
  null,
  Buffer.from(activationA.payload.signature_payload),
  keysA.privateKey,
).toString("base64url");
const signedValidation = await request("/api/public/validate", {
  method: "POST",
  body: {
    project_id: project.id,
    session_token: activationA.payload.session_token,
    device_token: activationA.payload.device_token,
    signature: validationSignature,
  },
});
const replay = await request("/api/public/validate", {
  method: "POST",
  body: {
    project_id: project.id,
    session_token: activationA.payload.session_token,
    device_token: activationA.payload.device_token,
    signature: validationSignature,
  },
});
const activationB = await activate("smoke-device-b", deviceIdentity());

const raceIssued = await request("/api/admin/licenses/batch", {
  method: "POST",
  admin: true,
  body: { project_id: project.id, plan_id: daily.id, count: 1, max_devices: 1 },
});
if (raceIssued.status !== 201) throw new Error(`race license issue failed: ${JSON.stringify(raceIssued)}`);
const raceLicense = raceIssued.payload.items[0];
const raceResults = await Promise.all([
  activate("race-device-a", deviceIdentity(), raceLicense),
  activate("race-device-b", deviceIdentity(), raceLicense),
]);
const concurrent_activation_statuses = raceResults.map((item) => item.status).sort((a, b) => a - b);

await request(`/api/admin/projects/${encodeURIComponent(project.id)}`, {
  method: "PATCH",
  admin: true,
  body: { status: "disabled" },
});
const disabledSignature = sign(
  null,
  Buffer.from(signedValidation.payload.signature_payload),
  keysA.privateKey,
).toString("base64url");
const disabledValidation = await request("/api/public/validate", {
  method: "POST",
  body: {
    project_id: project.id,
    session_token: signedValidation.payload.session_token,
    device_token: activationA.payload.device_token,
    signature: disabledSignature,
  },
});
const deleteBatchIssued = await request("/api/admin/licenses/batch", {
  method: "POST",
  admin: true,
  body: { project_id: project.id, plan_id: daily.id, count: 2, max_devices: 1 },
});
if (deleteBatchIssued.status !== 201) throw new Error(`delete batch setup failed: ${JSON.stringify(deleteBatchIssued)}`);
const singleDeleted = await request(`/api/admin/licenses/${encodeURIComponent(license.id)}`, { method: "DELETE", admin: true });
const batchDeleteIds = [raceLicense.id, ...deleteBatchIssued.payload.items.map((item) => item.id)];
const batchDeleted = await request("/api/admin/licenses/delete-batch", {
  method: "POST",
  admin: true,
  body: { ids: batchDeleteIds },
});
const licensesAfterDelete = await request(`/api/admin/licenses?project_id=${encodeURIComponent(project.id)}`, { admin: true });
const deletedLicensesAbsent = singleDeleted.status === 200
  && singleDeleted.payload.deleted === 1
  && batchDeleted.status === 200
  && batchDeleted.payload.deleted === batchDeleteIds.length
  && !licensesAfterDelete.payload.items.some((item) => item.id === license.id || batchDeleteIds.includes(item.id));
const deleted = await request(`/api/admin/projects/${encodeURIComponent(project.id)}`, {
  method: "DELETE",
  admin: true,
});
const projectsAfterDelete = await request("/api/admin/projects", { admin: true });
const deletedProjectAbsent = deleted.status === 200
  && deleted.payload.id === project.id
  && !projectsAfterDelete.payload.items.some((item) => item.id === project.id);

const result = {
  ...(badLoginBlocked === null ? {} : { bad_login_blocked: badLoginBlocked }),
  project_created: created.status,
  listed_key_recoverable: listedKeyRecoverable,
  presets: [...presets].sort(),
  activation_a: activationA.status,
  unsigned_validate_blocked: unsignedValidation.status,
  signed_validate: signedValidation.status,
  stale_session_and_signature_blocked: replay.status,
  second_device_blocked: activationB.status,
  concurrent_activation_statuses,
  disabled_project_blocked: disabledValidation.status,
  single_license_deleted: singleDeleted.status,
  batch_licenses_deleted: batchDeleted.status,
  deleted_licenses_absent: deletedLicensesAbsent,
  project_deleted: deleted.status,
  deleted_project_absent: deletedProjectAbsent,
};
console.log(JSON.stringify(result));

const expected = {
  ...(badLoginBlocked === null ? {} : { bad_login_blocked: 401 }),
  project_created: 201,
  listed_key_recoverable: true,
  presets: expectedPresets,
  activation_a: 200,
  unsigned_validate_blocked: 400,
  signed_validate: 200,
  stale_session_and_signature_blocked: 400,
  second_device_blocked: 400,
  concurrent_activation_statuses: [200, 400],
  disabled_project_blocked: 400,
  single_license_deleted: 200,
  batch_licenses_deleted: 200,
  deleted_licenses_absent: true,
  project_deleted: 200,
  deleted_project_absent: true,
};
if (JSON.stringify(result) !== JSON.stringify(expected)) process.exitCode = 1;
