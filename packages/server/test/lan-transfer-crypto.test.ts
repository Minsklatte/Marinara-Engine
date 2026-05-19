import test from "node:test";
import assert from "node:assert/strict";
import {
  decryptLanTransferPackage,
  encryptLanTransferPackage,
  generateLanTransferSecret,
  generateLanTransferToken,
  hashLanTransferToken,
} from "../src/services/lan-transfer/lan-transfer-crypto.js";

test("encrypts and decrypts a transfer package", () => {
  const secret = generateLanTransferSecret();
  const plaintext = JSON.stringify({ version: 1, items: [{ type: "chat", content: "hello" }] });
  const encrypted = encryptLanTransferPackage(plaintext, secret);
  const decrypted = decryptLanTransferPackage(encrypted, secret);

  assert.equal(decrypted, plaintext);
  assert.equal(encrypted.algorithm, "AES-256-GCM");
  assert.notEqual(encrypted.ciphertext, Buffer.from(plaintext, "utf8").toString("base64url"));
});

test("tampered ciphertext fails authentication", () => {
  const secret = generateLanTransferSecret();
  const encrypted = encryptLanTransferPackage(JSON.stringify({ version: 1 }), secret);
  const replacement = encrypted.ciphertext.endsWith("A") ? "B" : "A";
  const tampered = { ...encrypted, ciphertext: encrypted.ciphertext.slice(0, -1) + replacement };

  assert.throws(() => decryptLanTransferPackage(tampered, secret));
});

test("token hashes are stable and do not equal the token", () => {
  const token = generateLanTransferToken();
  const hash = hashLanTransferToken(token);

  assert.equal(hashLanTransferToken(token), hash);
  assert.notEqual(hash, token);
});
