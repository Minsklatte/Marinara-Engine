// Modal: Send chats and characters to another LAN device
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Clipboard, Loader2, QrCode, Radio, TriangleAlert, XCircle } from "lucide-react";
import QRCode from "qrcode";
import { toast } from "sonner";
import {
  LAN_TRANSFER_TYPE,
  LAN_TRANSFER_VERSION,
  type LanTransferCreateOfferResponse,
  type LanTransferItemRequest,
  type LanTransferPayload,
} from "@marinara-engine/shared";
import {
  useCancelLanTransferOffer,
  useCreateLanTransferOffer,
  useLanTransferOfferStatus,
} from "../../hooks/use-lan-transfer";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOriginOnlyHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      value === url.origin
    );
  } catch {
    return false;
  }
}

function parseLanTransferPayload(raw: string): LanTransferPayload | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;

  const { type, version, from, origins, offerId, downloadToken, secret } = parsed;
  if (
    type !== LAN_TRANSFER_TYPE ||
    version !== LAN_TRANSFER_VERSION ||
    typeof from !== "string" ||
    typeof offerId !== "string" ||
    typeof downloadToken !== "string" ||
    typeof secret !== "string" ||
    !isOriginOnlyHttpUrl(from)
  ) {
    return null;
  }

  const normalizedOrigins = Array.isArray(origins)
    ? Array.from(
        new Set(
          origins.filter((origin): origin is string => typeof origin === "string" && origin.trim().length > 0),
        ),
      )
        .map((origin) => origin.trim())
        .filter(isOriginOnlyHttpUrl)
        .slice(0, 5)
    : [];

  return {
    type: LAN_TRANSFER_TYPE,
    version: LAN_TRANSFER_VERSION,
    from,
    origins: normalizedOrigins.length > 0 ? normalizedOrigins : [from],
    offerId,
    downloadToken,
    secret,
  };
}

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
      body: "This transfer was cancelled, expired, or is no longer available.",
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
  const offerPayload = useMemo(
    () => (offer?.transferPayload ? parseLanTransferPayload(offer.transferPayload) : null),
    [offer?.transferPayload],
  );
  const senderOrigin = offerPayload?.origins?.[0] ?? offerPayload?.from ?? null;
  const offerStatus = useLanTransferOfferStatus(offer?.offerId ?? null, open && !!offer);
  const senderStatusCopy = getSenderStatusCopy(offerStatus.data?.state);
  const SenderStatusIcon = senderStatusCopy.icon;
  const shouldAnimateSenderStatusIcon = !offerStatus.data?.state || offerStatus.data.state === "waiting";
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

  const handleCopyOrigin = useCallback(async () => {
    if (!senderOrigin) return;

    try {
      await navigator.clipboard.writeText(senderOrigin);
      toast.success("Sender address copied.");
    } catch {
      toast.error("Could not copy automatically. Select the address and copy it manually.");
    }
  }, [senderOrigin]);

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
                This offer is available for 10 minutes and can be downloaded once by a device on your LAN. Keep this sender
                window open; closing it cancels the transfer.
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
            <div className={`flex items-start gap-3 rounded-lg border p-3 text-sm ${senderStatusCopy.className}`}>
              <SenderStatusIcon
                className={shouldAnimateSenderStatusIcon ? "mt-0.5 shrink-0 animate-spin" : "mt-0.5 shrink-0"}
                size="1rem"
              />
              <div className="space-y-1">
                <p className="font-semibold">{senderStatusCopy.title}</p>
                <p>{senderStatusCopy.body}</p>
              </div>
            </div>

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

            {senderOrigin && (
              <div className="space-y-2 rounded-lg border border-[var(--border)]/60 bg-[var(--card)]/70 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold uppercase text-[var(--muted-foreground)]">
                    Sender address
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleCopyOrigin()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2.5 py-1.5 text-xs font-semibold text-[var(--foreground)] transition-colors hover:bg-[var(--accent)]"
                  >
                    <Clipboard size="0.8125rem" />
                    Copy Address
                  </button>
                </div>
                <input
                  readOnly
                  aria-label="Sender address"
                  value={senderOrigin}
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-xs text-[var(--foreground)] outline-none focus:ring-2 focus:ring-[var(--primary)]/40"
                />
              </div>
            )}

            <label className="block space-y-2">
              <span className="text-xs font-semibold uppercase text-[var(--muted-foreground)]">
                Transfer payload (fallback)
              </span>
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
            Copy Payload
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
