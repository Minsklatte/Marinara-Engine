import test from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import {
  buildLanTransferPackage,
  validateLanTransferPackage,
} from "../src/services/lan-transfer/lan-transfer-package.js";

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

test("accepts a native chat package item with matching manifest bytes", () => {
  const chat = { id: "chat-1", messages: [{ role: "user", content: "hi" }] };
  const bytes = Buffer.byteLength(JSON.stringify(chat), "utf8");
  const result = validateLanTransferPackage(
    {
      version: 1,
      manifest: {
        version: 1,
        createdAt: "2026-05-19T00:00:00.000Z",
        expiresAt: FUTURE_EXPIRES_AT,
        sourceApp: "Marinara Engine",
        sourceVersion: "1.6.0",
        items: [
          {
            type: "chat",
            id: "chat-1",
            name: "Chat",
            format: "native",
            messageCount: 1,
            characterCount: 0,
            bytes,
          },
        ],
        totalBytes: bytes,
      },
      items: [{ type: "chat", id: "chat-1", name: "Chat", format: "native", chat }],
    },
    { now: () => NOW },
  );

  assert.equal(result.ok, true);
});

test("rejects native chat package bytes that match stray content instead of chat", () => {
  const chat = { id: "chat-1", messages: [{ role: "user", content: "hi" }] };
  const content = "stray";
  const contentBytes = Buffer.byteLength(content, "utf8");
  assert.notEqual(contentBytes, Buffer.byteLength(JSON.stringify(chat), "utf8"));
  const result = validateLanTransferPackage(
    {
      version: 1,
      manifest: {
        version: 1,
        createdAt: "2026-05-19T00:00:00.000Z",
        expiresAt: FUTURE_EXPIRES_AT,
        sourceApp: "Marinara Engine",
        sourceVersion: "1.6.0",
        items: [
          {
            type: "chat",
            id: "chat-1",
            name: "Chat",
            format: "native",
            messageCount: 1,
            characterCount: 0,
            bytes: contentBytes,
          },
        ],
        totalBytes: contentBytes,
      },
      items: [{ type: "chat", id: "chat-1", name: "Chat", format: "native", chat, content }],
    },
    { now: () => NOW },
  );

  assert.deepEqual(result, { ok: false, error: "Manifest item bytes mismatch" });
});

test("build rejects native chat item requests until native packaging is implemented", async () => {
  await assert.rejects(
    () =>
      buildLanTransferPackage(
        { db: {} } as FastifyInstance,
        [{ type: "chat", id: "chat-1", format: "native" }],
        FUTURE_EXPIRES_AT,
      ),
    /Native chat LAN transfer is not implemented yet/,
  );
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

test("rejects malformed but parseable timestamps", () => {
  const result = validateLanTransferPackage(
    {
      version: 1,
      manifest: {
        version: 1,
        createdAt: "2026-02-31T00:00:00.000Z",
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

  assert.equal(result.ok, false);
});

test("rejects loose timestamp strings", () => {
  const result = validateLanTransferPackage(
    {
      version: 1,
      manifest: {
        version: 1,
        createdAt: "0",
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

  assert.equal(result.ok, false);
});

test("rejects malformed character envelope", () => {
  const envelope = { type: "marinara_character", version: 1, data: {} };
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

test("accepts a valid native character envelope", () => {
  const envelope = {
    type: "marinara_character",
    version: 1,
    data: {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: { name: "Character" },
    },
  };
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

  assert.equal(result.ok, true);
});
