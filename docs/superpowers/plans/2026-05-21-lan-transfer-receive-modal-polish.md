# LAN Transfer Receive Modal Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the LAN receive preview and success wording so smart imports feel like sync, not duplicate import bookkeeping.

**Architecture:** Keep this as a focused client-only polish in `ReceiveFromDeviceModal.tsx`. Build a small grouped preview view model from the normalized manifest and analysis actions, then render one row per character/card group where possible. Update toast copy so appended-only and already-current results read as successful sync outcomes rather than “0 items imported.”

**Tech Stack:** React 19, TypeScript, Tailwind utility classes, existing Sonner toast and LAN transfer hooks.

---

## File Structure

- Modify `packages/client/src/components/modals/ReceiveFromDeviceModal.tsx`
  - Replace item-by-item preview labels with a grouped display model.
  - Replace “reused” wording with user-facing “existing” / “already up to date” / “using existing card” wording.
  - Fix appended-only toast summaries.
- Test with existing static checks:
  - `pnpm --filter @marinara-engine/client exec eslint src/components/modals/ReceiveFromDeviceModal.tsx`
  - `pnpm --filter @marinara-engine/client lint`
  - `git diff --check`
- Manual smoke with the already-running LAN transfer server:
  - Linux -> Android first import.
  - Re-import unchanged transfer.
  - Append-only transfer.
  - Copy-mode transfer.

---

### Task 1: Replace Import Toast Summary Wording

**Files:**
- Modify: `packages/client/src/components/modals/ReceiveFromDeviceModal.tsx`
- Test: client ESLint for this file

- [ ] **Step 1: Update summary helpers**

Replace `getImportSummary()` with wording that does not say “Imported 0 items” when the successful work was append-only or already-current.

Use this shape:

```ts
function getImportSummary(summary: LanTransferImportSummary) {
  const importedParts: string[] = [];
  const existingParts: string[] = [];
  const copiedParts: string[] = [];
  const sentences: string[] = [];

  pushCountPart(importedParts, summary.imported.chats, "chat");
  pushCountPart(importedParts, summary.imported.characters, "card");
  pushCountPart(existingParts, summary.reused?.chats, "chat");
  pushCountPart(existingParts, summary.reused?.characters, "card");
  pushCountPart(copiedParts, summary.copied?.chats, "chat");
  pushCountPart(copiedParts, summary.copied?.characters, "card");

  if (summary.appended && summary.appended.messages > 0) {
    sentences.push(
      `Added ${pluralize(summary.appended.messages, "message")} to ${pluralize(summary.appended.chats, "chat")}`,
    );
  }

  if (importedParts.length > 0) {
    sentences.push(`Imported ${joinCountParts(importedParts)}`);
  }

  if (existingParts.length > 0) {
    sentences.push(`Used existing ${joinCountParts(existingParts)}`);
  }

  if (copiedParts.length > 0) {
    sentences.push(`Imported ${joinCountParts(copiedParts)} as ${copiedParts.length === 1 ? "a copy" : "copies"}`);
  }

  if (sentences.length === 0 && summary.skipped.length === 0) {
    sentences.push("Everything was already up to date");
  }

  if (summary.skipped.length > 0) {
    sentences.push(`Skipped ${summary.skipped.length}`);
  }

  return `${sentences.join("; ")}.`;
}
```

If this produces duplicate “Imported” wording for copy mode because both `imported` and `copied` are present, adjust by treating copied counts as the preferred copy-mode wording:

```ts
const copiedChats = summary.copied?.chats ?? 0;
const copiedCharacters = summary.copied?.characters ?? 0;
const copiedTotal = copiedChats + copiedCharacters;
const importedChatsForPlainImport = copiedChats > 0 ? Math.max(0, summary.imported.chats - copiedChats) : summary.imported.chats;
const importedCharactersForPlainImport =
  copiedCharacters > 0 ? Math.max(0, summary.imported.characters - copiedCharacters) : summary.imported.characters;
```

- [ ] **Step 2: Run focused lint**

Run:

```bash
pnpm --filter @marinara-engine/client exec eslint src/components/modals/ReceiveFromDeviceModal.tsx
```

Expected: exits `0`.

- [ ] **Step 3: Commit toast wording**

```bash
git add packages/client/src/components/modals/ReceiveFromDeviceModal.tsx
git commit -m "fix: clarify LAN receive import summaries"
```

---

### Task 2: Build Grouped Preview Rows

**Files:**
- Modify: `packages/client/src/components/modals/ReceiveFromDeviceModal.tsx`
- Test: client ESLint for this file

- [ ] **Step 1: Add preview row types**

Add these types near `type PreviewManifestItem`:

