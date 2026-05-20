import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileNativeDB } from "../src/db/file-backed-store.js";
import {
  buildLanTransferPackage,
  importLanTransferPackage,
  validateLanTransferPackage,
} from "../src/services/lan-transfer/lan-transfer-package.js";
import { createChatsStorage } from "../src/services/storage/chats.storage.js";

const NOW = Date.parse("2026-05-19T00:00:00.000Z");
const FUTURE_EXPIRES_AT = "2026-05-19T00:10:00.000Z";
const CHAT_CONTENT = "{}\n{\"mes\":\"hi\"}";
const CHAT_BYTES = Buffer.byteLength(CHAT_CONTENT, "utf8");

async function withDb<T>(fn: (db: Awaited<ReturnType<typeof createFileNativeDB>>) => Promise<T>) {
  const root = mkdtempSync(join(tmpdir(), "marinara-lan-transfer-package-"));
  const previousDataDir = process.env.DATA_DIR;
  const previousStorageDir = process.env.FILE_STORAGE_DIR;
  process.env.DATA_DIR = join(root, "data");
  process.env.FILE_STORAGE_DIR = join(root, "storage");
  const db = await createFileNativeDB();
  try {
    return await fn(db);
  } finally {
    await db._fileStore.close();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
    else process.env.FILE_STORAGE_DIR = previousStorageDir;
    rmSync(root, { recursive: true, force: true });
  }
}

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

test("builds, validates, and imports characterless native chat packages", async () =>
  withDb(async (db) => {
    const chats = createChatsStorage(db);
    const chat = await chats.create({ name: "Solo notes", mode: "roleplay", characterIds: [] });
    assert.ok(chat?.id);
    await chats.createMessagesBatch(chat.id, [{ role: "user", characterId: null, content: "Remember this" }]);

    const pkg = await buildLanTransferPackage(
      { db } as any,
      [{ type: "chat", id: chat.id, format: "native" }],
      "2999-01-01T00:00:00.000Z",
    );
    const validation = validateLanTransferPackage(pkg);
    assert.equal(validation.ok, true);

    const summary = await importLanTransferPackage({ db } as any, pkg);

    assert.equal(summary.imported.characters, 0);
    assert.equal(summary.imported.chats, 1);
    assert.deepEqual(summary.skipped, []);
    assert.equal(pkg.items.length, 1);
    assert.equal(pkg.items[0]?.type, "chat");
    assert.equal((pkg.items[0] as any).format, "native");
    assert.deepEqual((pkg.items[0] as any).chat.chat.characterIds, []);
    assert.equal(pkg.manifest.items[0]?.type, "chat");
    assert.equal((pkg.manifest.items[0] as any).characterCount, 0);

    const importedChat = (await chats.list()).find(
      (candidate) => candidate.id !== chat.id && candidate.name === "Solo notes",
    );
    assert.ok(importedChat);
    assert.deepEqual(JSON.parse(importedChat.characterIds as string), []);
  }));

test("imports explicit JSONL chat packages through package import", async () =>
  withDb(async (db) => {
    const content = [
      JSON.stringify({ user_name: "User", character_name: "Notebook" }),
      JSON.stringify({ name: "User", is_user: true, mes: "hello" }),
    ].join("\n");
    const bytes = Buffer.byteLength(content, "utf8");
    const pkg = {
      version: 1,
      manifest: {
        version: 1,
        createdAt: "2026-05-19T00:00:00.000Z",
        expiresAt: "2999-01-01T00:00:00.000Z",
        sourceApp: "Marinara Engine",
        sourceVersion: "1.6.0",
        items: [{ type: "chat", id: "chat-jsonl", name: "JSONL import", format: "jsonl", messageCount: 1, bytes }],
        totalBytes: bytes,
      },
      items: [{ type: "chat", id: "chat-jsonl", name: "JSONL import", format: "jsonl", content }],
    };
    const validation = validateLanTransferPackage(pkg);
    assert.equal(validation.ok, true);

    const summary = await importLanTransferPackage({ db } as any, validation.ok ? validation.package : (pkg as any));

    assert.equal(summary.imported.characters, 0);
    assert.equal(summary.imported.chats, 1);
    assert.deepEqual(summary.skipped, []);
    const chats = createChatsStorage(db);
    const importedChat = (await chats.list()).find((candidate) => candidate.name === "JSONL import");
    assert.ok(importedChat);
    assert.deepEqual(JSON.parse(importedChat.characterIds as string), []);
    const messages = await chats.listMessages(importedChat.id);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.content, "hello");
  }));

test("accepts a native chat package item with matching manifest bytes", () => {
  const chat = {
    type: "marinara_lan_chat",
    version: 1,
    chat: { id: "chat-1", name: "Chat", mode: "roleplay", characterIds: ["char-1"] },
    messages: [{ role: "user", characterId: null, content: "hi" }],
  };
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
            characterCount: 1,
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
  const chat = {
    type: "marinara_lan_chat",
    version: 1,
    chat: { id: "chat-1", name: "Chat", mode: "roleplay", characterIds: ["char-1"] },
    messages: [{ role: "user", characterId: null, content: "hi" }],
  };
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
            characterCount: 1,
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

test("rejects forged native chat manifest message count", () => {
  const chat = {
    type: "marinara_lan_chat",
    version: 1,
    chat: { id: "chat-1", name: "Chat", mode: "roleplay", characterIds: ["char-1"] },
    messages: [{ role: "user", characterId: null, content: "hi" }],
  };
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
            messageCount: 2,
            characterCount: 1,
            bytes,
          },
        ],
        totalBytes: bytes,
      },
      items: [{ type: "chat", id: "chat-1", name: "Chat", format: "native", chat }],
    },
    { now: () => NOW },
  );

  assert.deepEqual(result, { ok: false, error: "Native chat manifest messageCount mismatch" });
});

test("rejects forged native chat manifest character count", () => {
  const chat = {
    type: "marinara_lan_chat",
    version: 1,
    chat: { id: "chat-1", name: "Chat", mode: "roleplay", characterIds: ["char-1"] },
    messages: [{ role: "assistant", characterId: "char-1", content: "hi" }],
  };
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
            characterCount: 2,
            bytes,
          },
        ],
        totalBytes: bytes,
      },
      items: [{ type: "chat", id: "chat-1", name: "Chat", format: "native", chat }],
    },
    { now: () => NOW },
  );

  assert.deepEqual(result, { ok: false, error: "Native chat manifest characterCount mismatch" });
});

test("rejects native chat package item with invalid native export", () => {
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

  assert.deepEqual(result, { ok: false, error: "Unsupported native chat export type" });
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
