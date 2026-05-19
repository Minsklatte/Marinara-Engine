import type { LanTransferEncryptedPackage, LanTransferManifest } from "@marinara-engine/shared";

export interface LanTransferStoredOffer {
  offerId: string;
  downloadTokenHash: string;
  expiresAtMs: number;
  manifest: LanTransferManifest;
  encryptedPackage: LanTransferEncryptedPackage;
}

export interface LanTransferOfferStoreOptions {
  maxOffers?: number;
  now?: () => number;
}

export interface LanTransferOfferStore {
  put(offer: LanTransferStoredOffer): void;
  get(offerId: string): LanTransferStoredOffer | null;
  consume(offerId: string): LanTransferStoredOffer | null;
  delete(offerId: string): boolean;
  size(): number;
}

export function createLanTransferOfferStore(
  options: LanTransferOfferStoreOptions = {},
): LanTransferOfferStore {
  const maxOffers = options.maxOffers ?? 10;
  const now = options.now ?? Date.now;
  const offers = new Map<string, LanTransferStoredOffer>();

  function pruneExpired(): void {
    const nowMs = now();

    for (const [offerId, offer] of offers) {
      if (offer.expiresAtMs <= nowMs) {
        offers.delete(offerId);
      }
    }
  }

  return {
    put(offer) {
      pruneExpired();

      if (!offers.has(offer.offerId) && offers.size >= maxOffers) {
        throw new Error("Maximum active LAN transfer offers exceeded");
      }

      offers.set(offer.offerId, offer);
    },
    get(offerId) {
      pruneExpired();
      return offers.get(offerId) ?? null;
    },
    consume(offerId) {
      pruneExpired();
      const offer = offers.get(offerId) ?? null;

      if (offer) {
        offers.delete(offerId);
      }

      return offer;
    },
    delete(offerId) {
      return offers.delete(offerId);
    },
    size() {
      pruneExpired();
      return offers.size;
    },
  };
}

export const lanTransferOfferStore = createLanTransferOfferStore({ maxOffers: 10 });
