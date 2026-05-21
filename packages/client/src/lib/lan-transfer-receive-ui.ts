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

interface MutablePreviewRow {
  key: string;
  title: string;
  cardCount: number;
  chatCount: number;
  actions: LanTransferPreviewChip[];
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

function getItemKey(item: PreviewManifestItem) {
  return `${item.type}:${item.id}`;
}

function getLinkedCharacterTitle(action: LanTransferPreviewAction | undefined) {
  if (action?.type !== "chat" || action.linkedCharacterNames?.length !== 1) return null;
  return action.linkedCharacterNames[0] ?? null;
}

function getRowTitle(item: PreviewManifestItem, action: LanTransferPreviewAction | undefined) {
  if (item.type === "character") return item.name;
  return getLinkedCharacterTitle(action) ?? item.name;
}

function getActionChip(action: LanTransferPreviewAction | undefined, importAsCopies: boolean): LanTransferPreviewChip | null {
  if (!action) return null;

  if (importAsCopies) return { label: "Will import a copy", tone: "copy" };

  if (action.type === "character") {
    return action.action === "reuse"
      ? { label: "Using existing card", tone: "success" }
      : { label: "Will import card", tone: "card" };
  }

  if (action.action === "skip") return { label: "Already up to date", tone: "neutral" };
  if (action.action === "append") {
    return { label: `Will add ${pluralize(action.appendCount ?? 0, "message")}`, tone: "update" };
  }
  if (action.action === "conflict-copy") {
    return { label: "History differs; will import a copy", tone: "warning" };
  }
  return { label: "Will import chat", tone: "chat" };
}

function toPreviewRow(row: MutablePreviewRow): LanTransferPreviewRow {
  const chips: LanTransferPreviewChip[] = [];
  const actions = new Map(row.actions.map((action) => [`${action.tone}:${action.label}`, action]));
  if (row.cardCount > 0) chips.push({ label: pluralize(row.cardCount, "card"), tone: "card" });
  if (row.chatCount > 0) chips.push({ label: pluralize(row.chatCount, "chat"), tone: "chat" });

  return {
    key: row.key,
    title: row.title,
    chips,
    actions: Array.from(actions.values()),
  };
}

export function buildLanTransferPreviewRows(
  preview: LanTransferPreviewResponse,
  importAsCopies: boolean,
): LanTransferPreviewRow[] {
  const actionByItemKey = new Map(preview.analysis?.actions.map((action) => [getActionKey(action), action]) ?? []);
  const rows: MutablePreviewRow[] = [];
  const groupedRows = new Map<string, MutablePreviewRow>();

  for (const item of preview.manifest.items) {
    const action = actionByItemKey.get(getItemKey(item));
    const title = getRowTitle(item, action);
    const rowKey = `group:${title}`;
    let row = groupedRows.get(rowKey);

    if (!row) {
      row = { key: rowKey, title, cardCount: 0, chatCount: 0, actions: [] };
      groupedRows.set(rowKey, row);
      rows.push(row);
    }

    if (item.type === "character") row.cardCount += 1;
    if (item.type === "chat") row.chatCount += 1;

    const actionChip = getActionChip(action, importAsCopies);
    if (actionChip) row.actions.push(actionChip);
  }

  return rows.map(toPreviewRow);
}

export function isLanTransferPreviewNoOp(
  preview: LanTransferPreviewResponse | null,
  importAsCopies: boolean,
): boolean {
  if (importAsCopies || !preview?.analysis || preview.analysis.actions.length === 0) return false;

  return preview.analysis.actions.every((action) => {
    if (action.type === "character") return action.action === "reuse";
    return action.action === "skip";
  });
}

export function getImportButtonLabel(preview: LanTransferPreviewResponse | null, importAsCopies: boolean): string {
  if (importAsCopies) return "Import Copies";
  if (isLanTransferPreviewNoOp(preview, importAsCopies)) return "Already up to date";
  return "Import";
}

function pushCountPart(parts: string[], count: number | undefined, singular: string, plural?: string) {
  if (typeof count === "number" && count > 0) parts.push(pluralize(count, singular, plural));
}

function getImportedParts(summary: LanTransferImportSummary) {
  const copiedChats = summary.copied?.chats ?? 0;
  const copiedCharacters = summary.copied?.characters ?? 0;
  const importedChats = Math.max(0, summary.imported.chats - copiedChats);
  const importedCharacters = Math.max(0, summary.imported.characters - copiedCharacters);
  const parts: string[] = [];

  pushCountPart(parts, importedChats, "chat");
  pushCountPart(parts, importedCharacters, "card");
  return parts;
}

function getUsedExistingParts(summary: LanTransferImportSummary) {
  const parts: string[] = [];
  pushCountPart(parts, summary.reused?.chats, "existing chat");
  pushCountPart(parts, summary.reused?.characters, "existing card");
  return parts;
}

function getCopiedParts(summary: LanTransferImportSummary) {
  const parts: string[] = [];
  pushCountPart(parts, summary.copied?.chats, "chat");
  pushCountPart(parts, summary.copied?.characters, "card");
  return parts;
}

export function getLanTransferImportToast(summary: LanTransferImportSummary): LanTransferImportToast {
  const importedParts = getImportedParts(summary);
  const usedExistingParts = getUsedExistingParts(summary);
  const copiedParts = getCopiedParts(summary);
  const copiedItemCount = (summary.copied?.chats ?? 0) + (summary.copied?.characters ?? 0);
  const appendedChats = summary.appended?.chats ?? 0;
  const appendedMessages = summary.appended?.messages ?? 0;
  const changed =
    importedParts.length > 0 || copiedParts.length > 0 || appendedChats > 0 || appendedMessages > 0 || summary.skipped.length > 0;

  if (!changed) {
    return {
      kind: "info",
      message: "Nothing changed. This device is already up to date.",
      closeModal: false,
    };
  }

  const sentences: string[] = [];
  if (appendedChats > 0 || appendedMessages > 0) {
    sentences.push(`Updated ${pluralize(appendedChats, "chat")} with ${pluralize(appendedMessages, "new message")}`);
  }
  if (importedParts.length > 0) sentences.push(`imported ${joinParts(importedParts)}`);
  if (copiedParts.length > 0) {
    sentences.push(`imported ${joinParts(copiedParts)} as ${copiedItemCount === 1 ? "a copy" : "copies"}`);
  }
  if (usedExistingParts.length > 0) sentences.push(`used ${joinParts(usedExistingParts)}`);
  if (summary.skipped.length > 0) sentences.push(`skipped ${pluralize(summary.skipped.length, "item")}`);

  return {
    kind: summary.skipped.length > 0 ? "warning" : "success",
    message: `${sentences.join("; ")}.`,
    closeModal: true,
  };
}
