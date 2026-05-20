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

test("native LAN chat import rejects invalid exports", async () =>
  withDb(async (db) => {
    const { importNativeLanChat } = await import("../src/services/lan-transfer/lan-transfer-native-chat.js");

    const result = await importNativeLanChat(db, { type: "marinara_lan_chat", version: 1, chat: {}, messages: [] }, {});

    assert.deepEqual(result, { success: false, error: "Native chat export chat must include name, mode, and characterIds" });
  }));
