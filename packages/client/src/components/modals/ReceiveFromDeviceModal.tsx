// Modal: Receive chats and characters from another LAN device
import { useCallback, useMemo, useRef, useState } from "react";
import { Download, Eye, Loader2, TriangleAlert, Wifi } from "lucide-react";
import { toast } from "sonner";
import type { LanTransferImportSummary, LanTransferPreviewResponse } from "@marinara-engine/shared";
import { useImportLanTransferFromOffer, usePreviewLanTransfer } from "../../hooks/use-lan-transfer";
import { Modal } from "../ui/Modal";

interface ReceiveFromDeviceModalProps {
  open: boolean;
  onClose: () => void;
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function getItemTypeLabel(type: string) {
  return type === "chat" ? "Chat" : type === "character" ? "Character" : type;
}

function getImportSummary(summary: LanTransferImportSummary) {
  const parts: string[] = [];
  const { chats, characters } = summary.imported;

  if (chats > 0) parts.push(`${chats} ${chats === 1 ? "chat" : "chats"}`);
  if (characters > 0) parts.push(`${characters} ${characters === 1 ? "character" : "characters"}`);

  const imported = parts.length > 0 ? parts.join(" and ") : "0 items";
  return summary.skipped.length > 0 ? `Imported ${imported}; skipped ${summary.skipped.length}.` : `Imported ${imported}.`;
}

export function ReceiveFromDeviceModal({ open, onClose }: ReceiveFromDeviceModalProps) {
  const previewTransfer = usePreviewLanTransfer();
  const importTransfer = useImportLanTransferFromOffer();
  const [transferPayload, setTransferPayload] = useState("");
  const [preview, setPreview] = useState<LanTransferPreviewResponse | null>(null);
  const [previewedPayload, setPreviewedPayload] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const currentTrimmedPayloadRef = useRef("");
  const previewRequestIdRef = useRef(0);

  const trimmedPayload = transferPayload.trim();
  const isBusy = previewTransfer.isPending || importTransfer.isPending;
  const canPreview = trimmedPayload.length > 0 && !isBusy;
  const canImport = trimmedPayload.length > 0 && previewedPayload === trimmedPayload && !isBusy;
  const itemCount = preview?.manifest.items.length ?? 0;
  const errorMessage =
    localError ??
    (previewTransfer.error ? getErrorMessage(previewTransfer.error, "Could not preview this transfer payload.") : null) ??
    (importTransfer.error ? getErrorMessage(importTransfer.error, "Could not import this transfer payload.") : null);

  const previewSummary = useMemo(() => {
    if (!preview) return null;
    const chats = preview.manifest.items.filter((item) => item.type === "chat").length;
    const characters = preview.manifest.items.filter((item) => item.type === "character").length;
    const parts: string[] = [];

    if (chats > 0) parts.push(`${chats} ${chats === 1 ? "chat" : "chats"}`);
    if (characters > 0) parts.push(`${characters} ${characters === 1 ? "character" : "characters"}`);

    return parts.length > 0 ? parts.join(" and ") : "No importable items";
  }, [preview]);

  const handlePayloadChange = useCallback(
    (value: string) => {
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

      setPreview(nextPreview);
      setPreviewedPayload(payload);
      setStatusMessage(`Preview ready: ${nextPreview.manifest.items.length} item${nextPreview.manifest.items.length === 1 ? "" : "s"}.`);
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
      const summary = await importTransfer.mutateAsync({ transferPayload: payload });
      toast.success(getImportSummary(summary));
      onClose();
    } catch {
      setStatusMessage(null);
    }
  }, [importTransfer, onClose, previewedPayload, transferPayload]);

  return (
    <Modal open={open} onClose={onClose} title="Receive from Device" width="max-w-2xl">
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
            placeholder="Paste the transfer payload from the sending device"
            className="min-h-36 w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-xs text-[var(--foreground)] outline-none transition-shadow placeholder:text-[var(--muted-foreground)] focus:ring-2 focus:ring-[var(--primary)]/40"
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
              {preview.manifest.items.map((item) => (
                <div
                  key={`${item.type}:${item.id}`}
                  className="flex items-center justify-between gap-3 border-b border-[var(--border)]/60 px-3 py-2 last:border-b-0"
                >
                  <span className="min-w-0 truncate text-sm font-medium text-[var(--foreground)]">{item.name}</span>
                  <span className="shrink-0 rounded-md bg-[var(--muted)] px-2 py-1 text-xs font-semibold text-[var(--muted-foreground)]">
                    {getItemTypeLabel(item.type)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2 pt-1">
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
    </Modal>
  );
}
