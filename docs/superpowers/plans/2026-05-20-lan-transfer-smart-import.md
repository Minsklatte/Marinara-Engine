# LAN Transfer Smart Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LAN transfers default to sync-like smart import instead of duplicate import, while keeping an explicit `Import as copies` escape hatch.

**Architecture:** Extend LAN transfer manifests with stable non-secret identity metadata and fingerprints so the receiver can preview reuse/append/copy decisions before consuming the one-time encrypted download. Smart import reuses exact matching character cards, appends only strict chat extensions, keeps receiver-local chat settings, and imports a copy only when message history diverges. Copy mode preserves the current duplicate behavior.

**Tech Stack:** TypeScript, Fastify, Node `node:test`, Drizzle/file-backed storage, React 19, existing LAN transfer package and modal patterns.

---

## File Structure

- Modify `packages/shared/src/types/lan-transfer.ts`
  - Add `LanTransferImportMode`, import options, preview analysis types, sync IDs, fingerprints, and linked character IDs.
- Create `packages/server/src/services/lan-transfer/lan-transfer-fingerprints.ts`
  - Stable JSON canonicalization and SHA-256 helpers for character and message fingerprints.
- Create `packages/server/src/services/lan-transfer/lan-transfer-smart-import.ts`
  - Receiver-side manifest analysis, exact character reuse, chat match detection, append-only import, copy fallback.
- Modify `packages/server/src/services/lan-transfer/lan-transfer-native-chat.ts`
  - Export native chats using stable LAN sync IDs and message fingerprints; import smart/appended messages while preserving receiver-local settings.
- Modify `packages/server/src/services/lan-transfer/lan-transfer-package.ts`
  - Add manifest fingerprints/linked IDs, call smart import by default, keep copy mode for current behavior.
- Modify `packages/server/src/routes/lan-transfer.routes.ts`
  - Include preview analysis and pass import mode into package import.
- Modify `packages/client/src/components/modals/ReceiveFromDeviceModal.tsx`
  - Show `1 chat linked to Alicia`, action preview (`will reuse`, `will append N messages`, `history differs; will import copy`), and an `Import as copies` toggle defaulting off.
- Test `packages/server/test/lan-transfer-fingerprints.test.ts`
- Test `packages/server/test/lan-transfer-smart-import.test.ts`
- Update existing tests:
  - `packages/server/test/lan-transfer-native-chat.test.ts`
  - `packages/server/test/lan-transfer-package.test.ts`
  - `packages/server/test/lan-transfer-routes.test.ts`

---

### Task 1: Shared Types For Smart Import

**Files:**
- Modify: `packages/shared/src/types/lan-transfer.ts`
- Test: TypeScript compile via server/client lint

- [ ] **Step 1: Extend shared LAN transfer types**

Update `packages/shared/src/types/lan-transfer.ts` so these exported types exist:

```ts
export type LanTransferImportMode = "smart" | "copy";

export type LanTransferPreviewAction =
  | {
      type: "character";
      sourceId: string;
      name: string;
      action: "reuse" | "import-copy";
      targetId?: string;
      reason: string;
    }
  | {
      type: "chat";
      sourceId: string;
      name: string;
      action: "skip" | "append" | "import-copy" | "conflict-copy";
      targetId?: string;
      messageCount: number;
      appendCount?: number;
      linkedCharacterNames?: string[];
      reason: string;
    };

export interface LanTransferPreviewAnalysis {
  mode: "smart";
  actions: LanTransferPreviewAction[];
}
```

Extend native manifest items:

```ts
| {
    type: "chat";
    id: string;
    syncId: string;
    name: string;
    format: "native";
    messageCount: number;
    characterCount: number;
    characterIds: string[];
    messageFingerprint: string;
    messageFingerprints: string[];
    bytes: number;
  }
| {
    type: "character";
    id: string;
    syncId: string;
    name: string;
    format: "native";
    fingerprint: string;
    bytes: number;
  }
```

Extend package items:

```ts
| { type: "chat"; id: string; syncId: string; name: string; format: "native"; chat: unknown }
| { type: "character"; id: string; syncId: string; name: string; format: "native"; fingerprint: string; envelope: unknown }
```

Extend request/response types:

```ts
export interface LanTransferPreviewResponse {
  from: string;
  offerId: string;
  expiresAt: string;
  manifest: LanTransferManifest;
  analysis?: LanTransferPreviewAnalysis;
}

export interface LanTransferImportFromOfferRequest {
  transferPayload: string;
  options?: {
    importMode?: LanTransferImportMode;
    chatImportMode?: "new-chat" | "branch";
    characterImportMode?: "new-copy";
  };
}

export interface LanTransferImportSummary {
  imported: {
    chats: number;
    characters: number;
  };
  reused?: {
    chats: number;
    characters: number;
  };
  appended?: {
    chats: number;
    messages: number;
  };
  copied?: {
    chats: number;
    characters: number;
  };
  skipped: Array<{ type: string; name?: string; reason: string }>;
  characterIdMap?: Record<string, string>;
  chatIdMap?: Record<string, string>;
}
```

- [ ] **Step 2: Run type checks and record expected failures**

Run:

```bash
pnpm --filter @marinara-engine/server lint
pnpm --filter @marinara-engine/client lint
```

Expected: TypeScript errors in LAN transfer package/route/client code because the new manifest fields are not populated or normalized yet.

- [ ] **Step 3: Commit shared type scaffold**

```bash
git add packages/shared/src/types/lan-transfer.ts
git commit -m "feat: add LAN transfer smart import types"
```

---

### Task 2: Stable Fingerprint And Sync ID Helpers

**Files:**
- Create: `packages/server/src/services/lan-transfer/lan-transfer-fingerprints.ts`
- Test: `packages/server/test/lan-transfer-fingerprints.test.ts`

- [ ] **Step 1: Write failing fingerprint tests**

