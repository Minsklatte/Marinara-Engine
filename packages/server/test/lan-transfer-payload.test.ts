import test from "node:test";
import assert from "node:assert/strict";
import {
  parseLanTransferPayload,
  serializeLanTransferPayload,
} from "../src/services/lan-transfer/lan-transfer-payload.js";

test("serializes and parses a valid LAN transfer payload", () => {
  const raw = serializeLanTransferPayload({
    type: "marinara-lan-transfer",
    version: 1,
    from: "http://192.168.1.50:7860",
    offerId: "offer_123",
    downloadToken: "download-token",
    secret: "secret-key",
  });

  assert.deepEqual(parseLanTransferPayload(raw), {
    type: "marinara-lan-transfer",
    version: 1,
    from: "http://192.168.1.50:7860",
    offerId: "offer_123",
    downloadToken: "download-token",
    secret: "secret-key",
  });
});

test("rejects malformed payload JSON", () => {
  assert.equal(parseLanTransferPayload("{not-json"), null);
});

test("rejects payloads with a non-origin from value", () => {
  const payload = JSON.stringify({
    type: "marinara-lan-transfer",
    version: 1,
    from: "http://192.168.1.50:7860/path?x=1",
    offerId: "offer_123",
    downloadToken: "download-token",
    secret: "secret-key",
  });

  assert.equal(parseLanTransferPayload(payload), null);
});

test("rejects payloads without token and secret", () => {
  const payload = JSON.stringify({
    type: "marinara-lan-transfer",
    version: 1,
    from: "http://192.168.1.50:7860",
    offerId: "offer_123",
  });

  assert.equal(parseLanTransferPayload(payload), null);
});

test("rejects payloads missing downloadToken", () => {
  const payload = JSON.stringify({
    type: "marinara-lan-transfer",
    version: 1,
    from: "http://192.168.1.50:7860",
    offerId: "offer_123",
    secret: "secret-key",
  });

  assert.equal(parseLanTransferPayload(payload), null);
});

test("rejects payloads missing secret", () => {
  const payload = JSON.stringify({
    type: "marinara-lan-transfer",
    version: 1,
    from: "http://192.168.1.50:7860",
    offerId: "offer_123",
    downloadToken: "download-token",
  });

  assert.equal(parseLanTransferPayload(payload), null);
});
