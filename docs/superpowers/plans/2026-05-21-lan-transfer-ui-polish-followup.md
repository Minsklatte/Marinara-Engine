# LAN Transfer UI Polish Follow-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LAN transfer receive/send UI read like sync: clear grouped preview, no empty-import success toast, disabled no-op imports, and sender-side guidance/status.

**Architecture:** Keep import behavior server-side unchanged, but expose one lightweight offer-status endpoint so the sender modal can show lifecycle state. Move receive-preview display and import-summary decisions into a small client utility module with unit tests, then wire `ReceiveFromDeviceModal.tsx` and `SendToDeviceModal.tsx` to those helpers.

**Tech Stack:** React 19, TypeScript, TanStack Query mutations/queries, Tailwind utility classes, Lucide icons, Sonner toasts, Fastify route tests with Node test/tsx.

---

## File Structure

- Create: `packages/client/src/lib/lan-transfer-receive-ui.ts`
  - Pure helpers for grouped preview rows, chip tones, no-op detection, import button copy, and toast summary.
- Create: `packages/client/test/lan-transfer-receive-ui.test.ts`
  - Unit tests for no-op preview gating, append/import/copy cases, grouped rows, and no-op toast copy.
- Modify: `packages/client/src/components/modals/ReceiveFromDeviceModal.tsx`
  - Use helper view models.
  - Disable smart-mode empty imports before download.
  - Render neutral no-op status inline.
  - Use `toast.info` for defensive no-op import fallback.
  - Color-code card/chat/action chips.
- Modify: `packages/shared/src/types/lan-transfer.ts`
  - Add sender offer status response type.
- Modify: `packages/server/src/services/lan-transfer/lan-transfer-offer-store.ts`
  - Track `previewedAtMs` and `downloadedAtMs` for active offers.
- Modify: `packages/server/src/routes/lan-transfer.routes.ts`
  - Mark manifest preview/download events.
  - Add local status route for the sender modal.
- Modify: `packages/server/test/lan-transfer-routes.test.ts`
  - Verify offer status moves from waiting, to previewed, to downloaded.
- Modify: `packages/client/src/hooks/use-lan-transfer.ts`
  - Add `useLanTransferOfferStatus(offerId, enabled)`.
- Modify: `packages/client/src/components/modals/SendToDeviceModal.tsx`
  - Show receiving-device instructions.
  - Show sender status: waiting, preview opened, downloaded/import may be completing, expired/unavailable.

---

### Task 1: Add Receive UI Pure Helpers and Tests

**Files:**
- Create: `packages/client/src/lib/lan-transfer-receive-ui.ts`
- Create: `packages/client/test/lan-transfer-receive-ui.test.ts`

- [ ] **Step 1: Write failing tests for no-op, append, copy, grouped rows, and toast copy**

