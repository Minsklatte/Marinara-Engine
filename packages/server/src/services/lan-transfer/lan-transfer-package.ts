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
import {
  buildNativeLanChatExport,
  collectNativeLanChatCharacterIds,
  validateNativeLanChatExport,
} from "./lan-transfer-native-chat.js";
import {
  fingerprintComparableNativeCharacterEnvelope,
  fingerprintLanTransferMessageSequence,
  fingerprintNativeCharacterEnvelope,
  readLanTransferSyncId,
  withLanTransferCharacterSyncMetadata,
} from "./lan-transfer-fingerprints.js";
import {
  createEmptyLanTransferImportSummary,
  importLanTransferChats,
  importLanTransferCharacters,
  omitEmptyLanTransferImportSummaryCounts,
  type LanTransferPackageImportOptions,
} from "./lan-transfer-smart-import.js";
import { createCharacterGalleryStorage } from "../storage/character-gallery.storage.js";
import { createCharactersStorage } from "../storage/characters.storage.js";
import { createChatsStorage } from "../storage/chats.storage.js";

export const LAN_TRANSFER_PACKAGE_MAX_BYTES = 25 * 1024 * 1024;

type ValidationResult =
  | { ok: true; package: LanTransferPackage }
  | { ok: false; error: string };

interface ValidationOptions {
  maxBytes?: number;
  now?: () => number;
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
  const addedLocalCharacterIds = new Set<string>();
  const addedSyncCharacterIds = new Set<string>();
  let totalBytes = 0;

  const addBytes = (bytes: number) => {
    totalBytes += bytes;
    if (totalBytes > LAN_TRANSFER_PACKAGE_MAX_BYTES) {
      throw new Error("LAN transfer package exceeds maximum size");
    }
  };

  const addCharacterItem = async (id: string) => {
    if (addedLocalCharacterIds.has(id)) return;

    const character = await characters.getById(id);
    if (!character) throw new Error(`Character not found: ${id}`);

    const data = parseCharacterData(character.data, id);
    const name = readName(data, id);
    const baseEnvelope = await buildNativeCharacterEnvelope(character, data, gallery);
    const fingerprint = fingerprintNativeCharacterEnvelope(baseEnvelope);
    const comparisonFingerprint = fingerprintComparableNativeCharacterEnvelope(baseEnvelope);
    const syncId = readLanTransferSyncId(baseEnvelope) ?? id;
    if (addedSyncCharacterIds.has(syncId)) {
      addedLocalCharacterIds.add(id);
      return;
    }
    const envelope = withLanTransferCharacterSyncMetadata(baseEnvelope, { syncId, fingerprint });
    const bytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
    addBytes(bytes);

    packageItems.push({
      type: "character",
      id: syncId,
      syncId,
      name,
      format: "native",
      fingerprint,
      comparisonFingerprint,
      envelope,
    });
    manifestItems.push({
      type: "character",
      id: syncId,
      syncId,
      name,
      format: "native",
      fingerprint,
      comparisonFingerprint,
      bytes,
    });
    addedLocalCharacterIds.add(id);
    addedSyncCharacterIds.add(syncId);
  };

