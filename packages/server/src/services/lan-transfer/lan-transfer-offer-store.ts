import type { LanTransferEncryptedPackage, LanTransferManifest } from "@marinara-engine/shared";

export interface LanTransferStoredOffer {
  offerId: string;
  downloadTokenHash: string;
  expiresAtMs: number;
  manifest: LanTransferManifest;
  encryptedPackage: LanTransferEncryptedPackage;
  previewedAtMs?: number;
  downloadedAtMs?: number;
}

export type LanTransferStoredOfferStatus = Omit<LanTransferStoredOffer, "encryptedPackage">;

export interface LanTransferOfferStoreOptions {
  maxOffers?: number;
  now?: () => number;
}

export interface LanTransferOfferStore {
  put(offer: LanTransferStoredOffer): void;
  get(offerId: string): LanTransferStoredOffer | null;
  getStatus(offerId: string): LanTransferStoredOfferStatus | null;
  markPreviewed(offerId: string): LanTransferStoredOfferStatus | null;
  markDownloaded(offerId: string): LanTransferStoredOfferStatus | null;
  consume(offerId: string): LanTransferStoredOffer | null;
  delete(offerId: string): boolean;
  size(): number;
}

type LanTransferOfferRecord = Omit<LanTransferStoredOffer, "encryptedPackage"> & {
  encryptedPackage?: LanTransferEncryptedPackage;
};

export function createLanTransferOfferStore(
  options: LanTransferOfferStoreOptions = {},
): LanTransferOfferStore {
  const maxOffers = options.maxOffers ?? 10;
  const now = options.now ?? Date.now;
  const offers = new Map<string, LanTransferOfferRecord>();

  function pruneExpired(): void {
    const nowMs = now();

    for (const [offerId, offer] of offers) {
      if (offer.expiresAtMs <= nowMs) {
        offers.delete(offerId);
      }
    }
  }

  function activeOfferCount(): number {
    let count = 0;
    for (const offer of offers.values()) {
      if (offer.encryptedPackage) count += 1;
    }
    return count;
  }

  function toActiveOffer(offer: LanTransferOfferRecord | undefined): LanTransferStoredOffer | null {
    if (!offer?.encryptedPackage) return null;
    return { ...offer, encryptedPackage: offer.encryptedPackage };
  }

  function toStatus(offer: LanTransferOfferRecord | undefined): LanTransferStoredOfferStatus | null {
    if (!offer) return null;
    const { encryptedPackage: _encryptedPackage, ...status } = offer;
    return status;
  }

  return {
    put(offer) {
      pruneExpired();

      if (!offers.has(offer.offerId) && activeOfferCount() >= maxOffers) {
        throw new Error("Maximum active LAN transfer offers exceeded");
      }

      offers.set(offer.offerId, { ...offer });
    },
    get(offerId) {
      pruneExpired();
      return toActiveOffer(offers.get(offerId));
    },
    getStatus(offerId) {
      pruneExpired();
      return toStatus(offers.get(offerId));
    },
    markPreviewed(offerId) {
      pruneExpired();
      const offer = offers.get(offerId);
      if (!offer) return null;
      offer.previewedAtMs = offer.previewedAtMs ?? now();
      return toStatus(offer);
    },
    markDownloaded(offerId) {
      pruneExpired();
      const offer = offers.get(offerId);
      if (!offer) return null;
      offer.downloadedAtMs = offer.downloadedAtMs ?? now();
      return toStatus(offer);
    },
    consume(offerId) {
      pruneExpired();
      const offer = offers.get(offerId);
      const activeOffer = toActiveOffer(offer);
      if (!offer || !activeOffer) return null;

      offer.downloadedAtMs = offer.downloadedAtMs ?? now();
      delete offer.encryptedPackage;
      return activeOffer;
    },
    delete(offerId) {
      return offers.delete(offerId);
    },
    size() {
      pruneExpired();
      return activeOfferCount();
    },
  };
}

export const lanTransferOfferStore = createLanTransferOfferStore({ maxOffers: 10 });