Create `packages/server/test/lan-transfer-fingerprints.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";

test("character fingerprint ignores export timestamp and LAN sync extension", async () => {
  const {
    fingerprintNativeCharacterEnvelope,
    withLanTransferCharacterSyncMetadata,
  } = await import("../src/services/lan-transfer/lan-transfer-fingerprints.js");

  const base = {
    type: "marinara_character",
    version: 1,
    exportedAt: "2026-05-20T00:00:00.000Z",
    data: {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: { name: "Alicia", description: "same", extensions: {} },
      metadata: { comment: "same" },
    },
  };
  const withSync = withLanTransferCharacterSyncMetadata(base, {
    syncId: "source-character",
    fingerprint: "existing",
  });
  const later = { ...withSync, exportedAt: "2026-05-21T00:00:00.000Z" };

  assert.equal(fingerprintNativeCharacterEnvelope(base), fingerprintNativeCharacterEnvelope(later));
});

test("message fingerprints are stable for identical synced messages", async () => {
  const { fingerprintLanTransferMessage } = await import(
    "../src/services/lan-transfer/lan-transfer-fingerprints.js"
  );

  const first = fingerprintLanTransferMessage({
    role: "assistant",
    characterId: "source-character",
    content: "Hello",
    createdAt: "2026-05-20T12:00:00.000Z",
  });
  const second = fingerprintLanTransferMessage({
    role: "assistant",
    characterId: "source-character",
    content: "Hello",
    createdAt: "2026-05-20T12:00:00.000Z",
  });

  assert.equal(first, second);
});

test("message sequence prefix detection distinguishes append and divergence", async () => {
  const { compareFingerprintSequences } = await import(
    "../src/services/lan-transfer/lan-transfer-fingerprints.js"
  );

  assert.deepEqual(compareFingerprintSequences(["a", "b"], ["a", "b", "c"]), {
    kind: "incoming_extends_local",
    appendFrom: 2,
  });
  assert.deepEqual(compareFingerprintSequences(["a", "b"], ["a", "x"]), { kind: "diverged" });
  assert.deepEqual(compareFingerprintSequences(["a", "b"], ["a", "b"]), { kind: "same" });
  assert.deepEqual(compareFingerprintSequences(["a", "b", "c"], ["a", "b"]), { kind: "local_ahead" });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm --filter @marinara-engine/server exec tsx --test test/lan-transfer-fingerprints.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement fingerprint helpers**

Create `packages/server/src/services/lan-transfer/lan-transfer-fingerprints.ts`:

```ts
import { createHash } from "node:crypto";

const LAN_TRANSFER_EXTENSION_KEYS = new Set(["marinara_lan_transfer", "lanTransfer"]);

export interface LanTransferCharacterSyncMetadata {
  syncId: string;
  fingerprint: string;
}

export interface LanTransferMessageFingerprintInput {
  role: string;
  characterId: string | null;
  content: string;
  createdAt?: string | null;
}

export function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function fingerprintNativeCharacterEnvelope(envelope: unknown): string {
  return sha256Base64Url(stableStringify(stripVolatileCharacterEnvelopeFields(envelope)));
}

export function fingerprintLanTransferMessage(message: LanTransferMessageFingerprintInput): string {
  return sha256Base64Url(
    stableStringify({
      role: message.role,
      characterId: message.characterId ?? null,
      content: message.content,
      createdAt: message.createdAt ?? null,
    }),
  );
}

export function fingerprintLanTransferMessageSequence(messages: LanTransferMessageFingerprintInput[]): string {
  return sha256Base64Url(stableStringify(messages.map(fingerprintLanTransferMessage)));
}

export function compareFingerprintSequences(
  local: string[],
  incoming: string[],
):
  | { kind: "same" }
  | { kind: "incoming_extends_local"; appendFrom: number }
  | { kind: "local_ahead" }
  | { kind: "diverged" } {
  const min = Math.min(local.length, incoming.length);
  for (let i = 0; i < min; i += 1) {
    if (local[i] !== incoming[i]) return { kind: "diverged" };
  }
  if (local.length === incoming.length) return { kind: "same" };
  if (local.length < incoming.length) return { kind: "incoming_extends_local", appendFrom: local.length };
  return { kind: "local_ahead" };
}

export function readLanTransferSyncId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const extensions = isRecord(value.extensions) ? value.extensions : null;
  const direct = isRecord(value.marinara_lan_transfer) ? value.marinara_lan_transfer : null;
  const nested = extensions && isRecord(extensions.marinara_lan_transfer) ? extensions.marinara_lan_transfer : null;
  const metadata = direct ?? nested;
  return typeof metadata?.syncId === "string" && metadata.syncId.trim() ? metadata.syncId : null;
}

export function withLanTransferCharacterSyncMetadata<T>(
  envelope: T,
  metadata: LanTransferCharacterSyncMetadata,
): T {
  if (!isRecord(envelope) || !isRecord(envelope.data) || !isRecord(envelope.data.data)) return envelope;
  const cardData = envelope.data.data;
  const extensions = isRecord(cardData.extensions) ? { ...cardData.extensions } : {};
  extensions.marinara_lan_transfer = metadata;
  return {
    ...envelope,
    data: {
      ...envelope.data,
      data: {
        ...cardData,
        extensions,
      },
    },
  };
}

