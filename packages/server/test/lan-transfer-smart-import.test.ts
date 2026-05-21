import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileNativeDB } from "../src/db/file-backed-store.js";
import { characters as charactersTable, chats as chatsTable } from "../src/db/schema/index.js";
import { fingerprintLanTransferMessage } from "../src/services/lan-transfer/lan-transfer-fingerprints.js";
import { buildLanTransferPackage, importLanTransferPackage } from "../src/services/lan-transfer/lan-transfer-package.js";
import { analyzeLanTransferManifest } from "../src/services/lan-transfer/lan-transfer-smart-import.js";
import { createCharactersStorage } from "../src/services/storage/characters.storage.js";
import { createChatsStorage } from "../src/services/storage/chats.storage.js";

async function withDb<T>(fn: (db: Awaited<ReturnType<typeof createFileNativeDB>>) => Promise<T>) {
  const root = mkdtempSync(join(tmpdir(), "marinara-lan-transfer-smart-import-"));
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

test("omitted import mode reuses a matching character with different local metadata", async () =>
  withDb(async (db) => {
    const characters = createCharactersStorage(db);
    const existing = await characters.create({ name: "Alicia", description: "same", first_mes: "Hi" } as any);
    assert.ok(existing?.id);
    const source = await characters.create({ name: "Alicia", description: "same", first_mes: "Hi" } as any);
    assert.ok(source?.id);
    await db
      .update(charactersTable)
      .set({ createdAt: "2026-05-21T00:00:00.000Z", updatedAt: "2026-05-21T00:00:00.000Z" })
      .where(eq(charactersTable.id, source.id));

    const pkg = await buildLanTransferPackage(
      { db } as any,
      [{ type: "character", id: source.id }],
      "2999-01-01T00:00:00.000Z",
    );
    await characters.remove(source.id);

    const summary = await importLanTransferPackage({ db } as any, pkg);

    assert.equal(summary.imported.characters, 0);
    assert.equal(summary.reused?.characters, 1);
    assert.equal(summary.appended, undefined);
    assert.equal(summary.copied, undefined);
    assert.equal(summary.characterIdMap?.[pkg.items[0]!.id], existing.id);
    const allCharacters = await characters.list();
    assert.equal(allCharacters.length, 1);
  }));

test("smart import reuses a matching character with different local metadata", async () =>
  withDb(async (db) => {
    const characters = createCharactersStorage(db);
    const existing = await characters.create({ name: "Alicia", description: "same", first_mes: "Hi" } as any);
    assert.ok(existing?.id);
    const source = await characters.create({ name: "Alicia", description: "same", first_mes: "Hi" } as any);
    assert.ok(source?.id);
    await db
      .update(charactersTable)
      .set({ createdAt: "2026-05-21T00:00:00.000Z", updatedAt: "2026-05-21T00:00:00.000Z" })
      .where(eq(charactersTable.id, source.id));

    const pkg = await buildLanTransferPackage(
      { db } as any,
      [{ type: "character", id: source.id }],
      "2999-01-01T00:00:00.000Z",
    );
    await characters.remove(source.id);

    const summary = await importLanTransferPackage({ db } as any, pkg, { importMode: "smart" });

    assert.equal(summary.imported.characters, 0);
    assert.equal(summary.reused?.characters, 1);
    assert.equal(summary.appended, undefined);
    assert.equal(summary.copied, undefined);
    assert.equal(summary.characterIdMap?.[pkg.items[0]!.id], existing.id);
    const allCharacters = await characters.list();
    assert.equal(allCharacters.length, 1);
  }));

test("preview analysis shows existing card when import would reuse comparable character envelope", async () =>
  withDb(async (db) => {
    const characters = createCharactersStorage(db);
    const existing = await characters.create({ name: "Alicia", description: "same", first_mes: "Hi" } as any);
    assert.ok(existing?.id);
    const source = await characters.create({ name: "Alicia", description: "same", first_mes: "Hi" } as any);
    assert.ok(source?.id);
    await db
      .update(charactersTable)
      .set({ createdAt: "2026-05-21T00:00:00.000Z", updatedAt: "2026-05-21T00:00:00.000Z" })
      .where(eq(charactersTable.id, source.id));

    const pkg = await buildLanTransferPackage(
      { db } as any,
      [{ type: "character", id: source.id }],
      "2999-01-01T00:00:00.000Z",
    );
    await characters.remove(source.id);

    const analysis = await analyzeLanTransferManifest({ db } as any, pkg.manifest);

    assert.deepEqual(analysis.actions[0], {
      type: "character",
      sourceId: pkg.manifest.items[0]!.id,
      name: "Alicia",
      action: "reuse",
      targetId: existing.id,
      reason: "Matching native character already exists",
    });
  }));

test("copy import still duplicates an exact matching character", async () =>
  withDb(async (db) => {
    const characters = createCharactersStorage(db);
    const existing = await characters.create({ name: "Alicia", description: "same", first_mes: "Hi" } as any);
    const source = await characters.create({ name: "Alicia", description: "same", first_mes: "Hi" } as any);
    assert.ok(existing?.id);
    assert.ok(source?.id);

    const pkg = await buildLanTransferPackage(
      { db } as any,
      [{ type: "character", id: source.id }],
      "2999-01-01T00:00:00.000Z",
    );
    await characters.remove(source.id);

    const summary = await importLanTransferPackage({ db } as any, pkg, { importMode: "copy" });

    assert.equal(summary.imported.characters, 1);
    assert.equal(summary.reused?.characters ?? 0, 0);
    assert.equal(summary.appended, undefined);
    assert.equal(summary.copied?.characters, 1);
    const allCharacters = await characters.list();
    assert.equal(allCharacters.length, 2);
  }));

test("zero summary omits empty smart import counters", async () =>
  withDb(async (db) => {
    const summary = await importLanTransferPackage(
      { db } as any,
      {
        version: 1,
        manifest: {
          version: 1,
          createdAt: "2026-05-20T00:00:00.000Z",
          expiresAt: "2999-01-01T00:00:00.000Z",
          sourceApp: "Marinara Engine",
          sourceVersion: "1.6.0",
          items: [],
          totalBytes: 0,
        },
        items: [],
      },
    );

    assert.deepEqual(summary, {
      imported: { chats: 0, characters: 0 },
      skipped: [],
    });
  }));

test("preview analysis sanitizes malformed native manifest metadata conservatively", async () =>
  withDb(async (db) => {
    const chats = createChatsStorage(db);
    const existing = await chats.create({ name: "Existing route", mode: "roleplay", characterIds: [] });
    assert.ok(existing?.id);
    await chats.patchMetadata(existing.id, { lanTransfer: { syncId: "existing-chat" } }, { touchUpdatedAt: false });
    await chats.createMessagesBatch(existing.id, [
      { role: "user", characterId: null, content: "One", createdAt: "2026-05-20T12:00:00.000Z" },
    ]);

    const analysis = await analyzeLanTransferManifest(
      { db } as any,
      {
        version: 1,
        createdAt: "2026-05-20T00:00:00.000Z",
        expiresAt: "2999-01-01T00:00:00.000Z",
        sourceApp: "Marinara Engine",
        sourceVersion: "1.6.0",
        totalBytes: 0,
        items: [
          null,
          { type: "character", id: 42, name: "", format: "native", fingerprint: 123, bytes: "bad" },
          {
            type: "chat",
            id: "missing-sync",
            name: "Missing sync",
            format: "native",
            messageCount: "2",
            characterIds: "not-array",
            messageFingerprints: ["unused"],
          },
          {
            type: "chat",
            id: "existing-chat",
            syncId: "existing-chat",
            name: "Existing route",
            format: "native",
            messageCount: 1,
            characterIds: [],
            messageFingerprints: "not-array",
          },
          { type: "chat", id: "jsonl-chat", name: "JSONL", format: "jsonl", messageCount: "bad" },
        ],
      } as any,
    );

    assert.deepEqual(analysis, {
      mode: "smart",
      actions: [
        {
          type: "character",
          sourceId: "unknown-character",
          name: "Untitled character",
          action: "import-copy",
          reason: "Character fingerprint is missing; will import a copy",
        },
        {
          type: "chat",
          sourceId: "missing-sync",
          name: "Missing sync",
          action: "import-copy",
          messageCount: 0,
          reason: "Chat sync metadata is missing; will import a copy",
        },
        {
          type: "chat",
          sourceId: "existing-chat",
          name: "Existing route",
          action: "conflict-copy",
          targetId: existing.id,
          messageCount: 1,
          reason: "Message fingerprints are missing; will import a conflict copy",
        },
        {
          type: "chat",
          sourceId: "jsonl-chat",
          name: "JSONL",
          action: "import-copy",
          messageCount: 0,
          reason: "Non-native chat transfers are imported as copies",
        },
      ],
    });
  }));

test("preview analysis does not treat malformed native chat characterIds as empty dependencies", async () =>
  withDb(async (db) => {
    const chats = createChatsStorage(db);
    const existing = await chats.create({ name: "Existing route", mode: "roleplay", characterIds: [] });
    assert.ok(existing?.id);
    await chats.patchMetadata(existing.id, { lanTransfer: { syncId: "bad-dependency-chat" } }, {
      touchUpdatedAt: false,
    });
    await chats.createMessagesBatch(existing.id, [
      { role: "user", characterId: null, content: "One", createdAt: "2026-05-20T12:00:00.000Z" },
    ]);
    const fingerprint = fingerprintLanTransferMessage({
      role: "user",
      characterId: null,
      content: "One",
      createdAt: "2026-05-20T12:00:00.000Z",
    });

    const analysis = await analyzeLanTransferManifest(
      { db } as any,
      {
        version: 1,
        createdAt: "2026-05-20T00:00:00.000Z",
        expiresAt: "2999-01-01T00:00:00.000Z",
        sourceApp: "Marinara Engine",
        sourceVersion: "1.6.0",
        totalBytes: 0,
        items: [
          {
            type: "chat",
            id: "bad-dependency-chat",
            syncId: "bad-dependency-chat",
            name: "Existing route",
            format: "native",
            messageCount: 1,
            characterIds: "__proto__",
            messageFingerprints: [fingerprint],
          },
        ],
      } as any,
    );

    assert.deepEqual(analysis.actions, [
      {
        type: "chat",
        sourceId: "bad-dependency-chat",
        name: "Existing route",
        action: "conflict-copy",
        targetId: existing.id,
        messageCount: 1,
        reason: "Character dependency metadata is missing; will import a conflict copy",
      },
    ]);
  }));

test("preview analysis treats prototype-key character dependencies as unmapped when absent", async () =>
  withDb(async (db) => {
    const chats = createChatsStorage(db);
    const existing = await chats.create({ name: "Prototype route", mode: "roleplay", characterIds: [] });
    assert.ok(existing?.id);
    await chats.patchMetadata(existing.id, { lanTransfer: { syncId: "prototype-chat" } }, { touchUpdatedAt: false });
    await chats.createMessagesBatch(existing.id, [
      { role: "user", characterId: null, content: "One", createdAt: "2026-05-20T12:00:00.000Z" },
    ]);
    const fingerprint = fingerprintLanTransferMessage({
      role: "user",
      characterId: null,
      content: "One",
      createdAt: "2026-05-20T12:00:00.000Z",
    });

    const analysis = await analyzeLanTransferManifest(
      { db } as any,
      {
        version: 1,
        createdAt: "2026-05-20T00:00:00.000Z",
        expiresAt: "2999-01-01T00:00:00.000Z",
        sourceApp: "Marinara Engine",
        sourceVersion: "1.6.0",
        totalBytes: 0,
        items: [
          {
            type: "chat",
            id: "prototype-chat",
            syncId: "prototype-chat",
            name: "Prototype route",
            format: "native",
            messageCount: 1,
            characterIds: ["__proto__"],
            messageFingerprints: [fingerprint],
          },
        ],
      } as any,
    );

    assert.deepEqual(analysis.actions, [
      {
        type: "chat",
        sourceId: "prototype-chat",
        name: "Prototype route",
        action: "skip",
        messageCount: 1,
        linkedCharacterNames: ["__proto__"],
        reason: "Missing character mapping for __proto__",
      },
    ]);
  }));

test("smart import appends missing messages to an existing synced chat and keeps local settings", async () =>
  withDb(async (db) => {
    const characters = createCharactersStorage(db);
    const chats = createChatsStorage(db);
    const character = await characters.create({ name: "Alicia", description: "same", first_mes: "Hi" } as any);
    assert.ok(character?.id);
    const existing = await chats.create({
      name: "Alicia thread",
      mode: "roleplay",
      characterIds: [character.id],
      promptPresetId: "local-preset",
      connectionId: "local-connection",
    });
    assert.ok(existing?.id);
    await chats.patchMetadata(existing.id, { lanTransfer: { syncId: "source-chat" } }, { touchUpdatedAt: false });
    await chats.createMessagesBatch(existing.id, [
      { role: "assistant", characterId: character.id, content: "One", createdAt: "2026-05-20T12:00:00.000Z" },
    ]);

    const source = await chats.create({ name: "Alicia thread", mode: "roleplay", characterIds: [character.id] });
    assert.ok(source?.id);
    await chats.patchMetadata(source.id, { lanTransfer: { syncId: "source-chat" } }, { touchUpdatedAt: false });
    await chats.createMessagesBatch(source.id, [
      { role: "assistant", characterId: character.id, content: "One", createdAt: "2026-05-20T12:00:00.000Z" },
      { role: "user", characterId: null, content: "Two", createdAt: "2026-05-20T12:01:00.000Z" },
    ]);

    const pkg = await buildLanTransferPackage(
      { db } as any,
      [{ type: "chat", id: source.id, format: "native" }],
      "2999-01-01T00:00:00.000Z",
    );
    await chats.remove(source.id);

    const summary = await importLanTransferPackage({ db } as any, pkg, { importMode: "smart" });

    assert.equal(summary.appended?.chats, 1);
    assert.equal(summary.appended?.messages, 1);
    assert.equal(summary.imported.chats, 0);
    const updated = await chats.getById(existing.id);
    assert.equal(updated?.promptPresetId, "local-preset");
    assert.equal(updated?.connectionId, "local-connection");
    const messages = await chats.listMessages(existing.id);
    assert.deepEqual(messages.map((message) => message.content), ["One", "Two"]);
  }));

test("smart import skips identical synced chats", async () =>
  withDb(async (db) => {
    const characters = createCharactersStorage(db);
    const chats = createChatsStorage(db);
    const character = await characters.create({ name: "Alicia", description: "same", first_mes: "Hi" } as any);
    assert.ok(character?.id);
    const existing = await chats.create({ name: "Alicia thread", mode: "roleplay", characterIds: [character.id] });
    assert.ok(existing?.id);
    await chats.patchMetadata(existing.id, { lanTransfer: { syncId: "source-chat" } }, { touchUpdatedAt: false });
    await chats.createMessagesBatch(existing.id, [
      { role: "assistant", characterId: character.id, content: "One", createdAt: "2026-05-20T12:00:00.000Z" },
    ]);

    const pkg = await buildLanTransferPackage(
      { db } as any,
      [{ type: "chat", id: existing.id, format: "native" }],
      "2999-01-01T00:00:00.000Z",
    );

    const summary = await importLanTransferPackage({ db } as any, pkg, { importMode: "smart" });

    assert.equal(summary.reused?.chats, 1);
    assert.equal(summary.imported.chats, 0);
    assert.equal((await chats.list()).length, 1);
  }));

test("smart import copies divergent synced chats instead of silently merging", async () =>
  withDb(async (db) => {
    const characters = createCharactersStorage(db);
    const chats = createChatsStorage(db);
    const character = await characters.create({ name: "Alicia", description: "same", first_mes: "Hi" } as any);
    assert.ok(character?.id);
    const existing = await chats.create({ name: "Alicia thread", mode: "roleplay", characterIds: [character.id] });
    assert.ok(existing?.id);
    await chats.patchMetadata(existing.id, { lanTransfer: { syncId: "source-chat" } }, { touchUpdatedAt: false });
    await chats.createMessagesBatch(existing.id, [
      { role: "assistant", characterId: character.id, content: "Local branch", createdAt: "2026-05-20T12:00:00.000Z" },
    ]);

    const source = await chats.create({ name: "Alicia thread", mode: "roleplay", characterIds: [character.id] });
    assert.ok(source?.id);
    await chats.patchMetadata(source.id, { lanTransfer: { syncId: "source-chat" } }, { touchUpdatedAt: false });
    await chats.createMessagesBatch(source.id, [
      { role: "assistant", characterId: character.id, content: "Remote branch", createdAt: "2026-05-20T12:00:00.000Z" },
    ]);
    const pkg = await buildLanTransferPackage(
      { db } as any,
      [{ type: "chat", id: source.id, format: "native" }],
      "2999-01-01T00:00:00.000Z",
    );
    await chats.remove(source.id);

    const summary = await importLanTransferPackage({ db } as any, pkg, { importMode: "smart" });

    assert.equal(summary.copied?.chats, 1);
    assert.equal(summary.imported.chats, 1);
    assert.deepEqual(summary.skipped, []);
    assert.equal((await chats.list()).length, 2);
  }));

test("smart import reuses an identical divergent conflict copy on repeated import", async () =>
  withDb(async (db) => {
    const characters = createCharactersStorage(db);
    const chats = createChatsStorage(db);
    const character = await characters.create({ name: "Alicia", description: "same", first_mes: "Hi" } as any);
    assert.ok(character?.id);
    const existing = await chats.create({ name: "Alicia thread", mode: "roleplay", characterIds: [character.id] });
    assert.ok(existing?.id);
    await chats.patchMetadata(existing.id, { lanTransfer: { syncId: "source-chat" } }, { touchUpdatedAt: false });
    await chats.createMessagesBatch(existing.id, [
      { role: "assistant", characterId: character.id, content: "Local branch", createdAt: "2026-05-20T12:00:00.000Z" },
    ]);

    const source = await chats.create({ name: "Alicia thread", mode: "roleplay", characterIds: [character.id] });
    assert.ok(source?.id);
    await chats.patchMetadata(source.id, { lanTransfer: { syncId: "source-chat" } }, { touchUpdatedAt: false });
    await chats.createMessagesBatch(source.id, [
      { role: "assistant", characterId: character.id, content: "Remote branch", createdAt: "2026-05-20T12:00:00.000Z" },
    ]);
    const pkg = await buildLanTransferPackage(
      { db } as any,
      [{ type: "chat", id: source.id, format: "native" }],
      "2999-01-01T00:00:00.000Z",
    );
    await chats.remove(source.id);

    const first = await importLanTransferPackage({ db } as any, pkg, { importMode: "smart" });
    const second = await importLanTransferPackage({ db } as any, pkg, { importMode: "smart" });

    assert.equal(first.copied?.chats, 1);
    assert.equal(second.reused?.chats, 1);
    assert.equal(second.copied, undefined);
    assert.deepEqual(second.skipped, []);
    assert.equal((await chats.list()).length, 2);
    const conflictCopy = (await chats.list()).find((candidate) => candidate.name === "Alicia thread (LAN conflict copy)");
    assert.ok(conflictCopy);
    const metadata = JSON.parse(conflictCopy.metadata as string);
    assert.equal(metadata.lanTransfer.conflict.syncId, "source-chat");
    assert.equal(typeof metadata.lanTransfer.conflict.messageFingerprint, "string");
  }));

test("smart import fallback fingerprints use synced character IDs for existing local messages", async () =>
  withDb(async (db) => {
    const characters = createCharactersStorage(db);
    const chats = createChatsStorage(db);
    const character = await characters.create({
      name: "Alicia",
      description: "same",
      first_mes: "Hi",
      extensions: {
        marinara_lan_transfer: {
          syncId: "source-character",
          fingerprint: "card-fingerprint",
        },
      },
    } as any);
    assert.ok(character?.id);
    assert.notEqual(character.id, "source-character");
    const existing = await chats.create({ name: "Alicia thread", mode: "roleplay", characterIds: [character.id] });
    assert.ok(existing?.id);
    await chats.patchMetadata(existing.id, { lanTransfer: { syncId: "source-chat" } }, { touchUpdatedAt: false });
    await chats.createMessagesBatch(existing.id, [
      { role: "assistant", characterId: character.id, content: "One", createdAt: "2026-05-20T12:00:00.000Z" },
    ]);

    const source = await chats.create({ name: "Alicia thread", mode: "roleplay", characterIds: [character.id] });
    assert.ok(source?.id);
    await chats.patchMetadata(source.id, { lanTransfer: { syncId: "source-chat" } }, { touchUpdatedAt: false });
    await chats.createMessagesBatch(source.id, [
      { role: "assistant", characterId: character.id, content: "One", createdAt: "2026-05-20T12:00:00.000Z" },
      { role: "user", characterId: null, content: "Two", createdAt: "2026-05-20T12:01:00.000Z" },
    ]);

    const pkg = await buildLanTransferPackage(
      { db } as any,
      [{ type: "chat", id: source.id, format: "native" }],
      "2999-01-01T00:00:00.000Z",
    );
    await chats.remove(source.id);

    const summary = await importLanTransferPackage({ db } as any, pkg, { importMode: "smart" });

    assert.equal(summary.appended?.chats, 1);
    assert.equal(summary.copied, undefined);
    assert.deepEqual(summary.skipped, []);
    assert.deepEqual(
      (await chats.listMessages(existing.id)).map((message) => message.content),
      ["One", "Two"],
    );
  }));

test("smart import fallback fingerprints use package character IDs when reused local characters lack LAN metadata", async () =>
  withDb(async (db) => {
    const characters = createCharactersStorage(db);
    const chats = createChatsStorage(db);
    const existingCharacter = await characters.create({
      name: "Alicia",
      description: "same",
      first_mes: "Hi",
    } as any);
    assert.ok(existingCharacter?.id);
    assert.notEqual(existingCharacter.id, "source-character");
    const existing = await chats.create({
      name: "Alicia thread",
      mode: "roleplay",
      characterIds: [existingCharacter.id],
    });
    assert.ok(existing?.id);
    await chats.patchMetadata(existing.id, { lanTransfer: { syncId: "source-chat" } }, { touchUpdatedAt: false });
    await chats.createMessagesBatch(existing.id, [
      {
        role: "assistant",
        characterId: existingCharacter.id,
        content: "One",
        createdAt: "2026-05-20T12:00:00.000Z",
      },
    ]);

    const sourceCharacter = await characters.create({
      name: "Alicia",
      description: "same",
      first_mes: "Hi",
      extensions: {
        marinara_lan_transfer: {
          syncId: "source-character",
          fingerprint: "card-fingerprint",
        },
      },
    } as any);
    assert.ok(sourceCharacter?.id);
    const source = await chats.create({
      name: "Alicia thread",
      mode: "roleplay",
      characterIds: [sourceCharacter.id],
    });
    assert.ok(source?.id);
    await chats.patchMetadata(source.id, { lanTransfer: { syncId: "source-chat" } }, { touchUpdatedAt: false });
    await chats.createMessagesBatch(source.id, [
      {
        role: "assistant",
        characterId: sourceCharacter.id,
        content: "One",
        createdAt: "2026-05-20T12:00:00.000Z",
      },
      { role: "user", characterId: null, content: "Two", createdAt: "2026-05-20T12:01:00.000Z" },
    ]);

    const pkg = await buildLanTransferPackage(
      { db } as any,
      [{ type: "chat", id: source.id, format: "native" }],
      "2999-01-01T00:00:00.000Z",
    );
    await chats.remove(source.id);
    await characters.remove(sourceCharacter.id);

    const summary = await importLanTransferPackage({ db } as any, pkg, { importMode: "smart" });

    assert.equal(summary.reused?.characters, 1);
    assert.equal(summary.appended?.chats, 1);
    assert.equal(summary.appended?.messages, 1);
    assert.equal(summary.imported.chats, 0);
    assert.equal(summary.copied, undefined);
    assert.deepEqual(summary.skipped, []);
    assert.equal((await chats.list()).length, 1);
    assert.deepEqual(
      (await chats.listMessages(existing.id)).map((message) => message.content),
      ["One", "Two"],
    );
  }));

test("preview analysis appends when a required bundled character will be imported first", async () =>
  withDb(async (db) => {
    const characters = createCharactersStorage(db);
    const chats = createChatsStorage(db);
    const sourceCharacter = await characters.create({ name: "Alicia", description: "same", first_mes: "Hi" } as any);
    assert.ok(sourceCharacter?.id);
    const existing = await chats.create({ name: "Alicia thread", mode: "roleplay", characterIds: [] });
    assert.ok(existing?.id);
    await chats.patchMetadata(existing.id, { lanTransfer: { syncId: "source-chat" } }, { touchUpdatedAt: false });
    await chats.createMessagesBatch(existing.id, [
      { role: "user", characterId: null, content: "One", createdAt: "2026-05-20T12:00:00.000Z" },
    ]);

    const source = await chats.create({ name: "Alicia thread", mode: "roleplay", characterIds: [sourceCharacter.id] });
    assert.ok(source?.id);
    await chats.patchMetadata(source.id, { lanTransfer: { syncId: "source-chat" } }, { touchUpdatedAt: false });
    await chats.createMessagesBatch(source.id, [
      { role: "user", characterId: null, content: "One", createdAt: "2026-05-20T12:00:00.000Z" },
      {
        role: "assistant",
        characterId: sourceCharacter.id,
        content: "Two",
        createdAt: "2026-05-20T12:01:00.000Z",
      },
    ]);
    const pkg = await buildLanTransferPackage(
      { db } as any,
      [{ type: "chat", id: source.id, format: "native" }],
      "2999-01-01T00:00:00.000Z",
    );
    await chats.remove(source.id);
    await characters.remove(sourceCharacter.id);

    const analysis = await analyzeLanTransferManifest({ db } as any, pkg.manifest);

    assert.equal(analysis.actions[0]?.type, "character");
    assert.equal(analysis.actions[0]?.action, "import-copy");
    assert.deepEqual(analysis.actions[1], {
      type: "chat",
      sourceId: "source-chat",
      name: "Alicia thread",
      action: "append",
      targetId: existing.id,
      messageCount: 2,
      appendCount: 1,
      linkedCharacterNames: ["Alicia"],
      reason: "Existing synced chat is missing 1 newer message",
    });
  }));

test("smart import append does not move existing chat updatedAt backwards", async () =>
  withDb(async (db) => {
    const characters = createCharactersStorage(db);
    const chats = createChatsStorage(db);
    const character = await characters.create({ name: "Alicia", description: "same", first_mes: "Hi" } as any);
    assert.ok(character?.id);
    const existing = await chats.create({ name: "Alicia thread", mode: "roleplay", characterIds: [character.id] });
    assert.ok(existing?.id);
    await chats.patchMetadata(existing.id, { lanTransfer: { syncId: "source-chat" } }, { touchUpdatedAt: false });
    await chats.createMessagesBatch(existing.id, [
      { role: "assistant", characterId: character.id, content: "One", createdAt: "2026-05-20T12:00:00.000Z" },
    ]);
    await db
      .update(chatsTable)
      .set({ updatedAt: "2026-05-21T00:00:00.000Z" })
      .where(eq(chatsTable.id, existing.id));

    const source = await chats.create({ name: "Alicia thread", mode: "roleplay", characterIds: [character.id] });
    assert.ok(source?.id);
    await chats.patchMetadata(source.id, { lanTransfer: { syncId: "source-chat" } }, { touchUpdatedAt: false });
    await chats.createMessagesBatch(source.id, [
      { role: "assistant", characterId: character.id, content: "One", createdAt: "2026-05-20T12:00:00.000Z" },
      { role: "user", characterId: null, content: "Two", createdAt: "2026-05-20T12:01:00.000Z" },
    ]);

    const pkg = await buildLanTransferPackage(
      { db } as any,
      [{ type: "chat", id: source.id, format: "native" }],
      "2999-01-01T00:00:00.000Z",
    );
    await chats.remove(source.id);

    const summary = await importLanTransferPackage({ db } as any, pkg, { importMode: "smart" });

    assert.equal(summary.appended?.messages, 1);
    assert.equal((await chats.getById(existing.id))?.updatedAt, "2026-05-21T00:00:00.000Z");
  }));

test("smart import append is idempotent for the same package", async () =>
  withDb(async (db) => {
    const characters = createCharactersStorage(db);
    const chats = createChatsStorage(db);
    const character = await characters.create({ name: "Alicia", description: "same", first_mes: "Hi" } as any);
    assert.ok(character?.id);
    const existing = await chats.create({ name: "Alicia thread", mode: "roleplay", characterIds: [character.id] });
    assert.ok(existing?.id);
    await chats.patchMetadata(existing.id, { lanTransfer: { syncId: "source-chat" } }, { touchUpdatedAt: false });
    await chats.createMessagesBatch(existing.id, [
      { role: "assistant", characterId: character.id, content: "One", createdAt: "2026-05-20T12:00:00.000Z" },
    ]);

    const source = await chats.create({ name: "Alicia thread", mode: "roleplay", characterIds: [character.id] });
    assert.ok(source?.id);
    await chats.patchMetadata(source.id, { lanTransfer: { syncId: "source-chat" } }, { touchUpdatedAt: false });
    await chats.createMessagesBatch(source.id, [
      { role: "assistant", characterId: character.id, content: "One", createdAt: "2026-05-20T12:00:00.000Z" },
      { role: "user", characterId: null, content: "Two", createdAt: "2026-05-20T12:01:00.000Z" },
    ]);

    const pkg = await buildLanTransferPackage(
      { db } as any,
      [{ type: "chat", id: source.id, format: "native" }],
      "2999-01-01T00:00:00.000Z",
    );
    await chats.remove(source.id);

    const first = await importLanTransferPackage({ db } as any, pkg, { importMode: "smart" });
    const second = await importLanTransferPackage({ db } as any, pkg, { importMode: "smart" });

    assert.equal(first.appended?.messages, 1);
    assert.equal(second.reused?.chats, 1);
    assert.equal(second.appended, undefined);
    assert.deepEqual(
      (await chats.listMessages(existing.id)).map((message) => message.content),
      ["One", "Two"],
    );
  }));
