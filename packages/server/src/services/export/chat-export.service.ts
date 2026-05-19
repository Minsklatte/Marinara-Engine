import type { FastifyInstance } from "fastify";
import { inArray } from "drizzle-orm";
import { characters } from "../../db/schema/index.js";

export type ChatExportFormat = "jsonl" | "text";

export interface ChatExportRow {
  id: string;
  name: string;
  mode?: string | null;
  groupId?: string | null;
  folderId?: string | null;
  characterIds?: unknown;
  metadata?: unknown;
  createdAt: string;
  updatedAt?: string | null;
}

interface ChatExportMessage {
  role: string;
  characterId?: string | null;
  content: string;
  createdAt?: string | null;
}

interface ChatExportStorage {
  listMessages(chatId: string): Promise<ChatExportMessage[]>;
}

export interface SerializedChatTranscript {
  content: string;
  extension: "jsonl" | "txt";
  contentType: "application/jsonl" | "text/plain; charset=utf-8";
  messageCount: number;
  branchName: string;
}

export const normalizeChatExportFormat = (value: unknown): ChatExportFormat =>
  typeof value === "string" && value.toLowerCase() === "text" ? "text" : "jsonl";

const parseExportCharacterIds = (raw: unknown): string[] => {
  if (Array.isArray(raw)) return raw.filter((id): id is string => typeof id === "string");
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
};

const parseExportMetadata = (raw: unknown): Record<string, unknown> => {
  if (!raw) return {};
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

export const safeChatExportNamePart = (value: unknown, fallback: string): string => {
  const source = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return (
    source
      .normalize("NFKD")
      .replace(/[^\w .-]+/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || fallback
  );
};

export async function serializeChatTranscript(
  app: FastifyInstance,
  storage: ChatExportStorage,
  chat: ChatExportRow,
  format: ChatExportFormat,
): Promise<SerializedChatTranscript> {
  const msgs = await storage.listMessages(chat.id);
  const charIds = parseExportCharacterIds(chat.characterIds);
  const metadata = parseExportMetadata(chat.metadata);
  const branchName = typeof metadata.branchName === "string" ? metadata.branchName : "";

  const charNameMap = new Map<string, string>();
  if (charIds.length > 0) {
    try {
      const rows = await app.db.select().from(characters).where(inArray(characters.id, charIds));
      for (const row of rows) {
        const data = JSON.parse(row.data);
        if (data?.name) charNameMap.set(row.id, data.name);
      }
    } catch {
      // fall through - use chat name as fallback
    }
  }
  const primaryCharName = (charIds[0] && charNameMap.get(charIds[0])) ?? chat.name;

  const getDisplayName = (msg: { role: string; characterId?: string | null }) => {
    if (msg.role === "user") return "User";
    if (msg.role === "system") return "System";
    if (msg.role === "narrator") return "Narrator";
    if (msg.characterId && charNameMap.has(msg.characterId)) return charNameMap.get(msg.characterId)!;
    return primaryCharName;
  };

  if (format === "text") {
    const header = `Chat: ${chat.name}\nDate: ${chat.createdAt}\n${"─".repeat(50)}\n`;
    const body = msgs
      .map((msg) => {
        const name = getDisplayName(msg);
        const ts = msg.createdAt ? new Date(msg.createdAt).toLocaleString() : "";
        return `[${name}]${ts ? ` (${ts})` : ""}\n${msg.content}`;
      })
      .join("\n\n");

    return {
      content: header + body,
      extension: "txt",
      contentType: "text/plain; charset=utf-8",
      messageCount: msgs.length,
      branchName,
    };
  }

  const lines: string[] = [
    JSON.stringify({
      user_name: "User",
      character_name: primaryCharName,
      create_date: chat.createdAt,
      chat_metadata: {},
    }),
  ];

  for (const msg of msgs) {
    lines.push(
      JSON.stringify({
        name: getDisplayName(msg),
        is_user: msg.role === "user",
        is_system: msg.role === "system" || msg.role === "narrator",
        mes: msg.content,
        send_date: msg.createdAt,
      }),
    );
  }

  return {
    content: lines.join("\n"),
    extension: "jsonl",
    contentType: "application/jsonl",
    messageCount: msgs.length,
    branchName,
  };
}
