# LAN Transfer Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LAN chat transfer self-contained and low-friction by automatically using reachable LAN sender origins and importing selected chats with their referenced character cards, avatars, sprites, and gallery images.

**Architecture:** Keep the existing pull-based, encrypted, one-time LAN offer flow. Add a native Marinara chat package format for LAN transfers, import characters before chats, remap old character IDs to newly imported IDs, and let offer payloads carry bounded sender-origin candidates so receivers never require manual URL editing. Manifest/download remain token-gated offer endpoints; normal app APIs stay behind existing local auth rules.

**Tech Stack:** TypeScript, Fastify, Node `node:test`, Drizzle/file-backed storage, React 19, TanStack Query, existing QR payload flow.

---

## File Structure

- Modify `packages/shared/src/types/lan-transfer.ts`
  - Add origin candidates to transfer payloads.
  - Add native chat manifest/package item types.
  - Add imported character ID mapping to import summaries.
- Modify `packages/server/src/services/lan-transfer/lan-transfer-payload.ts`
  - Parse both v1 `from` payloads and phase-2 payloads with `origins`.
  - Serialize payloads without leaking secrets to logs.
- Create `packages/server/src/services/lan-transfer/lan-transfer-origins.ts`
  - Detect bounded local sender-origin candidates from request/config/network interfaces.
  - Normalize, dedupe, and rank origins without scanning the LAN.
- Create `packages/server/src/services/lan-transfer/lan-transfer-native-chat.ts`
  - Export a native chat payload from Marinara storage.
  - Import native chat payloads after character import and remap character IDs.
- Modify `packages/server/src/services/lan-transfer/lan-transfer-package.ts`
  - Default chat items to native LAN format.
  - Auto-include referenced characters.
  - Import package items in dependency order.
- Modify `packages/server/src/routes/lan-transfer.routes.ts`
  - Use origin candidates when creating offers.
  - Try candidate origins in order for preview/import.
  - Return the origin that actually worked.
- Modify `packages/server/src/middleware/basic-auth.ts`
  - Exempt only token-gated LAN transfer manifest/download endpoints from global Basic Auth so a receiver backend can fetch a prepared encrypted offer without broad LAN auth bypass.
- Modify `packages/client/src/hooks/use-lan-transfer.ts`
  - Add optional preferred origin in create-offer request typing if needed by the UI.
- Modify `packages/client/src/components/modals/SendToDeviceModal.tsx`
  - Show the selected sender origin and avoid exposing raw URL editing as the normal path.
- Modify `packages/client/src/components/modals/ReceiveFromDeviceModal.tsx`
  - Accept native chat manifest items and show bundled character dependencies clearly.
- Modify `packages/server/test/lan-transfer-routes.test.ts`
  - Add route-level regression tests for origin candidates, Basic Auth bypass, native bundle preview/import, and old-ID to new-ID remapping.
- Create `packages/server/test/lan-transfer-native-chat.test.ts`
  - Unit-test native chat export/import without network fetch noise.
- Update `docs/superpowers/specs/2026-05-19-lan-device-transfer-design.md`
  - Add phase-2 notes so the docs match the implementation direction.

---

### Task 1: Shared Types And Payload Compatibility

**Files:**
- Modify: `packages/shared/src/types/lan-transfer.ts`
- Modify: `packages/server/src/services/lan-transfer/lan-transfer-payload.ts`
- Test: `packages/server/test/lan-transfer-routes.test.ts`

- [ ] **Step 1: Write failing payload compatibility tests**

Add tests near the existing payload/preview route tests in `packages/server/test/lan-transfer-routes.test.ts`:

```ts
test("preview accepts phase-2 payloads with multiple LAN origins", async () =>
  withLanTransferApp({ LAN_TRANSFER_ENABLED: "1" }, async (app) => {
    const offerId = "route-preview-multi-origin";
    const downloadToken = "download-token";
    lanTransferOfferStore.delete(offerId);
    lanTransferOfferStore.put({
      offerId,
      downloadTokenHash: hashLanTransferToken(downloadToken),
      expiresAtMs: Date.now() + 60_000,
      manifest: testManifest,
      encryptedPackage: testEncryptedPackage,
    });

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.equal(typeof address, "object");
    assert.notEqual(address, null);

    const transferPayload = serializeLanTransferPayload({
      type: LAN_TRANSFER_TYPE,
      version: LAN_TRANSFER_VERSION,
      from: `http://127.0.0.1:${address.port}`,
      origins: ["http://8.8.8.8:7860", `http://127.0.0.1:${address.port}`],
      offerId,
      downloadToken,
      secret: "secret",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/lan-transfer/preview",
      payload: { transferPayload },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(JSON.parse(response.body).from, `http://127.0.0.1:${address.port}`);
  }));
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
packages/server/node_modules/.bin/tsx --test packages/server/test/lan-transfer-routes.test.ts
```

Expected: the new test fails because `LanTransferPayload` and parsing do not yet support `origins`, and the route only tries `payload.from`.

- [ ] **Step 3: Extend shared payload types**

Update `packages/shared/src/types/lan-transfer.ts`:

```ts
export type LanTransferChatFormat = "jsonl" | "native";

