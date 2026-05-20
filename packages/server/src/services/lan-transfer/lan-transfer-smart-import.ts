import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { ExportEnvelope, LanTransferImportSummary, LanTransferPackage } from "@marinara-engine/shared";
import { chats as chatsTable } from "../../db/schema/index.js";
import { buildNativeCharacterEnvelope } from "../export/character-export.service.js";
import { importMarinara } from "../import/marinara.importer.js";
import { importSTChat } from "../import/st-chat.importer.js";
import { createCharacterGalleryStorage } from "../storage/character-gallery.storage.js";
import { createCharactersStorage } from "../storage/characters.storage.js";
import { createChatsStorage } from "../storage/chats.storage.js";
import {
  compareFingerprintSequences,
  fingerprintLanTransferMessage,
  fingerprintNativeCharacterEnvelope,
  readLanTransferSyncId,
  withLanTransferCharacterSyncMetadata,
} from "./lan-transfer-fingerprints.js";
import {
  buildImportedMessages,
  collectNativeLanChatCharacterIds,
  importNativeLanChat,
  type NativeLanChatExport,
  validateNativeLanChatExport,
} from "./lan-transfer-native-chat.js";

export interface LanTransferPackageImportOptions {
  importMode?: "smart" | "copy";
}

export function createEmptyLanTransferImportSummary(): LanTransferImportSummary {
  return {
    imported: { chats: 0, characters: 0 },
    reused: { chats: 0, characters: 0 },
    appended: { chats: 0, messages: 0 },
    copied: { chats: 0, characters: 0 },
    skipped: [],
  };
}

export async function findExactCharacterByFingerprint(
  app: FastifyInstance,
  fingerprint: string | undefined,
): Promise<string | null> {
  if (!fingerprint) return null;

  const characters = createCharactersStorage(app.db);
  const gallery = createCharacterGalleryStorage(app.db);
  for (const character of await characters.list()) {
    let data: unknown;
    try {
      data = JSON.parse(character.data);
    } catch {
      continue;
    }

    const envelope = await buildNativeCharacterEnvelope(character, data, gallery);
    if (fingerprintNativeCharacterEnvelope(envelope) === fingerprint) return character.id;
  }
  return null;
}

export async function importLanTransferCharacters(
  app: FastifyInstance,
  pkg: LanTransferPackage,
  summary: LanTransferImportSummary,
  options: LanTransferPackageImportOptions,
): Promise<Record<string, string>> {
  const characterIdMap: Record<string, string> = {};
  const smart = (options.importMode ?? "smart") === "smart";

  for (const item of pkg.items) {
    if (item.type !== "character") continue;

    try {
      if (smart) {
        const existingId =
          (await findExactCharacterByFingerprint(app, item.fingerprint)) ??
          (await findExactCharacterByComparableEnvelope(app, item.envelope));
        if (existingId) {
          writeCharacterIdMap(characterIdMap, item, existingId);
          summary.reused!.characters += 1;
          continue;
        }
      }

      const envelope =
        smart && item.syncId && item.fingerprint
          ? withLanTransferCharacterSyncMetadata(item.envelope, {
              syncId: item.syncId,
              fingerprint: item.fingerprint,
            })
          : item.envelope;
      const result = await importMarinara(envelope as ExportEnvelope, app.db);
      if (result.success && result.id) {
        writeCharacterIdMap(characterIdMap, item, result.id);
        summary.imported.characters += 1;
        if (!smart) summary.copied!.characters += 1;
      } else {
        summary.skipped.push({ type: item.type, name: item.name, reason: result.error ?? "Import failed" });
      }
    } catch (err) {
      summary.skipped.push({
        type: item.type,
        name: item.name,
        reason: err instanceof Error ? err.message : "Import failed",
      });
    }
  }

  if (Object.keys(characterIdMap).length > 0) summary.characterIdMap = characterIdMap;
  return characterIdMap;
}

export async function importLanTransferChats(
  app: FastifyInstance,
  pkg: LanTransferPackage,
  characterIdMap: Record<string, string>,
  summary: LanTransferImportSummary,
  options: LanTransferPackageImportOptions,
) {
  const smart = (options.importMode ?? "smart") === "smart";

  for (const item of pkg.items) {
    if (item.type !== "chat") continue;

    try {
      if (item.format === "native" && smart) {
        await importNativeChatSmart(app, item, characterIdMap, summary);
        continue;
      }

      await importChatAsCopy(app, item, characterIdMap, summary, options);
    } catch (err) {
      summary.skipped.push({
        type: item.type,
        name: item.name,
        reason: err instanceof Error ? err.message : "Import failed",
      });
    }
  }
}

