import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileNativeDB } from "../src/db/file-backed-store.js";
import { createCharactersStorage } from "../src/services/storage/characters.storage.js";
import { createChatsStorage } from "../src/services/storage/chats.storage.js";

async function withDb<T>(fn: (db: Awaited<ReturnType<typeof createFileNativeDB>>) => Promise<T>) {
  const root = mkdtempSync(join(tmpdir(), "marinara-native-chat-transfer-"));
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

test("native LAN chat import remaps chat and message character IDs", async () =>
  withDb(async (db) => {
    const { buildNativeLanChatExport, importNativeLanChat, collectNativeLanChatCharacterIds } = await import(
      "../src/services/lan-transfer/lan-transfer-native-chat.js"
    );
    const characters = createCharactersStorage(db);
    const chats = createChatsStorage(db);
    const character = await characters.create({ name: "Ari", description: "", first_mes: "Hi" });
    assert.ok(character?.id);
    const chat = await chats.create({ name: "Ari chat", mode: "roleplay", characterIds: [character.id] });
    assert.ok(chat?.id);
    await chats.createMessagesBatch(chat.id, [{ role: "assistant", characterId: character.id, content: "Hello" }]);

    const exported = await buildNativeLanChatExport(db, chat.id);
    assert.deepEqual(collectNativeLanChatCharacterIds(exported), [character.id]);

    const importedCharacter = await characters.create({ name: "Ari imported", description: "", first_mes: "Hi" });
    assert.ok(importedCharacter?.id);
    const result = await importNativeLanChat(db, exported, { [character.id]: importedCharacter.id });

    assert.equal(result.success, true);
    assert.ok(result.id);
    const importedChat = await chats.getById(result.id);
    assert.ok(importedChat);
    assert.deepEqual(JSON.parse(importedChat.characterIds as string), [importedCharacter.id]);
    assert.equal(importedChat.personaId, null);
    assert.equal(importedChat.promptPresetId, null);
    assert.equal(importedChat.connectionId, null);
    const messages = await chats.listMessages(result.id);
    assert.equal(messages[0]?.characterId, importedCharacter.id);
  }));

test("native LAN chat import drops unmapped source character IDs", async () =>
  withDb(async (db) => {
    const { buildNativeLanChatExport, importNativeLanChat } = await import(
      "../src/services/lan-transfer/lan-transfer-native-chat.js"
    );
    const characters = createCharactersStorage(db);
    const chats = createChatsStorage(db);
    const mappedCharacter = await characters.create({ name: "Ari", description: "", first_mes: "Hi" });
    const unmappedCharacter = await characters.create({ name: "Bea", description: "", first_mes: "Hi" });
    assert.ok(mappedCharacter?.id);
    assert.ok(unmappedCharacter?.id);
    const chat = await chats.create({
      name: "Group chat",
      mode: "roleplay",
      characterIds: [mappedCharacter.id, unmappedCharacter.id],
    });
    assert.ok(chat?.id);
    await chats.createMessagesBatch(chat.id, [
      { role: "assistant", characterId: mappedCharacter.id, content: "Mapped" },
      { role: "assistant", characterId: unmappedCharacter.id, content: "Unmapped" },
    ]);

    const exported = await buildNativeLanChatExport(db, chat.id);
    const importedCharacter = await characters.create({ name: "Ari imported", description: "", first_mes: "Hi" });
    assert.ok(importedCharacter?.id);
    const result = await importNativeLanChat(db, exported, { [mappedCharacter.id]: importedCharacter.id });

    assert.equal(result.success, true);
    assert.ok(result.id);
    const importedChat = await chats.getById(result.id);
    assert.ok(importedChat);
    assert.deepEqual(JSON.parse(importedChat.characterIds as string), [importedCharacter.id]);
    const messages = await chats.listMessages(result.id);
    assert.equal(messages[0]?.characterId, importedCharacter.id);
    assert.equal(messages[1]?.characterId, null);
  }));

test("native LAN chat import keeps source order when timestamps collide", async () =>
  withDb(async (db) => {
    const { importNativeLanChat } = await import("../src/services/lan-transfer/lan-transfer-native-chat.js");
    const characters = createCharactersStorage(db);
    const chats = createChatsStorage(db);
    const sourceCharacterId = "source-character";
    const importedCharacter = await characters.create({ name: "Ari imported", description: "", first_mes: "Hi" });
    assert.ok(importedCharacter?.id);
    const createdAt = "2026-05-20T12:00:00.000Z";

    const result = await importNativeLanChat(
      db,
      {
        type: "marinara_lan_chat",
        version: 1,
        chat: {
          id: "source-chat",
          name: "Imported chat",
          mode: "roleplay",
          characterIds: [sourceCharacterId],
        },
        messages: [
          { role: "assistant", characterId: sourceCharacterId, content: "First", createdAt },
          { role: "assistant", characterId: sourceCharacterId, content: "Second", createdAt },
        ],
      },
      { [sourceCharacterId]: importedCharacter.id },
    );

    assert.equal(result.success, true);
    assert.ok(result.id);
    const messages = await chats.listMessages(result.id);
    assert.deepEqual(
      messages.map((message) => message.content),
      ["First", "Second"],
    );
    assert.deepEqual(
      messages.map((message) => message.createdAt),
      ["2026-05-20T12:00:00.000Z", "2026-05-20T12:00:00.001Z"],
    );
  }));

test("native LAN chat export emits object metadata", async () =>
  withDb(async (db) => {
    const { buildNativeLanChatExport } = await import("../src/services/lan-transfer/lan-transfer-native-chat.js");
    const chats = createChatsStorage(db);
    const chat = await chats.create({ name: "Ari chat", mode: "roleplay", characterIds: [] });
    assert.ok(chat?.id);

    const exported = await buildNativeLanChatExport(db, chat.id);

    assert.equal(typeof exported.chat.metadata, "object");
    assert.equal(Array.isArray(exported.chat.metadata), false);
    assert.notEqual(exported.chat.metadata, null);
  }));

test("LAN package for a chat includes its referenced character before the native chat item", async () =>
  withDb(async (db) => {
    const { buildLanTransferPackage } = await import("../src/services/lan-transfer/lan-transfer-package.js");
    const characters = createCharactersStorage(db);
    const chats = createChatsStorage(db);
    const character = await characters.create({ name: "Ari", description: "", first_mes: "Hi" } as any);
    assert.ok(character?.id);
    const chat = await chats.create({ name: "Ari chat", mode: "roleplay", characterIds: [character.id] });
    assert.ok(chat?.id);
    await chats.createMessagesBatch(chat.id, [{ role: "assistant", characterId: character.id, content: "Hello" }]);

    const fakeApp = { db } as any;
    const pkg = await buildLanTransferPackage(
      fakeApp,
      [{ type: "chat", id: chat.id, format: "native" }],
      "2999-01-01T00:00:00.000Z",
    );

    assert.equal(pkg.items[0]?.type, "character");
    assert.equal(pkg.items[0]?.id, character.id);
    assert.equal(pkg.items[1]?.type, "chat");
    assert.equal((pkg.items[1] as any).format, "native");
    assert.equal(pkg.manifest.items[1]?.type, "chat");
    assert.equal((pkg.manifest.items[1] as any).format, "native");
    assert.equal((pkg.manifest.items[1] as any).messageCount, 1);
    assert.equal((pkg.manifest.items[1] as any).characterCount, 1);
    assert.equal(pkg.manifest.items.some((item) => item.type === "character" && item.name === "Ari"), true);

    const pkgWithExplicitCharacter = await buildLanTransferPackage(
      fakeApp,
      [
        { type: "chat", id: chat.id, format: "native" },
        { type: "character", id: character.id },
      ],
      "2999-01-01T00:00:00.000Z",
    );

    assert.deepEqual(
      pkgWithExplicitCharacter.items.map((item) => item.type),
      ["character", "chat"],
    );

    const { importLanTransferPackage } = await import("../src/services/lan-transfer/lan-transfer-package.js");
    const summary = await importLanTransferPackage(fakeApp, pkg);
    const importedCharacterId = summary.characterIdMap?.[character.id];
    assert.equal(summary.imported.characters, 1);
    assert.equal(summary.imported.chats, 1);
    assert.ok(importedCharacterId);
    assert.notEqual(importedCharacterId, character.id);

    const importedChat = (await chats.list()).find((candidate) => candidate.id !== chat.id && candidate.name === "Ari chat");
    assert.ok(importedChat);
    assert.deepEqual(JSON.parse(importedChat.characterIds as string), [importedCharacterId]);
    const importedMessages = await chats.listMessages(importedChat.id);
    assert.equal(importedMessages[0]?.characterId, importedCharacterId);
  }));

test("LAN package import skips native chat when required character mappings are missing", async () =>
  withDb(async (db) => {
    const { importLanTransferPackage } = await import("../src/services/lan-transfer/lan-transfer-package.js");
    const chats = createChatsStorage(db);
    const sourceCharacterId = "source-character";
    const pkg = {
      version: 1,
      manifest: {
        version: 1,
        createdAt: "2026-05-20T00:00:00.000Z",
        expiresAt: "2999-01-01T00:00:00.000Z",
        sourceApp: "Marinara Engine",
        sourceVersion: "1.6.0",
        items: [
          {
            type: "character",
            id: sourceCharacterId,
            name: "Ari",
            format: "native",
            bytes: 2,
          },
          {
            type: "chat",
            id: "source-chat",
            name: "Ari chat",
            format: "native",
            messageCount: 1,
            characterCount: 1,
            bytes: 0,
          },
        ],
        totalBytes: 0,
      },
      items: [
        {
          type: "character",
          id: sourceCharacterId,
          name: "Ari",
          format: "native",
          envelope: {},
        },
        {
          type: "chat",
          id: "source-chat",
          name: "Ari chat",
          format: "native",
          chat: {
            type: "marinara_lan_chat",
            version: 1,
            chat: {
              id: "source-chat",
              name: "Ari chat",
              mode: "roleplay",
              characterIds: [sourceCharacterId],
            },
            messages: [{ role: "assistant", characterId: sourceCharacterId, content: "Hello" }],
          },
        },
      ],
    } as any;

    const summary = await importLanTransferPackage({ db } as any, pkg);

    assert.equal(summary.imported.chats, 0);
    assert.equal(summary.imported.characters, 0);
    assert.deepEqual(summary.skipped, [
      {
        type: "character",
        name: "Ari",
        reason: "Invalid Marinara export file",
      },
      {
        type: "chat",
        name: "Ari chat",
        reason: "Missing imported character mappings: source-character",
      },
    ]);
    assert.deepEqual(await chats.list(), []);
  }));

test("native LAN chat export validator rejects unsafe shapes", async () => {
  const { collectNativeLanChatCharacterIds, validateNativeLanChatExport } = await import(
    "../src/services/lan-transfer/lan-transfer-native-chat.js"
  );
  const baseExport = {
    type: "marinara_lan_chat",
    version: 1,
    chat: {
      id: "source-chat",
      name: "Imported chat",
      mode: "roleplay",
      characterIds: ["source-character"],
    },
    messages: [{ role: "assistant", characterId: "source-character", content: "Hello" }],
  };

  assert.equal(validateNativeLanChatExport(baseExport).ok, true);
  const characterlessExport = {
    ...baseExport,
    chat: { ...baseExport.chat, characterIds: [] },
    messages: [{ role: "user", characterId: null, content: "Hello" }],
  };
  assert.equal(validateNativeLanChatExport(characterlessExport).ok, true);
  assert.deepEqual(collectNativeLanChatCharacterIds(characterlessExport as any), []);
  assert.equal(validateNativeLanChatExport({ ...baseExport, chat: { ...baseExport.chat, name: "" } }).ok, false);
  assert.equal(
    validateNativeLanChatExport({ ...baseExport, chat: { ...baseExport.chat, characterIds: [""] } }).ok,
    false,
  );
  assert.equal(
    validateNativeLanChatExport({ ...baseExport, chat: { ...baseExport.chat, characterIds: ["  "] } }).ok,
    false,
  );
  assert.equal(
    validateNativeLanChatExport({
      ...baseExport,
      messages: [{ role: "assistant", characterId: "", content: "Hello" }],
    }).ok,
    false,
  );
  assert.equal(
    validateNativeLanChatExport({
      ...baseExport,
      messages: [{ role: "assistant", characterId: null, content: "Hello", createdAt: 1 }],
    }).ok,
    false,
  );
  assert.equal(
    validateNativeLanChatExport({
      ...baseExport,
      messages: [{ role: "assistant", characterId: null, content: "Hello", createdAt: "0" }],
    }).ok,
    false,
  );
  assert.equal(
    validateNativeLanChatExport({
      ...baseExport,
      chat: { ...baseExport.chat, createdAt: "2026-02-31T00:00:00.000Z" },
    }).ok,
    false,
  );
  assert.equal(validateNativeLanChatExport({ ...baseExport, chat: { ...baseExport.chat, id: "  " } }).ok, false);
  assert.equal(
    validateNativeLanChatExport({ ...baseExport, chat: { ...baseExport.chat, personaId: "  " } }).ok,
    false,
  );
  assert.equal(validateNativeLanChatExport({ ...baseExport, chat: { ...baseExport.chat, metadata: [] } }).ok, false);
});

test("native LAN chat import rejects invalid exports", async () =>
  withDb(async (db) => {
    const { importNativeLanChat } = await import("../src/services/lan-transfer/lan-transfer-native-chat.js");

    const result = await importNativeLanChat(db, { type: "marinara_lan_chat", version: 1, chat: {}, messages: [] }, {});

    assert.deepEqual(result, { success: false, error: "Native chat export chat must include name, mode, and characterIds" });
  }));