function stripVolatileCharacterEnvelopeFields(value: unknown): unknown {
  const cloned = canonicalize(value);
  if (!isRecord(cloned)) return cloned;
  delete cloned.exportedAt;
  if (isRecord(cloned.data) && isRecord(cloned.data.data)) {
    const cardData = cloned.data.data;
    if (isRecord(cardData.extensions)) {
      for (const key of LAN_TRANSFER_EXTENSION_KEYS) delete cardData.extensions[key];
    }
  }
  return cloned;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (entry !== undefined) out[key] = canonicalize(entry);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
```

- [ ] **Step 4: Run fingerprint tests**

Run:

```bash
pnpm --filter @marinara-engine/server exec tsx --test test/lan-transfer-fingerprints.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit helpers**

```bash
git add packages/server/src/services/lan-transfer/lan-transfer-fingerprints.ts packages/server/test/lan-transfer-fingerprints.test.ts
git commit -m "feat: add LAN transfer fingerprints"
```

---

### Task 3: Export Native Packages With Sync Identity

**Files:**
- Modify: `packages/server/src/services/lan-transfer/lan-transfer-native-chat.ts`
- Modify: `packages/server/src/services/lan-transfer/lan-transfer-package.ts`
- Test: `packages/server/test/lan-transfer-native-chat.test.ts`
- Test: `packages/server/test/lan-transfer-package.test.ts`

- [ ] **Step 1: Add failing export tests**

Append to `packages/server/test/lan-transfer-native-chat.test.ts`:

```ts
test("native LAN chat export uses stable chat and character sync IDs", async () =>
  withDb(async (db) => {
    const { buildNativeLanChatExport } = await import("../src/services/lan-transfer/lan-transfer-native-chat.js");
    const characters = createCharactersStorage(db);
    const chats = createChatsStorage(db);
    const character = await characters.create({
      name: "Alicia",
      description: "",
      first_mes: "Hi",
      extensions: { marinara_lan_transfer: { syncId: "source-character", fingerprint: "card-fingerprint" } },
    } as any);
    assert.ok(character?.id);
    const chat = await chats.create({ name: "Alicia chat", mode: "roleplay", characterIds: [character.id] });
    assert.ok(chat?.id);
    await chats.patchMetadata(chat.id, { lanTransfer: { syncId: "source-chat" } }, { touchUpdatedAt: false });
    await chats.createMessagesBatch(chat.id, [
      { role: "assistant", characterId: character.id, content: "Hello", createdAt: "2026-05-20T12:00:00.000Z" },
    ]);

    const exported = await buildNativeLanChatExport(db, chat.id);

    assert.equal(exported.chat.id, "source-chat");
    assert.equal(exported.chat.syncId, "source-chat");
    assert.deepEqual(exported.chat.characterIds, ["source-character"]);
    assert.equal(exported.messages[0]?.characterId, "source-character");
    assert.equal(typeof exported.messages[0]?.fingerprint, "string");
  }));
```

Append to `packages/server/test/lan-transfer-package.test.ts`:

```ts
test("native LAN package manifest exposes linked character names through stable IDs", async () =>
  withDb(async (db) => {
    const characters = createCharactersStorage(db);
    const chats = createChatsStorage(db);
    const character = await characters.create({ name: "Alicia", description: "", first_mes: "Hi" } as any);
    assert.ok(character?.id);
    const chat = await chats.create({ name: "Alicia thread", mode: "roleplay", characterIds: [character.id] });
    assert.ok(chat?.id);
    await chats.createMessagesBatch(chat.id, [{ role: "assistant", characterId: character.id, content: "Hello" }]);

    const pkg = await buildLanTransferPackage(
      { db } as any,
      [{ type: "chat", id: chat.id, format: "native" }],
      "2999-01-01T00:00:00.000Z",
    );

    const characterItem = pkg.manifest.items.find((item) => item.type === "character");
    const chatItem = pkg.manifest.items.find((item) => item.type === "chat" && item.format === "native") as any;
    assert.ok(characterItem);
    assert.equal(typeof (characterItem as any).fingerprint, "string");
    assert.equal(typeof (characterItem as any).syncId, "string");
    assert.deepEqual(chatItem.characterIds, [(characterItem as any).syncId]);
    assert.equal(typeof chatItem.messageFingerprint, "string");
    assert.deepEqual(chatItem.messageFingerprints.length, 1);
  }));
```

- [ ] **Step 2: Run failing export tests**

Run:

```bash
pnpm --filter @marinara-engine/server exec tsx --test test/lan-transfer-native-chat.test.ts test/lan-transfer-package.test.ts
```

Expected: failures because sync IDs, fingerprints, and `characterIds` are not exported yet.

- [ ] **Step 3: Export stable sync IDs**

In `lan-transfer-native-chat.ts`, extend the exported interfaces:

```ts
chat: {
  id: string;
  syncId: string;
  name: string;
  mode: ChatMode;
  characterIds: string[];
  ...
};
messages: Array<{
  role: "system" | "user" | "assistant" | "narrator";
  characterId: string | null;
  content: string;
  createdAt?: string | null;
  fingerprint: string;
}>;
```

Add helpers near existing parsing helpers:

```ts
function readChatSyncId(chat: { id: string; metadata?: unknown }): string {
  const metadata = parseMetadata(chat.metadata);
  const lan = isRecord(metadata.lanTransfer) ? metadata.lanTransfer : null;
  return typeof lan?.syncId === "string" && lan.syncId.trim() ? lan.syncId : chat.id;
}

async function buildCharacterSyncIdMap(db: DB, localCharacterIds: string[]) {
  const characters = createCharactersStorage(db);
  const entries: Array<[string, string]> = [];
  for (const localId of localCharacterIds) {
    const character = await characters.getById(localId);
    if (!character) continue;
    const data = typeof character.data === "string" ? JSON.parse(character.data) : character.data;
    const syncId = readLanTransferSyncId(data) ?? localId;
    entries.push([localId, syncId]);
  }
  return new Map(entries);
}
```

Import from the fingerprint helper:

```ts
import {
  fingerprintLanTransferMessage,
  readLanTransferSyncId,
} from "./lan-transfer-fingerprints.js";
import { createCharactersStorage } from "../storage/characters.storage.js";
```

In `buildNativeLanChatExport()`, collect all local character IDs from chat and messages, build a local-to-sync map, and emit sync IDs:

```ts
const localMessageCharacterIds = messages
  .map((message) => message.characterId)
  .filter((id): id is string => typeof id === "string" && id.length > 0);
const characterSyncIds = await buildCharacterSyncIdMap(db, [
  ...new Set([...parseCharacterIds(chat.characterIds), ...localMessageCharacterIds]),
]);
const toSyncCharacterId = (id: string | null) => (id ? (characterSyncIds.get(id) ?? id) : null);
const syncId = readChatSyncId(chat);
```

Use `syncId` for `exported.chat.id`, `exported.chat.syncId`, `exported.chat.characterIds`, and each message `characterId`. Set each message `fingerprint` with `fingerprintLanTransferMessage()`.

- [ ] **Step 4: Add manifest sync fields and fingerprints**

In `lan-transfer-package.ts`, import fingerprint helpers:

```ts
import {
  fingerprintNativeCharacterEnvelope,
  fingerprintLanTransferMessageSequence,
  readLanTransferSyncId,
  withLanTransferCharacterSyncMetadata,
} from "./lan-transfer-fingerprints.js";
```

When adding a character item, compute a stable sync ID and fingerprint:

```ts
const data = parseCharacterData(character.data, id);
const envelope = await buildNativeCharacterEnvelope(character, data, gallery);
const fingerprint = fingerprintNativeCharacterEnvelope(envelope);
const syncId = readLanTransferSyncId(data) ?? id;
const envelopeWithSync = withLanTransferCharacterSyncMetadata(envelope, { syncId, fingerprint });
```

Use `syncId` in the package/manifest identity fields but keep the local `id` only as the storage lookup argument:

```ts
packageItems.push({
  type: "character",
  id: syncId,
  syncId,
  name,
  format: "native",
  fingerprint,
  envelope: envelopeWithSync,
});
manifestItems.push({
  type: "character",
  id: syncId,
  syncId,
  name,
  format: "native",
  fingerprint,
  bytes,
});
```

For native chats, use the exported sync IDs:

```ts
const messageFingerprints = nativeChat.messages.map((message) => message.fingerprint);
const messageFingerprint = fingerprintLanTransferMessageSequence(nativeChat.messages);
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
packageItems.push({
  type: "chat",
  id: nativeChat.chat.syncId,
  syncId: nativeChat.chat.syncId,
  name: nativeChat.chat.name,
  format: "native",
  chat: nativeChat,
});
```

- [ ] **Step 5: Update package validation**

In `validateManifestItem()` require native chat `syncId`, `characterIds`, `messageFingerprint`, and `messageFingerprints`; require character `syncId` and `fingerprint`.

Use explicit checks:

```ts
if (item.format === "native") {
  if (typeof item.syncId !== "string" || !item.syncId.trim()) {
    return { ok: false, error: "Native chat manifest syncId must be a non-empty string" };
  }
  if (!Array.isArray(item.characterIds) || !item.characterIds.every(isNonEmptyString)) {
    return { ok: false, error: "Native chat manifest characterIds must be non-empty strings" };
  }
  if (typeof item.messageFingerprint !== "string" || !item.messageFingerprint.trim()) {
    return { ok: false, error: "Native chat manifest messageFingerprint must be a non-empty string" };
  }
  if (!Array.isArray(item.messageFingerprints) || !item.messageFingerprints.every(isNonEmptyString)) {
    return { ok: false, error: "Native chat manifest messageFingerprints must be non-empty strings" };
  }
}
```

In `validatePackageItem()` require wrapper `syncId` for native chat/character items and `fingerprint` for character items.

In `validateManifestItemMatchesPackageItem()` compare `syncId`, `characterIds`, and message fingerprints for native chat items.

- [ ] **Step 6: Run native/package tests**

Run:

```bash
pnpm --filter @marinara-engine/server exec tsx --test test/lan-transfer-native-chat.test.ts test/lan-transfer-package.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: Commit sync identity export**

```bash
git add packages/server/src/services/lan-transfer/lan-transfer-native-chat.ts packages/server/src/services/lan-transfer/lan-transfer-package.ts packages/server/test/lan-transfer-native-chat.test.ts packages/server/test/lan-transfer-package.test.ts
git commit -m "feat: export LAN transfer sync identity"
```

---

### Task 4: Smart Character Reuse

**Files:**
- Create: `packages/server/src/services/lan-transfer/lan-transfer-smart-import.ts`
- Modify: `packages/server/src/services/lan-transfer/lan-transfer-package.ts`
- Test: `packages/server/test/lan-transfer-smart-import.test.ts`

- [ ] **Step 1: Write failing smart character tests**

Create `packages/server/test/lan-transfer-smart-import.test.ts`:

```ts
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
    const allCharacters = await characters.list();
    assert.equal(allCharacters.length, 2);
  }));
