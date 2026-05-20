import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type {
  ExportEnvelope,
  LanTransferImportSummary,
  LanTransferManifest,
  LanTransferPackage,
  LanTransferPreviewAction,
  LanTransferPreviewAnalysis,
} from "@marinara-engine/shared";
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

interface PreviewCharacterItem {
  type: "character";
  id: string;
  syncId?: string;
  name: string;
  format: "native";
  fingerprint?: string;
}

interface PreviewJsonlChatItem {
  type: "chat";
  id: string;
  name: string;
  format: "jsonl";
  messageCount: number;
}

interface PreviewNativeChatItem {
  type: "chat";
  id: string;
  syncId?: string;
  name: string;
  format: "native";
  messageCount: number;
  characterIds?: string[];
  messageFingerprints?: string[];
}

type PreviewChatItem = PreviewJsonlChatItem | PreviewNativeChatItem;
type PreviewManifestItem = PreviewCharacterItem | PreviewChatItem;

export function createEmptyLanTransferImportSummary(): LanTransferImportSummary {
  return {
    imported: { chats: 0, characters: 0 },
    reused: { chats: 0, characters: 0 },
    appended: { chats: 0, messages: 0 },
    copied: { chats: 0, characters: 0 },
    skipped: [],
  };
}

export async function analyzeLanTransferManifest(
  app: FastifyInstance,
  manifest: LanTransferManifest,
): Promise<LanTransferPreviewAnalysis> {
  const actions: LanTransferPreviewAction[] = [];
  const characterIdMap: Record<string, string> = {};
  const manifestCharacterIds = new Set<string>();
  const characterNames = new Map<string, string>();
  const items = sanitizePreviewManifestItems(manifest);

  for (const item of items) {
    if (item.type !== "character" || item.format !== "native") continue;
    rememberManifestCharacter(item, manifestCharacterIds, characterNames);
  }

  for (const item of items) {
    if (item.type === "character" && item.format === "native") {
      const existingId = await findExactCharacterByFingerprint(app, item.fingerprint);
      if (existingId) {
        writePreviewCharacterIdMap(characterIdMap, item, existingId);
        actions.push({
          type: "character",
          sourceId: item.id,
          name: item.name,
          action: "reuse",
          targetId: existingId,
          reason: "Exact matching native character already exists",
        });
      } else {
        actions.push({
          type: "character",
          sourceId: item.id,
          name: item.name,
          action: "import-copy",
          reason: item.fingerprint
            ? "No exact matching native character was found"
            : "Character fingerprint is missing; will import a copy",
        });
      }
      continue;
    }

    if (item.type === "chat" && item.format === "native") {
      actions.push(await analyzeNativeChatManifestItem(app, item, characterIdMap, manifestCharacterIds, characterNames));
      continue;
    }

    if (item.type === "chat") {
      actions.push({
        type: "chat",
        sourceId: item.id,
        name: item.name,
        action: "import-copy",
        messageCount: item.messageCount,
        reason: "Non-native chat transfers are imported as copies",
      });
    }
  }

  return { mode: "smart", actions };
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

async function analyzeNativeChatManifestItem(
  app: FastifyInstance,
  item: PreviewChatItem & { format: "native" },
  characterIdMap: Record<string, string>,
  manifestCharacterIds: Set<string>,
  characterNames: Map<string, string>,
): Promise<LanTransferPreviewAction> {
  const linkedCharacterNames = readLinkedCharacterNames(item.characterIds, characterNames);
  const base = {
    type: "chat" as const,
    sourceId: item.id,
    name: item.name,
    messageCount: item.messageCount,
  };
  const linkedCharacterContext = linkedCharacterNames ? { linkedCharacterNames } : {};

  if (!item.syncId) {
    return {
      ...base,
      ...linkedCharacterContext,
      action: "import-copy",
      reason: "Chat sync metadata is missing; will import a copy",
    };
  }

  const characterIds = Array.isArray(item.characterIds) ? item.characterIds : [];
  const missingDependencies = characterIds.filter(
    (characterId) => !characterIdMap[characterId] && !manifestCharacterIds.has(characterId),
  );
  if (missingDependencies.length > 0) {
    return {
      ...base,
      ...linkedCharacterContext,
      action: "skip",
      reason: `Missing character mapping for ${missingDependencies.join(", ")}`,
    };
  }

  const existing = await findChatBySyncId(app, item.syncId);
  if (!existing) {
    return {
      ...base,
      ...linkedCharacterContext,
      action: "import-copy",
      reason: "No existing synced chat was found",
    };
  }

  if (!Array.isArray(item.messageFingerprints)) {
    return {
      ...base,
      ...linkedCharacterContext,
      action: "conflict-copy",
      targetId: existing.id,
      reason: "Message fingerprints are missing; will import a conflict copy",
    };
  }

  const missingLocalMappings = characterIds.filter((characterId) => !characterIdMap[characterId]);
  if (missingLocalMappings.length > 0) {
    return {
      ...base,
      ...linkedCharacterContext,
      action: "conflict-copy",
      targetId: existing.id,
      reason: `Existing chat found, but local character mapping is missing for ${missingLocalMappings.join(", ")}`,
    };
  }

  const localFingerprints = await getLocalMessageFingerprints(
    app,
    existing.id,
    buildPreviewNativeChat(item),
    characterIdMap,
  );
  const comparison = compareFingerprintSequences(localFingerprints, item.messageFingerprints);
  if (comparison.kind === "same") {
    return {
      ...base,
      ...linkedCharacterContext,
      action: "skip",
      targetId: existing.id,
      reason: "Existing synced chat is already up to date",
    };
  }
  if (comparison.kind === "local_ahead") {
    return {
      ...base,
      ...linkedCharacterContext,
      action: "skip",
      targetId: existing.id,
      reason: "Existing synced chat already has newer local messages",
    };
  }
  if (comparison.kind === "incoming_extends_local") {
    const appendCount = item.messageFingerprints.length - comparison.appendFrom;
    return {
      ...base,
      ...linkedCharacterContext,
      action: "append",
      targetId: existing.id,
      appendCount,
      reason: `Existing synced chat is missing ${appendCount} newer ${appendCount === 1 ? "message" : "messages"}`,
    };
  }

  return {
    ...base,
    ...linkedCharacterContext,
    action: "conflict-copy",
    targetId: existing.id,
    reason: "Existing synced chat history differs; will import a conflict copy",
  };
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

function writePreviewCharacterIdMap(
  characterIdMap: Record<string, string>,
  item: PreviewCharacterItem,
  localId: string,
) {
  characterIdMap[item.id] = localId;
  if (item.syncId) characterIdMap[item.syncId] = localId;
}

function rememberManifestCharacter(
  item: PreviewCharacterItem,
  characterIds: Set<string>,
  characterNames: Map<string, string>,
) {
  characterIds.add(item.id);
  characterNames.set(item.id, item.name);
  if (item.syncId) {
    characterIds.add(item.syncId);
    characterNames.set(item.syncId, item.name);
  }
}

function readLinkedCharacterNames(value: unknown, characterNames: Map<string, string>): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value
    .map((id) => (typeof id === "string" ? (characterNames.get(id) ?? id) : null))
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  return names.length > 0 ? [...new Set(names)] : undefined;
}

function buildPreviewNativeChat(
  item: PreviewChatItem & { format: "native" },
): NativeLanChatExport {
  return {
    type: "marinara_lan_chat",
    version: 1,
    chat: {
      id: item.syncId ?? item.id,
      syncId: item.syncId ?? item.id,
      name: item.name,
      mode: "roleplay",
      characterIds: Array.isArray(item.characterIds) ? item.characterIds : [],
    },
    messages: [],
  };
}

function sanitizePreviewManifestItems(manifest: unknown): PreviewManifestItem[] {
  if (!isRecord(manifest) || !Array.isArray(manifest.items)) return [];
  return manifest.items
    .map(sanitizePreviewManifestItem)
    .filter((item): item is PreviewManifestItem => item !== null);
}

function sanitizePreviewManifestItem(value: unknown): PreviewManifestItem | null {
  if (!isRecord(value)) return null;
  if (value.type === "character" && value.format === "native") {
    return {
      type: "character",
      id: readNonEmptyString(value.id) ?? "unknown-character",
      syncId: readNonEmptyString(value.syncId),
      name: readNonEmptyString(value.name) ?? "Untitled character",
      format: "native",
      fingerprint: readNonEmptyString(value.fingerprint),
    };
  }

  if (value.type === "chat" && (value.format === "native" || value.format === "jsonl")) {
    const id = readNonEmptyString(value.id) ?? "unknown-chat";
    const name = readNonEmptyString(value.name) ?? "Untitled chat";
    const messageCount = readNonNegativeInteger(value.messageCount) ?? 0;
    if (value.format === "jsonl") {
      return {
        type: "chat",
        id,
        name,
        format: "jsonl",
        messageCount,
      };
    }
    return {
      type: "chat" as const,
      id,
      name,
      format: "native",
      messageCount,
      syncId: readNonEmptyString(value.syncId),
      characterIds: readStringArray(value.characterIds),
      messageFingerprints: readStringArray(value.messageFingerprints),
    };
  }

  return null;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => readNonEmptyString(entry) !== undefined);
  return strings.length === value.length ? strings : undefined;
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