export type LanTransferItemRequest =
  | { type: "chat"; id: string; format?: LanTransferChatFormat }
  | { type: "character"; id: string; format?: "native" };

export interface LanTransferPayload {
  type: typeof LAN_TRANSFER_TYPE;
  version: typeof LAN_TRANSFER_VERSION;
  /** Backward-compatible primary origin. Receivers should prefer `origins` when present. */
  from: string;
  /** Bounded, sender-advertised origins. This is self-discovery, not LAN scanning. */
  origins?: string[];
  offerId: string;
  downloadToken: string;
  secret: string;
}
```

Also update manifest/package unions so chat items can be `format: "native"`:

```ts
| {
    type: "chat";
    id: string;
    name: string;
    format: "native";
    messageCount: number;
    characterCount: number;
    bytes: number;
  }
```

and package items:

```ts
| { type: "chat"; id: string; name: string; format: "native"; chat: unknown }
```

Extend the import summary:

```ts
export interface LanTransferImportSummary {
  imported: {
    chats: number;
    characters: number;
  };
  characterIdMap?: Record<string, string>;
  skipped: Array<{ type: string; name?: string; reason: string }>;
}
```

- [ ] **Step 4: Keep payload parse backward compatible**

In `packages/server/src/services/lan-transfer/lan-transfer-payload.ts`, preserve v1 JSON parsing but normalize origins:

```ts
function normalizeOrigins(value: unknown, fallback: string): string[] | undefined {
  if (!Array.isArray(value)) return fallback ? [fallback] : undefined;
  const origins = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  const deduped = Array.from(new Set(origins.map((entry) => entry.trim()))).slice(0, 5);
  return deduped.length > 0 ? deduped : fallback ? [fallback] : undefined;
}
```

Ensure `parseLanTransferPayload()` returns a payload whose `from` is still a non-empty string and whose optional `origins` is a deduped array of at most 5 strings.

- [ ] **Step 5: Run focused tests**

Run:

```bash
packages/server/node_modules/.bin/tsx --test packages/server/test/lan-transfer-routes.test.ts
```

Expected: existing tests still pass or fail only because routes have not yet been updated to iterate origins.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types/lan-transfer.ts packages/server/src/services/lan-transfer/lan-transfer-payload.ts packages/server/test/lan-transfer-routes.test.ts
git commit -m "feat: support LAN transfer origin candidates"
```

---

### Task 2: Sender Origin Candidate Detection

**Files:**
- Create: `packages/server/src/services/lan-transfer/lan-transfer-origins.ts`
- Modify: `packages/server/src/routes/lan-transfer.routes.ts`
- Test: `packages/server/test/lan-transfer-routes.test.ts`

- [ ] **Step 1: Write failing origin selection tests**

Add route tests that assert offer creation returns an origin list when the request host is loopback:

```ts
test("create offer advertises bounded origin candidates", async () =>
  withLanTransferApp({ LAN_TRANSFER_ENABLED: "1", LAN_TRANSFER_PUBLIC_ORIGIN: "http://192.168.1.230:7860" }, async (app) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/lan-transfer/offers",
      headers: { host: "localhost:7860" },
      payload: { items: [{ type: "character", id: "missing", format: "native" }] },
    });

    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.body, /Character not found/);
  }));
```

Then add a pure unit-style test in the same file after exposing an injectable helper:

```ts
test("origin helper ranks public configured origin before loopback request origin", async () => {
  const { resolveLanTransferOrigins } = await import("../src/services/lan-transfer/lan-transfer-origins.js");
  const origins = resolveLanTransferOrigins({
    protocol: "http",
    requestHost: "localhost:7860",
    configuredOrigin: "http://192.168.1.230:7860",
    interfaceAddresses: ["192.168.1.230", "10.12.42.103"],
    port: 7860,
  });

  assert.deepEqual(origins, [
    "http://192.168.1.230:7860",
    "http://10.12.42.103:7860",
    "http://localhost:7860",
  ]);
});
```

- [ ] **Step 2: Run tests and verify helper is missing**

Run:

```bash
packages/server/node_modules/.bin/tsx --test packages/server/test/lan-transfer-routes.test.ts
```

