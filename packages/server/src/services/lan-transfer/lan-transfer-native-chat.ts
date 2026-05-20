import type { ChatMode, MessageRole } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { parseTrustedTimestamp } from "../import/import-timestamps.js";
import { createCharactersStorage } from "../storage/characters.storage.js";
import { createChatsStorage } from "../storage/chats.storage.js";
import { fingerprintLanTransferMessage, readLanTransferSyncId } from "./lan-transfer-fingerprints.js";

export interface NativeLanChatExport {
  type: "marinara_lan_chat";
  version: 1;
  chat: {
    id: string;
    syncId: string;
    name: string;
    mode: ChatMode;
    characterIds: string[];
    personaId?: string | null;
    promptPresetId?: string | null;
    connectionId?: string | null;
    metadata?: unknown;
    createdAt?: string | null;
    updatedAt?: string | null;
  };
  messages: Array<{
    role: "system" | "user" | "assistant" | "narrator";
    characterId: string | null;
    content: string;
    fingerprint: string;
    createdAt?: string | null;
  }>;
}

type NativeLanChatImportResult = { success: true; id: string } | { success: false; error: string };

const CHAT_MODES: readonly ChatMode[] = ["conversation", "roleplay", "visual_novel", "game"];
const MESSAGE_ROLES: readonly MessageRole[] = ["system", "user", "assistant", "narrator"];

export async function buildNativeLanChatExport(db: DB, chatId: string): Promise<NativeLanChatExport> {
  const chats = createChatsStorage(db);
  const characters = createCharactersStorage(db);
  const chat = await chats.getById(chatId);
  if (!chat) throw new Error(`Chat not found: ${chatId}`);

  const messages = await chats.listMessages(chatId);
  const localCharacterIds = parseCharacterIds(chat.characterIds);
  const characterIdMap = await buildCharacterSyncIdMap(characters, [
    ...localCharacterIds,
    ...messages.map((message) => message.characterId).filter((id): id is string => typeof id === "string"),
  ]);
  const syncChatId = readChatSyncId(parseMetadata(chat.metadata)) ?? chat.id;

  return {
    type: "marinara_lan_chat",
    version: 1,
    chat: {
      id: chat.id,
      syncId: syncChatId,
      name: chat.name,
      mode: chat.mode,
      characterIds: localCharacterIds.map((id) => characterIdMap.get(id) ?? id),
      personaId: chat.personaId,
      promptPresetId: chat.promptPresetId,
      connectionId: chat.connectionId,
      metadata: parseMetadata(chat.metadata),
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
    },
    messages: messages.map((message) => {
      const syncCharacterId =
        message.characterId === null ? null : (characterIdMap.get(message.characterId) ?? message.characterId);
      const exportedMessage = {
        role: message.role,
        characterId: syncCharacterId,
        content: message.content,
        createdAt: message.createdAt,
      };
      return {
        ...exportedMessage,
        fingerprint: fingerprintLanTransferMessage(exportedMessage),
      };
    }),
  };
}

export async function importNativeLanChat(
  db: DB,
  exported: unknown,
  characterIdMap: Record<string, string>,
): Promise<NativeLanChatImportResult> {
  const validation = validateNativeLanChatExport(exported);
  if (!validation.ok) return { success: false, error: validation.error };

  try {
    const nativeChat = validation.chat;
    const chats = createChatsStorage(db);
    const characterIds = nativeChat.chat.characterIds
      .map((id) => characterIdMap[id])
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const chat = await chats.create({
      name: nativeChat.chat.name,
      mode: nativeChat.chat.mode,
      characterIds,
      groupId: null,
      personaId: null,
      promptPresetId: null,
      connectionId: null,
    });
    if (!chat) return { success: false, error: "Failed to create chat" };

    await chats.createMessagesBatch(
      chat.id,
      buildImportedMessages(nativeChat.messages, characterIdMap).map((message) => ({
        role: message.role,
        characterId: message.characterId,
        content: message.content,
        createdAt: message.createdAt,
      })),
    );

    return { success: true, id: chat.id };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Import failed" };
  }
}

export function collectNativeLanChatCharacterIds(exported: NativeLanChatExport): string[] {
  const ids = new Set<string>();
  for (const id of exported.chat.characterIds) {
    ids.add(id);
  }
  for (const message of exported.messages) {
    if (message.characterId) ids.add(message.characterId);
  }
  return [...ids];
}

