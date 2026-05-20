import type { FastifyInstance } from "fastify";
import type { ExportEnvelope, LanTransferImportSummary, LanTransferPackage } from "@marinara-engine/shared";
import { buildNativeCharacterEnvelope } from "../export/character-export.service.js";
import { importMarinara } from "../import/marinara.importer.js";
import { createCharacterGalleryStorage } from "../storage/character-gallery.storage.js";
import { createCharactersStorage } from "../storage/characters.storage.js";
import {
  fingerprintNativeCharacterEnvelope,
  withLanTransferCharacterSyncMetadata,
} from "./lan-transfer-fingerprints.js";

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
