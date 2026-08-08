export interface Env {
  DB: D1Database;
  LICENSE_COORDINATOR: DurableObjectNamespace;
  ASSETS: Fetcher;
  PUBLIC_RATE_LIMITER: RateLimit;
  ADMIN_LOGIN_RATE_LIMITER: RateLimit;
  ADMIN_API_TOKEN?: string;
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD_HASH: string;
  ADMIN_PASSWORD_SALT: string;
  ADMIN_SESSION_SECRET: string;
  KEY_PEPPER: string;
  LICENSE_KEY_ENCRYPTION_SECRET: string;
  TRUSTED_ORIGINS?: string;
}

export interface LicenseRow {
  id: string;
  project_id: string;
  key_digest: string;
  status: "enabled" | "disabled";
  duration_seconds: number;
  max_devices: number;
  activated_at: number | null;
  expires_at: number | null;
}

export interface CoordinatorRequest {
  action: "activate" | "validate" | "deactivate";
  requestId: string;
  licenseId: string;
  projectId: string;
  now: number;
  challengeToken?: string;
  deviceId?: string;
  devicePublicKey?: string;
  signature?: string;
  sessionToken?: string;
  deviceToken?: string;
}

export interface PublicSuccess {
  ok: true;
  license_id: string;
  expires_at: number;
  session_token?: string;
  device_token?: string;
  validation_challenge?: string;
  signature_payload?: string;
  signature_required?: boolean;
}
