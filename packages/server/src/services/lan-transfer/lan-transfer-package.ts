import type { FastifyInstance } from "fastify";
import {
  APP_VERSION,
  type LanTransferImportSummary,
  type LanTransferItemRequest,
  type LanTransferManifest,
  type LanTransferPackage,
} from "@marinara-engine/shared";
import { serializeChatTranscript } from "../export/chat-export.service.js";
import { buildNativeCharacterEnvelope } from "../export/character-export.service.js";
import { importMarinara } from "../import/marinara.importer.js";
import { importSTChat } from "../import/st-chat.importer.js";
import { createCharacterGalleryStorage } from "../storage/character-gallery.storage.js";
import { createCharactersStorage } from "../storage/characters.storage.js";
import { createChatsStorage } from "../storage/chats.storage.js";

export const LAN_TRANSFER_PACKAGE_MAX_BYTES = 25 * 1024 * 1024;

type ValidationResult =
  | { ok: true; package: LanTransferPackage }
  | { ok: false; error: string };

interface ValidationOptions {
  maxBytes?: number;
}

export async function buildLanTransferPackage(
  app: FastifyInstance,
  items: LanTransferItemRequest[],
  expiresAt: string,
): Promise<LanTransferPackage> {
  const chats = createChatsStorage(app.db);
  const characters = createCharactersStorage(app.db);
  const gallery = createCharacterGalleryStorage(app.db);
  const packageItems: LanTransferPackage["items"] = [];
  const manifestItems: LanTransferManifest["items"] = [];
  let totalBytes = 0;

  for (const item of items) {
    if (item.type === "chat") {
      const chat = await chats.getById(item.id);
      if (!chat) throw new Error(`Chat not found: ${item.id}`);

      const serialized = await serializeChatTranscript(app, chats, chat, "jsonl");
      const bytes = Buffer.byteLength(serialized.content, "utf8");
      totalBytes += bytes;
      if (totalBytes > LAN_TRANSFER_PACKAGE_MAX_BYTES) {
        throw new Error("LAN transfer package exceeds maximum size");
      }

      packageItems.push({
        type: "chat",
        id: item.id,
        name: chat.name,
        format: "jsonl",
        content: serialized.content,
      });
      manifestItems.push({
        type: "chat",
        id: item.id,
        name: chat.name,
        format: "jsonl",
        messageCount: serialized.messageCount,
        bytes,
      });
      continue;
    }

    if (item.type === "character") {
      const character = await characters.getById(item.id);
      if (!character) throw new Error(`Character not found: ${item.id}`);

      const data = parseCharacterData(character.data, item.id);
      const name = readName(data, item.id);
      const envelope = await buildNativeCharacterEnvelope(character, data, gallery);
      const bytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
      totalBytes += bytes;
      if (totalBytes > LAN_TRANSFER_PACKAGE_MAX_BYTES) {
        throw new Error("LAN transfer package exceeds maximum size");
      }

      packageItems.push({
        type: "character",
        id: item.id,
        name,
        format: "native",
        envelope,
      });
      manifestItems.push({
        type: "character",
        id: item.id,
        name,
        format: "native",
        bytes,
      });
      continue;
    }

    throw new Error(`Unsupported LAN transfer item type: ${(item as { type?: unknown }).type ?? "unknown"}`);
  }

  return {
    version: 1,
    manifest: {
      version: 1,
      createdAt: new Date().toISOString(),
      expiresAt,
      sourceApp: "Marinara Engine",
      sourceVersion: APP_VERSION,
      items: manifestItems,
      totalBytes,
    },
    items: packageItems,
  };
}

export function validateLanTransferPackage(value: unknown, options: ValidationOptions = {}): ValidationResult {
  const maxBytes = options.maxBytes ?? LAN_TRANSFER_PACKAGE_MAX_BYTES;
  if (!isRecord(value)) return { ok: false, error: "Package must be an object" };
  if (value.version !== 1) return { ok: false, error: "Unsupported package version" };
  if (!isRecord(value.manifest)) return { ok: false, error: "Package manifest must be an object" };
  if (!Array.isArray(value.items)) return { ok: false, error: "Package items must be an array" };

  const manifest = value.manifest;
  if (manifest.version !== 1) return { ok: false, error: "Unsupported manifest version" };
  if (manifest.sourceApp !== "Marinara Engine") return { ok: false, error: "Unsupported source app" };
  if (typeof manifest.createdAt !== "string") return { ok: false, error: "Manifest createdAt must be a string" };
  if (typeof manifest.expiresAt !== "string") return { ok: false, error: "Manifest expiresAt must be a string" };
  if (typeof manifest.sourceVersion !== "string") return { ok: false, error: "Manifest sourceVersion must be a string" };
  if (!Array.isArray(manifest.items)) return { ok: false, error: "Manifest items must be an array" };
  if (typeof manifest.totalBytes !== "number" || !Number.isFinite(manifest.totalBytes) || manifest.totalBytes < 0) {
    return { ok: false, error: "Manifest totalBytes must be finite" };
  }
  if (manifest.totalBytes > maxBytes) return { ok: false, error: "Package exceeds maximum size" };

  for (const item of manifest.items) {
    const result = validateManifestItem(item);
    if (!result.ok) return result;
  }

  for (const item of value.items) {
    const result = validatePackageItem(item);
    if (!result.ok) return result;
  }

  return { ok: true, package: value as unknown as LanTransferPackage };
}

