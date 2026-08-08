export const MAX_JSON_BYTES = 64 * 1024;
export const CHALLENGE_TTL_SECONDS = 120;
export const SESSION_TTL_SECONDS = 15 * 60;

export const PLAN_PRESETS = {
  daily: { name: "Daily", durationSeconds: 86400, maxDevices: 1 },
  weekly: { name: "Weekly", durationSeconds: 7 * 86400, maxDevices: 1 },
  monthly: { name: "Monthly", durationSeconds: 30 * 86400, maxDevices: 1 },
  quarterly: { name: "Quarterly", durationSeconds: 90 * 86400, maxDevices: 1 },
  annual: { name: "Annual", durationSeconds: 365 * 86400, maxDevices: 1 },
} as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readString(
  body: Record<string, unknown>,
  field: string,
  options: { min?: number; max?: number; optional?: boolean } = {},
): string | undefined {
  const value = body[field];
  if (value === undefined && options.optional) return undefined;
  if (typeof value !== "string") throw new Error(`invalid_${field}`);
  const trimmed = value.trim();
  if (trimmed.length < (options.min ?? 1) || trimmed.length > (options.max ?? 256)) {
    throw new Error(`invalid_${field}`);
  }
  return trimmed;
}

export function readInt(
  body: Record<string, unknown>,
  field: string,
  options: { min: number; max: number; optional?: boolean },
): number | undefined {
  const value = body[field];
  if (value === undefined && options.optional) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < options.min || (value as number) > options.max) {
    throw new Error(`invalid_${field}`);
  }
  return value as number;
}

export function slugify(value: string): string {
  const slug = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug || slug.length > 64) throw new Error("invalid_slug");
  return slug;
}

export function encodeCursor(createdAt: number, id: string): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify([createdAt, id])));
}

export function decodeCursor(cursor: string): [number, string] {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(cursor)));
    if (!Array.isArray(parsed) || parsed.length !== 2 || !Number.isSafeInteger(parsed[0]) || typeof parsed[1] !== "string") {
      throw new Error();
    }
    return [parsed[0] as number, parsed[1]];
  } catch {
    throw new Error("invalid_cursor");
  }
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid_base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  const size = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < size; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

export function boundedMetadata(value: unknown): string {
  if (value === undefined) return "{}";
  if (!isRecord(value)) throw new Error("invalid_metadata");
  const encoded = JSON.stringify(value);
  if (encoded.length > 4096) throw new Error("invalid_metadata");
  return encoded;
}
