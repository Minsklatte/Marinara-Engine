import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileNativeDB } from "../src/db/file-backed-store.js";
import { buildLanTransferPackage, importLanTransferPackage } from "../src/services/lan-transfer/lan-transfer-package.js";
import { createCharactersStorage } from "../src/services/storage/characters.storage.js";

async function withDb<T>(fn: (db: Awaited<ReturnType<typeof createFileNativeDB>>) => Promise<T>) {
  const root = mkdtempSync(join(tmpdir(), "marinara-lan-transfer-smart-import-"));
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

test("omitted import mode reuses an exact matching character instead of duplicating it", async () =>
  withDb(async (db) => {
    const characters = createCharactersStorage(db);
    const existing = await characters.create({ name: "Alicia", description: "same", first_mes: "Hi" } as any);
    assert.ok(existing?.id);
    const source = await characters.create({ name: "Alicia", description: "same", first_mes: "Hi" } as any);
    assert.ok(source?.id);

    const pkg = await buildLanTransferPackage(
      { db } as any,
      [{ type: "character", id: source.id }],
      "2999-01-01T00:00:00.000Z",
    );
    await characters.remove(source.id);

    const summary = await importLanTransferPackage({ db } as any, pkg);

    assert.equal(summary.imported.characters, 0);
    assert.equal(summary.reused?.characters, 1);
    assert.equal(summary.appended, undefined);
    assert.equal(summary.copied, undefined);
    assert.equal(summary.characterIdMap?.[pkg.items[0]!.id], existing.id);
    const allCharacters = await characters.list();
    assert.equal(allCharacters.length, 1);
  }));

test("smart import reuses an exact matching character instead of duplicating it", async () =>
  withDb(async (db) => {
    const characters = createCharactersStorage(db);
    const existing = await characters.create({ name: "Alicia", description: "same", first_mes: "Hi" } as any);
    assert.ok(existing?.id);
    const source = await characters.create({ name: "Alicia", description: "same", first_mes: "Hi" } as any);
    assert.ok(source?.id);

    const pkg = await buildLanTransferPackage(
      { db } as any,
      [{ type: "character", id: source.id }],
      "2999-01-01T00:00:00.000Z",
    );
    await characters.remove(source.id);

    const summary = await importLanTransferPackage({ db } as any, pkg, { importMode: "smart" });

    assert.equal(summary.imported.characters, 0);
    assert.equal(summary.reused?.characters, 1);
    assert.equal(summary.appended, undefined);
    assert.equal(summary.copied, undefined);
    assert.equal(summary.characterIdMap?.[pkg.items[0]!.id], existing.id);
    const allCharacters = await characters.list();
    assert.equal(allCharacters.length, 1);
  }));

test("copy import still duplicates an exact matching character", async () =>
  withDb(async (db) => {
    const characters = createCharactersStorage(db);
    const existing = await characters.create({ name: "Alicia", description: "same", first_mes: "Hi" } as any);
    const source = await characters.create({ name: "Alicia", description: "same", first_mes: "Hi" } as any);
    assert.ok(existing?.id);
    assert.ok(source?.id);

    const pkg = await buildLanTransferPackage(
      { db } as any,
      [{ type: "character", id: source.id }],
      "2999-01-01T00:00:00.000Z",
    );
    await characters.remove(source.id);

    const summary = await importLanTransferPackage({ db } as any, pkg, { importMode: "copy" });

    assert.equal(summary.imported.characters, 1);
    assert.equal(summary.reused?.characters ?? 0, 0);
    assert.equal(summary.appended, undefined);
    assert.equal(summary.copied?.characters, 1);
    const allCharacters = await characters.list();
    assert.equal(allCharacters.length, 2);
  }));

test("zero summary omits empty smart import counters", async () =>
  withDb(async (db) => {
    const summary = await importLanTransferPackage(
      { db } as any,
      {
        version: 1,
        manifest: {
          version: 1,
          createdAt: "2026-05-20T00:00:00.000Z",
          expiresAt: "2999-01-01T00:00:00.000Z",
          sourceApp: "Marinara Engine",
          sourceVersion: "1.6.0",
          items: [],
          totalBytes: 0,
        },
        items: [],
      },
    );

    assert.deepEqual(summary, {
      imported: { chats: 0, characters: 0 },
      skipped: [],
    });
  }));