Create `packages/client/test/lan-transfer-receive-ui.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import type { LanTransferImportSummary, LanTransferPreviewAction, LanTransferPreviewResponse } from "@marinara-engine/shared";
import {
  buildLanTransferPreviewRows,
  getImportButtonLabel,
  getLanTransferImportToast,
  isLanTransferPreviewNoOp,
} from "../src/lib/lan-transfer-receive-ui.js";

const reuseCard: LanTransferPreviewAction = {
  type: "character",
  sourceId: "char-sync",
  name: "Alicia",
  action: "reuse",
  targetId: "local-char",
  reason: "Matching native character already exists",
};

const skipChat: LanTransferPreviewAction = {
  type: "chat",
  sourceId: "chat-sync",
  name: "Alicia Chat",
  action: "skip",
  targetId: "local-chat",
  messageCount: 2,
  linkedCharacterNames: ["Alicia"],
  reason: "Existing synced chat is already up to date",
};

const appendChat: LanTransferPreviewAction = {
  ...skipChat,
  action: "append",
  appendCount: 3,
  reason: "Existing synced chat is missing 3 newer messages",
};

function preview(actions: LanTransferPreviewAction[]): LanTransferPreviewResponse {
  return {
    from: "http://192.168.1.230:7860",
    offerId: "offer",
    expiresAt: "2999-01-01T00:00:00.000Z",
    manifest: {
      version: 1,
      createdAt: "2026-05-21T00:00:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z",
      sourceApp: "Marinara Engine",
      sourceVersion: "1.6.0",
      totalBytes: 100,
      items: [
        {
          type: "character",
          id: "char-sync",
          syncId: "char-sync",
          name: "Alicia",
          format: "native",
          fingerprint: "fingerprint",
          bytes: 40,
        },
        {
          type: "chat",
          id: "chat-sync",
          syncId: "chat-sync",
          name: "Alicia Chat",
          format: "native",
          messageCount: 2,
          characterCount: 1,
          characterIds: ["char-sync"],
          bytes: 60,
        },
      ],
    },
    analysis: { mode: "smart", actions },
  };
}

test("smart preview with only reused cards and skipped chats is a no-op", () => {
  assert.equal(isLanTransferPreviewNoOp(preview([reuseCard, skipChat]), false), true);
  assert.equal(getImportButtonLabel(preview([reuseCard, skipChat]), false), "Already up to date");
});

test("copy mode is never blocked as a no-op", () => {
  assert.equal(isLanTransferPreviewNoOp(preview([reuseCard, skipChat]), true), false);
  assert.equal(getImportButtonLabel(preview([reuseCard, skipChat]), true), "Import Copies");
});

test("append and import actions are not no-ops", () => {
  assert.equal(isLanTransferPreviewNoOp(preview([reuseCard, appendChat]), false), false);
  assert.equal(getImportButtonLabel(preview([reuseCard, appendChat]), false), "Import");
});

test("preview rows group card and chat under one character without linked-to copy", () => {
  const rows = buildLanTransferPreviewRows(preview([reuseCard, appendChat]), false);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.title, "Alicia");
  assert.deepEqual(rows[0]?.chips.map((chip) => chip.label), ["1 card", "1 chat"]);
  assert.deepEqual(rows[0]?.actions.map((chip) => chip.label), ["Using existing card", "Will add 3 messages"]);
  assert.equal(rows[0]?.actions.some((chip) => chip.label.includes("linked to")), false);
});

test("empty smart import toast is neutral and does not claim an import happened", () => {
  const summary: LanTransferImportSummary = {
    imported: { chats: 0, characters: 0 },
    reused: { chats: 1, characters: 1 },
    skipped: [],
  };

  assert.deepEqual(getLanTransferImportToast(summary), {
    kind: "info",
    message: "Nothing changed. This device is already up to date.",
    closeModal: false,
  });
});

test("append-only import toast reports the actual update", () => {
  const summary: LanTransferImportSummary = {
    imported: { chats: 0, characters: 0 },
    reused: { characters: 1, chats: 0 },
    appended: { chats: 1, messages: 3 },
    skipped: [],
  };

  assert.deepEqual(getLanTransferImportToast(summary), {
    kind: "success",
    message: "Updated 1 chat with 3 new messages; used 1 existing card.",
    closeModal: true,
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm exec tsx --test packages/client/test/lan-transfer-receive-ui.test.ts
```

Expected: FAIL because `packages/client/src/lib/lan-transfer-receive-ui.ts` does not exist.

- [ ] **Step 3: Implement the helper module**

Create `packages/client/src/lib/lan-transfer-receive-ui.ts`:

