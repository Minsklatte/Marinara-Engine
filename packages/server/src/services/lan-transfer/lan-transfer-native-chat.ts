import type { ChatMode, MessageRole } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { createChatsStorage } from "../storage/chats.storage.js";

export interface NativeLanChatExport {
  type: "marinara_lan_chat";
  version: 1;
  chat: {
    id: string;
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
    createdAt?: string | null;
  }>;
}

type NativeLanChatImportResult = { success: true; id: string } | { success: false; error: string };

const CHAT_MODES: readonly ChatMode[] = ["conversation", "roleplay", "visual_novel", "game"];
const MESSAGE_ROLES: readonly MessageRole[] = ["system", "user", "assistant", "narrator"];

export async function buildNativeLanChatExport(db: DB, chatId: string): Promise<NativeLanChatExport> {
  const chats = createChatsStorage(db);
  const chat = await chats.getById(chatId);
  if (!chat) throw new Error(`Chat not found: ${chatId}`);

  const messages = await chats.listMessages(chatId);

  return {
    type: "marinara_lan_chat",
    version: 1,
    chat: {
      id: chat.id,
      name: chat.name,
      mode: chat.mode,
      characterIds: parseCharacterIds(chat.characterIds),
      personaId: chat.personaId,
      promptPresetId: chat.promptPresetId,
      connectionId: chat.connectionId,
      metadata: parseMetadata(chat.metadata),
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
    },
    messages: messages.map((message) => ({
      role: message.role,
      characterId: message.characterId,
      content: message.content,
      createdAt: message.createdAt,
    })),
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
    const nativeChat = validation.exported;
    const chats = createChatsStorage(db);
    const characterIds = nativeChat.chat.characterIds.map((id) => characterIdMap[id] ?? id);
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
      nativeChat.messages.map((message) => ({
        role: message.role,
        characterId: message.characterId === null ? null : (characterIdMap[message.characterId] ?? message.characterId),
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

function validateNativeLanChatExport(
  value: unknown,
): { ok: true; exported: NativeLanChatExport } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "Native chat export must be an object" };
  if (value.type !== "marinara_lan_chat") return { ok: false, error: "Unsupported native chat export type" };
  if (value.version !== 1) return { ok: false, error: "Unsupported native chat export version" };
  if (!isRecord(value.chat)) return { ok: false, error: "Native chat export chat must be an object" };
  if (!Array.isArray(value.messages)) return { ok: false, error: "Native chat export messages must be an array" };

  const chat = value.chat;
  if (
    typeof chat.id !== "string" ||
    typeof chat.name !== "string" ||
    !isChatMode(chat.mode) ||
    !isStringArray(chat.characterIds)
  ) {
    return { ok: false, error: "Native chat export chat must include name, mode, and characterIds" };
  }
  if (!isValidMetadata(chat.metadata)) {
    return { ok: false, error: "Native chat export chat metadata must be an object" };
  }

  for (const message of value.messages) {
    if (!isRecord(message)) return { ok: false, error: "Native chat export message must be an object" };
    if (
      !isMessageRole(message.role) ||
      (message.characterId !== null && typeof message.characterId !== "string") ||
      typeof message.content !== "string"
    ) {
      return { ok: false, error: "Native chat export message must include role, characterId, and content" };
    }
  }

  return { ok: true, exported: value as unknown as NativeLanChatExport };
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
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isValidMetadata(value: unknown): boolean {
  return value === undefined || value === null || isRecord(value);
}
