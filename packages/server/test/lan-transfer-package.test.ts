import test from "node:test";
import assert from "node:assert/strict";
import { validateLanTransferPackage } from "../src/services/lan-transfer/lan-transfer-package.js";

test("accepts a minimal valid transfer package", () => {
  const result = validateLanTransferPackage({
    version: 1,
    manifest: {
      version: 1,
      createdAt: "2026-05-19T00:00:00.000Z",
      expiresAt: "2026-05-19T00:10:00.000Z",
      sourceApp: "Marinara Engine",
      sourceVersion: "1.6.0",
      items: [{ type: "chat", id: "chat-1", name: "Chat", format: "jsonl", messageCount: 1, bytes: 20 }],
      totalBytes: 20,
    },
    items: [{ type: "chat", id: "chat-1", name: "Chat", format: "jsonl", content: "{}\n{\"mes\":\"hi\"}" }],
  });

  assert.equal(result.ok, true);
});

test("rejects unknown item types", () => {
  const result = validateLanTransferPackage({
    version: 1,
    manifest: {
      version: 1,
      createdAt: "2026-05-19T00:00:00.000Z",
      expiresAt: "2026-05-19T00:10:00.000Z",
      sourceApp: "Marinara Engine",
      sourceVersion: "1.6.0",
      items: [{ type: "unknown", id: "x", name: "Bad", bytes: 1 }],
      totalBytes: 1,
    },
    items: [{ type: "unknown", id: "x", name: "Bad", content: "" }],
  });

  assert.equal(result.ok, false);
});

test("rejects oversized packages", () => {
  const result = validateLanTransferPackage(
    {
      version: 1,
      manifest: {
        version: 1,
        createdAt: "2026-05-19T00:00:00.000Z",
        expiresAt: "2026-05-19T00:10:00.000Z",
        sourceApp: "Marinara Engine",
        sourceVersion: "1.6.0",
        items: [],
        totalBytes: 10,
      },
      items: [],
    },
    { maxBytes: 1 },
  );

  assert.equal(result.ok, false);
});