export function omitEmptyLanTransferImportSummaryCounts(
  summary: LanTransferImportSummary,
): LanTransferImportSummary {
  if (summary.reused && summary.reused.chats === 0 && summary.reused.characters === 0) {
    delete summary.reused;
  }
  if (summary.appended && summary.appended.chats === 0 && summary.appended.messages === 0) {
    delete summary.appended;
  }
  if (summary.copied && summary.copied.chats === 0 && summary.copied.characters === 0) {
    delete summary.copied;
  }
  return summary;
}

async function findExactCharacterByComparableEnvelope(
  app: FastifyInstance,
  sourceEnvelope: unknown,
): Promise<string | null> {
  const sourceFingerprint = fingerprintNativeCharacterEnvelope(
    normalizeCharacterEnvelopeForLocalComparison(sourceEnvelope),
  );
  const characters = createCharactersStorage(app.db);
  const gallery = createCharacterGalleryStorage(app.db);
  for (const character of await characters.list()) {
    let data: unknown;
    try {
      data = JSON.parse(character.data);
    } catch {
      continue;
    }

    const envelope = await buildNativeCharacterEnvelope(character, data, gallery);
    const localFingerprint = fingerprintNativeCharacterEnvelope(
      normalizeCharacterEnvelopeForLocalComparison(envelope),
    );
    if (localFingerprint === sourceFingerprint) return character.id;
  }
  return null;
}

function normalizeCharacterEnvelopeForLocalComparison(value: unknown): unknown {
  const cloned = cloneJsonCompatible(value);
  if (!isRecord(cloned)) return cloned;
  const outerData = cloned.data;
  if (!isRecord(outerData)) return cloned;
  const metadata = outerData.metadata;
  if (!isRecord(metadata)) return cloned;
  delete metadata.createdAt;
  delete metadata.updatedAt;
  return cloned;
}