  for (const item of items) {
    if (item.type === "chat") {
      const format = item.format ?? "native";

      const chat = await chats.getById(item.id);
      if (!chat) throw new Error(`Chat not found: ${item.id}`);

      if (format === "native") {
        const nativeChat = await buildNativeLanChatExport(app.db, item.id);
        const localCharacterIds = await collectLocalNativeChatCharacterIds(chats, chat);
        for (const characterId of localCharacterIds) {
          await addCharacterItem(characterId);
        }
        const characterIds = collectNativeLanChatCharacterIds(nativeChat);
        const messageFingerprints = nativeChat.messages.map((message) => message.fingerprint);
        const messageFingerprint = fingerprintLanTransferMessageSequence(nativeChat.messages);

        const bytes = Buffer.byteLength(JSON.stringify(nativeChat), "utf8");
        addBytes(bytes);

        packageItems.push({
          type: "chat",
          id: nativeChat.chat.syncId,
          syncId: nativeChat.chat.syncId,
          name: nativeChat.chat.name,
          format: "native",
          chat: nativeChat,
        });
        manifestItems.push({
          type: "chat",
          id: nativeChat.chat.syncId,
          syncId: nativeChat.chat.syncId,
          name: nativeChat.chat.name,
          format: "native",
          messageCount: nativeChat.messages.length,
          characterCount: characterIds.length,
          characterIds,
          messageFingerprint,
          messageFingerprints,
          bytes,
        });
        continue;
      }

      if (format !== "jsonl") {
        throw new Error(`Unsupported LAN transfer chat format: ${format}`);
      }

      const serialized = await serializeChatTranscript(app, chats, chat, "jsonl");
      const bytes = Buffer.byteLength(serialized.content, "utf8");
      addBytes(bytes);

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
      await addCharacterItem(item.id);
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
  const now = options.now?.() ?? Date.now();
  if (!isRecord(value)) return { ok: false, error: "Package must be an object" };
  if (value.version !== 1) return { ok: false, error: "Unsupported package version" };
  if (!isRecord(value.manifest)) return { ok: false, error: "Package manifest must be an object" };
  if (!Array.isArray(value.items)) return { ok: false, error: "Package items must be an array" };

  const manifest = value.manifest;
  if (manifest.version !== 1) return { ok: false, error: "Unsupported manifest version" };
  if (manifest.sourceApp !== "Marinara Engine") return { ok: false, error: "Unsupported source app" };
  if (!isUsableTimestamp(manifest.createdAt)) return { ok: false, error: "Manifest createdAt must be a valid timestamp" };
  if (!isUsableTimestamp(manifest.expiresAt)) return { ok: false, error: "Manifest expiresAt must be a valid timestamp" };
  if (Date.parse(manifest.expiresAt) <= now) return { ok: false, error: "Package has expired" };
  if (typeof manifest.sourceVersion !== "string") return { ok: false, error: "Manifest sourceVersion must be a string" };
  if (!Array.isArray(manifest.items)) return { ok: false, error: "Manifest items must be an array" };
  if (typeof manifest.totalBytes !== "number" || !Number.isFinite(manifest.totalBytes) || manifest.totalBytes < 0) {
    return { ok: false, error: "Manifest totalBytes must be finite" };
  }
  if (manifest.items.length !== value.items.length) return { ok: false, error: "Manifest item count mismatch" };

  for (const item of manifest.items) {
    const result = validateManifestItem(item);
    if (!result.ok) return result;
  }

  for (const item of value.items) {
    const result = validatePackageItem(item);
    if (!result.ok) return result;
  }

  let totalBytes = 0;
  for (let i = 0; i < value.items.length; i++) {
    const manifestItem = manifest.items[i];
    const packageItem = value.items[i];
    const matchResult = validateManifestItemMatchesPackageItem(manifestItem, packageItem);
    if (!matchResult.ok) return matchResult;

    const bytes = getPackageItemBytes(packageItem);
    if (bytes === null) return { ok: false, error: "Package item bytes could not be computed" };
    if ((manifestItem as Record<string, unknown>).bytes !== bytes) {
      return { ok: false, error: "Manifest item bytes mismatch" };
    }
    totalBytes += bytes;
  }

  if (manifest.totalBytes !== totalBytes) return { ok: false, error: "Manifest totalBytes mismatch" };
  if (manifest.totalBytes > maxBytes) return { ok: false, error: "Package exceeds maximum size" };

  return { ok: true, package: value as unknown as LanTransferPackage };
}

export async function importLanTransferPackage(
  app: FastifyInstance,
  pkg: LanTransferPackage,
  options: LanTransferPackageImportOptions = {},
): Promise<LanTransferImportSummary> {
  const summary = createEmptyLanTransferImportSummary();
  const characterIdMap = await importLanTransferCharacters(app, pkg, summary, options);
  await importLanTransferChats(app, pkg, characterIdMap, summary, options);

  return omitEmptyLanTransferImportSummaryCounts(summary);
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

async function collectLocalNativeChatCharacterIds(
  chats: ReturnType<typeof createChatsStorage>,
  chat: Awaited<ReturnType<ReturnType<typeof createChatsStorage>["getById"]>>,
): Promise<string[]> {
  if (!chat) return [];
  const ids = new Set<string>();
  for (const id of parseCharacterIds(chat.characterIds)) {
    ids.add(id);
  }
  for (const message of await chats.listMessages(chat.id)) {
    if (message.characterId) ids.add(message.characterId);
  }
  return [...ids];
}

function validateManifestItem(item: unknown): { ok: true } | { ok: false; error: string } {
  if (!isRecord(item)) return { ok: false, error: "Manifest item must be an object" };
  if (typeof item.id !== "string" || !item.id.trim()) {
    return { ok: false, error: "Manifest item id must be a non-empty string" };
  }
  if (typeof item.name !== "string" || !item.name.trim()) {
    return { ok: false, error: "Manifest item name must be a non-empty string" };
  }
  if (typeof item.bytes !== "number" || !Number.isFinite(item.bytes) || item.bytes < 0) {
    return { ok: false, error: "Manifest item bytes must be finite" };
  }

  if (item.type === "chat") {
    if (item.format !== "jsonl" && item.format !== "native") {
      return { ok: false, error: "Chat manifest item must use jsonl or native format" };
    }
    if (
      typeof item.messageCount !== "number" ||
      !Number.isFinite(item.messageCount) ||
      item.messageCount < 0 ||
      !Number.isInteger(item.messageCount)
    ) {
      return { ok: false, error: "Chat manifest item messageCount must be a non-negative integer" };
    }
    if (
      item.format === "native" &&
      (typeof item.characterCount !== "number" ||
        !Number.isFinite(item.characterCount) ||
        item.characterCount < 0 ||
        !Number.isInteger(item.characterCount))
    ) {
      return { ok: false, error: "Native chat manifest item characterCount must be a non-negative integer" };
    }
    if (item.format === "native") {
      if (item.syncId !== undefined && !isNonEmptyString(item.syncId)) {
        return { ok: false, error: "Native chat manifest item syncId must be a non-empty string" };
      }
      if (item.characterIds !== undefined && !isArrayOfNonEmptyStrings(item.characterIds)) {
        return { ok: false, error: "Native chat manifest item characterIds must be non-empty strings" };
      }
      if (item.messageFingerprint !== undefined && !isNonEmptyString(item.messageFingerprint)) {
        return { ok: false, error: "Native chat manifest item messageFingerprint must be a non-empty string" };
      }
      if (item.messageFingerprints !== undefined && !isArrayOfNonEmptyStrings(item.messageFingerprints)) {
        return { ok: false, error: "Native chat manifest item messageFingerprints must be non-empty strings" };
      }
    }
    return { ok: true };
  }

  if (item.type === "character") {
    if (item.format !== "native") return { ok: false, error: "Character manifest item must use native format" };
    if (item.syncId !== undefined && !isNonEmptyString(item.syncId)) {
      return { ok: false, error: "Character manifest item syncId must be a non-empty string" };
    }
    if (item.fingerprint !== undefined && !isNonEmptyString(item.fingerprint)) {
      return { ok: false, error: "Character manifest item fingerprint must be a non-empty string" };
    }
    if (item.comparisonFingerprint !== undefined && !isNonEmptyString(item.comparisonFingerprint)) {
      return { ok: false, error: "Character manifest item comparisonFingerprint must be a non-empty string" };
    }
    return { ok: true };
  }

  return { ok: false, error: "Unsupported manifest item type" };
}

function validatePackageItem(item: unknown): { ok: true } | { ok: false; error: string } {
  if (!isRecord(item)) return { ok: false, error: "Package item must be an object" };
  if (typeof item.id !== "string" || !item.id.trim()) {
    return { ok: false, error: "Package item id must be a non-empty string" };
  }
  if (typeof item.name !== "string" || !item.name.trim()) {
    return { ok: false, error: "Package item name must be a non-empty string" };
  }

  if (item.type === "chat") {
    if (item.format === "jsonl") {
      if (typeof item.content !== "string") return { ok: false, error: "Chat package item content must be a string" };
      return { ok: true };
    }
    if (item.format === "native") {
      if (item.syncId !== undefined && !isNonEmptyString(item.syncId)) {
        return { ok: false, error: "Native chat package item syncId must be a non-empty string" };
      }
      if (!Object.prototype.hasOwnProperty.call(item, "chat")) {
        return { ok: false, error: "Native chat package item chat must be present" };
      }
      const validation = validateNativeLanChatExport(item.chat);
      if (!validation.ok) return validation;
      const expectedId = item.syncId ? validation.chat.chat.syncId : validation.chat.chat.id;
      if (item.id !== expectedId || (item.syncId !== undefined && item.syncId !== expectedId) || item.name !== validation.chat.chat.name) {
        return { ok: false, error: "Native chat package item must match embedded chat identity" };
      }
      return { ok: true };
    }
    return { ok: false, error: "Chat package item must use jsonl or native format" };
  }

  if (item.type === "character") {
    if (item.format !== "native") return { ok: false, error: "Character package item must use native format" };
    if (item.syncId !== undefined && !isNonEmptyString(item.syncId)) {
      return { ok: false, error: "Character package item syncId must be a non-empty string" };
    }
    if (item.fingerprint !== undefined && !isNonEmptyString(item.fingerprint)) {
      return { ok: false, error: "Character package item fingerprint must be a non-empty string" };
    }
    if (item.comparisonFingerprint !== undefined && !isNonEmptyString(item.comparisonFingerprint)) {
      return { ok: false, error: "Character package item comparisonFingerprint must be a non-empty string" };
    }
    if (!isNativeCharacterEnvelope(item.envelope)) {
      return { ok: false, error: "Character package item envelope must be a native character envelope" };
    }
    if (item.syncId !== undefined && (item.id !== item.syncId || readLanTransferSyncId(item.envelope) !== item.syncId)) {
      return { ok: false, error: "Character package item must match sync identity" };
    }
    if (item.fingerprint !== undefined && fingerprintNativeCharacterEnvelope(item.envelope) !== item.fingerprint) {
      return { ok: false, error: "Character fingerprint mismatch" };
    }
    if (
      item.comparisonFingerprint !== undefined &&
      fingerprintComparableNativeCharacterEnvelope(item.envelope) !== item.comparisonFingerprint
    ) {
      return { ok: false, error: "Character comparison fingerprint mismatch" };
    }
    return { ok: true };
  }

  return { ok: false, error: "Unsupported package item type" };
}

function isUsableTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function getPackageItemBytes(item: unknown): number | null {
  if (!isRecord(item)) return null;
  if (item.type === "chat") {
    if (item.format === "jsonl" && typeof item.content === "string") {
      return Buffer.byteLength(item.content, "utf8");
    }
    if (item.format === "native" && Object.prototype.hasOwnProperty.call(item, "chat")) {
      try {
        const serialized = JSON.stringify(item.chat);
        return typeof serialized === "string" ? Buffer.byteLength(serialized, "utf8") : null;
      } catch {
        return null;
      }
    }
  }
  if (item.type === "character" && isRecord(item.envelope)) {
    try {
      const serialized = JSON.stringify(item.envelope);
      return typeof serialized === "string" ? Buffer.byteLength(serialized, "utf8") : null;
    } catch {
      return null;
    }
  }
  return null;
}

function validateManifestItemMatchesPackageItem(
  manifestItem: unknown,
  packageItem: unknown,
): { ok: true } | { ok: false; error: string } {
  if (!isRecord(manifestItem) || !isRecord(packageItem)) {
    return { ok: false, error: "Package item mismatch" };
  }

  if (
    manifestItem.type !== packageItem.type ||
    manifestItem.id !== packageItem.id ||
    manifestItem.name !== packageItem.name ||
    manifestItem.format !== packageItem.format
  ) {
    return { ok: false, error: "Manifest item does not match package item" };
  }

  if (manifestItem.type === "chat" && manifestItem.format === "native" && packageItem.type === "chat") {
    const validation = validateNativeLanChatExport(packageItem.chat);
    if (!validation.ok) return validation;
    if (manifestItem.messageCount !== validation.chat.messages.length) {
      return { ok: false, error: "Native chat manifest messageCount mismatch" };
    }
    if (manifestItem.characterCount !== collectNativeLanChatCharacterIds(validation.chat).length) {
      return { ok: false, error: "Native chat manifest characterCount mismatch" };
    }
    if (
      (manifestItem.syncId !== undefined && manifestItem.syncId !== validation.chat.chat.syncId) ||
      (packageItem.syncId !== undefined && packageItem.syncId !== validation.chat.chat.syncId) ||
      (manifestItem.syncId !== undefined && packageItem.syncId !== undefined && manifestItem.syncId !== packageItem.syncId)
    ) {
      return { ok: false, error: "Native chat syncId mismatch" };
    }
    const characterIds = collectNativeLanChatCharacterIds(validation.chat);
    if (manifestItem.characterIds !== undefined && !arraysEqual(manifestItem.characterIds, characterIds)) {
      return { ok: false, error: "Native chat manifest characterIds mismatch" };
    }
    const messageFingerprints = validation.chat.messages.map((message) => message.fingerprint);
    if (manifestItem.messageFingerprints !== undefined && !arraysEqual(manifestItem.messageFingerprints, messageFingerprints)) {
      return { ok: false, error: "Native chat manifest messageFingerprints mismatch" };
    }
    if (
      manifestItem.messageFingerprint !== undefined &&
      manifestItem.messageFingerprint !== fingerprintLanTransferMessageSequence(validation.chat.messages)
    ) {
      return { ok: false, error: "Native chat manifest messageFingerprint mismatch" };
    }
  }

  if (manifestItem.type === "character" && manifestItem.format === "native" && packageItem.type === "character") {
    if (
      (manifestItem.syncId !== undefined || packageItem.syncId !== undefined) &&
      manifestItem.syncId !== packageItem.syncId
    ) {
      return { ok: false, error: "Character sync metadata mismatch" };
    }
    if (
      (manifestItem.fingerprint !== undefined || packageItem.fingerprint !== undefined) &&
      manifestItem.fingerprint !== packageItem.fingerprint
    ) {
      return { ok: false, error: "Character sync metadata mismatch" };
    }
    if (
      (manifestItem.comparisonFingerprint !== undefined || packageItem.comparisonFingerprint !== undefined) &&
      manifestItem.comparisonFingerprint !== packageItem.comparisonFingerprint
    ) {
      return { ok: false, error: "Character sync metadata mismatch" };
    }
    if (manifestItem.fingerprint !== undefined && manifestItem.fingerprint !== fingerprintNativeCharacterEnvelope(packageItem.envelope)) {
      return { ok: false, error: "Character fingerprint mismatch" };
    }
    if (
      manifestItem.comparisonFingerprint !== undefined &&
      manifestItem.comparisonFingerprint !== fingerprintComparableNativeCharacterEnvelope(packageItem.envelope)
    ) {
      return { ok: false, error: "Character comparison fingerprint mismatch" };
    }
  }

  return { ok: true };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isArrayOfNonEmptyStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function arraysEqual(left: unknown, right: string[]): boolean {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function isNativeCharacterEnvelope(value: unknown): value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    value.type !== "marinara_character" ||
    value.version !== 1 ||
    !isRecord(value.data)
  ) {
    return false;
  }

  const data = value.data;
  return (
    typeof data.spec === "string" &&
    typeof data.spec_version === "string" &&
    isRecord(data.data)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