export async function importLanTransferPackage(
  app: FastifyInstance,
  pkg: LanTransferPackage,
): Promise<LanTransferImportSummary> {
  const summary: LanTransferImportSummary = {
    imported: {
      chats: 0,
      characters: 0,
    },
    skipped: [],
  };

  for (const item of pkg.items) {
    try {
      if (item.type === "chat") {
        const result = await importSTChat(item.content, app.db, { chatName: item.name });
        if ("success" in result && result.success) {
          summary.imported.chats += 1;
        } else {
          summary.skipped.push({ type: item.type, name: item.name, reason: readImportError(result) });
        }
        continue;
      }

      if (item.type === "character") {
        const result = await importMarinara(item.envelope as any, app.db);
        if (result.success) {
          summary.imported.characters += 1;
        } else {
          summary.skipped.push({ type: item.type, name: item.name, reason: result.error ?? "Import failed" });
        }
        continue;
      }

      summary.skipped.push({ type: (item as { type?: string }).type ?? "unknown", reason: "Unsupported item type" });
    } catch (err) {
      summary.skipped.push({
        type: (item as { type?: string }).type ?? "unknown",
        name: isRecord(item) && typeof item.name === "string" ? item.name : undefined,
        reason: err instanceof Error ? err.message : "Import failed",
      });
    }
  }

  return summary;
}

function parseCharacterData(value: unknown, id: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new Error(`Invalid character data for ${id}`, { cause: err });
  }
}

function readName(data: unknown, fallback: string): string {
  if (isRecord(data) && typeof data.name === "string" && data.name.trim()) {
    return data.name;
  }
  return fallback;
}

function validateManifestItem(item: unknown): { ok: true } | { ok: false; error: string } {
  if (!isRecord(item)) return { ok: false, error: "Manifest item must be an object" };
  if (typeof item.id !== "string") return { ok: false, error: "Manifest item id must be a string" };
  if (typeof item.name !== "string") return { ok: false, error: "Manifest item name must be a string" };
  if (typeof item.bytes !== "number" || !Number.isFinite(item.bytes) || item.bytes < 0) {
    return { ok: false, error: "Manifest item bytes must be finite" };
  }

  if (item.type === "chat") {
    if (item.format !== "jsonl") return { ok: false, error: "Chat manifest item must use jsonl format" };
    if (typeof item.messageCount !== "number" || !Number.isFinite(item.messageCount) || item.messageCount < 0) {
      return { ok: false, error: "Chat manifest item messageCount must be finite" };
    }
    return { ok: true };
  }

  if (item.type === "character") {
    if (item.format !== "native") return { ok: false, error: "Character manifest item must use native format" };
    return { ok: true };
  }

  return { ok: false, error: "Unsupported manifest item type" };
}

function validatePackageItem(item: unknown): { ok: true } | { ok: false; error: string } {
  if (!isRecord(item)) return { ok: false, error: "Package item must be an object" };
  if (typeof item.id !== "string") return { ok: false, error: "Package item id must be a string" };
  if (typeof item.name !== "string") return { ok: false, error: "Package item name must be a string" };

  if (item.type === "chat") {
    if (item.format !== "jsonl") return { ok: false, error: "Chat package item must use jsonl format" };
    if (typeof item.content !== "string") return { ok: false, error: "Chat package item content must be a string" };
    return { ok: true };
  }

  if (item.type === "character") {
    if (item.format !== "native") return { ok: false, error: "Character package item must use native format" };
    if (!isRecord(item.envelope)) return { ok: false, error: "Character package item envelope must be an object" };
    return { ok: true };
  }

  return { ok: false, error: "Unsupported package item type" };
}

function readImportError(value: unknown): string {
  return isRecord(value) && typeof value.error === "string" ? value.error : "Import failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