```ts
import type {
  LanTransferImportSummary,
  LanTransferPreviewAction,
  LanTransferPreviewResponse,
} from "@marinara-engine/shared";

type PreviewManifestItem = LanTransferPreviewResponse["manifest"]["items"][number];

export type LanTransferChipTone = "neutral" | "card" | "chat" | "success" | "update" | "warning" | "copy";

export interface LanTransferPreviewChip {
  label: string;
  tone: LanTransferChipTone;
}

export interface LanTransferPreviewRow {
  key: string;
  title: string;
  chips: LanTransferPreviewChip[];
  actions: LanTransferPreviewChip[];
}

export interface LanTransferImportToast {
  kind: "success" | "info" | "warning";
  message: string;
  closeModal: boolean;
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function joinParts(parts: string[]) {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

function getActionKey(action: LanTransferPreviewAction) {
  return `${action.type}:${action.sourceId}`;
}

function getLinkedCharacterNames(item: PreviewManifestItem, action?: LanTransferPreviewAction) {
  if (action?.type === "chat" && action.sourceId === item.id && action.linkedCharacterNames?.length) {
    return action.linkedCharacterNames;
  }
  return undefined;
}

function getPrimaryLinkedCharacterName(item: PreviewManifestItem, action?: LanTransferPreviewAction) {
  const names = getLinkedCharacterNames(item, action);
  return names?.length === 1 ? names[0] : null;
}

function summarizeItemChips(chips: LanTransferPreviewChip[]) {
  const cardCount = chips.filter((chip) => chip.label === "1 card").length;
  const chatCount = chips.filter((chip) => chip.label === "1 chat").length;
  const summarized: LanTransferPreviewChip[] = [];

  if (cardCount > 0) summarized.push({ label: pluralize(cardCount, "card"), tone: "card" });
  if (chatCount > 0) summarized.push({ label: pluralize(chatCount, "chat"), tone: "chat" });
  summarized.push(...chips.filter((chip) => chip.label !== "1 card" && chip.label !== "1 chat"));
  return summarized;
}

function getItemChip(item: PreviewManifestItem): LanTransferPreviewChip {
  return item.type === "character" ? { label: "1 card", tone: "card" } : { label: "1 chat", tone: "chat" };
}

function getActionChip(action: LanTransferPreviewAction | undefined, importAsCopies: boolean): LanTransferPreviewChip | null {
  if (importAsCopies) return { label: "Will import a copy", tone: "copy" };
  if (!action) return null;

  if (action.type === "character") {
    return action.action === "reuse"
      ? { label: "Using existing card", tone: "success" }
      : { label: "Will import card", tone: "card" };
  }

  if (action.action === "skip") return { label: "Already up to date", tone: "success" };
  if (action.action === "append") {
    return { label: `Will add ${pluralize(action.appendCount ?? 0, "message")}`, tone: "update" };
  }
  if (action.action === "conflict-copy") return { label: "History differs; will import a copy", tone: "warning" };
  return { label: "Will import chat", tone: "chat" };
}

function dedupeChips(chips: LanTransferPreviewChip[]) {
  const seen = new Set<string>();
  return chips.filter((chip) => {
    const key = `${chip.tone}:${chip.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildLanTransferPreviewRows(
  preview: LanTransferPreviewResponse,
  importAsCopies: boolean,
): LanTransferPreviewRow[] {
  const actions = new Map((preview.analysis?.actions ?? []).map((action) => [getActionKey(action), action]));
  const rows: LanTransferPreviewRow[] = [];
  const groupedByCharacter = new Map<string, LanTransferPreviewRow>();

  for (const item of preview.manifest.items) {
    const action = actions.get(`${item.type}:${item.id}`);
    const title = item.type === "character" ? item.name : getPrimaryLinkedCharacterName(item, action);
    const chip = getItemChip(item);
    const actionChip = getActionChip(action, importAsCopies);

    if (title) {
      const existing = groupedByCharacter.get(title);
      if (existing) {
        existing.chips.push(chip);
        if (actionChip) existing.actions.push(actionChip);
        continue;
      }

      const row = {
        key: `group:${title}:${item.id}`,
        title,
        chips: [chip],
        actions: actionChip ? [actionChip] : [],
      };
      groupedByCharacter.set(title, row);
      rows.push(row);
      continue;
    }

    rows.push({
      key: `${item.type}:${item.id}`,
      title: item.name,
      chips: [chip],
      actions: actionChip ? [actionChip] : [],
    });
  }

  return rows.map((row) => ({
    ...row,
    chips: summarizeItemChips(row.chips),
    actions: dedupeChips(row.actions),
  }));
}

export function isLanTransferPreviewNoOp(
  preview: LanTransferPreviewResponse | null,
  importAsCopies: boolean,
): boolean {
  if (!preview || importAsCopies) return false;
  const actions = preview.analysis?.actions;
  if (!actions || actions.length === 0) return false;
  return actions.every((action) => {
    if (action.type === "character") return action.action === "reuse";
    return action.action === "skip";
  });
}

export function getImportButtonLabel(preview: LanTransferPreviewResponse | null, importAsCopies: boolean) {
  if (importAsCopies) return "Import Copies";
  if (isLanTransferPreviewNoOp(preview, false)) return "Already up to date";
  return "Import";
}

function pushCount(parts: string[], count: number | undefined, singular: string, plural?: string) {
  if (typeof count === "number" && count > 0) parts.push(pluralize(count, singular, plural));
}

export function getLanTransferImportToast(summary: LanTransferImportSummary): LanTransferImportToast {
  const copiedChats = summary.copied?.chats ?? 0;
  const copiedCharacters = summary.copied?.characters ?? 0;
  const importedChats = Math.max(0, summary.imported.chats - copiedChats);
  const importedCharacters = Math.max(0, summary.imported.characters - copiedCharacters);
  const appendedMessages = summary.appended?.messages ?? 0;
  const appendedChats = summary.appended?.chats ?? 0;
  const changedCount = importedChats + importedCharacters + copiedChats + copiedCharacters + appendedMessages;
  const copiedParts: string[] = [];
  const importedParts: string[] = [];
  const existingParts: string[] = [];
  const sentences: string[] = [];

  if (changedCount === 0 && summary.skipped.length === 0) {
    return {
      kind: "info",
      message: "Nothing changed. This device is already up to date.",
      closeModal: false,
    };
  }

  if (appendedMessages > 0) {
    sentences.push(`Updated ${pluralize(appendedChats, "chat")} with ${pluralize(appendedMessages, "new message")}`);
  }

  pushCount(importedParts, importedChats, "chat");
  pushCount(importedParts, importedCharacters, "card");
  pushCount(copiedParts, copiedChats, "chat");
  pushCount(copiedParts, copiedCharacters, "card");
  pushCount(existingParts, summary.reused?.characters, "existing card");
  pushCount(existingParts, summary.reused?.chats, "existing chat");

  if (importedParts.length > 0) sentences.push(`Imported ${joinParts(importedParts)}`);
  if (copiedParts.length > 0) sentences.push(`Imported ${joinParts(copiedParts)} as copies`);
  if (existingParts.length > 0) sentences.push(`Used ${joinParts(existingParts)}`);
  if (summary.skipped.length > 0) sentences.push(`Skipped ${summary.skipped.length}`);

  return {
    kind: summary.skipped.length > 0 ? "warning" : "success",
    message: `${sentences.join("; ")}.`,
    closeModal: true,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
pnpm exec tsx --test packages/client/test/lan-transfer-receive-ui.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit helper extraction**

```bash
git add packages/client/src/lib/lan-transfer-receive-ui.ts packages/client/test/lan-transfer-receive-ui.test.ts
git commit -m "test: cover LAN receive UI outcomes"
```

---

### Task 2: Wire Receive Modal Empty-Import Gate and Color-Coded Preview

**Files:**
- Modify: `packages/client/src/components/modals/ReceiveFromDeviceModal.tsx`
- Test: `packages/client/test/lan-transfer-receive-ui.test.ts`

- [ ] **Step 1: Import helper functions and chip type**

In `packages/client/src/components/modals/ReceiveFromDeviceModal.tsx`, add:

```ts
import {
  buildLanTransferPreviewRows,
  getImportButtonLabel,
  getLanTransferImportToast,
  isLanTransferPreviewNoOp,
  type LanTransferChipTone,
} from "../../lib/lan-transfer-receive-ui";
```

- [ ] **Step 2: Remove duplicated local preview-row and summary helpers**

Delete these local definitions from `ReceiveFromDeviceModal.tsx`:

```ts
interface PreviewDisplayRow { /* ... */ }
function getLinkedCharacterNames(...) { /* ... */ }
function getActionLabel(...) { /* ... */ }
function getVisibleActionLabel(...) { /* ... */ }
function getActionKey(...) { /* ... */ }
function getPrimaryLinkedCharacterName(...) { /* ... */ }
function getStandaloneItemChip(...) { /* ... */ }
function summarizePreviewChips(...) { /* ... */ }
function buildPreviewRows(...) { /* ... */ }
function pushCountPart(...) { /* ... */ }
function joinCountParts(...) { /* ... */ }
function getImportSummary(...) { /* ... */ }
```

Keep `pluralize()` if the modal still uses it for `previewSummary`; otherwise remove it too.

- [ ] **Step 3: Add chip styling helper**

Add below `normalizePreviewResponse()`:

```ts
function getChipClassName(tone: LanTransferChipTone) {
  const base = "max-w-full truncate rounded-md border px-2 py-1 text-xs font-semibold sm:max-w-72";
  if (tone === "card") {
    return `${base} border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-200`;
  }
  if (tone === "chat") {
    return `${base} border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200`;
  }
  if (tone === "success") {
    return `${base} border-green-500/25 bg-green-500/10 text-green-700 dark:text-green-200`;
  }
  if (tone === "update") {
    return `${base} border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200`;
  }
  if (tone === "warning") {
    return `${base} border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-200`;
  }
  if (tone === "copy") {
    return `${base} border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-200`;
  }
  return `${base} border-[var(--border)] bg-[var(--muted)] text-[var(--muted-foreground)]`;
}
```

- [ ] **Step 4: Compute no-op state and button copy**

Inside `ReceiveFromDeviceModal`, replace:

```ts
const canImport = trimmedPayload.length > 0 && previewedPayload === trimmedPayload && !isBusy;
```

With:

```ts
const isPreviewNoOp = isLanTransferPreviewNoOp(preview, importAsCopies);
const canImport = trimmedPayload.length > 0 && previewedPayload === trimmedPayload && !isBusy && !isPreviewNoOp;
const importButtonLabel = getImportButtonLabel(preview, importAsCopies);
```

- [ ] **Step 5: Use helper rows**

Replace the existing `actionByItemKey` and `previewRows` memos with:

```ts
const previewRows = useMemo(() => {
  if (!preview) return [];
  return buildLanTransferPreviewRows(preview, importAsCopies);
}, [importAsCopies, preview]);
```

- [ ] **Step 6: Add inline no-op status**

After the preview header and before the row list, add:

```tsx
{isPreviewNoOp && (
  <div className="rounded-lg border border-[var(--border)]/60 bg-[var(--muted)]/30 p-3 text-sm text-[var(--muted-foreground)]">
    Nothing to import. This device already has this card and chat up to date.
  </div>
)}
```

Use this slightly broader copy when there are multiple rows:

```tsx
{isPreviewNoOp && (
  <div className="rounded-lg border border-[var(--border)]/60 bg-[var(--muted)]/30 p-3 text-sm text-[var(--muted-foreground)]">
    Nothing to import. This device already has the selected cards and chats up to date.
  </div>
)}
```

- [ ] **Step 7: Render typed chip view models**

Replace row chip rendering with:

```tsx
{row.chips.map((chip) => (
  <span key={`${chip.tone}:${chip.label}`} title={chip.label} className={getChipClassName(chip.tone)}>
    {chip.label}
  </span>
))}
{row.actions.map((chip) => (
  <span key={`${chip.tone}:${chip.label}`} title={chip.label} className={getChipClassName(chip.tone)}>
    {chip.label}
  </span>
))}
```

- [ ] **Step 8: Use toast result helper**

Replace:

```ts
toast.success(getImportSummary(summary));
onClose();
```

With:

```ts
const resultToast = getLanTransferImportToast(summary);
if (resultToast.kind === "info") toast.info(resultToast.message);
else if (resultToast.kind === "warning") toast.warning(resultToast.message);
else toast.success(resultToast.message);
if (resultToast.closeModal) onClose();
```

- [ ] **Step 9: Use dynamic button label**

Replace the import button text:

```tsx
Import
```

With:

```tsx
{importButtonLabel}
```

- [ ] **Step 10: Run focused tests and lint**

Run:

```bash
pnpm exec tsx --test packages/client/test/lan-transfer-receive-ui.test.ts
pnpm --filter @marinara-engine/client exec eslint src/components/modals/ReceiveFromDeviceModal.tsx src/lib/lan-transfer-receive-ui.ts test/lan-transfer-receive-ui.test.ts
```

Expected: tests pass and ESLint exits `0`.

- [ ] **Step 11: Commit receive modal polish**

```bash
git add packages/client/src/components/modals/ReceiveFromDeviceModal.tsx packages/client/src/lib/lan-transfer-receive-ui.ts packages/client/test/lan-transfer-receive-ui.test.ts
git commit -m "fix: prevent empty LAN receive imports"
```

---

### Task 3: Add Sender Offer Status Endpoint

**Files:**
- Modify: `packages/shared/src/types/lan-transfer.ts`
- Modify: `packages/server/src/services/lan-transfer/lan-transfer-offer-store.ts`
- Modify: `packages/server/src/routes/lan-transfer.routes.ts`
- Modify: `packages/server/test/lan-transfer-routes.test.ts`

- [ ] **Step 1: Add shared status type**

In `packages/shared/src/types/lan-transfer.ts`, add after `LanTransferCreateOfferResponse`:

```ts
export interface LanTransferOfferStatusResponse {
  offerId: string;
  expiresAt: string;
  state: "waiting" | "previewed" | "downloaded" | "missing";
  previewedAt?: string;
  downloadedAt?: string;
}
```

- [ ] **Step 2: Extend stored offers**

In `packages/server/src/services/lan-transfer/lan-transfer-offer-store.ts`, update `LanTransferStoredOffer`:

```ts
export interface LanTransferStoredOffer {
  offerId: string;
  downloadTokenHash: string;
  expiresAtMs: number;
  manifest: LanTransferManifest;
  encryptedPackage: LanTransferEncryptedPackage;
  previewedAtMs?: number;
  downloadedAtMs?: number;
}
```

Update `LanTransferOfferStore`:

```ts
markPreviewed(offerId: string): LanTransferStoredOffer | null;
markDownloaded(offerId: string): LanTransferStoredOffer | null;
```

Implement in `createLanTransferOfferStore()`:

```ts
markPreviewed(offerId) {
  pruneExpired();
  const offer = offers.get(offerId) ?? null;
  if (!offer) return null;
  offer.previewedAtMs = offer.previewedAtMs ?? now();
  return offer;
},
markDownloaded(offerId) {
  pruneExpired();
  const offer = offers.get(offerId) ?? null;
  if (!offer) return null;
  offer.downloadedAtMs = offer.downloadedAtMs ?? now();
  return offer;
},
```

- [ ] **Step 3: Add route test for status transitions**

In `packages/server/test/lan-transfer-routes.test.ts`, add a test near the existing offer route tests:

```ts
test("sender offer status tracks preview and download lifecycle", async () =>
  withLanTransferApp({ LAN_TRANSFER_ENABLED: "1" }, async (app) => {
    const chats = createChatsStorage(app.db);
    const chat = await chats.create({ name: "Status smoke", mode: "roleplay", characterIds: [] });
    assert.ok(chat?.id);

    const create = await app.inject({
      method: "POST",
      url: "/api/lan-transfer/offers",
      payload: { items: [{ type: "chat", id: chat.id }] },
    });
    assert.equal(create.statusCode, 200);
    const created = JSON.parse(create.body) as { offerId: string; transferPayload: string };
    const payload = JSON.parse(created.transferPayload) as { downloadToken: string };

    const waiting = await app.inject({ method: "GET", url: `/api/lan-transfer/offers/${created.offerId}/status` });
    assert.equal(waiting.statusCode, 200);
    assert.equal(JSON.parse(waiting.body).state, "waiting");

    const manifest = await app.inject({
      method: "POST",
      url: `/api/lan-transfer/offers/${created.offerId}/manifest`,
      payload: { downloadToken: payload.downloadToken },
    });
    assert.equal(manifest.statusCode, 200);

    const previewed = await app.inject({ method: "GET", url: `/api/lan-transfer/offers/${created.offerId}/status` });
    assert.equal(previewed.statusCode, 200);
    assert.equal(JSON.parse(previewed.body).state, "previewed");
    assert.equal(typeof JSON.parse(previewed.body).previewedAt, "string");

    const download = await app.inject({
      method: "POST",
      url: `/api/lan-transfer/offers/${created.offerId}/download`,
      payload: { downloadToken: payload.downloadToken },
    });
    assert.equal(download.statusCode, 200);

    const downloaded = await app.inject({ method: "GET", url: `/api/lan-transfer/offers/${created.offerId}/status` });
    assert.equal(downloaded.statusCode, 200);
    assert.equal(JSON.parse(downloaded.body).state, "downloaded");
  }));
```

- [ ] **Step 4: Run route test and confirm it fails**

Run:

```bash
pnpm --filter @marinara-engine/server exec tsx --test test/lan-transfer-routes.test.ts
```

Expected: FAIL with HTTP 404 for `/status`.

- [ ] **Step 5: Implement status route and lifecycle marking**

In `packages/server/src/routes/lan-transfer.routes.ts`, import the shared response type:

```ts
import type { LanTransferOfferStatusResponse } from "@marinara-engine/shared";
```

In the manifest route, after token verification:

```ts
lanTransferOfferStore.markPreviewed(request.params.offerId);
```

In the download route, before `consume()`:

```ts
lanTransferOfferStore.markDownloaded(request.params.offerId);
```

Change download to keep a consumed status briefly instead of deleting all status immediately by updating the store in the previous step to retain downloaded offers until expiry. If keeping consumed package data is undesirable, split offer data into active package + status metadata:

```ts
// Store keeps status metadata until expiry, but consume removes encryptedPackage.
```

For the MVP, acceptable minimal implementation is to let `consume()` leave a status-only record with `encryptedPackage: null` internally, while `get()` returns only active offers for manifest/download. Keep the public TypeScript interfaces strict by adding a separate private `StoredOfferRecord`.

Add this route before `DELETE /offers/:offerId`:

```ts
app.get<{ Params: { offerId: string } }>("/offers/:offerId/status", async (request, reply) => {
  const offer = lanTransferOfferStore.getStatus(request.params.offerId);
  if (!offer) {
    return reply.send({
      offerId: request.params.offerId,
      expiresAt: new Date(0).toISOString(),
      state: "missing",
    } satisfies LanTransferOfferStatusResponse);
  }

  const state = offer.downloadedAtMs ? "downloaded" : offer.previewedAtMs ? "previewed" : "waiting";
  return reply.send({
    offerId: offer.offerId,
    expiresAt: offer.manifest.expiresAt,
    state,
    ...(offer.previewedAtMs ? { previewedAt: new Date(offer.previewedAtMs).toISOString() } : {}),
    ...(offer.downloadedAtMs ? { downloadedAt: new Date(offer.downloadedAtMs).toISOString() } : {}),
  } satisfies LanTransferOfferStatusResponse);
});
```

- [ ] **Step 6: Run route tests**

Run:

```bash
pnpm --filter @marinara-engine/server exec tsx --test test/lan-transfer-routes.test.ts
pnpm --filter @marinara-engine/server lint
```

Expected: route tests pass and server lint exits `0`.

- [ ] **Step 7: Commit sender status backend**

```bash
git add packages/shared/src/types/lan-transfer.ts packages/server/src/services/lan-transfer/lan-transfer-offer-store.ts packages/server/src/routes/lan-transfer.routes.ts packages/server/test/lan-transfer-routes.test.ts
git commit -m "feat: expose LAN transfer offer status"
```

---

### Task 4: Wire Sender Modal Instructions and Status

**Files:**
- Modify: `packages/client/src/hooks/use-lan-transfer.ts`
- Modify: `packages/client/src/components/modals/SendToDeviceModal.tsx`

- [ ] **Step 1: Add offer status hook**

In `packages/client/src/hooks/use-lan-transfer.ts`, update imports:

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LanTransferOfferStatusResponse } from "@marinara-engine/shared";
```

Add:

```ts
export function useLanTransferOfferStatus(offerId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["lan-transfer", "offer-status", offerId],
    queryFn: () => api.get<LanTransferOfferStatusResponse>(`/lan-transfer/offers/${encodeURIComponent(offerId!)}/status`),
    enabled: enabled && !!offerId,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === "downloaded" || state === "missing" ? false : 1500;
    },
  });
}
```

- [ ] **Step 2: Import hook and status icons**

In `packages/client/src/components/modals/SendToDeviceModal.tsx`, change imports:

```ts
import { CheckCircle2, Clipboard, Loader2, QrCode, Radio, TriangleAlert, XCircle } from "lucide-react";
import { useCancelLanTransferOffer, useCreateLanTransferOffer, useLanTransferOfferStatus } from "../../hooks/use-lan-transfer";
```

- [ ] **Step 3: Add status copy helper**

Add above `SendToDeviceModal`:

```ts
function getSenderStatusCopy(state: "waiting" | "previewed" | "downloaded" | "missing" | undefined) {
  if (state === "previewed") {
    return {
      icon: Radio,
      title: "Receiver connected",
      body: "The receiving device opened the preview. Keep this window open until import finishes.",
      className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200",
    };
  }
  if (state === "downloaded") {
    return {
      icon: CheckCircle2,
      title: "Transfer downloaded",
      body: "The receiving device downloaded the package. It may take a moment to finish importing.",
      className: "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-200",
    };
  }
  if (state === "missing") {
    return {
      icon: XCircle,
      title: "Offer no longer available",
      body: "This transfer was cancelled, expired, or already consumed.",
      className: "border-[var(--destructive)]/40 bg-[var(--destructive)]/10 text-[var(--foreground)]",
    };
  }
  return {
    icon: Loader2,
    title: "Waiting for receiver",
    body: "On the other device, open Settings > Import > Receive from Device, then scan this code or paste the payload.",
    className: "border-[var(--border)]/60 bg-[var(--muted)]/30 text-[var(--muted-foreground)]",
  };
}
```

- [ ] **Step 4: Use status hook**

Inside `SendToDeviceModal`, after `senderOrigin`:

```ts
const offerStatus = useLanTransferOfferStatus(offer?.offerId ?? null, open && !!offer);
const senderStatusCopy = getSenderStatusCopy(offerStatus.data?.state);
const SenderStatusIcon = senderStatusCopy.icon;
```

- [ ] **Step 5: Render receiving instructions/status**

Inside `{offer && (...)}`, above the QR code block, add:

```tsx
<div className={`flex items-start gap-3 rounded-lg border p-3 text-sm ${senderStatusCopy.className}`}>
  <SenderStatusIcon
    className={offerStatus.data?.state ? "mt-0.5 shrink-0" : "mt-0.5 shrink-0 animate-spin"}
    size="1rem"
  />
  <div className="space-y-1">
    <p className="font-semibold">{senderStatusCopy.title}</p>
    <p>{senderStatusCopy.body}</p>
  </div>