function cloneJsonCompatible(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function writeCharacterIdMap(
  characterIdMap: Record<string, string>,
  item: Extract<LanTransferPackage["items"][number], { type: "character" }>,
  localId: string,
) {
  characterIdMap[item.id] = localId;
  if (item.syncId) characterIdMap[item.syncId] = localId;
}

async function importNativeChatSmart(
  app: FastifyInstance,
  item: Extract<LanTransferPackage["items"][number], { type: "chat"; format: "native" }>,
  characterIdMap: Record<string, string>,
  summary: LanTransferImportSummary,
) {
  const validation = validateNativeLanChatExport(item.chat);
  if (!validation.ok) {
    summary.skipped.push({ type: item.type, name: item.name, reason: validation.error });
    return;
  }

  const missingCharacterIds = collectNativeLanChatCharacterIds(validation.chat).filter((id) => !characterIdMap[id]);
  if (missingCharacterIds.length > 0) {
    summary.skipped.push({
      type: item.type,
      name: item.name,
      reason: `Missing imported character mappings: ${missingCharacterIds.join(", ")}`,
    });
    return;
  }

  const existing = await findChatBySyncId(app, validation.chat.chat.syncId);
  if (!existing) {
    const result = await importNativeLanChat(app.db, validation.chat, characterIdMap, { preserveSyncId: true });
    if (result.success) {
      summary.imported.chats += 1;
      writeChatIdMap(summary, item.id, result.id, item.syncId);
    } else {
      summary.skipped.push({ type: item.type, name: item.name, reason: result.error });
    }
    return;
  }

  const localFingerprints = await getLocalMessageFingerprints(app, existing.id, validation.chat, characterIdMap);
  const incomingFingerprints = validation.chat.messages.map((message) => message.fingerprint);
  const comparison = compareFingerprintSequences(localFingerprints, incomingFingerprints);
  if (comparison.kind === "same" || comparison.kind === "local_ahead") {
    summary.reused!.chats += 1;
    writeChatIdMap(summary, item.id, existing.id, item.syncId);
    return;
  }

  if (comparison.kind === "incoming_extends_local") {
    const chats = createChatsStorage(app.db);
    const appendedMessages = buildImportedMessages(validation.chat.messages, characterIdMap, comparison.appendFrom);
    await chats.createMessagesBatch(existing.id, appendedMessages);
    const lastAppendedAt = appendedMessages.at(-1)?.createdAt;
    if (lastAppendedAt && existing.updatedAt > lastAppendedAt) {
      await app.db.update(chatsTable).set({ updatedAt: existing.updatedAt }).where(eq(chatsTable.id, existing.id));
    }
    summary.appended!.chats += 1;
    summary.appended!.messages += incomingFingerprints.length - comparison.appendFrom;
    writeChatIdMap(summary, item.id, existing.id, item.syncId);
    return;
  }

  const result = await importNativeLanChat(app.db, validation.chat, characterIdMap, {
    nameSuffix: " (LAN conflict copy)",
  });
  if (result.success) {
    summary.imported.chats += 1;
    summary.copied!.chats += 1;
  } else {
    summary.skipped.push({ type: item.type, name: item.name, reason: result.error });
  }
}

async function importChatAsCopy(
  app: FastifyInstance,
  item: Extract<LanTransferPackage["items"][number], { type: "chat" }>,
  characterIdMap: Record<string, string>,
  summary: LanTransferImportSummary,
  options: LanTransferPackageImportOptions,
) {
  if (item.format === "native") {
    const validation = validateNativeLanChatExport(item.chat);
    if (!validation.ok) {
      summary.skipped.push({ type: item.type, name: item.name, reason: validation.error });
      return;
    }

    const missingCharacterIds = collectNativeLanChatCharacterIds(validation.chat).filter((id) => !characterIdMap[id]);
    if (missingCharacterIds.length > 0) {
      summary.skipped.push({
        type: item.type,
        name: item.name,
        reason: `Missing imported character mappings: ${missingCharacterIds.join(", ")}`,
      });
      return;
    }

    const result = await importNativeLanChat(app.db, validation.chat, characterIdMap);
    if (result.success) {
      summary.imported.chats += 1;
      if ((options.importMode ?? "smart") === "copy") summary.copied!.chats += 1;
    } else {
      summary.skipped.push({ type: item.type, name: item.name, reason: result.error });
    }
    return;
  }

  if (item.format === "jsonl") {
    const result = await importSTChat(item.content, app.db, { chatName: item.name });
    if ("success" in result && result.success) {
      summary.imported.chats += 1;
      if ((options.importMode ?? "smart") === "copy") summary.copied!.chats += 1;
    } else {
      summary.skipped.push({ type: item.type, name: item.name, reason: readImportError(result) });
    }
  }
}

async function findChatBySyncId(app: FastifyInstance, syncId: string) {
  const chats = createChatsStorage(app.db);
  for (const chat of await chats.list()) {
    if (chat.id === syncId) return chat;
    const metadata = parseJsonObject(chat.metadata);
    const lanTransfer = isRecord(metadata.lanTransfer) ? metadata.lanTransfer : null;
    if (lanTransfer?.syncId === syncId) return chat;
  }
  return null;
}

async function getLocalMessageFingerprints(
  app: FastifyInstance,
  chatId: string,
  incomingChat: NativeLanChatExport,
  characterIdMap: Record<string, string>,
): Promise<string[]> {
  const chats = createChatsStorage(app.db);
  const incomingCharacterIds = buildIncomingCharacterIdsByLocalId(incomingChat, characterIdMap);
  const characterSyncIds = await buildLocalCharacterSyncIdMap(app, chatId, incomingCharacterIds);
  const localMessages = await chats.listMessages(chatId);
  return localMessages.map((message) => {
    const extra = parseJsonObject(message.extra);
    const lanTransfer = isRecord(extra.lanTransfer) ? extra.lanTransfer : null;
    if (typeof lanTransfer?.fingerprint === "string" && lanTransfer.fingerprint.trim().length > 0) {
      return lanTransfer.fingerprint;
    }
    return fingerprintLanTransferMessage({
      role: message.role,
      characterId:
        message.characterId === null ? null : (characterSyncIds.get(message.characterId) ?? message.characterId),
      content: message.content,
      createdAt: message.createdAt,
    });
  });
}

function buildIncomingCharacterIdsByLocalId(
  incomingChat: NativeLanChatExport,
  characterIdMap: Record<string, string>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const sourceId of collectNativeLanChatCharacterIds(incomingChat)) {
    const localId = characterIdMap[sourceId];
    if (localId && !map.has(localId)) map.set(localId, sourceId);
  }
  return map;
}

async function buildLocalCharacterSyncIdMap(
  app: FastifyInstance,
  chatId: string,
  incomingCharacterIds: Map<string, string>,
): Promise<Map<string, string>> {
  const chats = createChatsStorage(app.db);
  const characters = createCharactersStorage(app.db);
  const ids = new Set<string>();
  const chat = await chats.getById(chatId);
  if (chat) {
    for (const id of parseJsonStringArray(chat.characterIds)) ids.add(id);
  }
  for (const message of await chats.listMessages(chatId)) {
    if (message.characterId) ids.add(message.characterId);
  }

  const map = new Map<string, string>();
  for (const id of ids) {
    const character = await characters.getById(id);
    if (!character) {
      map.set(id, id);
      continue;
    }
    const storedSyncId = readLanTransferSyncId({ data: { data: parseJsonObject(character.data) } });
    map.set(id, storedSyncId ?? incomingCharacterIds.get(id) ?? id);
  }
  return map;
}

function writeChatIdMap(
  summary: LanTransferImportSummary,
  sourceId: string,
  localId: string,
  syncId?: string,
) {
  summary.chatIdMap = { ...(summary.chatIdMap ?? {}), [sourceId]: localId };
  if (syncId) summary.chatIdMap[syncId] = localId;
}

function readImportError(value: unknown): string {
  return isRecord(value) && typeof value.error === "string" ? value.error : "Import failed";
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  }
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : [];
  } catch {
    return [];
  }
}
