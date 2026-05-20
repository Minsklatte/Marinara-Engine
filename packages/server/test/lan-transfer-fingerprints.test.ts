import test from "node:test";
import assert from "node:assert/strict";

test("character fingerprint ignores export timestamp and LAN sync extension", async () => {
  const { fingerprintNativeCharacterEnvelope, withLanTransferCharacterSyncMetadata } = await import(
    "../src/services/lan-transfer/lan-transfer-fingerprints.js"
  );

  const base = {
    type: "marinara_character",
    version: 1,
    exportedAt: "2026-05-20T00:00:00.000Z",
    data: {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: { name: "Alicia", description: "same", extensions: {} },
      metadata: { comment: "same" },
    },
  };
  const withSync = withLanTransferCharacterSyncMetadata(base, {
    syncId: "source-character",
    fingerprint: "existing",
  });
  const later = { ...withSync, exportedAt: "2026-05-21T00:00:00.000Z" };

  assert.equal(fingerprintNativeCharacterEnvelope(base), fingerprintNativeCharacterEnvelope(later));
});

test("message fingerprints are stable for identical synced messages", async () => {
  const { fingerprintLanTransferMessage } = await import(
    "../src/services/lan-transfer/lan-transfer-fingerprints.js"
  );

  const first = fingerprintLanTransferMessage({
    role: "assistant",
    characterId: "source-character",
    content: "Hello",
    createdAt: "2026-05-20T12:00:00.000Z",
  });
  const second = fingerprintLanTransferMessage({
    role: "assistant",
    characterId: "source-character",
    content: "Hello",
    createdAt: "2026-05-20T12:00:00.000Z",
  });

  assert.equal(first, second);
});

test("message sequence prefix detection distinguishes append and divergence", async () => {
  const { compareFingerprintSequences } = await import("../src/services/lan-transfer/lan-transfer-fingerprints.js");

  assert.deepEqual(compareFingerprintSequences(["a", "b"], ["a", "b", "c"]), {
    kind: "incoming_extends_local",
    appendFrom: 2,
  });
  assert.deepEqual(compareFingerprintSequences(["a", "b"], ["a", "x"]), { kind: "diverged" });
  assert.deepEqual(compareFingerprintSequences(["a", "b"], ["a", "b"]), { kind: "same" });
  assert.deepEqual(compareFingerprintSequences(["a", "b", "c"], ["a", "b"]), { kind: "local_ahead" });
});