Expected: import fails because `lan-transfer-origins.ts` does not exist.

- [ ] **Step 3: Implement origin helper**

Create `packages/server/src/services/lan-transfer/lan-transfer-origins.ts`:

```ts
import { networkInterfaces } from "node:os";

export interface ResolveLanTransferOriginsInput {
  protocol: "http" | "https";
  requestHost: string;
  configuredOrigin?: string | null;
  interfaceAddresses?: string[];
  port: number;
}

export function getPrivateIpv4InterfaceAddresses(): string[] {
  const result: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (isPrivateIpv4(entry.address)) result.push(entry.address);
    }
  }
  return Array.from(new Set(result));
}

export function resolveLanTransferOrigins(input: ResolveLanTransferOriginsInput): string[] {
  const candidates: string[] = [];
  if (input.configuredOrigin) candidates.push(input.configuredOrigin);
  for (const address of input.interfaceAddresses ?? getPrivateIpv4InterfaceAddresses()) {
    candidates.push(`${input.protocol}://${address}:${input.port}`);
  }
  candidates.push(`${input.protocol}://${input.requestHost}`);
  return Array.from(new Set(candidates.map(normalizeOrigin).filter((origin): origin is string => !!origin))).slice(0, 5);
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.pathname = "";
    url.search = "";
    url.hash = "";
    url.username = "";
    url.password = "";
    return url.origin;
  } catch {
    return null;
  }
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127;
}
```

- [ ] **Step 4: Add config getter for explicit public origin**

In `packages/server/src/config/runtime-config.ts`, add:

```ts
export function getLanTransferPublicOrigin() {
  return normalizeEnvValue(process.env.LAN_TRANSFER_PUBLIC_ORIGIN);
}
```

- [ ] **Step 5: Use origin helper in offer creation**

In `packages/server/src/routes/lan-transfer.routes.ts`, replace the single `getRequestOrigin(request)` use with:

```ts
const origins = getRequestOrigins(request);
const transferPayload = serializeLanTransferPayload({
  type: LAN_TRANSFER_TYPE,
  version: LAN_TRANSFER_VERSION,
  from: origins[0] ?? getRequestOrigin(request),
  origins,
  offerId,
  downloadToken,
  secret,
});
```

Add a route helper:

```ts
function getRequestOrigins(request: FastifyRequest): string[] {
  const host = request.headers.host ?? "localhost";
  const protocol = (request.protocol || "http") as "http" | "https";
  return resolveLanTransferOrigins({
    protocol,
    requestHost: host,
    configuredOrigin: getLanTransferPublicOrigin(),
    port: getPort(),
  });
}
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
packages/server/node_modules/.bin/tsx --test packages/server/test/lan-transfer-routes.test.ts
```

Expected: origin helper tests pass. Existing route tests continue to pass.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/config/runtime-config.ts packages/server/src/services/lan-transfer/lan-transfer-origins.ts packages/server/src/routes/lan-transfer.routes.ts packages/server/test/lan-transfer-routes.test.ts
git commit -m "feat: advertise LAN transfer sender origins"
```

---

### Task 3: Native Chat Export And Import With Character Remapping

**Files:**
- Create: `packages/server/src/services/lan-transfer/lan-transfer-native-chat.ts`
- Test: `packages/server/test/lan-transfer-native-chat.test.ts`

- [ ] **Step 1: Write failing native chat tests**

Create `packages/server/test/lan-transfer-native-chat.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileNativeDB } from "../src/db/file-backed-store.js";
import { createCharactersStorage } from "../src/services/storage/characters.storage.js";
import { createChatsStorage } from "../src/services/storage/chats.storage.js";

async function withDb<T>(fn: (db: Awaited<ReturnType<typeof createFileNativeDB>>) => Promise<T>) {
  const root = mkdtempSync(join(tmpdir(), "marinara-native-chat-transfer-"));
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

test("native LAN chat import remaps chat and message character IDs", async () =>
  withDb(async (db) => {
    const { buildNativeLanChatExport, importNativeLanChat } = await import(
      "../src/services/lan-transfer/lan-transfer-native-chat.js"
    );
    const characters = createCharactersStorage(db);
    const chats = createChatsStorage(db);
    const character = await characters.create({ name: "Ari", description: "", first_mes: "Hi" } as any);
    assert.ok(character?.id);
    const chat = await chats.create({ name: "Ari chat", mode: "roleplay", characterIds: [character.id] });
    assert.ok(chat?.id);
    await chats.createMessagesBatch(chat.id, [{ role: "assistant", characterId: character.id, content: "Hello" }]);

    const exported = await buildNativeLanChatExport(db, chat.id);
    const importedCharacter = await characters.create({ name: "Ari imported", description: "", first_mes: "Hi" } as any);
    assert.ok(importedCharacter?.id);
    const result = await importNativeLanChat(db, exported, { [character.id]: importedCharacter.id });

    assert.equal(result.success, true);
    assert.ok(result.id);
    const importedChat = await chats.getById(result.id!);
    assert.ok(importedChat);
    assert.deepEqual(JSON.parse(importedChat.characterIds as string), [importedCharacter.id]);
    const messages = await chats.listMessages(result.id!);
    assert.equal(messages[0]?.characterId, importedCharacter.id);
  }));
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
packages/server/node_modules/.bin/tsx --test packages/server/test/lan-transfer-native-chat.test.ts
```