</div>
```

- [ ] **Step 6: Tighten existing intro copy**

Replace the current paragraph:

```tsx
This offer is available for 10 minutes and can be downloaded once by a device on your LAN. Keep this
sender window open until the receiving device imports it; closing this modal cancels the transfer.
```

With:

```tsx
This offer is available for 10 minutes and can be downloaded once by a device on your LAN. Keep this sender window open; closing it cancels the transfer.
```

The status panel now carries the concrete receiver path.

- [ ] **Step 7: Run client checks**

Run:

```bash
pnpm --filter @marinara-engine/client exec eslint src/components/modals/SendToDeviceModal.tsx src/hooks/use-lan-transfer.ts
pnpm --filter @marinara-engine/client lint
```

Expected: ESLint exits `0`.

- [ ] **Step 8: Commit sender UI status**

```bash
git add packages/client/src/hooks/use-lan-transfer.ts packages/client/src/components/modals/SendToDeviceModal.tsx
git commit -m "feat: show LAN sender transfer status"
```

---

### Task 5: Full Validation and Manual Smoke

**Files:**
- No new files.
- Validate all files changed in Tasks 1-4.

- [ ] **Step 1: Run focused automated validation**

Run:

```bash
pnpm exec tsx --test packages/client/test/lan-transfer-receive-ui.test.ts
pnpm --filter @marinara-engine/server exec tsx --test test/lan-transfer-routes.test.ts test/lan-transfer-smart-import.test.ts
pnpm --filter @marinara-engine/server lint
pnpm --filter @marinara-engine/client lint
git diff --check
```

Expected:
- Client helper tests pass.
- LAN route and smart-import tests pass.
- Server/client lint pass.
- `git diff --check` prints nothing.

- [ ] **Step 2: Restart dev server with LAN envs**

Run:

```bash
LAN_TRANSFER_ENABLED=1 HOST=0.0.0.0 ALLOW_UNAUTHENTICATED_PRIVATE_NETWORK=true pnpm dev
```

Expected:
- Client available at `http://localhost:5173`.
- API health available at `http://127.0.0.1:7860/api/health`.

