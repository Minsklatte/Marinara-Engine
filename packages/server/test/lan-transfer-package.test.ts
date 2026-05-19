import test from "node:test";
import assert from "node:assert/strict";
import { validateLanTransferPackage } from "../src/services/lan-transfer/lan-transfer-package.js";

const NOW = Date.parse("2026-05-19T00:00:00.000Z");
const FUTURE_EXPIRES_AT = "2026-05-19T00:10:00.000Z";
const CHAT_CONTENT = "{}\n{\"mes\":\"hi\"}";
const CHAT_BYTES = Buffer.byteLength(CHAT_CONTENT, "utf8");

test("accepts a minimal valid transfer package", () => {
  const result = validateLanTransferPackage(
    {
      version: 1,
      manifest: {
        version: 1,
        createdAt: "2026-05-19T00:00:00.000Z",
        expiresAt: FUTURE_EXPIRES_AT,
        sourceApp: "Marinara Engine",
        sourceVersion: "1.6.0",
        items: [{ type: "chat", id: "chat-1", name: "Chat", format: "jsonl", messageCount: 1, bytes: CHAT_BYTES }],
        totalBytes: CHAT_BYTES,
      },
      items: [{ type: "chat", id: "chat-1", name: "Chat", format: "jsonl", content: CHAT_CONTENT }],
    },
    { now: () => NOW },
  );

  assert.equal(result.ok, true);
});

test("rejects unknown item types", () => {
  const result = validateLanTransferPackage(
    {
      version: 1,
      manifest: {
        version: 1,
        createdAt: "2026-05-19T00:00:00.000Z",
        expiresAt: FUTURE_EXPIRES_AT,
        sourceApp: "Marinara Engine",
        sourceVersion: "1.6.0",
        items: [{ type: "unknown", id: "x", name: "Bad", bytes: 1 }],
        totalBytes: 1,
      },
      items: [{ type: "unknown", id: "x", name: "Bad", content: "" }],
    },
    { now: () => NOW },
  );

  assert.equal(result.ok, false);
});

test("rejects oversized packages", () => {
  const content = "oversized";
  const bytes = Buffer.byteLength(content, "utf8");
  const result = validateLanTransferPackage(
    {
      version: 1,
      manifest: {
        version: 1,
        createdAt: "2026-05-19T00:00:00.000Z",
        expiresAt: FUTURE_EXPIRES_AT,
        sourceApp: "Marinara Engine",
        sourceVersion: "1.6.0",
        items: [{ type: "chat", id: "chat-1", name: "Chat", format: "jsonl", messageCount: 1, bytes }],
        totalBytes: bytes,
      },
      items: [{ type: "chat", id: "chat-1", name: "Chat", format: "jsonl", content }],
    },
    { maxBytes: bytes - 1, now: () => Date.parse("2026-05-19T00:05:00.000Z") },
  );

  assert.equal(result.ok, false);
});

test("rejects manifest and package item mismatch", () => {
  const result = validateLanTransferPackage(
    {
      version: 1,
      manifest: {
        version: 1,
        createdAt: "2026-05-19T00:00:00.000Z",
        expiresAt: FUTURE_EXPIRES_AT,
        sourceApp: "Marinara Engine",
        sourceVersion: "1.6.0",
        items: [{ type: "chat", id: "chat-2", name: "Chat", format: "jsonl", messageCount: 1, bytes: CHAT_BYTES }],
        totalBytes: CHAT_BYTES,
      },
      items: [{ type: "chat", id: "chat-1", name: "Chat", format: "jsonl", content: CHAT_CONTENT }],
    },
    { now: () => NOW },
  );

  assert.equal(result.ok, false);
});

test("rejects forged manifest bytes", () => {
  const result = validateLanTransferPackage(
    {
      version: 1,
      manifest: {
        version: 1,
        createdAt: "2026-05-19T00:00:00.000Z",
        expiresAt: FUTURE_EXPIRES_AT,
        sourceApp: "Marinara Engine",
        sourceVersion: "1.6.0",
        items: [{ type: "chat", id: "chat-1", name: "Chat", format: "jsonl", messageCount: 1, bytes: CHAT_BYTES + 1 }],
        totalBytes: CHAT_BYTES + 1,
      },
      items: [{ type: "chat", id: "chat-1", name: "Chat", format: "jsonl", content: CHAT_CONTENT }],
    },
    { now: () => NOW },
  );

  assert.equal(result.ok, false);
});

test("rejects expired packages", () => {
  const result = validateLanTransferPackage(
    {
      version: 1,
      manifest: {
        version: 1,
        createdAt: "2026-05-18T23:00:00.000Z",
        expiresAt: "2026-05-18T23:59:59.000Z",
        sourceApp: "Marinara Engine",
        sourceVersion: "1.6.0",
        items: [{ type: "chat", id: "chat-1", name: "Chat", format: "jsonl", messageCount: 1, bytes: CHAT_BYTES }],
        totalBytes: CHAT_BYTES,
      },
      items: [{ type: "chat", id: "chat-1", name: "Chat", format: "jsonl", content: CHAT_CONTENT }],
    },
    { now: () => NOW },
  );

  assert.equal(result.ok, false);
});

test("rejects malformed character envelope", () => {
  const envelope = { type: "marinara_character", version: 1 };
  const bytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
  const result = validateLanTransferPackage(
    {
      version: 1,
      manifest: {
        version: 1,
        createdAt: "2026-05-19T00:00:00.000Z",
        expiresAt: FUTURE_EXPIRES_AT,
        sourceApp: "Marinara Engine",
        sourceVersion: "1.6.0",
        items: [{ type: "character", id: "char-1", name: "Character", format: "native", bytes }],
        totalBytes: bytes,
      },
      items: [{ type: "character", id: "char-1", name: "Character", format: "native", envelope }],
    },
    { now: () => NOW },
  );

  assert.equal(result.ok, false);
});