Expected: module import fails because `lan-transfer-native-chat.ts` does not exist.

- [ ] **Step 3: Implement native chat module**

Create `packages/server/src/services/lan-transfer/lan-transfer-native-chat.ts`:

```ts
import type { DB } from "../../db/connection.js";
import type { ChatMode } from "@marinara-engine/shared";
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
      mode: (chat.mode ?? "roleplay") as ChatMode,
      characterIds: parseCharacterIds(chat.characterIds),
      personaId: chat.personaId ?? null,
      promptPresetId: chat.promptPresetId ?? null,
      connectionId: chat.connectionId ?? null,
      metadata: parseJsonObject(chat.metadata),
      createdAt: chat.createdAt ?? null,
      updatedAt: chat.updatedAt ?? null,
    },
    messages: messages.map((message) => ({
      role: message.role as "system" | "user" | "assistant" | "narrator",
      characterId: message.characterId ?? null,
      content: message.content,
      createdAt: message.createdAt ?? null,
    })),
  };
}

export async function importNativeLanChat(
  db: DB,
  exported: NativeLanChatExport,
  characterIdMap: Record<string, string>,
): Promise<{ success: boolean; id?: string; error?: string }> {
  const validation = validateNativeLanChatExport(exported);
  if (!validation.ok) return { success: false, error: validation.error };

  const chats = createChatsStorage(db);
  const remappedCharacterIds = exported.chat.characterIds.map((id) => characterIdMap[id]).filter(isString);
  const chat = await chats.create({
    name: exported.chat.name,
    mode: exported.chat.mode,
    characterIds: remappedCharacterIds,
    personaId: null,
    promptPresetId: null,
    connectionId: null,
  });
  if (!chat) return { success: false, error: "Failed to create chat" };

  await chats.createMessagesBatch(
    chat.id,
    exported.messages.map((message) => ({
      role: message.role,
      characterId: message.characterId ? (characterIdMap[message.characterId] ?? null) : null,
      content: message.content,
      createdAt: message.createdAt ?? undefined,
    })),
  );
  return { success: true, id: chat.id };
}

export function collectNativeLanChatCharacterIds(exported: NativeLanChatExport): string[] {
  const ids = new Set<string>();
  for (const id of exported.chat.characterIds) ids.add(id);
  for (const message of exported.messages) if (message.characterId) ids.add(message.characterId);
  return Array.from(ids);
}

function validateNativeLanChatExport(value: unknown): { ok: true } | { ok: false; error: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "Native chat export must be an object" };
  const record = value as NativeLanChatExport;
  if (record.type !== "marinara_lan_chat" || record.version !== 1) return { ok: false, error: "Unsupported native chat export" };
  if (!record.chat || typeof record.chat.name !== "string" || !Array.isArray(record.chat.characterIds)) {
    return { ok: false, error: "Native chat export has invalid chat metadata" };
  }
  if (!Array.isArray(record.messages)) return { ok: false, error: "Native chat export messages must be an array" };
  return { ok: true };
}

function parseCharacterIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter(isString);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(isString) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: unknown): unknown {
  if (!value || typeof value === "object") return value ?? {};
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
```

- [ ] **Step 4: Run native chat tests**

Run:

```bash
packages/server/node_modules/.bin/tsx --test packages/server/test/lan-transfer-native-chat.test.ts
```