- [ ] **Step 3: Manual smoke no-op smart import**

On Linux sender:
- Open an existing chat with its bundled card.
- Send to device.

On Android receiver:
- Open `Settings > Import > Receive from Device`.
- Scan/paste payload.
- Preview.

Expected:
- Preview row groups card and chat under one character.
- Card/chat chips are visually distinct.
- Action chips show existing/up-to-date state.
- Inline panel says nothing to import.
- `Import` is disabled or reads `Already up to date`.
- Sender status changes from waiting to receiver connected.
- Sender offer is not consumed by this no-op preview.

- [ ] **Step 4: Manual smoke append update**

On one device:
- Add a new message to a synced chat.
- Send chat + card to the other device.

On receiver:
- Preview.
- Import.

Expected:
- Preview says the chat will add messages.
- Import is enabled.
- Toast says `Updated 1 chat with N new messages; used 1 existing card.`
- Sender status changes to downloaded.

- [ ] **Step 5: Manual smoke copy mode**

On receiver:
- Preview an already-current transfer.
- Enable `Import as copies`.

Expected:
- No-op gate clears.
- Button reads `Import Copies`.
- Action chips say copy import.
- Import creates copies and toast uses copy wording.

- [ ] **Step 6: Final commit if smoke causes copy tweaks**

