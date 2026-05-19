import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { LanTransferEncryptedPackage } from "@marinara-engine/shared";

const LAN_TRANSFER_ENCRYPTION_VERSION = 1;
const LAN_TRANSFER_ALGORITHM = "AES-256-GCM";
const LAN_TRANSFER_KEY_INFO = "marinara-lan-transfer-package";
const LAN_TRANSFER_AAD = "marinara-lan-transfer:v1";
const TOKEN_BYTES = 16;
const SECRET_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;

export function generateLanTransferToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function generateLanTransferSecret(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

export function hashLanTransferToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

export function verifyLanTransferToken(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashLanTransferToken(token), "utf8");
  const expected = Buffer.from(expectedHash, "utf8");

  if (actual.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(actual, expected);
}

export function encryptLanTransferPackage(
  plaintext: string,
  secret: string,
): LanTransferEncryptedPackage {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const aad = Buffer.from(LAN_TRANSFER_AAD, "utf8");
  const key = deriveLanTransferKey(secret, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  cipher.setAAD(aad);

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: LAN_TRANSFER_ENCRYPTION_VERSION,
    algorithm: LAN_TRANSFER_ALGORITHM,
    salt: salt.toString("base64url"),
    iv: iv.toString("base64url"),
    aad: aad.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: tag.toString("base64url"),
  };
}

export function decryptLanTransferPackage(
  encrypted: LanTransferEncryptedPackage,
  secret: string,
): string {
  if (
    encrypted.version !== LAN_TRANSFER_ENCRYPTION_VERSION ||
    encrypted.algorithm !== LAN_TRANSFER_ALGORITHM
  ) {
    throw new Error("Unsupported LAN transfer package format");
  }

  try {
    const salt = decodeCanonicalBase64Url(encrypted.salt);
    const iv = decodeCanonicalBase64Url(encrypted.iv);
    const aad = decodeCanonicalBase64Url(encrypted.aad);
    const ciphertext = decodeCanonicalBase64Url(encrypted.ciphertext);
    const tag = decodeCanonicalBase64Url(encrypted.tag);
    const key = deriveLanTransferKey(secret, salt);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);

    decipher.setAAD(aad);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (err) {
    throw new Error("Failed to decrypt LAN transfer package", { cause: err });
  }
}

function deriveLanTransferKey(secret: string, salt: Buffer): Buffer {
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(secret, "utf8"), salt, LAN_TRANSFER_KEY_INFO, KEY_BYTES),
  );
}

function decodeCanonicalBase64Url(value: string): Buffer {
  const decoded = Buffer.from(value, "base64url");

  if (decoded.toString("base64url") !== value) {
    throw new Error("Invalid base64url encoding");
  }

  return decoded;
}