Expected: the new test passes.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/lan-transfer/lan-transfer-native-chat.ts packages/server/test/lan-transfer-native-chat.test.ts
git commit -m "feat: add native LAN chat transfer format"
```

---

### Task 4: Package Builder Auto-Includes Character Dependencies

**Files:**
- Modify: `packages/server/src/services/lan-transfer/lan-transfer-package.ts`
- Test: `packages/server/test/lan-transfer-native-chat.test.ts`

- [ ] **Step 1: Write failing dependency packaging test**

Extend `packages/server/test/lan-transfer-native-chat.test.ts`:

```ts
test("LAN package for a chat includes its referenced character before the native chat item", async () =>
  withDb(async (db) => {
    const { buildLanTransferPackage } = await import("../src/services/lan-transfer/lan-transfer-package.js");
    const characters = createCharactersStorage(db);
    const chats = createChatsStorage(db);
    const character = await characters.create({ name: "Ari", description: "", first_mes: "Hi" } as any);
    assert.ok(character?.id);
    const chat = await chats.create({ name: "Ari chat", mode: "roleplay", characterIds: [character.id] });
    assert.ok(chat?.id);
    await chats.createMessagesBatch(chat.id, [{ role: "assistant", characterId: character.id, content: "Hello" }]);

    const fakeApp = { db } as any;
    const pkg = await buildLanTransferPackage(fakeApp, [{ type: "chat", id: chat.id, format: "native" }], "2999-01-01T00:00:00.000Z");

    assert.equal(pkg.items[0]?.type, "character");
    assert.equal(pkg.items[1]?.type, "chat");
    assert.equal((pkg.items[1] as any).format, "native");
    assert.equal(pkg.manifest.items.some((item) => item.type === "character" && item.name === "Ari"), true);
  }));
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
packages/server/node_modules/.bin/tsx --test packages/server/test/lan-transfer-native-chat.test.ts
```

Expected: package builder currently exports chat as JSONL and does not auto-include dependencies.

- [ ] **Step 3: Update package builder for native chat default**

In `packages/server/src/services/lan-transfer/lan-transfer-package.ts`:

```ts
import {
  buildNativeLanChatExport,
  collectNativeLanChatCharacterIds,
  importNativeLanChat,
  type NativeLanChatExport,
} from "./lan-transfer-native-chat.js";
```

Before iterating requested items, compute a deduped work list:

```ts
const requestedCharacters = new Set<string>();
const requestedChats: LanTransferItemRequest[] = [];

for (const item of items) {
  if (item.type === "character") requestedCharacters.add(item.id);
  else requestedChats.push({ ...item, format: item.format ?? "native" });
}
```

When processing a native chat, build the native export first, collect dependency IDs, append missing character items before appending the chat item, and compute manifest bytes from `JSON.stringify(nativeChat)`.

- [ ] **Step 4: Update validation for native chat items**

In `validateManifestItem()`, accept:

```ts
if (item.type === "chat" && item.format === "native") {
  if (typeof item.messageCount !== "number" || !Number.isInteger(item.messageCount) || item.messageCount < 0) {
    return { ok: false, error: "Native chat manifest item messageCount must be a non-negative integer" };
  }
  if (typeof item.characterCount !== "number" || !Number.isInteger(item.characterCount) || item.characterCount < 0) {
    return { ok: false, error: "Native chat manifest item characterCount must be a non-negative integer" };
  }
  return { ok: true };
}
```

In `validatePackageItem()`, accept `item.format === "native"` with `isNativeLanChatExport(item.chat)`.

- [ ] **Step 5: Import in dependency order and remap IDs**

In `importLanTransferPackage()`, do two passes:

```ts
const characterIdMap: Record<string, string> = {};

for (const item of pkg.items) {
  if (item.type !== "character") continue;
  const result = await importMarinara(item.envelope as any, app.db);
  if (result.success && result.id) {
    characterIdMap[item.id] = result.id;
    summary.imported.characters += 1;
  } else {
    summary.skipped.push({ type: item.type, name: item.name, reason: result.error ?? "Import failed" });
  }
}

for (const item of pkg.items) {
  if (item.type !== "chat") continue;
  if (item.format === "native") {
    const result = await importNativeLanChat(app.db, item.chat as NativeLanChatExport, characterIdMap);
    if (result.success) summary.imported.chats += 1;
    else summary.skipped.push({ type: item.type, name: item.name, reason: result.error ?? "Import failed" });
    continue;
  }
  // keep existing JSONL import fallback
}

summary.characterIdMap = characterIdMap;
```

- [ ] **Step 6: Run package/native tests**

Run:

```bash
packages/server/node_modules/.bin/tsx --test packages/server/test/lan-transfer-native-chat.test.ts packages/server/test/lan-transfer-routes.test.ts
```

Expected: native package tests pass and existing route tests still pass.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/services/lan-transfer/lan-transfer-package.ts packages/server/test/lan-transfer-native-chat.test.ts
git commit -m "feat: bundle chat character dependencies in LAN transfer"
```

---

### Task 5: Receiver Tries Sender Origins Without LAN Scanning

**Files:**
- Modify: `packages/server/src/routes/lan-transfer.routes.ts`
- Test: `packages/server/test/lan-transfer-routes.test.ts`

- [ ] **Step 1: Write failing fallback-origin route test**

