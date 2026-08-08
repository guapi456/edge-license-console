import { base64UrlDecode, base64UrlEncode, constantTimeEqual, isRecord } from "./core";

export const ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60;
export const PASSWORD_PBKDF2_ITERATIONS = 100_000;

async function hmacBytes(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

export function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64UrlEncode(value);
}

export function newLicenseKey(): string {
  return `ELC-${randomToken(24)}`;
}

export async function hmacHex(pepper: string, value: string): Promise<string> {
  const digest = await hmacBytes(pepper, value);
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function importLicenseEncryptionKey(secret: string): Promise<CryptoKey> {
  const keyBytes = base64UrlDecode(secret);
  if (keyBytes.length !== 32) throw new Error("key_encryption_misconfigured");
  const keyData = keyBytes.slice().buffer as ArrayBuffer;
  return crypto.subtle.importKey("raw", keyData, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptLicenseKey(secret: string, licenseKey: string, context: string): Promise<{ ciphertext: string; iv: string }> {
  const key = await importLicenseEncryptionKey(secret);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context), tagLength: 128 },
    key,
    new TextEncoder().encode(licenseKey),
  );
  return { ciphertext: base64UrlEncode(new Uint8Array(encrypted)), iv: base64UrlEncode(iv) };
}

export async function decryptLicenseKey(secret: string, ciphertext: string, iv: string, context: string): Promise<string> {
  const key = await importLicenseEncryptionKey(secret);
  const ivData = base64UrlDecode(iv).slice().buffer as ArrayBuffer;
  const ciphertextData = base64UrlDecode(ciphertext).slice().buffer as ArrayBuffer;
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: ivData,
      additionalData: new TextEncoder().encode(context),
      tagLength: 128,
    },
    key,
    ciphertextData,
  );
  return new TextDecoder().decode(decrypted);
}

export async function derivePasswordHash(password: string, salt: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new TextEncoder().encode(salt),
      iterations: PASSWORD_PBKDF2_ITERATIONS,
    },
    keyMaterial,
    256,
  );
  return base64UrlEncode(new Uint8Array(bits));
}

export async function verifyPasswordHash(password: string, salt: string, expectedHash: string): Promise<boolean> {
  const actualHash = await derivePasswordHash(password, salt);
  return constantTimeEqual(actualHash, expectedHash);
}

export async function issueAdminSession(secret: string, username: string, now = Math.floor(Date.now() / 1000)): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = now + ADMIN_SESSION_TTL_SECONDS;
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({
    username,
    issued_at: now,
    expires_at: expiresAt,
    nonce: randomToken(16),
  })));
  const signature = base64UrlEncode(await hmacBytes(secret, payload));
  return { token: `${payload}.${signature}`, expiresAt };
}

export async function verifyAdminSession(secret: string, expectedUsername: string, token: string, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  try {
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
    const expectedSignature = base64UrlEncode(await hmacBytes(secret, parts[0]));
    if (!constantTimeEqual(parts[1], expectedSignature)) return false;
    const payload: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
    if (!isRecord(payload)) return false;
    const username = payload.username;
    const issuedAt = payload.issued_at;
    const expiresAt = payload.expires_at;
    const nonce = payload.nonce;
    return typeof username === "string"
      && constantTimeEqual(username, expectedUsername)
      && Number.isSafeInteger(issuedAt)
      && Number.isSafeInteger(expiresAt)
      && typeof nonce === "string"
      && nonce.length >= 20
      && Number(issuedAt) <= now + 60
      && Number(expiresAt) > now
      && Number(expiresAt) - Number(issuedAt) === ADMIN_SESSION_TTL_SECONDS;
  } catch {
    return false;
  }
}

export async function verifyEd25519(publicKey: string, signature: string, message: string): Promise<boolean> {
  try {
    const keyBytes = base64UrlDecode(publicKey);
    const signatureBytes = base64UrlDecode(signature);
    if (keyBytes.length !== 32 || signatureBytes.length !== 64) return false;
    const keyData = keyBytes.slice().buffer as ArrayBuffer;
    const signatureData = signatureBytes.slice().buffer as ArrayBuffer;
    const messageData = new TextEncoder().encode(message).slice().buffer as ArrayBuffer;
    const key = await crypto.subtle.importKey("raw", keyData, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signatureData, messageData);
  } catch {
    return false;
  }
}