If manual smoke requires small copy/style adjustments:

```bash
git add packages/client/src/components/modals/ReceiveFromDeviceModal.tsx packages/client/src/components/modals/SendToDeviceModal.tsx packages/client/src/lib/lan-transfer-receive-ui.ts
git commit -m "fix: polish LAN transfer receive copy"
```

If no changes are needed, do not create an empty commit.

---

## Self-Review

- Spec coverage:
  - Empty smart imports are blocked before download in Task 2.
  - Defensive no-op toast fallback is covered in Tasks 1 and 2.
  - Card/chat grouping and removal of redundant linked-to copy is covered in Tasks 1 and 2.
  - Color-coded card/chat/action preview chips are covered in Task 2.
  - Sender instructions and status lifecycle are covered in Tasks 3 and 4.
  - Manual smoke paths cover unchanged, append, and copy-mode imports in Task 5.
- Placeholder scan:
  - No placeholder markers or unbounded edge-case instructions remain.
- Type consistency:
  - `LanTransferOfferStatusResponse`, `LanTransferImportToast`, `LanTransferPreviewRow`, and `LanTransferChipTone` are introduced before use.
  - `isLanTransferPreviewNoOp`, `getImportButtonLabel`, `getLanTransferImportToast`, and `buildLanTransferPreviewRows` names match between tests, helper implementation, and modal wiring.