Add a test that puts an unreachable private origin first and loopback second:

```ts
test("preview tries sender origins in order until one succeeds", async () =>
  withLanTransferApp({ LAN_TRANSFER_ENABLED: "1" }, async (app) => {
    const offerId = "route-preview-origin-fallback";
    const downloadToken = "download-token";
    lanTransferOfferStore.delete(offerId);
    lanTransferOfferStore.put({
      offerId,
      downloadTokenHash: hashLanTransferToken(downloadToken),
      expiresAtMs: Date.now() + 60_000,
      manifest: testManifest,
      encryptedPackage: testEncryptedPackage,
    });

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.equal(typeof address, "object");
    assert.notEqual(address, null);
    const workingOrigin = `http://127.0.0.1:${address.port}`;

    const transferPayload = serializeLanTransferPayload({
      type: LAN_TRANSFER_TYPE,
      version: LAN_TRANSFER_VERSION,
      from: "http://192.168.255.254:7860",
      origins: ["http://192.168.255.254:7860", workingOrigin],
      offerId,
      downloadToken,
      secret: "secret",
    });

    const response = await app.inject({ method: "POST", url: "/api/lan-transfer/preview", payload: { transferPayload } });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(JSON.parse(response.body).from, workingOrigin);
  }));
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
packages/server/node_modules/.bin/tsx --test packages/server/test/lan-transfer-routes.test.ts
```

Expected: route returns the first-origin fetch error instead of trying the second origin.

- [ ] **Step 3: Implement bounded origin iteration**

In `packages/server/src/routes/lan-transfer.routes.ts`, add:

```ts
async function fetchFromAnySenderOrigin<T>(
  payload: LanTransferPayload,
  endpoint: "manifest" | "download",
): Promise<{ origin: string; value: T }> {
  const origins = Array.from(new Set([...(payload.origins ?? []), payload.from])).slice(0, 5);
  const errors: string[] = [];
  for (const origin of origins) {
    const originResult = await validateLanTransferOrigin(origin);
    if (!originResult.ok) {
      errors.push(`${origin}: ${originResult.error}`);
      continue;
    }
    try {
      const value = await fetchSenderJson<T>({ ...payload, from: origin }, originResult, endpoint);
      return { origin, value };
    } catch (err) {
      errors.push(`${origin}: ${getErrorMessage(err)}`);
    }
  }
  throw new Error(`Unable to reach sender. Tried ${origins.length} origin${origins.length === 1 ? "" : "s"}: ${errors.join("; ")}`);
}
```

Update preview/import routes to call `fetchFromAnySenderOrigin()` and return the working origin as `from`.

- [ ] **Step 4: Run route tests**

Run:

```bash
packages/server/node_modules/.bin/tsx --test packages/server/test/lan-transfer-routes.test.ts
```

Expected: fallback-origin tests pass. Public origin rejection tests still reject public candidates before fetch.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/lan-transfer.routes.ts packages/server/test/lan-transfer-routes.test.ts
git commit -m "feat: try LAN transfer sender origin candidates"
```

---

### Task 6: Token-Gated Manifest/Download Basic Auth Exemption

**Files:**
- Modify: `packages/server/src/middleware/basic-auth.ts`
- Test: `packages/server/test/lan-transfer-routes.test.ts` or create `packages/server/test/basic-auth-lan-transfer.test.ts`

- [ ] **Step 1: Write failing Basic Auth route test**

Create a full app test if existing route-only app does not register `basicAuthHook`:

```ts
test("LAN transfer manifest and download are reachable without Basic Auth but still require token", async () => {
  const previousEnabled = process.env.LAN_TRANSFER_ENABLED;
  const previousUser = process.env.BASIC_AUTH_USER;
  const previousPass = process.env.BASIC_AUTH_PASS;
  process.env.LAN_TRANSFER_ENABLED = "1";
  process.env.BASIC_AUTH_USER = "user";
  process.env.BASIC_AUTH_PASS = "pass";
  try {
    const { buildApp } = await import("../src/app.js");
    const app = await buildApp();
    const offerId = "auth-bypass-offer";
    const downloadToken = "download-token";
    lanTransferOfferStore.delete(offerId);
    lanTransferOfferStore.put({
      offerId,
      downloadTokenHash: hashLanTransferToken(downloadToken),
      expiresAtMs: Date.now() + 60_000,
      manifest: testManifest,
      encryptedPackage: testEncryptedPackage,
    });
    await app.ready();

    const noToken = await app.inject({ method: "POST", url: `/api/lan-transfer/offers/${offerId}/manifest`, payload: {} });
    const validToken = await app.inject({
      method: "POST",
      url: `/api/lan-transfer/offers/${offerId}/manifest`,
      payload: { downloadToken },
    });

    assert.equal(noToken.statusCode, 400, noToken.body);
    assert.equal(validToken.statusCode, 200, validToken.body);
    await app.close();
  } finally {
    if (previousEnabled === undefined) delete process.env.LAN_TRANSFER_ENABLED;
    else process.env.LAN_TRANSFER_ENABLED = previousEnabled;
    if (previousUser === undefined) delete process.env.BASIC_AUTH_USER;
    else process.env.BASIC_AUTH_USER = previousUser;
    if (previousPass === undefined) delete process.env.BASIC_AUTH_PASS;
    else process.env.BASIC_AUTH_PASS = previousPass;
  }
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
packages/server/node_modules/.bin/tsx --test packages/server/test/lan-transfer-routes.test.ts
```

