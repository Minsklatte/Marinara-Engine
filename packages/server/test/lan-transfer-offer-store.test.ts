import test from "node:test";
import assert from "node:assert/strict";
import { createLanTransferOfferStore } from "../src/services/lan-transfer/lan-transfer-offer-store.js";

const manifest = {
  version: 1 as const,
  createdAt: "2026-05-19T00:00:00.000Z",
  expiresAt: "2026-05-19T00:10:00.000Z",
  sourceApp: "Marinara Engine" as const,
  sourceVersion: "1.6.0",
  items: [],
  totalBytes: 0,
};

const encryptedPackage = {
  version: 1 as const,
  algorithm: "AES-256-GCM" as const,
  salt: "salt",
  iv: "iv",
  aad: "aad",
  ciphertext: "ciphertext",
  tag: "tag",
};

test("stores, reads, consumes, and removes offers", () => {
  const store = createLanTransferOfferStore({ maxOffers: 2, now: () => 1000 });
  store.put({
    offerId: "offer-1",
    downloadTokenHash: "hash-1",
    expiresAtMs: 2000,
    manifest,
    encryptedPackage,
  });

  assert.equal(store.get("offer-1")?.offerId, "offer-1");
  assert.equal(store.consume("offer-1")?.offerId, "offer-1");
  assert.equal(store.get("offer-1"), null);
});

test("expires offers before returning them", () => {
  const store = createLanTransferOfferStore({ maxOffers: 2, now: () => 3000 });
  store.put({
    offerId: "offer-1",
    downloadTokenHash: "hash-1",
    expiresAtMs: 2000,
    manifest,
    encryptedPackage,
  });

  assert.equal(store.get("offer-1"), null);
});

test("enforces max active offers", () => {
  const store = createLanTransferOfferStore({ maxOffers: 1, now: () => 1000 });
  store.put({
    offerId: "offer-1",
    downloadTokenHash: "hash-1",
    expiresAtMs: 2000,
    manifest,
    encryptedPackage,
  });

  assert.throws(() =>
    store.put({
      offerId: "offer-2",
      downloadTokenHash: "hash-2",
      expiresAtMs: 2000,
      manifest,
      encryptedPackage,
    }),
  );
});