```

- [ ] **Step 2: Run failing smart character tests**

Run:

```bash
pnpm --filter @marinara-engine/server exec tsx --test test/lan-transfer-smart-import.test.ts
```

Expected: compile failure because `importLanTransferPackage()` does not accept `{ importMode }` and smart import module does not exist.

- [ ] **Step 3: Add smart import module character helpers**

Create `packages/server/src/services/lan-transfer/lan-transfer-smart-import.ts` with:

```ts
import type { FastifyInstance } from "fastify";
import type { LanTransferImportSummary, LanTransferPackage } from "@marinara-engine/shared";
import { importMarinara } from "../import/marinara.importer.js";
import { buildNativeCharacterEnvelope } from "../export/character-export.service.js";
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
        const existingId = await findExactCharacterByFingerprint(app, item.fingerprint);
        if (existingId) {
          characterIdMap[item.id] = existingId;
          summary.reused!.characters += 1;
          continue;
        }
      }
      const envelope =
        smart && item.syncId
          ? withLanTransferCharacterSyncMetadata(item.envelope, { syncId: item.syncId, fingerprint: item.fingerprint })
          : item.envelope;
      const result = await importMarinara(envelope as any, app.db);
      if (result.success && result.id) {
        characterIdMap[item.id] = result.id;
        summary.imported.characters += 1;
        if (options.importMode === "copy") summary.copied!.characters += 1;
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

export async function findExactCharacterByFingerprint(app: FastifyInstance, fingerprint: string): Promise<string | null> {
  const characters = createCharactersStorage(app.db);
  const gallery = createCharacterGalleryStorage(app.db);
  for (const character of await characters.list()) {
    const data = JSON.parse(character.data);
    const envelope = await buildNativeCharacterEnvelope(character, data, gallery);
    if (fingerprintNativeCharacterEnvelope(envelope) === fingerprint) return character.id;
  }
  return null;
}
```

- [ ] **Step 4: Wire character smart import into package import**

In `lan-transfer-package.ts`, import:

```ts
import {
  createEmptyLanTransferImportSummary,
  importLanTransferCharacters,
  type LanTransferPackageImportOptions,
} from "./lan-transfer-smart-import.js";
```

Change signature:

```ts
export async function importLanTransferPackage(
  app: FastifyInstance,
  pkg: LanTransferPackage,
  options: LanTransferPackageImportOptions = {},
): Promise<LanTransferImportSummary> {
```

Replace the first character import loop and summary initialization with:

```ts
const summary = createEmptyLanTransferImportSummary();
const characterIdMap = await importLanTransferCharacters(app, pkg, summary, options);
```

Leave the existing chat import loop in place for now.

- [ ] **Step 5: Run smart character tests**

Run:

```bash
pnpm --filter @marinara-engine/server exec tsx --test test/lan-transfer-smart-import.test.ts test/lan-transfer-package.test.ts
```

Expected: smart character tests pass; existing package tests pass after updating expected summary objects where they compare exact object shape.

- [ ] **Step 6: Commit smart character reuse**

```bash
git add packages/server/src/services/lan-transfer/lan-transfer-smart-import.ts packages/server/src/services/lan-transfer/lan-transfer-package.ts packages/server/test/lan-transfer-smart-import.test.ts packages/server/test/lan-transfer-package.test.ts
git commit -m "feat: reuse exact LAN transfer characters"
```

---

### Task 5: Smart Chat Append And Conflict Copy

**Files:**
- Modify: `packages/server/src/services/lan-transfer/lan-transfer-smart-import.ts`
- Modify: `packages/server/src/services/lan-transfer/lan-transfer-native-chat.ts`
- Modify: `packages/server/src/services/lan-transfer/lan-transfer-package.ts`
- Test: `packages/server/test/lan-transfer-smart-import.test.ts`
- Test: `packages/server/test/lan-transfer-native-chat.test.ts`

- [ ] **Step 1: Add failing smart chat tests**

Append to `packages/server/test/lan-transfer-smart-import.test.ts`:

```ts
test("smart import appends missing messages to an existing synced chat and keeps local settings", async () =>
  withDb(async (db) => {
    const characters = createCharactersStorage(db);
    const chats = createChatsStorage(db);
    const character = await characters.create({ name: "Alicia", description: "same", first_mes: "Hi" } as any);
    assert.ok(character?.id);
    const existing = await chats.create({
      name: "Alicia thread",
      mode: "roleplay",
      characterIds: [character.id],
      promptPresetId: "local-preset",
      connectionId: "local-connection",
    });
    assert.ok(existing?.id);
    await chats.patchMetadata(existing.id, { lanTransfer: { syncId: "source-chat" } }, { touchUpdatedAt: false });
    await chats.createMessagesBatch(existing.id, [
      { role: "assistant", characterId: character.id, content: "One", createdAt: "2026-05-20T12:00:00.000Z" },
    ]);

    const source = await chats.create({ name: "Alicia thread", mode: "roleplay", characterIds: [character.id] });
    assert.ok(source?.id);
    await chats.patchMetadata(source.id, { lanTransfer: { syncId: "source-chat" } }, { touchUpdatedAt: false });
    await chats.createMessagesBatch(source.id, [
      { role: "assistant", characterId: character.id, content: "One", createdAt: "2026-05-20T12:00:00.000Z" },
      { role: "user", characterId: null, content: "Two", createdAt: "2026-05-20T12:01:00.000Z" },
    ]);

    const pkg = await buildLanTransferPackage(
      { db } as any,
      [{ type: "chat", id: source.id, format: "native" }],
      "2999-01-01T00:00:00.000Z",
    );
    await chats.remove(source.id);

    const summary = await importLanTransferPackage({ db } as any, pkg, { importMode: "smart" });

    assert.equal(summary.appended?.chats, 1);
    assert.equal(summary.appended?.messages, 1);
    assert.equal(summary.imported.chats, 0);
    const updated = await chats.getById(existing.id);
    assert.equal(updated?.promptPresetId, "local-preset");
    assert.equal(updated?.connectionId, "local-connection");
    const messages = await chats.listMessages(existing.id);
    assert.deepEqual(messages.map((message) => message.content), ["One", "Two"]);
  }));

test("smart import skips identical synced chats", async () =>
  withDb(async (db) => {
    const characters = createCharactersStorage(db);
    const chats = createChatsStorage(db);
    const character = await characters.create({ name: "Alicia", description: "same", first_mes: "Hi" } as any);
    assert.ok(character?.id);
    const existing = await chats.create({ name: "Alicia thread", mode: "roleplay", characterIds: [character.id] });
    assert.ok(existing?.id);
    await chats.patchMetadata(existing.id, { lanTransfer: { syncId: "source-chat" } }, { touchUpdatedAt: false });
    await chats.createMessagesBatch(existing.id, [
      { role: "assistant", characterId: character.id, content: "One", createdAt: "2026-05-20T12:00:00.000Z" },
    ]);

    const pkg = await buildLanTransferPackage(
      { db } as any,
      [{ type: "chat", id: existing.id, format: "native" }],
      "2999-01-01T00:00:00.000Z",
    );

    const summary = await importLanTransferPackage({ db } as any, pkg, { importMode: "smart" });

    assert.equal(summary.reused?.chats, 1);
    assert.equal(summary.imported.chats, 0);
    assert.equal((await chats.list()).length, 1);
  }));

test("smart import copies divergent synced chats instead of silently merging", async () =>
  withDb(async (db) => {
    const characters = createCharactersStorage(db);
    const chats = createChatsStorage(db);
    const character = await characters.create({ name: "Alicia", description: "same", first_mes: "Hi" } as any);
    assert.ok(character?.id);
    const existing = await chats.create({ name: "Alicia thread", mode: "roleplay", characterIds: [character.id] });
    assert.ok(existing?.id);
    await chats.patchMetadata(existing.id, { lanTransfer: { syncId: "source-chat" } }, { touchUpdatedAt: false });
    await chats.createMessagesBatch(existing.id, [
      { role: "assistant", characterId: character.id, content: "Local branch", createdAt: "2026-05-20T12:00:00.000Z" },
    ]);

    const source = await chats.create({ name: "Alicia thread", mode: "roleplay", characterIds: [character.id] });
    assert.ok(source?.id);
    await chats.patchMetadata(source.id, { lanTransfer: { syncId: "source-chat" } }, { touchUpdatedAt: false });
    await chats.createMessagesBatch(source.id, [
      { role: "assistant", characterId: character.id, content: "Remote branch", createdAt: "2026-05-20T12:00:00.000Z" },
    ]);
    const pkg = await buildLanTransferPackage(
      { db } as any,
      [{ type: "chat", id: source.id, format: "native" }],
      "2999-01-01T00:00:00.000Z",
    );
    await chats.remove(source.id);

    const summary = await importLanTransferPackage({ db } as any, pkg, { importMode: "smart" });

    assert.equal(summary.copied?.chats, 1);
    assert.equal(summary.imported.chats, 1);
    assert.match(summary.skipped[0]?.reason ?? "", /diverged/i);
    assert.equal((await chats.list()).length, 2);
  }));
```

- [ ] **Step 2: Run failing smart chat tests**

Run:

```bash
pnpm --filter @marinara-engine/server exec tsx --test test/lan-transfer-smart-import.test.ts
```

Expected: failures because smart chat matching and append do not exist.

- [ ] **Step 3: Preserve LAN sync metadata and message fingerprints on import**

In `lan-transfer-native-chat.ts`, extend imports from `lan-transfer-fingerprints.ts` and add exported helpers:

```ts
export function buildImportedMessages(
  messages: NativeLanChatExport["messages"],
  characterIdMap: Record<string, string>,
  startIndex = 0,
): Array<{
  role: MessageRole;
  characterId: string | null;
  content: string;
  createdAt: string;
  extra: Record<string, unknown>;
  swipeExtra: Record<string, unknown>;
}> {
  ...
  return messages.slice(startIndex).map((message, index) => ({
    role: message.role,
    characterId: message.characterId === null ? null : (characterIdMap[message.characterId] ?? null),
    content: message.content,
    createdAt: new Date(nextTimestampMs).toISOString(),
    extra: {
      displayText: null,
      isGenerated: message.role !== "user",
      tokenCount: null,
      generationInfo: null,
      lanTransfer: { fingerprint: message.fingerprint, sourceCharacterId: message.characterId },
    },
    swipeExtra: { lanTransfer: { fingerprint: message.fingerprint } },
  }));
}
```

Keep the old `importNativeLanChat()` behavior for copy imports, but when creating a smart/imported new chat, patch metadata:

```ts
await chats.patchMetadata(chat.id, { lanTransfer: { syncId: nativeChat.chat.syncId } }, { touchUpdatedAt: false });
```

- [ ] **Step 4: Add smart chat helpers**

In `lan-transfer-smart-import.ts`, add:

```ts
import { createChatsStorage } from "../storage/chats.storage.js";
import {
  buildImportedMessages,
  importNativeLanChat,
  validateNativeLanChatExport,
  collectNativeLanChatCharacterIds,
} from "./lan-transfer-native-chat.js";
import { compareFingerprintSequences, fingerprintLanTransferMessage } from "./lan-transfer-fingerprints.js";

export async function importLanTransferChats(
  app: FastifyInstance,
  pkg: LanTransferPackage,
  characterIdMap: Record<string, string>,
  summary: LanTransferImportSummary,
  options: LanTransferPackageImportOptions,
) {
  for (const item of pkg.items) {
    if (item.type !== "chat") continue;
    if (item.format !== "native" || (options.importMode ?? "smart") === "copy") {
      await importChatAsCopy(app, item, characterIdMap, summary, options);
      continue;
    }
    await importNativeChatSmart(app, item, characterIdMap, summary);
  }
}
```

Implement `findChatBySyncId()`:

```ts
async function findChatBySyncId(app: FastifyInstance, syncId: string) {
  const chats = createChatsStorage(app.db);
  for (const chat of await chats.list()) {
    if (chat.id === syncId) return chat;
    const metadata = parseJsonObject(chat.metadata);
    const lan = isRecord(metadata.lanTransfer) ? metadata.lanTransfer : null;
    if (lan?.syncId === syncId) return chat;
  }
  return null;
}
```

Implement local message fingerprints:

```ts
async function getLocalMessageFingerprints(app: FastifyInstance, chatId: string): Promise<string[]> {
  const chats = createChatsStorage(app.db);
  const messages = await chats.listMessages(chatId);
  return messages.map((message) => {
    const extra = parseJsonObject(message.extra);
    const lan = isRecord(extra.lanTransfer) ? extra.lanTransfer : null;
    if (typeof lan?.fingerprint === "string") return lan.fingerprint;
    return fingerprintLanTransferMessage({
      role: message.role,
      characterId: message.characterId,
      content: message.content,
      createdAt: message.createdAt,
    });
  });
}
```

Implement `importNativeChatSmart()`:

```ts
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
      summary.chatIdMap = { ...(summary.chatIdMap ?? {}), [item.id]: result.id };
    } else {
      summary.skipped.push({ type: item.type, name: item.name, reason: result.error });
    }
    return;
  }

  const localFingerprints = await getLocalMessageFingerprints(app, existing.id);
  const incomingFingerprints = validation.chat.messages.map((message) => message.fingerprint);
  const comparison = compareFingerprintSequences(localFingerprints, incomingFingerprints);
  if (comparison.kind === "same" || comparison.kind === "local_ahead") {
    summary.reused!.chats += 1;
    summary.chatIdMap = { ...(summary.chatIdMap ?? {}), [item.id]: existing.id };
    return;
  }

  if (comparison.kind === "incoming_extends_local") {
    const chats = createChatsStorage(app.db);
    await chats.createMessagesBatch(
      existing.id,
      buildImportedMessages(validation.chat.messages, characterIdMap, comparison.appendFrom),
    );
    summary.appended!.chats += 1;
    summary.appended!.messages += incomingFingerprints.length - comparison.appendFrom;
    summary.chatIdMap = { ...(summary.chatIdMap ?? {}), [item.id]: existing.id };
    return;
  }

  const result = await importNativeLanChat(app.db, validation.chat, characterIdMap, {
    preserveSyncId: false,
    nameSuffix: " (LAN conflict copy)",
  });
  if (result.success) {
    summary.imported.chats += 1;
    summary.copied!.chats += 1;
    summary.skipped.push({ type: item.type, name: item.name, reason: "Synced chat history diverged; imported a copy." });
  } else {
    summary.skipped.push({ type: item.type, name: item.name, reason: result.error });
  }
}
```

- [ ] **Step 5: Wire chat smart import into package import**

In `lan-transfer-package.ts`, replace the second chat import loop with:

```ts
await importLanTransferChats(app, pkg, characterIdMap, summary, options);
return summary;
```

Keep JSONL copy import support in `importChatAsCopy()` inside `lan-transfer-smart-import.ts` by moving the current JSONL import code from `lan-transfer-package.ts` into that helper.

- [ ] **Step 6: Run smart chat tests**

Run:

```bash
pnpm --filter @marinara-engine/server exec tsx --test test/lan-transfer-smart-import.test.ts test/lan-transfer-native-chat.test.ts test/lan-transfer-package.test.ts
```

Expected: all pass.

- [ ] **Step 7: Commit smart chat import**

```bash
git add packages/server/src/services/lan-transfer/lan-transfer-smart-import.ts packages/server/src/services/lan-transfer/lan-transfer-native-chat.ts packages/server/src/services/lan-transfer/lan-transfer-package.ts packages/server/test/lan-transfer-smart-import.test.ts packages/server/test/lan-transfer-native-chat.test.ts packages/server/test/lan-transfer-package.test.ts
git commit -m "feat: append synced LAN transfer chats"
```

---

### Task 6: Preview Analysis And Import Mode Routes

**Files:**
- Modify: `packages/server/src/routes/lan-transfer.routes.ts`
- Modify: `packages/server/src/services/lan-transfer/lan-transfer-smart-import.ts`
- Test: `packages/server/test/lan-transfer-routes.test.ts`

- [ ] **Step 1: Add failing route tests**

Add to `packages/server/test/lan-transfer-routes.test.ts` near preview/import route tests:

```ts
test("preview includes smart import analysis for native chat dependencies", async () =>
  withLanTransferApp({ LAN_TRANSFER_ENABLED: "1" }, async (app) => {
    const offerId = "route-preview-smart-analysis";
    const downloadToken = "download-token";
    const secret = "transfer-secret";
    lanTransferOfferStore.delete(offerId);
    lanTransferOfferStore.put({
      offerId,
      downloadTokenHash: hashLanTransferToken(downloadToken),
      expiresAtMs: Date.now() + 60_000,
      manifest: {
        version: 1,
        createdAt: "2026-05-20T00:00:00.000Z",
        expiresAt: "2999-01-01T00:00:00.000Z",
        sourceApp: "Marinara Engine",
        sourceVersion: "1.6.0",
        items: [
          {
            type: "character",
            id: "source-character",
            syncId: "source-character",
            name: "Alicia",
            format: "native",
            fingerprint: "missing-fingerprint",
            bytes: 1,
          },
          {
            type: "chat",
            id: "source-chat",
            syncId: "source-chat",
            name: "Alicia",
            format: "native",
            messageCount: 1,
            characterCount: 1,
            characterIds: ["source-character"],
            messageFingerprint: "message-sequence",
            messageFingerprints: ["message-one"],
            bytes: 1,
          },
        ],
        totalBytes: 2,
      },
      encryptedPackage: encryptLanTransferPackage(JSON.stringify(testPackage), secret),
    });

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.equal(typeof address, "object");
    assert.notEqual(address, null);
    const transferPayload = serializeLanTransferPayload({
      type: LAN_TRANSFER_TYPE,
      version: LAN_TRANSFER_VERSION,
      from: `http://127.0.0.1:${address.port}`,
      offerId,
      downloadToken,
      secret,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/lan-transfer/preview",
      payload: { transferPayload },
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = JSON.parse(response.body);
    assert.equal(body.analysis.mode, "smart");
    assert.equal(body.analysis.actions.some((action: any) => action.type === "chat" && action.name === "Alicia"), true);
  }));

test("import-from-offer accepts copy import mode", async () =>
  withLanTransferApp({ LAN_TRANSFER_ENABLED: "1" }, async (app) => {
    const offerId = "route-import-copy-mode";
    const downloadToken = "download-token";
    const secret = "transfer-secret";
    lanTransferOfferStore.delete(offerId);
    lanTransferOfferStore.put({
      offerId,
      downloadTokenHash: hashLanTransferToken(downloadToken),
      expiresAtMs: Date.now() + 60_000,
      manifest: testManifest,
      encryptedPackage: encryptLanTransferPackage(JSON.stringify(testPackage), secret),
    });

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.equal(typeof address, "object");
    assert.notEqual(address, null);
    const transferPayload = serializeLanTransferPayload({
      type: LAN_TRANSFER_TYPE,
      version: LAN_TRANSFER_VERSION,
      from: `http://127.0.0.1:${address.port}`,
      offerId,
      downloadToken,
      secret,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/lan-transfer/import-from-offer",
      payload: { transferPayload, options: { importMode: "copy" } },
    });

    assert.equal(response.statusCode, 200, response.body);
  }));
```

- [ ] **Step 2: Run failing route tests**

Run:

```bash
pnpm --filter @marinara-engine/server exec tsx --test test/lan-transfer-routes.test.ts
```

Expected: preview lacks `analysis`; import ignores `importMode`.

- [ ] **Step 3: Add manifest preview analysis helper**

In `lan-transfer-smart-import.ts`, add:

```ts
import type { LanTransferManifest, LanTransferPreviewAnalysis } from "@marinara-engine/shared";

export async function analyzeLanTransferManifest(
  app: FastifyInstance,
  manifest: LanTransferManifest,
): Promise<LanTransferPreviewAnalysis> {
  const characterNamesBySyncId = new Map<string, string>();
  const actions: LanTransferPreviewAnalysis["actions"] = [];

  for (const item of manifest.items) {
    if (item.type === "character") {
      characterNamesBySyncId.set(item.syncId, item.name);
      const existingId = await findExactCharacterByFingerprint(app, item.fingerprint);
      actions.push({
        type: "character",
        sourceId: item.syncId,
        name: item.name,
        action: existingId ? "reuse" : "import-copy",
        ...(existingId ? { targetId: existingId } : {}),
        reason: existingId ? "Exact matching card already exists." : "No exact matching card found.",
      });
    }
  }

  for (const item of manifest.items) {
    if (item.type !== "chat" || item.format !== "native") continue;
    const existing = await findChatBySyncId(app, item.syncId);
    const linkedCharacterNames = item.characterIds.map((id) => characterNamesBySyncId.get(id) ?? id);
    if (!existing) {
      actions.push({
        type: "chat",
        sourceId: item.syncId,
        name: item.name,
        action: "import-copy",
        messageCount: item.messageCount,
        linkedCharacterNames,
        reason: "No synced local chat found.",
      });
      continue;
    }
    const localFingerprints = await getLocalMessageFingerprints(app, existing.id);
    const comparison = compareFingerprintSequences(localFingerprints, item.messageFingerprints);
    if (comparison.kind === "same" || comparison.kind === "local_ahead") {
      actions.push({
        type: "chat",
        sourceId: item.syncId,
        name: item.name,
        action: "skip",
        targetId: existing.id,
        messageCount: item.messageCount,
        linkedCharacterNames,
        reason: comparison.kind === "same" ? "Local chat already has these messages." : "Local chat already has more messages.",
      });
    } else if (comparison.kind === "incoming_extends_local") {
      actions.push({
        type: "chat",
        sourceId: item.syncId,
        name: item.name,
        action: "append",
        targetId: existing.id,
        messageCount: item.messageCount,
        appendCount: item.messageFingerprints.length - comparison.appendFrom,
        linkedCharacterNames,
        reason: "Incoming chat extends the local chat.",
      });
    } else {
      actions.push({
        type: "chat",
        sourceId: item.syncId,
        name: item.name,
        action: "conflict-copy",
        targetId: existing.id,
        messageCount: item.messageCount,
        linkedCharacterNames,
        reason: "Local and incoming message histories diverged.",
      });
    }
  }

  return { mode: "smart", actions };
}
```

Export `findChatBySyncId()` and `getLocalMessageFingerprints()` from the module if they are currently local.

- [ ] **Step 4: Wire analysis and import mode into routes**

In `lan-transfer.routes.ts`, import:

```ts
import { analyzeLanTransferManifest } from "../services/lan-transfer/lan-transfer-smart-import.js";
```

In preview route:

```ts
const analysis = await analyzeLanTransferManifest(app, result.value.manifest as any);
return reply.send({
  from: result.origin,
  offerId: result.value.offerId,
  expiresAt: result.value.expiresAt,
  manifest: result.value.manifest,
  analysis,
});
```

In import route, parse safe import mode:

```ts
function getImportMode(value: unknown): "smart" | "copy" {
  const body = readBody(value);
  const options = isRecord(body.options) ? body.options : {};
  return options.importMode === "copy" ? "copy" : "smart";
}
```

Pass it:

```ts
const summary = await importLanTransferPackage(app, validation.package, { importMode: getImportMode(request.body) });
```

- [ ] **Step 5: Run route tests**

Run:

```bash
pnpm --filter @marinara-engine/server exec tsx --test test/lan-transfer-routes.test.ts
```

Expected: all route tests pass.

- [ ] **Step 6: Commit route analysis**

```bash
git add packages/server/src/routes/lan-transfer.routes.ts packages/server/src/services/lan-transfer/lan-transfer-smart-import.ts packages/server/test/lan-transfer-routes.test.ts
git commit -m "feat: preview LAN transfer smart import actions"
```

---

### Task 7: Receive Modal Labels, Smart Actions, And Copy Toggle

**Files:**
- Modify: `packages/client/src/components/modals/ReceiveFromDeviceModal.tsx`

- [ ] **Step 1: Read frontend instructions**

Run:

```bash
sed -n '1,220p' packages/client/.instructions.md
```

Expected: instructions confirm React Query for async calls, Zustand for UI state, existing modal patterns, and no new dependencies.

- [ ] **Step 2: Update preview normalization**

In `ReceiveFromDeviceModal.tsx`, extend native chat normalization to require and preserve `characterIds`, `messageFingerprint`, and `messageFingerprints`. Extend character normalization to preserve `syncId` and `fingerprint`.

Use this exact native chat branch shape:

```ts
if (format === "native") {
  if (typeof item.characterCount !== "number" || !Number.isFinite(item.characterCount)) return null;
  if (!Array.isArray(item.characterIds) || !item.characterIds.every((id) => typeof id === "string" && id.trim())) {
    return null;
  }
  if (typeof item.syncId !== "string" || !item.syncId.trim()) return null;
  if (typeof item.messageFingerprint !== "string" || !item.messageFingerprint.trim()) return null;
  if (
    !Array.isArray(item.messageFingerprints) ||
    !item.messageFingerprints.every((fingerprint) => typeof fingerprint === "string" && fingerprint.trim())
  ) {
    return null;
  }
  items.push({
    type: "chat",
    id,
    syncId: item.syncId,
    name,
    format: "native",
    messageCount: item.messageCount,
    characterCount: item.characterCount,
    characterIds: item.characterIds,
    messageFingerprint: item.messageFingerprint,
    messageFingerprints: item.messageFingerprints,
    bytes,
  });
  continue;
}
```

Normalize `analysis` if present with a defensive object/array check. If analysis is malformed, set it to `undefined` instead of rejecting the whole preview so legacy senders still work.

- [ ] **Step 3: Replace redundant per-row labels**

Replace `getItemTypeLabel()` with linked-name based labeling:

```ts
function getLinkedCharacterNames(item: PreviewManifestItem, items: PreviewManifestItem[]) {
  if (item.type !== "chat" || item.format !== "native") return [];
  const names = new Map(
    items
      .filter((candidate) => candidate.type === "character")
      .map((candidate) => [("syncId" in candidate ? candidate.syncId : candidate.id), candidate.name]),
  );
  return item.characterIds.map((id) => names.get(id)).filter((name): name is string => !!name);
}

function getItemTypeLabel(item: PreviewManifestItem, items: PreviewManifestItem[]) {
  if (item.type === "character") return "Character";
  const linkedNames = getLinkedCharacterNames(item, items);
  if (linkedNames.length === 1) return `Chat linked to ${linkedNames[0]}`;
  if (linkedNames.length > 1) return `Chat linked to ${linkedNames.length} cards`;
  return "Chat";
}
```

Update the map call:

```tsx
{preview.manifest.items.map((item) => (
  ...
  {getItemTypeLabel(item, preview.manifest.items)}
))}
```

- [ ] **Step 4: Add copy toggle defaulting off**

Add state:

```ts
const [importAsCopies, setImportAsCopies] = useState(false);
```

Reset it only when the modal closes, not when preview changes:

```ts
if (!open) setImportAsCopies(false);
```

Add a toggle near the import buttons:

```tsx
<label className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm">
  <span className="min-w-0">
    <span className="block font-semibold text-[var(--foreground)]">Import as copies</span>
    <span className="block text-xs text-[var(--muted-foreground)]">
      Leave off to reuse exact cards and append synced chats when safe.
    </span>
  </span>
  <input
    type="checkbox"
    checked={importAsCopies}
    onChange={(event) => setImportAsCopies(event.target.checked)}
    disabled={isBusy}
    className="h-4 w-4"
  />
</label>
```

In `handleImport()`, pass:

```ts
const summary = await importTransfer.mutateAsync({
  transferPayload: payload,
  options: { importMode: importAsCopies ? "copy" : "smart" },
});
```

- [ ] **Step 5: Show smart actions**

Add a helper:

```ts
function getActionLabel(action: NonNullable<LanTransferPreviewResponse["analysis"]>["actions"][number]) {
  if (action.type === "character") {
    return action.action === "reuse" ? "Will reuse existing card" : "Will import card";
  }
  if (action.action === "append") return `Will append ${pluralize(action.appendCount ?? 0, "message")}`;
  if (action.action === "skip") return "Already up to date";
  if (action.action === "conflict-copy") return "History differs; will import a copy";
  return "Will import chat";
}
```

Under each preview row, when an analysis action matches by `sourceId`, show:

```tsx
{action && (
  <span className="shrink-0 text-xs text-[var(--muted-foreground)]">{getActionLabel(action)}</span>
)}
```

When `importAsCopies` is true, show static row labels such as `Will import copy` instead of smart action labels.

- [ ] **Step 6: Improve import toast summary**

Update `getImportSummary()` to include reused/appended counts:

```ts
if ((summary.reused?.characters ?? 0) > 0) parts.push(`${summary.reused!.characters} reused cards`);
if ((summary.appended?.messages ?? 0) > 0) parts.push(`${summary.appended!.messages} appended messages`);
```

Keep the existing imported/skipped wording.

- [ ] **Step 7: Run client validation**

Run:

```bash
pnpm --filter @marinara-engine/client build
pnpm lint
git diff --check
```

Expected: all pass.

- [ ] **Step 8: Commit frontend smart import UX**

```bash
git add packages/client/src/components/modals/ReceiveFromDeviceModal.tsx
git commit -m "feat: show LAN transfer smart import choices"
```

---

### Task 8: Docs, Full Validation, And Manual Smoke

**Files:**
- Modify: `docs/superpowers/specs/2026-05-19-lan-device-transfer-design.md`

- [ ] **Step 1: Update the design doc**

Add a new section after `## Import Safety`:

```md
## Smart Import

Smart import is the default receive mode. It treats chat identity, message history, and local chat settings separately:

- Exact matching character cards are reused instead of duplicated.
- Chat matching uses LAN transfer `syncId`, not local generation settings, enabled agents, folders, personas, presets, or connections.
- If the incoming message fingerprint list exactly matches the local list, the chat is skipped as already up to date.
- If the incoming message fingerprint list strictly extends the local list, only missing messages are appended.
- If local and incoming message histories diverge, Marinara imports a conflict copy instead of silently merging.
- Receiver-local chat settings are preserved when appending messages.
- Users can enable `Import as copies` to force the older duplicate-import behavior.
```

Update preview wording to say rows use labels such as `1 chat linked to Alicia` and action summaries such as `will append 8 messages`.

- [ ] **Step 2: Run focused server tests**

Run:

```bash
pnpm --filter @marinara-engine/server exec tsx --test \
  test/lan-transfer-fingerprints.test.ts \
  test/lan-transfer-smart-import.test.ts \
  test/lan-transfer-native-chat.test.ts \
  test/lan-transfer-package.test.ts \
  test/lan-transfer-routes.test.ts \
  test/lan-transfer-payload.test.ts
```

Expected: all pass.

- [ ] **Step 3: Run build and lint**

Run:

```bash
pnpm --filter @marinara-engine/server build
pnpm --filter @marinara-engine/client build
pnpm lint
git diff --check
```

Expected: all pass. If `pnpm check` is run, it may still fail on the known Impeccable context loader invalid JSON issue; report that separately and do not conflate it with this feature.

- [ ] **Step 4: Commit docs**

```bash
git add docs/superpowers/specs/2026-05-19-lan-device-transfer-design.md
git commit -m "docs: describe LAN transfer smart import"
```

- [ ] **Step 5: Manual smoke flow**

Start the app:

```bash
LAN_TRANSFER_ENABLED=1 HOST=0.0.0.0 ALLOW_UNAUTHENTICATED_PRIVATE_NETWORK=true pnpm dev
```

Smoke cases:

1. Linux sends Alicia chat to Android with `Import as copies` off.
   - Expected preview row: `Alicia` with `Chat linked to Alicia`.
   - Expected result: Alicia card imported once and chat linked to that card.
2. Android immediately sends the same chat back to Linux.
   - Expected preview action: already up to date or skip.
   - Expected result: no duplicate card and no duplicate chat.
3. Android adds one new message, then sends back to Linux.
   - Expected preview action: append 1 message.
   - Expected result: Linux chat gains one message; Linux chat agent/preset/connection settings are unchanged.
4. Create divergent local and remote messages from the same sync point.
   - Expected preview action: history differs; import copy.
   - Expected result: no silent merge.
5. Enable `Import as copies`.
   - Expected result: current duplicate behavior is preserved.

---

## Self-Review Notes

- The plan keeps sync identity separate from mutable local settings, so enabled agents, presets, personas, folders, and connections do not cause duplicates.
- Preview analysis uses manifest fingerprints only and does not consume the one-time encrypted download.
- The only intentional duplicate path in smart mode is divergent chat history, where silent merge would be unsafe.
- Copy mode remains available and explicit.
