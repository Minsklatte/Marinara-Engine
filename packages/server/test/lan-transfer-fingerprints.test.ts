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

test("character fingerprints are stable across reordered object keys", async () => {
  const { fingerprintNativeCharacterEnvelope } = await import(
    "../src/services/lan-transfer/lan-transfer-fingerprints.js"
  );

  const first = {
    type: "marinara_character",
    version: 1,
    data: {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name: "Alicia",
        description: "same",
        tags: ["pilot", "engineer"],
      },
    },
  };
  const second = {
    version: 1,
    data: {
      data: {
        tags: ["pilot", "engineer"],
        description: "same",
        name: "Alicia",
      },
      spec_version: "2.0",
      spec: "chara_card_v2",
    },
    type: "marinara_character",
  };

  assert.equal(fingerprintNativeCharacterEnvelope(first), fingerprintNativeCharacterEnvelope(second));
});

test("character fingerprint includes real generic LAN transfer extension content", async () => {
  const { fingerprintNativeCharacterEnvelope } = await import(
    "../src/services/lan-transfer/lan-transfer-fingerprints.js"
  );

  const base = {
    type: "marinara_character",
    version: 1,
    data: {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name: "Alicia",
        description: "same",
        extensions: {
          lanTransfer: { inUniverseRelay: "deck-seven" },
        },
      },
    },
  };
  const changed = {
    ...base,
    data: {
      ...base.data,
      data: {
        ...base.data.data,
        extensions: {
          lanTransfer: { inUniverseRelay: "deck-eight" },
        },
      },
    },
  };

  assert.notEqual(fingerprintNativeCharacterEnvelope(base), fingerprintNativeCharacterEnvelope(changed));
});

test("readLanTransferSyncId reads namespaced character extension sync metadata", async () => {
  const { readLanTransferSyncId } = await import("../src/services/lan-transfer/lan-transfer-fingerprints.js");

  assert.equal(
    readLanTransferSyncId({
      type: "marinara_character",
      data: {
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: {
          name: "Alicia",
          extensions: {
            marinara_lan_transfer: {
              syncId: "source-character",
              fingerprint: "existing",
            },
          },
        },
      },
    }),
    "source-character",
  );
});

test("readLanTransferSyncId rejects unscoped and generic LAN transfer values", async () => {
  const { readLanTransferSyncId } = await import("../src/services/lan-transfer/lan-transfer-fingerprints.js");

  const rejectedValues = [
    { marinara_lan_transfer: { syncId: "root-namespaced" } },
    { lanTransfer: { syncId: "root-generic" } },
    { extensions: { marinara_lan_transfer: { syncId: "root-extension" } } },
    {
      data: {
        data: {
          lanTransfer: { syncId: "card-unscoped" },
        },
      },
    },
    {
      data: {
        data: {
          extensions: {
            lanTransfer: { syncId: "card-generic" },
          },
        },
      },
    },
  ];

  for (const value of rejectedValues) {
    assert.equal(readLanTransferSyncId(value), null);
  }
});

test("withLanTransferCharacterSyncMetadata does not mutate the original envelope", async () => {
  const { withLanTransferCharacterSyncMetadata } = await import(
    "../src/services/lan-transfer/lan-transfer-fingerprints.js"
  );

  const original = {
    type: "marinara_character",
    data: {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name: "Alicia",
        extensions: {
          existing: { value: true },
        },
      },
    },
  };
  const before = structuredClone(original);

  const withSync = withLanTransferCharacterSyncMetadata(original, {
    syncId: "source-character",
    fingerprint: "existing",
  });

  assert.deepEqual(original, before);
  assert.notEqual(withSync, original);
  assert.notEqual(withSync.data, original.data);
  assert.notEqual(withSync.data.data, original.data.data);
  assert.notEqual(withSync.data.data.extensions, original.data.data.extensions);
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