Expected: valid token request is blocked by Basic Auth before the route token check.

- [ ] **Step 3: Add narrow Basic Auth exemption**

In `packages/server/src/middleware/basic-auth.ts`, add a helper near existing exempt path logic:

```ts
function isLanTransferTokenEndpoint(pathname: string, method: string): boolean {
  if (method !== "POST") return false;
  return /^\/api\/lan-transfer\/offers\/[^/]+\/(manifest|download)$/.test(pathname);
}
```

At the beginning of the auth hook, after health/static exemptions and before remote auth refusal, add:

```ts
if (isLanTransferTokenEndpoint(url.pathname, req.method)) {
  return;
}
```

Do not exempt `POST /api/lan-transfer/offers`, `DELETE /api/lan-transfer/offers/:id`, `/preview`, or `/import-from-offer`.

- [ ] **Step 4: Run Basic Auth and route tests**

Run:

```bash
packages/server/node_modules/.bin/tsx --test packages/server/test/lan-transfer-routes.test.ts
```

Expected: token endpoint is reachable, invalid/missing tokens still fail in the route, and all existing auth behavior remains unchanged for normal APIs.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/middleware/basic-auth.ts packages/server/test/lan-transfer-routes.test.ts
git commit -m "feat: allow token-gated LAN transfer downloads"
```

---

### Task 7: Frontend Sender/Receiver UX Updates

**Files:**
- Modify: `packages/client/src/hooks/use-lan-transfer.ts`
- Modify: `packages/client/src/components/modals/SendToDeviceModal.tsx`
- Modify: `packages/client/src/components/modals/ReceiveFromDeviceModal.tsx`

- [ ] **Step 1: Read frontend instructions before editing**

Run:

```bash
sed -n '1,220p' packages/client/.instructions.md
```

Expected: confirm React/TanStack/modal conventions and no barrel exports.

- [ ] **Step 2: Update receive preview normalization for native chats**

In `ReceiveFromDeviceModal.tsx`, change chat manifest handling from JSONL-only to both formats:

```ts
if (type === "chat") {
  if (format === "jsonl") {
    if (typeof item.messageCount !== "number" || !Number.isFinite(item.messageCount)) return null;
    items.push({ type: "chat", id, name, format: "jsonl", messageCount: item.messageCount, bytes });
    continue;
  }
  if (format === "native") {
    if (typeof item.messageCount !== "number" || !Number.isFinite(item.messageCount)) return null;
    if (typeof item.characterCount !== "number" || !Number.isFinite(item.characterCount)) return null;
    items.push({
      type: "chat",
      id,
      name,
      format: "native",
      messageCount: item.messageCount,
      characterCount: item.characterCount,
      bytes,
    });
    continue;
  }
  return null;
}
```

- [ ] **Step 3: Show bundled native chat context in preview**

In the preview list badge logic, replace `getItemTypeLabel(item.type)` with:

```ts
function getItemTypeLabel(item: LanTransferPreviewResponse["manifest"]["items"][number]) {
  if (item.type === "chat" && item.format === "native") {
    return `Chat + ${item.characterCount} ${item.characterCount === 1 ? "card" : "cards"}`;
  }
  if (item.type === "chat") return "Chat";
  if (item.type === "character") return "Character";
  return item.type;
}
```

Update the call site:

```tsx
{getItemTypeLabel(item)}
```

- [ ] **Step 4: Show selected sender origin without making users edit raw payloads**

In `SendToDeviceModal.tsx`, derive the primary origin from the offer payload for display:

```ts
const senderOrigin = useMemo(() => {
  if (!offer?.transferPayload) return null;
  try {
    const parsed = JSON.parse(offer.transferPayload) as { origins?: unknown; from?: unknown };
    if (Array.isArray(parsed.origins) && typeof parsed.origins[0] === "string") return parsed.origins[0];
    return typeof parsed.from === "string" ? parsed.from : null;
  } catch {
    return null;
  }
}, [offer?.transferPayload]);
```

Add a compact status line above the QR code:

```tsx
{senderOrigin && (
  <div className="rounded-lg border border-[var(--border)]/60 bg-[var(--muted)]/30 px-3 py-2 text-sm text-[var(--muted-foreground)]">
    Sending from <span className="font-mono text-[var(--foreground)]">{senderOrigin}</span>
  </div>
)}
```

Keep the raw payload textarea as a fallback but move it visually below the QR/copy path.

- [ ] **Step 5: Run TypeScript/lint checks for client code**

Run:

```bash
pnpm --filter @marinara-engine/client build
pnpm lint
```

Expected: client build and lint pass.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/hooks/use-lan-transfer.ts packages/client/src/components/modals/SendToDeviceModal.tsx packages/client/src/components/modals/ReceiveFromDeviceModal.tsx
git commit -m "feat: clarify LAN transfer chat bundle UX"
```