export function validateNativeLanChatExport(
  value: unknown,
): { ok: true; chat: NativeLanChatExport } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "Native chat export must be an object" };
  if (value.type !== "marinara_lan_chat") return { ok: false, error: "Unsupported native chat export type" };
  if (value.version !== 1) return { ok: false, error: "Unsupported native chat export version" };
  if (!isRecord(value.chat)) return { ok: false, error: "Native chat export chat must be an object" };
  if (!Array.isArray(value.messages)) return { ok: false, error: "Native chat export messages must be an array" };

  const chat = value.chat;
  if (
    !isNonEmptyString(chat.id) ||
    !isOptionalNonEmptyString(chat.syncId) ||
    typeof chat.name !== "string" ||
    !chat.name.trim() ||
    !isChatMode(chat.mode) ||
    !isArrayOfNonEmptyStrings(chat.characterIds)
  ) {
    return { ok: false, error: "Native chat export chat must include name, mode, and characterIds" };
  }
  if (!isValidMetadata(chat.metadata)) {
    return { ok: false, error: "Native chat export chat metadata must be an object" };
  }
  if (
    !isOptionalNonEmptyString(chat.personaId) ||
    !isOptionalNonEmptyString(chat.promptPresetId) ||
    !isOptionalNonEmptyString(chat.connectionId)
  ) {
    return { ok: false, error: "Native chat export optional IDs must be non-empty strings" };
  }
  if (!isOptionalCanonicalTimestamp(chat.createdAt) || !isOptionalCanonicalTimestamp(chat.updatedAt)) {
    return { ok: false, error: "Native chat export chat timestamps must be valid strings" };
  }

  for (const message of value.messages) {
    if (!isRecord(message)) return { ok: false, error: "Native chat export message must be an object" };
    if (
      !isMessageRole(message.role) ||
      (message.characterId !== null &&
        (typeof message.characterId !== "string" || message.characterId.trim().length === 0)) ||
      typeof message.content !== "string" ||
      !isOptionalNonEmptyString(message.fingerprint)
    ) {
      return { ok: false, error: "Native chat export message must include role, characterId, and content" };
    }
    if (!isOptionalCanonicalTimestamp(message.createdAt)) {
      return { ok: false, error: "Native chat export message createdAt must be a valid string" };
    }
  }

  return { ok: true, chat: value as unknown as NativeLanChatExport };
}

function parseCharacterIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((id): id is string => typeof id === "string" && id.length > 0);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
  } catch {
    return [];
  }
}

function parseMetadata(value: unknown): unknown {
  if (typeof value !== "string") return isRecord(value) ? value : {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function buildCharacterSyncIdMap(
  characters: ReturnType<typeof createCharactersStorage>,
  characterIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const id of new Set(characterIds)) {
    const character = await characters.getById(id);
    if (!character) {
      map.set(id, id);
      continue;
    }
    const data = parseCharacterData(character.data);
    map.set(id, readLanTransferSyncId({ data: { data } }) ?? id);
  }
  return map;
}

function parseCharacterData(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function readChatSyncId(metadata: unknown): string | null {
  if (!isRecord(metadata)) return null;
  const lanTransfer = metadata.lanTransfer;
  if (!isRecord(lanTransfer)) return null;
  const syncId = lanTransfer.syncId;
  return typeof syncId === "string" && syncId.trim().length > 0 ? syncId : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isChatMode(value: unknown): value is ChatMode {
  return typeof value === "string" && CHAT_MODES.includes(value as ChatMode);
}

function isMessageRole(value: unknown): value is MessageRole {
  return typeof value === "string" && MESSAGE_ROLES.includes(value as MessageRole);
}

function isArrayOfNonEmptyStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isValidMetadata(value: unknown): boolean {
  return value === undefined || value === null || isRecord(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalNonEmptyString(value: unknown): boolean {
  return value === undefined || value === null || isNonEmptyString(value);
}

function isOptionalCanonicalTimestamp(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function buildImportedMessages(
  messages: NativeLanChatExport["messages"],
  characterIdMap: Record<string, string>,
): Array<Omit<NativeLanChatExport["messages"][number], "fingerprint">> {
  let previousTimestampMs: number | null = null;
  const fallbackBaseMs = Date.now();

  return messages.map((message, index) => {
    const trustedTimestamp = parseTrustedTimestamp(message.createdAt);
    const trustedTimestampMs = trustedTimestamp ? Date.parse(trustedTimestamp) : null;
    const nextTimestampMs =
      trustedTimestampMs !== null
        ? previousTimestampMs === null || trustedTimestampMs > previousTimestampMs
          ? trustedTimestampMs
          : previousTimestampMs + 1
        : previousTimestampMs === null
          ? fallbackBaseMs + index
          : previousTimestampMs + 1;
    previousTimestampMs = nextTimestampMs;

    return {
      role: message.role,
      characterId: message.characterId === null ? null : (characterIdMap[message.characterId] ?? null),
      content: message.content,
      createdAt: new Date(nextTimestampMs).toISOString(),
    };
  });
}