```ts
interface PreviewDisplayRow {
  key: string;
  title: string;
  items: PreviewManifestItem[];
  chips: string[];
  actions: LanTransferPreviewAction[];
}
```

- [ ] **Step 2: Add action wording helper without “reused”**

Replace `getActionLabel()` with:

```ts
function getActionLabel(action?: LanTransferPreviewAction) {
  if (!action) return null;

  if (action.type === "character") {
    return action.action === "reuse" ? "Using existing card" : "Will import card";
  }

  if (action.action === "skip") return "Already up to date";
  if (action.action === "append") return `Will add ${pluralize(action.appendCount ?? 0, "message")}`;
  if (action.action === "conflict-copy") return "History differs; will import a copy";
  return "Will import a copy";
}
```

Keep `getVisibleActionLabel()` so copy mode still overrides smart labels:

```ts
function getVisibleActionLabel(importAsCopies: boolean, action?: LanTransferPreviewAction) {
  if (importAsCopies) return "Will import a copy";
  return getActionLabel(action);
}
```

- [ ] **Step 3: Add grouping helpers**

Add helpers below `getActionKey()`:

```ts
function getPrimaryLinkedCharacterName(item: PreviewManifestItem, action?: LanTransferPreviewAction) {
  const names = getLinkedCharacterNames(item, action);
  return names?.length === 1 ? names[0] : null;
}

function getStandaloneItemChip(item: PreviewManifestItem) {
  if (item.type === "character") return "1 card";
  return "1 chat";
}

function buildPreviewRows(
  items: PreviewManifestItem[],
  actionByItemKey: Map<string, LanTransferPreviewAction>,
): PreviewDisplayRow[] {
  const rows: PreviewDisplayRow[] = [];
  const groupedByCharacter = new Map<string, PreviewDisplayRow>();

  for (const item of items) {
    const action = actionByItemKey.get(`${item.type}:${item.id}`);
    const linkedName = item.type === "chat" ? getPrimaryLinkedCharacterName(item, action) : null;
    const title = item.type === "character" ? item.name : linkedName;

    if (title) {
      const existing = groupedByCharacter.get(title);
      if (existing) {
        existing.items.push(item);
        existing.chips.push(getStandaloneItemChip(item));
        if (action) existing.actions.push(action);
        continue;
      }

      const row: PreviewDisplayRow = {
        key: `group:${title}:${item.id}`,
        title,
        items: [item],
        chips: [getStandaloneItemChip(item)],
        actions: action ? [action] : [],
      };
      groupedByCharacter.set(title, row);
      rows.push(row);
      continue;
    }

    rows.push({
      key: `${item.type}:${item.id}`,
      title: item.name,
      items: [item],
      chips: [getStandaloneItemChip(item)],
      actions: action ? [action] : [],
    });
  }

  return rows.map((row) => ({
    ...row,
    chips: summarizePreviewChips(row.chips),
  }));
}

function summarizePreviewChips(chips: string[]) {
  const chatCount = chips.filter((chip) => chip === "1 chat").length;
  const cardCount = chips.filter((chip) => chip === "1 card").length;
  const otherChips = chips.filter((chip) => chip !== "1 chat" && chip !== "1 card");
  const summarized: string[] = [];

  if (cardCount > 0) summarized.push(pluralize(cardCount, "card"));
  if (chatCount > 0) summarized.push(pluralize(chatCount, "chat"));
  summarized.push(...otherChips);
  return summarized;
}
```

This gives a row like:

```text
Alicia        1 card   1 chat   Using existing card   Will add 1 message
```

Instead of:

```text
Alicia        Character card
Alicia        1 chat linked to Alicia
```

- [ ] **Step 4: Add grouped row memo**

Inside `ReceiveFromDeviceModal`, after `actionByItemKey`, add:

```ts
const previewRows = useMemo(() => {
  if (!preview) return [];
  return buildPreviewRows(preview.manifest.items, actionByItemKey);
}, [actionByItemKey, preview]);
```

- [ ] **Step 5: Run focused lint**

Run:

```bash
pnpm --filter @marinara-engine/client exec eslint src/components/modals/ReceiveFromDeviceModal.tsx
```

Expected: exits `0`.

- [ ] **Step 6: Commit grouped row model**

```bash
git add packages/client/src/components/modals/ReceiveFromDeviceModal.tsx
git commit -m "feat: group LAN receive preview rows"
```

---

### Task 3: Render Grouped Preview Rows

**Files:**
- Modify: `packages/client/src/components/modals/ReceiveFromDeviceModal.tsx`
- Test: client ESLint and manual browser check

- [ ] **Step 1: Replace item map with grouped row map**

Replace:

