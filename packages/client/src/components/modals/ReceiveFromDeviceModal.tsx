// Modal: Receive chats and characters from another LAN device
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Eye, Loader2, TriangleAlert, Wifi } from "lucide-react";
import { toast } from "sonner";
import type {
  LanTransferImportSummary,
  LanTransferPreviewAction,
  LanTransferPreviewResponse,
} from "@marinara-engine/shared";
import { useImportLanTransferFromOffer, usePreviewLanTransfer } from "../../hooks/use-lan-transfer";
import { Modal } from "../ui/Modal";

interface ReceiveFromDeviceModalProps {
  open: boolean;
  onClose: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

type PreviewManifestItem = LanTransferPreviewResponse["manifest"]["items"][number];

interface PreviewDisplayRow {
  key: string;
  title: string;
  chips: string[];
  actions: LanTransferPreviewAction[];
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every(isNonEmptyString) ? value : undefined;
}

function getBundledCharacterCount(item: PreviewManifestItem) {
  return item.type === "chat" && item.format === "native" && item.characterCount > 0 ? item.characterCount : 0;
}

function getLinkedCharacterNames(item: PreviewManifestItem, action?: LanTransferPreviewAction) {
  if (action?.type === "chat" && action.sourceId === item.id && action.linkedCharacterNames?.length) {
    return action.linkedCharacterNames;
  }

  return undefined;
}

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

function getVisibleActionLabel(importAsCopies: boolean, action?: LanTransferPreviewAction) {
  if (importAsCopies) return "Will import a copy";
  return getActionLabel(action);
}

function getActionKey(action: LanTransferPreviewAction) {
  return `${action.type}:${action.sourceId}`;
}

function getPrimaryLinkedCharacterName(item: PreviewManifestItem, action?: LanTransferPreviewAction) {
  const names = getLinkedCharacterNames(item, action);
  return names?.length === 1 ? names[0] : null;
}

function getStandaloneItemChip(item: PreviewManifestItem) {
  return item.type === "character" ? "1 card" : "1 chat";
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
        existing.chips.push(getStandaloneItemChip(item));
        if (action) existing.actions.push(action);
        continue;
      }

      const row: PreviewDisplayRow = {
        key: `group:${title}:${item.id}`,
        title,
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
      chips: [getStandaloneItemChip(item)],
      actions: action ? [action] : [],
    });
  }

  return rows.map((row) => ({
    ...row,
    chips: summarizePreviewChips(row.chips),
  }));
}

function pushCountPart(parts: string[], count: number | undefined, singular: string, plural?: string) {
  if (typeof count === "number" && count > 0) parts.push(pluralize(count, singular, plural));
}