---

### Task 8: Documentation And End-To-End Validation

**Files:**
- Modify: `docs/superpowers/specs/2026-05-19-lan-device-transfer-design.md`
- Optional Modify: `docs/FAQ.md`

- [ ] **Step 1: Update design doc with phase-2 behavior**

Append a `Phase 2` section to `docs/superpowers/specs/2026-05-19-lan-device-transfer-design.md`:

```md
## Phase 2: Native Chat Bundles And Sender-Origin Candidates

Phase 2 makes chat transfer self-contained. A chat sent over LAN uses a native Marinara package item and automatically includes referenced character cards. The receiver imports characters first, remaps source character IDs to imported character IDs, then imports the chat and messages. This avoids placeholder `Assistant` chats when the receiving device does not already have the exact source card.

Sender-origin discovery remains self-discovery only. Marinara advertises a bounded list of its own candidate origins, such as a configured `LAN_TRANSFER_PUBLIC_ORIGIN`, private IPv4 interface URLs, and the request origin. The receiver tries only the origins embedded in the user-provided payload; it does not scan subnets or discover arbitrary devices.
```

- [ ] **Step 2: Run focused server tests**

Run:

```bash
packages/server/node_modules/.bin/tsx --test packages/server/test/lan-transfer-routes.test.ts packages/server/test/lan-transfer-native-chat.test.ts
```

Expected: all LAN transfer tests pass.

- [ ] **Step 3: Run build/lint validation**

Run:

```bash
pnpm --filter @marinara-engine/shared build
pnpm --filter @marinara-engine/server build
pnpm --filter @marinara-engine/client build
pnpm lint
git diff --check
```

Expected: all commands pass. If `pnpm check` is still blocked by the existing Impeccable loader issue, record that separately and do not claim it passed.

- [ ] **Step 4: Manual smoke test Linux to Android**

Start Linux sender:

```bash
HOST=0.0.0.0 LAN_TRANSFER_ENABLED=true pnpm dev
```

On Linux sender:
- Open Marinara at the LAN URL, for example `http://192.168.1.230:7860`.
- Open an existing character chat.
- Choose `Send to Device`.
- Confirm the modal displays a LAN sender origin without manual payload editing.
- Keep the sender modal open.

On Android receiver:
- Keep WireGuard off for the Wi-Fi smoke path unless the VPN route is intentionally configured.
- Open Android Marinara.
- Open `Receive from Device`.
- Paste or scan the payload.
- Preview the transfer.
- Confirm the preview says the chat includes character cards.
- Import.
- Open the imported chat and confirm it is linked to the imported character, not `Assistant`.
- Confirm the character avatar appears.

- [ ] **Step 5: Manual smoke test Android to Linux**

Repeat the same flow in reverse. Confirm the Termux `LAN access:` URL can appear as the sender origin without hand-editing the payload.

- [ ] **Step 6: Commit docs/validation notes**

```bash
git add docs/superpowers/specs/2026-05-19-lan-device-transfer-design.md
git commit -m "docs: describe LAN transfer phase two behavior"
```

---

## Self-Review

- Spec coverage: the plan covers self-discovered sender origins, bounded receiver retries, no LAN scanning, native chat transfer, character dependency bundling, avatar/sprite/gallery preservation through existing native character envelopes, Basic Auth friction for token-gated endpoints, frontend preview updates, and Linux-to-Android/Android-to-Linux smoke tests.
- Placeholder scan: no task depends on an undefined future decision. The only optional file is `docs/FAQ.md`, which is not required for implementation success.
- Type consistency: shared types define `origins`, native chat manifest items, native chat package items, and `characterIdMap`; backend tasks consume the same names; frontend preview normalization uses the same manifest shape.