```tsx
{preview.manifest.items.map((item) => {
  const action = actionByItemKey.get(`${item.type}:${item.id}`);
  const itemTypeLabel = getItemTypeLabel(item, action);
  const actionLabel = getVisibleActionLabel(importAsCopies, action);

  return (
    ...
  );
})}
```

With:

```tsx
{previewRows.map((row) => {
  const actionLabels = row.actions
    .map((action) => getVisibleActionLabel(importAsCopies, action))
    .filter((label): label is string => Boolean(label));

  return (
    <div
      key={row.key}
      className="flex items-center justify-between gap-3 border-b border-[var(--border)]/60 px-3 py-2 last:border-b-0 max-sm:flex-col max-sm:items-start"
    >
      <span className="min-w-0 truncate text-sm font-medium text-[var(--foreground)]" title={row.title}>
        {row.title}
      </span>
      <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2 max-sm:w-full max-sm:justify-start sm:max-w-[70%]">
        {row.chips.map((chip) => (
          <span
            key={chip}
            title={chip}
            className="max-w-full truncate rounded-md bg-[var(--muted)] px-2 py-1 text-xs font-semibold text-[var(--muted-foreground)] sm:max-w-72"
          >
            {chip}
          </span>
        ))}
        {actionLabels.map((label) => (
          <span
            key={label}
            title={label}
            className="max-w-full truncate rounded-md border border-[var(--primary)]/25 bg-[var(--primary)]/10 px-2 py-1 text-xs font-semibold text-[var(--foreground)] sm:max-w-72"
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  );
})}
```

- [ ] **Step 2: Remove obsolete label helper**

Remove `getItemTypeLabel()` if no longer referenced. Keep `getBundledCharacterCount()` because `previewSummary` still uses it.

- [ ] **Step 3: Verify copy-mode labels**

In code review, confirm:

```ts
getVisibleActionLabel(importAsCopies, action)
```

is still used for every rendered action label, so checking `Import as copies` changes action chips to `Will import a copy`.

- [ ] **Step 4: Run focused lint**

Run:

```bash
pnpm --filter @marinara-engine/client exec eslint src/components/modals/ReceiveFromDeviceModal.tsx
```

Expected: exits `0`.

- [ ] **Step 5: Commit rendering change**

```bash
git add packages/client/src/components/modals/ReceiveFromDeviceModal.tsx
git commit -m "fix: simplify LAN receive preview labels"
```

---

### Task 4: Validate And Smoke The Polish

**Files:**
- No expected file changes after Task 3.

- [ ] **Step 1: Run client checks**

Run:

```bash
pnpm --filter @marinara-engine/client exec eslint src/components/modals/ReceiveFromDeviceModal.tsx
pnpm --filter @marinara-engine/client lint
git diff --check
```

Expected:

- ESLint exits `0`.
- Client lint exits `0`.
- `git diff --check` prints no output and exits `0`.

- [ ] **Step 2: Manual smoke first import**

With both devices on LAN and WireGuard off on Android:

1. Linux sends one chat with its character card.
2. Android previews.
3. Confirm preview shows one grouped character row:

```text
Alicia    1 card    1 chat
```

No row should say:

```text
1 chat linked to Alicia
```

- [ ] **Step 3: Manual smoke appended-only toast**

1. Add one message on Linux to a chat already present on Android.
2. Send the chat again.
3. Android imports with `Import as copies` unchecked.
4. Confirm toast reads like:

```text
Added 1 message to 1 chat.
```

It must not read:

```text
Imported 0 items.
```

- [ ] **Step 4: Manual smoke unchanged import**

1. Send the same unchanged chat again.
2. Android imports with `Import as copies` unchecked.
3. Confirm preview/action wording uses “Already up to date” or “Using existing card,” not “Reused.”
4. Confirm the toast does not imply an alarming zero-item import.

- [ ] **Step 5: Manual smoke copy mode**

1. Preview the same transfer.
2. Check `Import as copies`.
3. Confirm action chips switch to:

```text
Will import a copy
```

4. Import and confirm duplicate copy behavior still works.

- [ ] **Step 6: Final status**

Run:

```bash
git status --short --branch
git log --oneline -4
```

Report:

- Latest commit SHA.
- Whether the worktree is clean.
- Validation commands and results.
- Manual smoke outcomes if run.

---

## Self-Review Checklist

- The plan removes `linked to {char}` from preview chips.
- The plan removes user-facing “reused” wording from preview actions and toast summaries.
- The plan groups a character card and its chat under one `{char}` title when there is exactly one linked character name.
- The plan keeps fallback display sane for standalone chats, standalone cards, multiple-card chats, and uncertain metadata.
- The plan fixes appended-only success toast wording.
- The plan keeps copy mode default off and keeps copy action labels aligned with copy behavior.
