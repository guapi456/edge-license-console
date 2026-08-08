import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  base64UrlEncode,
  boundedMetadata,
  constantTimeEqual,
  decodeCursor,
  encodeCursor,
  readInt,
  readString,
  PLAN_PRESETS,
  slugify,
} from "../src/core";
import { decryptLicenseKey, derivePasswordHash, encryptLicenseKey, hmacHex, issueAdminSession, newLicenseKey, verifyAdminSession, verifyPasswordHash } from "../src/crypto";

describe("core validation", () => {
  it("normalizes safe slugs and rejects empty ones", () => {
    expect(slugify("  Edge License Console ")).toBe("edge-license-console");
    expect(() => slugify("!!!")).toThrow("invalid_slug");
  });

  it("enforces bounded strings and integers", () => {
    expect(readString({ name: " test " }, "name", { max: 8 })).toBe("test");
    expect(() => readString({ name: "" }, "name")).toThrow("invalid_name");
    expect(readInt({ count: 100 }, "count", { min: 1, max: 100 })).toBe(100);
    expect(() => readInt({ count: 101 }, "count", { min: 1, max: 100 })).toThrow("invalid_count");
  });

  it("bounds metadata size", () => {
    expect(boundedMetadata({ team: "edge" })).toBe('{"team":"edge"}');
    expect(() => boundedMetadata({ value: "x".repeat(5000) })).toThrow("invalid_metadata");
  });

  it("ships fixed daily through annual presets", () => {
    expect(Object.keys(PLAN_PRESETS)).toEqual(["daily", "weekly", "monthly", "quarterly", "annual"]);
    expect(Object.values(PLAN_PRESETS).map((plan) => plan.durationSeconds / 86400)).toEqual([1, 7, 30, 90, 365]);
    expect(Object.values(PLAN_PRESETS).every((plan) => plan.maxDevices === 1)).toBe(true);
  });
});

describe("encoding and token primitives", () => {
  it("round-trips binary base64url values", () => {
    const input = Uint8Array.from([0, 1, 2, 253, 254, 255]);
    expect(base64UrlDecode(base64UrlEncode(input))).toEqual(input);
  });

  it("round-trips opaque pagination cursors", () => {
    expect(decodeCursor(encodeCursor(123456, "license-id"))).toEqual([123456, "license-id"]);
    expect(() => decodeCursor("not-valid" )).toThrow("invalid_cursor");
  });

  it("compares secrets without early length exits", () => {
    expect(constantTimeEqual("secret", "secret")).toBe(true);
    expect(constantTimeEqual("secret", "secrex")).toBe(false);
    expect(constantTimeEqual("", "secret")).toBe(false);
  });

  it("generates a 192-bit license payload", () => {
    const key = newLicenseKey();
    expect(key).toMatch(/^ELC-[A-Za-z0-9_-]{32}$/);
    expect(base64UrlDecode(key.slice(4))).toHaveLength(24);
  });

  it("produces stable keyed digests", async () => {
    const one = await hmacHex("pepper", "license");
    const two = await hmacHex("pepper", "license");
    const other = await hmacHex("other", "license");
    expect(one).toBe(two);
    expect(one).toMatch(/^[a-f0-9]{64}$/);
    expect(other).not.toBe(one);
  });

  it("encrypts recoverable license keys with authenticated context", async () => {
    const secret = base64UrlEncode(Uint8Array.from({ length: 32 }, (_, index) => index));
    const encrypted = await encryptLicenseKey(secret, "ELC-test-license", "license-id:project-id");
    expect(encrypted.iv).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(encrypted.ciphertext).not.toContain("ELC-test-license");
    expect(await decryptLicenseKey(secret, encrypted.ciphertext, encrypted.iv, "license-id:project-id")).toBe("ELC-test-license");
    await expect(decryptLicenseKey(secret, encrypted.ciphertext, encrypted.iv, "other-context")).rejects.toThrow();
  });

  it("verifies PBKDF2 password hashes", async () => {
    const hash = await derivePasswordHash("correct-password", "test-salt");
    expect(await verifyPasswordHash("correct-password", "test-salt", hash)).toBe(true);
    expect(await verifyPasswordHash("wrong", "test-salt", hash)).toBe(false);
  });

  it("issues signed, expiring admin sessions", async () => {
    const issued = await issueAdminSession("session-secret", "admin", 1_000);
    expect(await verifyAdminSession("session-secret", "admin", issued.token, 1_001)).toBe(true);
    expect(await verifyAdminSession("wrong-secret", "admin", issued.token, 1_001)).toBe(false);
    expect(await verifyAdminSession("session-secret", "other", issued.token, 1_001)).toBe(false);
    expect(await verifyAdminSession("session-secret", "admin", issued.token, issued.expiresAt)).toBe(false);
  });
});