function joinCountParts(parts: string[]) {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

function getImportSummary(summary: LanTransferImportSummary) {
  const sentences: string[] = [];
  const importedParts: string[] = [];
  const existingParts: string[] = [];
  const copiedParts: string[] = [];
  const copiedChats = summary.copied?.chats ?? 0;
  const copiedCharacters = summary.copied?.characters ?? 0;
  const importedChats = Math.max(0, summary.imported.chats - copiedChats);
  const importedCharacters = Math.max(0, summary.imported.characters - copiedCharacters);

  pushCountPart(importedParts, importedChats, "chat");
  pushCountPart(importedParts, importedCharacters, "card");
  pushCountPart(existingParts, summary.reused?.chats, "chat");
  pushCountPart(existingParts, summary.reused?.characters, "card");
  pushCountPart(copiedParts, summary.copied?.chats, "chat");
  pushCountPart(copiedParts, summary.copied?.characters, "card");

  if (summary.appended && summary.appended.messages > 0) {
    sentences.push(
      `Added ${pluralize(summary.appended.messages, "message")} to ${pluralize(summary.appended.chats, "chat")}`,
    );
  }

  if (importedParts.length > 0) sentences.push(`Imported ${joinCountParts(importedParts)}`);
  if (existingParts.length > 0) sentences.push(`Used ${joinCountParts(existingParts)} already on this device`);
  if (copiedParts.length > 0) {
    sentences.push(`Imported ${joinCountParts(copiedParts)} as ${copiedParts.length === 1 ? "a copy" : "copies"}`);
  }
  if (sentences.length === 0 && summary.skipped.length === 0) sentences.push("Everything was already up to date");
  if (summary.skipped.length > 0) sentences.push(`Skipped ${summary.skipped.length}`);

  return `${sentences.join("; ")}.`;
}

function normalizePreviewAction(value: unknown): LanTransferPreviewAction | null {
  if (!isRecord(value)) return null;

  const { type, sourceId, name, action, targetId, reason } = value;
  if (!isNonEmptyString(type) || !isNonEmptyString(sourceId) || !isNonEmptyString(name) || !isNonEmptyString(reason)) {
    return null;
  }
  const target = isNonEmptyString(targetId) ? { targetId } : {};

  if (type === "character") {
    if (action !== "reuse" && action !== "import-copy") return null;
    return { type: "character", sourceId, name, action, ...target, reason };
  }

  if (type === "chat") {
    if (action !== "skip" && action !== "append" && action !== "import-copy" && action !== "conflict-copy") return null;
    if (typeof value.messageCount !== "number" || !Number.isFinite(value.messageCount)) return null;
    if (
      action === "append" &&
      (typeof value.appendCount !== "number" || !Number.isFinite(value.appendCount) || value.appendCount < 0)
    ) {
      return null;
    }
    const appendCount =
      typeof value.appendCount === "number" && Number.isFinite(value.appendCount)
        ? { appendCount: value.appendCount }
        : {};
    const linkedCharacterNames = readStringArray(value.linkedCharacterNames);
    return {
      type: "chat",
      sourceId,
      name,
      action,
      ...target,
      messageCount: value.messageCount,
      ...appendCount,
      ...(linkedCharacterNames ? { linkedCharacterNames } : {}),
      reason,
    };
  }

  return null;
}

function normalizePreviewAnalysis(value: unknown): LanTransferPreviewResponse["analysis"] {
  if (!isRecord(value) || value.mode !== "smart" || !Array.isArray(value.actions)) return undefined;

  const actions: LanTransferPreviewAction[] = [];
  for (const action of value.actions) {
    const normalizedAction = normalizePreviewAction(action);
    if (!normalizedAction) return undefined;
    actions.push(normalizedAction);
  }

  return { mode: "smart", actions };
}

function normalizePreviewResponse(value: unknown): LanTransferPreviewResponse | null {
  if (!isRecord(value)) return null;

  const { from, offerId, expiresAt, manifest } = value;
  if (typeof from !== "string" || typeof offerId !== "string" || typeof expiresAt !== "string") return null;
  if (!isRecord(manifest) || !Array.isArray(manifest.items)) return null;
  if (
    manifest.version !== 1 ||
    typeof manifest.createdAt !== "string" ||
    typeof manifest.expiresAt !== "string" ||
    manifest.sourceApp !== "Marinara Engine" ||
    typeof manifest.sourceVersion !== "string" ||
    typeof manifest.totalBytes !== "number" ||
    !Number.isFinite(manifest.totalBytes)
  ) {
    return null;
  }

  const items: LanTransferPreviewResponse["manifest"]["items"] = [];
  for (const item of manifest.items) {
    if (!isRecord(item)) return null;

    const { type, id, name, format, bytes } = item;
    if (typeof type !== "string" || typeof id !== "string" || typeof name !== "string") return null;
    if (typeof bytes !== "number" || !Number.isFinite(bytes)) return null;

    if (type === "chat") {
      if (typeof item.messageCount !== "number" || !Number.isFinite(item.messageCount)) return null;

      if (format === "jsonl") {
        items.push({ type: "chat", id, name, format: "jsonl", messageCount: item.messageCount, bytes });
        continue;
      }

      if (format === "native") {
        if (typeof item.characterCount !== "number" || !Number.isFinite(item.characterCount)) return null;
        const syncId = isNonEmptyString(item.syncId) ? { syncId: item.syncId } : {};
        const characterIds = readStringArray(item.characterIds);
        const messageFingerprint = isNonEmptyString(item.messageFingerprint)
          ? { messageFingerprint: item.messageFingerprint }
          : {};
        const messageFingerprints = readStringArray(item.messageFingerprints);
        items.push({
          type: "chat",
          id,
          ...syncId,
          name,
          format: "native",
          messageCount: item.messageCount,
          characterCount: item.characterCount,
          ...(characterIds ? { characterIds } : {}),
          ...messageFingerprint,
          ...(messageFingerprints ? { messageFingerprints } : {}),
          bytes,
        });
        continue;
      }

      return null;
    }

    if (type === "character") {
      if (format !== "native") return null;
      const syncId = isNonEmptyString(item.syncId) ? { syncId: item.syncId } : {};
      const fingerprint = isNonEmptyString(item.fingerprint) ? { fingerprint: item.fingerprint } : {};
      items.push({ type: "character", id, ...syncId, name, format: "native", ...fingerprint, bytes });
      continue;
    }

    return null;
  }

  const analysis = normalizePreviewAnalysis(value.analysis);

  return {
    from,
    offerId,
    expiresAt,
    manifest: {
      version: 1,
      createdAt: manifest.createdAt,
      expiresAt: manifest.expiresAt,
      sourceApp: "Marinara Engine",
      sourceVersion: manifest.sourceVersion,
      items,
      totalBytes: manifest.totalBytes,
    },
    ...(analysis ? { analysis } : {}),
  };
}

export function ReceiveFromDeviceModal({ open, onClose }: ReceiveFromDeviceModalProps) {
  const previewTransfer = usePreviewLanTransfer();
  const importTransfer = useImportLanTransferFromOffer();
  const [transferPayload, setTransferPayload] = useState("");
  const [preview, setPreview] = useState<LanTransferPreviewResponse | null>(null);
  const [previewedPayload, setPreviewedPayload] = useState<string | null>(null);
  const [importAsCopies, setImportAsCopies] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const currentTrimmedPayloadRef = useRef("");
  const previewRequestIdRef = useRef(0);

  const trimmedPayload = transferPayload.trim();
  const isImporting = importTransfer.isPending;
  const isBusy = previewTransfer.isPending || isImporting;
  const canPreview = trimmedPayload.length > 0 && !isBusy;
  const canImport = trimmedPayload.length > 0 && previewedPayload === trimmedPayload && !isBusy;
  const itemCount = preview?.manifest.items.length ?? 0;
  const errorMessage =
    localError ??
    (previewTransfer.error ? getErrorMessage(previewTransfer.error, "Could not preview this transfer payload.") : null) ??
    (importTransfer.error ? getErrorMessage(importTransfer.error, "Could not import this transfer payload.") : null);

  useEffect(() => {
    if (open) setImportAsCopies(false);
  }, [open]);

  const previewSummary = useMemo(() => {
    if (!preview) return null;
    const chats = preview.manifest.items.filter((item) => item.type === "chat").length;
    const characters = preview.manifest.items.filter((item) => item.type === "character").length;
    const bundledCharacters = preview.manifest.items.reduce((total, item) => total + getBundledCharacterCount(item), 0);
    const parts: string[] = [];

    if (chats > 0) parts.push(pluralize(chats, "chat"));
    if (characters > 0) parts.push(pluralize(characters, "character card"));
    if (characters === 0 && bundledCharacters > 0) {
      parts.push(`includes ${pluralize(bundledCharacters, "card")} bundled with chats`);
    }

    return parts.length > 0 ? parts.join(" and ") : "No importable items";
  }, [preview]);

  const handlePayloadChange = useCallback(
    (value: string) => {
      if (importTransfer.isPending) return;

      currentTrimmedPayloadRef.current = value.trim();
      previewRequestIdRef.current += 1;
      setTransferPayload(value);
      setLocalError(null);
      setStatusMessage(null);
      previewTransfer.reset();
      importTransfer.reset();

      if (preview || previewedPayload) {
        setPreview(null);
        setPreviewedPayload(null);
      }
    },
    [importTransfer, preview, previewTransfer, previewedPayload],
  );

  const handlePreview = useCallback(async () => {
    const payload = transferPayload.trim();
    if (!payload) {
      setLocalError("Paste a transfer payload before previewing.");
      setStatusMessage(null);
      return;
    }

    const requestId = previewRequestIdRef.current + 1;
    previewRequestIdRef.current = requestId;
    currentTrimmedPayloadRef.current = payload;
    setLocalError(null);
    setStatusMessage(null);
    importTransfer.reset();

    try {
      const nextPreview = await previewTransfer.mutateAsync({ transferPayload: payload });
      if (previewRequestIdRef.current !== requestId || currentTrimmedPayloadRef.current !== payload) return;

      const normalizedPreview = normalizePreviewResponse(nextPreview);
      if (!normalizedPreview) {
        setPreview(null);
        setPreviewedPayload(null);
        setLocalError("The sender returned an invalid transfer preview.");
        setStatusMessage(null);
        return;
      }

      setPreview(normalizedPreview);
      setPreviewedPayload(payload);
      setStatusMessage(
        `Preview ready: ${normalizedPreview.manifest.items.length} item${normalizedPreview.manifest.items.length === 1 ? "" : "s"}.`,
      );
    } catch {
      if (previewRequestIdRef.current !== requestId || currentTrimmedPayloadRef.current !== payload) return;

      setPreview(null);
      setPreviewedPayload(null);
      setStatusMessage(null);
    }
  }, [importTransfer, previewTransfer, transferPayload]);

  const handleImport = useCallback(async () => {
    const payload = transferPayload.trim();
    if (!payload) {
      setLocalError("Paste a transfer payload before importing.");
      return;
    }
    if (payload !== previewedPayload) {
      setLocalError("Preview this exact transfer payload before importing.");
      return;
    }

    setLocalError(null);
    setStatusMessage(null);

    try {
      const summary = await importTransfer.mutateAsync({
        transferPayload: payload,
        options: { importMode: importAsCopies ? "copy" : "smart" },
      });
      toast.success(getImportSummary(summary));
      onClose();
    } catch {
      setStatusMessage(null);
    }
  }, [importAsCopies, importTransfer, onClose, previewedPayload, transferPayload]);

  const handleClose = useCallback(() => {
    if (importTransfer.isPending) return;
    onClose();
  }, [importTransfer.isPending, onClose]);

  const actionByItemKey = useMemo(() => {
    const actions = preview?.analysis?.actions;
    if (!actions) return new Map<string, LanTransferPreviewAction>();
    return new Map(actions.map((action) => [getActionKey(action), action]));
  }, [preview?.analysis?.actions]);

  const previewRows = useMemo(() => {
    if (!preview) return [];
    return buildPreviewRows(preview.manifest.items, actionByItemKey);
  }, [actionByItemKey, preview]);

  return (
    <Modal open={open} onClose={handleClose} title="Receive from Device" width="max-w-2xl">
      <div className="space-y-4">
        <div className="rounded-lg border border-[var(--border)]/60 bg-[var(--card)]/70 p-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-lg bg-[var(--primary)]/15 p-2 text-[var(--primary)]">
              <Wifi size="1.1rem" />
            </div>
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-semibold text-[var(--foreground)]">Paste a LAN transfer payload</p>
              <p className="text-sm leading-6 text-[var(--muted-foreground)]">
                Preview the sender manifest first, then import while the sender keeps their transfer window open.
              </p>
            </div>
          </div>
        </div>

        <label className="block space-y-2">
          <span className="text-xs font-semibold uppercase text-[var(--muted-foreground)]">Transfer payload</span>
          <textarea
            value={transferPayload}
            onChange={(event) => handlePayloadChange(event.target.value)}
            disabled={isImporting}
            placeholder="Paste the transfer payload from the sending device"
            className="min-h-36 w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-xs text-[var(--foreground)] outline-none transition-shadow placeholder:text-[var(--muted-foreground)] focus:ring-2 focus:ring-[var(--primary)]/40 disabled:cursor-not-allowed disabled:opacity-70"
          />
        </label>

        {isBusy && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-3 rounded-lg border border-[var(--border)]/60 bg-[var(--muted)]/30 p-4 text-sm text-[var(--muted-foreground)]"
          >
            <Loader2 className="shrink-0 animate-spin text-[var(--primary)]" size="1rem" />
            {previewTransfer.isPending ? "Previewing transfer..." : "Importing transfer..."}
          </div>
        )}

        {statusMessage && !isBusy && (
          <div
            role="status"
            aria-live="polite"
            className="rounded-lg border border-[var(--primary)]/30 bg-[var(--primary)]/10 p-3 text-sm text-[var(--foreground)]"
          >
            {statusMessage}
          </div>
        )}

        {errorMessage && (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-lg border border-[var(--destructive)]/40 bg-[var(--destructive)]/10 p-4 text-sm text-[var(--foreground)]"
          >
            <TriangleAlert className="mt-0.5 shrink-0 text-[var(--destructive)]" size="1rem" />
            <div className="space-y-1">
              <p className="font-semibold">Transfer failed</p>
              <p className="text-[var(--muted-foreground)]">{errorMessage}</p>
            </div>
          </div>
        )}

        {preview && (
          <div className="space-y-3 rounded-lg border border-[var(--border)]/60 bg-[var(--card)]/70 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-[var(--foreground)]">
                  {itemCount} item{itemCount === 1 ? "" : "s"} from {preview.from}
                </p>
                {previewSummary && <p className="text-sm text-[var(--muted-foreground)]">{previewSummary}</p>}
              </div>
              <span className="rounded-full border border-[var(--border)] bg-[var(--muted)]/40 px-3 py-1 text-xs font-semibold text-[var(--muted-foreground)]">
                Expires {new Date(preview.expiresAt).toLocaleString()}
              </span>
            </div>

            <div className="max-h-64 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--background)]">
              {previewRows.map((row) => {
                const actionLabels = Array.from(
                  new Set(
                    row.actions
                      .map((action) => getVisibleActionLabel(importAsCopies, action))
                      .filter((label): label is string => Boolean(label)),
                  ),
                );

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
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <label className="inline-flex items-center gap-2 text-sm font-medium text-[var(--foreground)]">
            <input
              type="checkbox"
              checked={importAsCopies}
              onChange={(event) => setImportAsCopies(event.target.checked)}
              disabled={isImporting}
              className="h-4 w-4 rounded border-[var(--border)] accent-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-60"
            />
            Import as copies
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => void handlePreview()}
              disabled={!canPreview}
              className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--card)] px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition-colors hover:bg-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {previewTransfer.isPending ? <Loader2 className="animate-spin" size="1rem" /> : <Eye size="1rem" />}
              Preview
            </button>
            <button
              type="button"
              onClick={() => void handleImport()}
              disabled={!canImport}
              className="inline-flex items-center gap-2 rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-semibold text-[var(--primary-foreground)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {importTransfer.isPending ? <Loader2 className="animate-spin" size="1rem" /> : <Download size="1rem" />}
              Import
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
