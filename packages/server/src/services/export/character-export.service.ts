import type { ExportEnvelope } from "@marinara-engine/shared";
import { existsSync } from "fs";
import { readFile, readdir } from "fs/promises";
import { extname, join } from "path";
import { DATA_DIR } from "../../utils/data-dir.js";
import { assertInsideDir, isAllowedImageBuffer } from "../../utils/security.js";

export const CHARACTER_GALLERY_ROOT = join(DATA_DIR, "gallery", "characters");

type GalleryStorage = {
  listByCharacterId(id: string): Promise<
    Array<{
      filePath?: string | null;
      prompt?: string | null;
      provider?: string | null;
      model?: string | null;
      width?: number | null;
      height?: number | null;
    }>
  >;
};

type CharacterExportSource = {
  id: string;
  createdAt: string;
  updatedAt: string;
  comment?: string | null;
  avatarPath?: string | null;
};

export async function readImageAsDataUrl(rootDir: string, filename: string): Promise<string | null> {
  if (!filename || filename.includes("..") || filename.includes("/") || filename.includes("\\")) return null;
  let filepath: string;
  try {
    filepath = assertInsideDir(rootDir, join(rootDir, filename));
  } catch {
    return null;
  }
  if (!existsSync(filepath)) return null;
  try {
    const buf = await readFile(filepath);
    const info = isAllowedImageBuffer(buf, extname(filename));
    if (!info) return null;
    return `data:${info.mimeType};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

export async function readAvatarDataUrl(avatarPath: string | null | undefined): Promise<string | null> {
  if (!avatarPath || typeof avatarPath !== "string") return null;
  const filename = avatarPath.split("?")[0]!.split("/").pop();
  if (!filename) return null;
  return readImageAsDataUrl(join(DATA_DIR, "avatars"), filename);
}

export async function readSpritesForId(id: string): Promise<Array<{ filename: string; data: string }>> {
  const dir = join(DATA_DIR, "sprites", id);
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const sprites: Array<{ filename: string; data: string }> = [];
  for (const entry of entries) {
    const dataUrl = await readImageAsDataUrl(dir, entry);
    if (dataUrl) sprites.push({ filename: entry, data: dataUrl });
  }
  return sprites;
}

export async function readGalleryForCharacter(
  characterId: string,
  galleryStorage: GalleryStorage,
): Promise<Array<Record<string, unknown>>> {
  const images = await galleryStorage.listByCharacterId(characterId);
  const result: Array<Record<string, unknown>> = [];
  for (const img of images) {
    const relPath: string = typeof img.filePath === "string" ? img.filePath : "";
    const filename = relPath.split("/").pop() ?? "";
    if (!filename) continue;
    const galleryDir = join(DATA_DIR, "gallery", "characters", characterId);
    const dataUrl = await readImageAsDataUrl(galleryDir, filename);
    if (!dataUrl) continue;
    result.push({
      filename,
      data: dataUrl,
      prompt: img.prompt ?? "",
      provider: img.provider ?? "",
      model: img.model ?? "",
      width: img.width ?? null,
      height: img.height ?? null,
    });
  }
  return result;
}

export async function buildNativeCharacterEnvelope(
  char: CharacterExportSource,
  data: unknown,
  galleryStorage: GalleryStorage,
) {
  const [avatar, sprites, gallery] = await Promise.all([
    readAvatarDataUrl(char.avatarPath),
    readSpritesForId(char.id),
    readGalleryForCharacter(char.id, galleryStorage),
  ]);
  return {
    type: "marinara_character",
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data,
      ...(avatar ? { avatar } : {}),
      ...(sprites.length > 0 ? { sprites } : {}),
      ...(gallery.length > 0 ? { gallery } : {}),
      metadata: {
        createdAt: char.createdAt,
        updatedAt: char.updatedAt,
        comment: char.comment ?? "",
      },
    },
  } satisfies ExportEnvelope;
}

export function buildCompatibleCharacterExport(data: unknown) {
  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data,
  };
}
