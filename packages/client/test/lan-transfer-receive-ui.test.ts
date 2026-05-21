import test from "node:test";
import assert from "node:assert/strict";
import type {
  LanTransferImportSummary,
  LanTransferPreviewAction,
  LanTransferPreviewResponse,
} from "@marinara-engine/shared";
import {
  buildLanTransferPreviewRows,
  getImportButtonLabel,
  getLanTransferImportToast,
  isLanTransferPreviewNoOp,
} from "../src/lib/lan-transfer-receive-ui.js";

const reuseCard: LanTransferPreviewAction = {
  type: "character",
  sourceId: "char-sync",
  name: "Alicia",
  action: "reuse",
  targetId: "local-char",
  reason: "Matching native character already exists",
};

const skipChat: LanTransferPreviewAction = {
  type: "chat",
  sourceId: "chat-sync",
  name: "Alicia Chat",
  action: "skip",
  targetId: "local-chat",
  messageCount: 2,
  linkedCharacterNames: ["Alicia"],
  reason: "Existing synced chat is already up to date",
};

const appendChat: LanTransferPreviewAction = {
  ...skipChat,
  action: "append",
  appendCount: 3,
  reason: "Existing synced chat is missing 3 newer messages",
};

function preview(actions: LanTransferPreviewAction[]): LanTransferPreviewResponse {
  return {
    from: "http://192.168.1.230:7860",
    offerId: "offer",
    expiresAt: "2999-01-01T00:00:00.000Z",
    manifest: {
      version: 1,
      createdAt: "2026-05-21T00:00:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z",
      sourceApp: "Marinara Engine",
      sourceVersion: "1.6.0",
      totalBytes: 100,
      items: [
        {
          type: "character",
          id: "char-sync",
          syncId: "char-sync",
          name: "Alicia",
          format: "native",
          fingerprint: "fingerprint",
          bytes: 40,
        },
        {
          type: "chat",
          id: "chat-sync",
          syncId: "chat-sync",
          name: "Alicia Chat",
          format: "native",
          messageCount: 2,
          characterCount: 1,
          characterIds: ["char-sync"],
          bytes: 60,
        },
      ],
    },
    analysis: { mode: "smart", actions },
  };
}

test("smart preview with only reused cards and skipped chats is a no-op", () => {
  assert.equal(isLanTransferPreviewNoOp(preview([reuseCard, skipChat]), false), true);
  assert.equal(getImportButtonLabel(preview([reuseCard, skipChat]), false), "Already up to date");
});

test("copy mode is never blocked as a no-op", () => {
  assert.equal(isLanTransferPreviewNoOp(preview([reuseCard, skipChat]), true), false);
  assert.equal(getImportButtonLabel(preview([reuseCard, skipChat]), true), "Import Copies");
});

test("append action is not a no-op", () => {
  assert.equal(isLanTransferPreviewNoOp(preview([reuseCard, appendChat]), false), false);
  assert.equal(getImportButtonLabel(preview([reuseCard, appendChat]), false), "Import");
});

test("preview rows group card and linked chat under one character without linked-to copy", () => {
  const rows = buildLanTransferPreviewRows(preview([reuseCard, appendChat]), false);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.title, "Alicia");
  assert.deepEqual(rows[0]?.chips.map((chip) => chip.label), ["1 card", "1 chat"]);
  assert.deepEqual(rows[0]?.chips.map((chip) => chip.tone), ["card", "chat"]);
  assert.deepEqual(rows[0]?.actions.map((chip) => chip.label), ["Using existing card", "Will add 3 messages"]);
  assert.equal(rows[0]?.actions.some((chip) => chip.label.includes("linked to")), false);
});

test("copy-mode grouped rows show one copy action chip", () => {
  const rows = buildLanTransferPreviewRows(preview([reuseCard, skipChat]), true);

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]?.actions.map((chip) => chip.label), ["Will import a copy"]);
});

test("empty smart import toast is neutral info and does not claim an import happened", () => {
  const summary: LanTransferImportSummary = {
    imported: { chats: 0, characters: 0 },
    reused: { chats: 1, characters: 1 },
    skipped: [],
  };

  assert.deepEqual(getLanTransferImportToast(summary), {
    kind: "info",
    message: "Nothing changed. This device is already up to date.",
    closeModal: false,
  });
});

test("append-only import toast reports update and existing card", () => {
  const summary: LanTransferImportSummary = {
    imported: { chats: 0, characters: 0 },
    reused: { characters: 1, chats: 0 },
    appended: { chats: 1, messages: 3 },
    skipped: [],
  };

  assert.deepEqual(getLanTransferImportToast(summary), {
    kind: "success",
    message: "Updated 1 chat with 3 new messages; used 1 existing card.",
    closeModal: true,
  });
});

test("copy import toast pluralizes multiple copied items as copies", () => {
  const summary: LanTransferImportSummary = {
    imported: { chats: 2, characters: 0 },
    copied: { chats: 2, characters: 0 },
    skipped: [],
  };

  assert.deepEqual(getLanTransferImportToast(summary), {
    kind: "success",
    message: "imported 2 chats as copies.",
    closeModal: true,
  });
});
