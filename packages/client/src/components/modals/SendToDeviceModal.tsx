// Modal: Send chats and characters to another LAN device
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clipboard, Loader2, QrCode, TriangleAlert, XCircle } from "lucide-react";
import QRCode from "qrcode";
import { toast } from "sonner";
import type { LanTransferCreateOfferResponse, LanTransferItemRequest } from "@marinara-engine/shared";
import { useCancelLanTransferOffer, useCreateLanTransferOffer } from "../../hooks/use-lan-transfer";
import { Modal } from "../ui/Modal";

interface SendToDeviceModalProps {
  open: boolean;
  onClose: () => void;
  items: LanTransferItemRequest[];
  title?: string;
}

function getItemSummary(items: LanTransferItemRequest[]) {
  const chats = items.filter((item) => item.type === "chat").length;
  const characters = items.filter((item) => item.type === "character").length;
  const parts: string[] = [];

  if (chats > 0) parts.push(`${chats} ${chats === 1 ? "chat" : "chats"}`);
  if (characters > 0) parts.push(`${characters} ${characters === 1 ? "character" : "characters"}`);

  return parts.length > 0 ? parts.join(" and ") : "No chats or characters";
}

export function SendToDeviceModal({ open, onClose, items, title = "Send to Device" }: SendToDeviceModalProps) {
  const { mutateAsync: createOfferAsync, reset: resetCreateOffer } = useCreateLanTransferOffer();
  const { mutateAsync: cancelOfferAsync, reset: resetCancelOffer } = useCancelLanTransferOffer();
  const [offer, setOffer] = useState<LanTransferCreateOfferResponse | null>(null);
  const [qrCodeUrl, setQrCodeUrl] = useState<string | null>(null);
  const [qrCodeError, setQrCodeError] = useState<string | null>(null);
  const [createStatus, setCreateStatus] = useState<"idle" | "pending" | "error">("idle");
  const [createErrorMessage, setCreateErrorMessage] = useState<string | null>(null);
  const createdKeyRef = useRef<string | null>(null);
  const offerIdRef = useRef<string | null>(null);
  const activeCreateRequestIdRef = useRef(0);
  const latestItemKeyRef = useRef<string | null>(null);
  const openRef = useRef(open);

  const itemKey = useMemo(() => JSON.stringify(items), [items]);
  const itemSummary = useMemo(() => getItemSummary(items), [items]);
  const hasItems = items.length > 0;

  const cancelOfferById = useCallback(
    async (offerId: string, notifyOnError = false) => {
      try {
        await cancelOfferAsync(offerId);
      } catch {
        if (notifyOnError) toast.error("Could not cancel the LAN transfer offer");
      }
    },
    [cancelOfferAsync],
  );

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) {
      activeCreateRequestIdRef.current += 1;
      latestItemKeyRef.current = null;
      createdKeyRef.current = null;
      offerIdRef.current = null;
      setOffer(null);
      setQrCodeUrl(null);
      setQrCodeError(null);
      setCreateStatus("idle");
      setCreateErrorMessage(null);
      resetCreateOffer();
      resetCancelOffer();
      return;
    }

    if (!hasItems || createdKeyRef.current === itemKey) return;

    const replacedOfferId = offerIdRef.current;
    if (replacedOfferId) {
      offerIdRef.current = null;
      void cancelOfferById(replacedOfferId);
    }

    createdKeyRef.current = itemKey;
    latestItemKeyRef.current = itemKey;
    const requestId = activeCreateRequestIdRef.current + 1;
    activeCreateRequestIdRef.current = requestId;
    setOffer(null);
    setQrCodeUrl(null);
    setQrCodeError(null);
    setCreateStatus("pending");
    setCreateErrorMessage(null);

    void createOfferAsync({ items })
      .then((nextOffer) => {
        const isCurrentRequest =
          openRef.current && activeCreateRequestIdRef.current === requestId && latestItemKeyRef.current === itemKey;

        if (!isCurrentRequest) {
          void cancelOfferById(nextOffer.offerId);
          return;
        }

        offerIdRef.current = nextOffer.offerId;
        setOffer(nextOffer);
        setCreateStatus("idle");
      })
      .catch((error: unknown) => {
        const isCurrentRequest =
          openRef.current && activeCreateRequestIdRef.current === requestId && latestItemKeyRef.current === itemKey;
        if (!isCurrentRequest) return;

        setCreateStatus("error");
        setCreateErrorMessage(error instanceof Error ? error.message : "Could not create a transfer offer.");
      });

    return () => {
      if (activeCreateRequestIdRef.current === requestId) {
        activeCreateRequestIdRef.current += 1;
        if (createdKeyRef.current === itemKey) createdKeyRef.current = null;
        if (latestItemKeyRef.current === itemKey) latestItemKeyRef.current = null;
      }
    };
  }, [cancelOfferById, createOfferAsync, hasItems, itemKey, items, open, resetCancelOffer, resetCreateOffer]);

  useEffect(() => {
    if (!offer?.transferPayload) {
      setQrCodeUrl(null);
      setQrCodeError(null);
      return;
    }

    let cancelled = false;
    setQrCodeError(null);
    QRCode.toDataURL(offer.transferPayload, { margin: 1, scale: 6 })
      .then((url) => {
        if (!cancelled) setQrCodeUrl(url);
      })
      .catch(() => {
        if (!cancelled) {
          setQrCodeUrl(null);
          setQrCodeError("Could not render the QR code. Copy the transfer payload instead.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [offer?.transferPayload]);

  const handleCopy = useCallback(async () => {
    if (!offer?.transferPayload) return;

    try {
      await navigator.clipboard.writeText(offer.transferPayload);
      toast.success("Transfer payload copied. Keep this sender window open until import finishes.");
    } catch {
      toast.error("Could not copy automatically. Select the payload and copy it manually.");
    }
  }, [offer?.transferPayload]);

  const handleClose = useCallback(() => {
    activeCreateRequestIdRef.current += 1;
    latestItemKeyRef.current = null;
    openRef.current = false;
    const offerId = offerIdRef.current;
    if (offerId) {
      offerIdRef.current = null;
      void cancelOfferById(offerId, true);
    }
    onClose();
  }, [cancelOfferById, onClose]);

  const createError = createErrorMessage ?? "Could not create a transfer offer.";
  const showPending = hasItems && !offer && createStatus === "pending";
  const showError = !hasItems || createStatus === "error";

  return (
    <Modal open={open} onClose={handleClose} title={title} width="max-w-lg">
      <div className="space-y-4">
        <div className="rounded-lg border border-[var(--border)]/60 bg-[var(--card)]/70 p-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-lg bg-[var(--primary)]/15 p-2 text-[var(--primary)]">
              <QrCode size="1.1rem" />
            </div>
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-semibold text-[var(--foreground)]">Preparing {itemSummary}</p>
              <p className="text-sm leading-6 text-[var(--muted-foreground)]">
                This offer is available for 10 minutes and can be downloaded once by a device on your LAN. Keep this
                sender window open until the receiving device imports it; closing this modal cancels the transfer.
              </p>
            </div>
          </div>
        </div>

        {showPending && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-3 rounded-lg border border-[var(--border)]/60 bg-[var(--muted)]/30 p-4 text-sm text-[var(--muted-foreground)]"
          >
            <Loader2 className="shrink-0 animate-spin text-[var(--primary)]" size="1rem" />
            Creating transfer offer...
          </div>
        )}

        {showError && (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-lg border border-[var(--destructive)]/40 bg-[var(--destructive)]/10 p-4 text-sm text-[var(--foreground)]"
          >
            <TriangleAlert className="mt-0.5 shrink-0 text-[var(--destructive)]" size="1rem" />
            <div className="space-y-1">
              <p className="font-semibold">{hasItems ? "Transfer offer failed" : "Nothing selected"}</p>
              <p className="text-[var(--muted-foreground)]">
                {hasItems ? createError : "Choose at least one chat or character before sending to another device."}
              </p>
            </div>
          </div>
        )}

        {offer && (
          <div className="space-y-4">
            <div
              role={qrCodeError ? "alert" : !qrCodeUrl ? "status" : undefined}
              aria-live={qrCodeError ? "assertive" : !qrCodeUrl ? "polite" : undefined}
              className="flex justify-center rounded-lg border border-[var(--border)]/60 bg-[var(--foreground)] p-4"
            >
              {qrCodeUrl ? (
                <img src={qrCodeUrl} alt="LAN transfer QR code" className="h-56 w-56 rounded-md" />
              ) : (
                <div className="flex h-56 w-56 items-center justify-center rounded-md bg-[var(--muted)] text-[var(--muted-foreground)]">
                  {qrCodeError ? (
                    <>
                      <TriangleAlert size="1.5rem" />
                      <span className="sr-only">{qrCodeError}</span>
                    </>
                  ) : (
                    <>
                      <Loader2 className="animate-spin" size="1.5rem" />
                      <span className="sr-only">Generating QR code...</span>
                    </>
                  )}
                </div>
              )}
            </div>

            {qrCodeError && (
              <p role="alert" className="text-sm text-[var(--muted-foreground)]">
                {qrCodeError}
              </p>
            )}

            <label className="block space-y-2">
              <span className="text-xs font-semibold uppercase text-[var(--muted-foreground)]">Transfer payload</span>
              <textarea
                readOnly
                value={offer.transferPayload}
                className="min-h-24 w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-xs text-[var(--foreground)] outline-none focus:ring-2 focus:ring-[var(--primary)]/40"
              />
            </label>
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={handleCopy}
            disabled={!offer?.transferPayload}
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--card)] px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition-colors hover:bg-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Clipboard size="1rem" />
            Copy
          </button>
          <button
            type="button"
            onClick={handleClose}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--destructive)] px-4 py-2 text-sm font-semibold text-[var(--destructive-foreground)] transition-opacity hover:opacity-90"
          >
            <XCircle size="1rem" />
            Cancel Transfer
          </button>
        </div>
      </div>
    </Modal>
  );
}
