import test from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { promises as dns } from "node:dns";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LAN_TRANSFER_TYPE,
  LAN_TRANSFER_VERSION,
  type LanTransferEncryptedPackage,
  type LanTransferManifest,
  type LanTransferPackage,
} from "@marinara-engine/shared";
import { createFileNativeDB } from "../src/db/file-backed-store.js";
import {
  encryptLanTransferPackage,
  hashLanTransferToken,
} from "../src/services/lan-transfer/lan-transfer-crypto.js";
import { lanTransferOfferStore } from "../src/services/lan-transfer/lan-transfer-offer-store.js";
import { serializeLanTransferPayload } from "../src/services/lan-transfer/lan-transfer-payload.js";

type EnvPatch = Record<string, string | undefined>;

const testManifest: LanTransferManifest = {
  version: 1,
  createdAt: "2026-05-19T00:00:00.000Z",
  expiresAt: "2999-05-19T00:10:00.000Z",
  sourceApp: "Marinara Engine",
  sourceVersion: "1.6.0",
  items: [],
  totalBytes: 0,
};

const testEncryptedPackage: LanTransferEncryptedPackage = {
  version: 1,
  algorithm: "AES-256-GCM",
  salt: "salt",
  iv: "iv",
  aad: "aad",
  ciphertext: "ciphertext",
  tag: "tag",
};

const testPackage: LanTransferPackage = {
  version: 1,
  manifest: testManifest,
  items: [],
};

function withEnv<T>(patch: EnvPatch, fn: () => Promise<T>) {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(patch)) {
    previous.set(key, process.env[key]);
    const value = patch[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  return fn().finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

async function withLanTransferApp<T>(
  env: EnvPatch,
  fn: (app: FastifyInstance) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "marinara-lan-transfer-routes-"));

  return withEnv(
    {
      DATA_DIR: join(root, "data"),
      FILE_STORAGE_DIR: join(root, "storage"),
      LAN_TRANSFER_ENABLED: undefined,
      MARINARA_LAN_TRANSFER_ENABLED: undefined,
      ...env,
    },
    async () => {
      const { lanTransferRoutes } = await import("../src/routes/lan-transfer.routes.js");
      const db = await createFileNativeDB();
      const app = Fastify({ logger: false });
      app.decorate("db", db);
      await app.register(lanTransferRoutes, { prefix: "/api/lan-transfer" });
      await app.ready();

      try {
        return await fn(app);
      } finally {
        await app.close();
        await db._fileStore.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}

test("create offer with no items returns 400 when LAN transfer is enabled", async () =>
  withLanTransferApp({ LAN_TRANSFER_ENABLED: "1" }, async (app) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/lan-transfer/offers",
      payload: { items: [] },
    });

    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(JSON.parse(response.body), { error: "items must be a non-empty array" });
  }));

test("preview with invalid payload returns 400", async () =>
  withLanTransferApp({ LAN_TRANSFER_ENABLED: "1" }, async (app) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/lan-transfer/preview",
      payload: { transferPayload: "not-json" },
    });

    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(JSON.parse(response.body), { error: "Invalid LAN transfer payload" });
  }));

test("disabled LAN transfer returns 403", async () =>
  withLanTransferApp({ LAN_TRANSFER_ENABLED: undefined }, async (app) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/lan-transfer/preview",
      payload: { transferPayload: "not-json" },
    });

    assert.equal(response.statusCode, 403, response.body);
    assert.deepEqual(JSON.parse(response.body), { error: "LAN transfer is disabled" });
  }));

test("download consumes an offer once after token verification", async () =>
  withLanTransferApp({ LAN_TRANSFER_ENABLED: "1" }, async (app) => {
    const offerId = "route-download-once";
    const downloadToken = "download-token";
    lanTransferOfferStore.delete(offerId);
    lanTransferOfferStore.put({
      offerId,
      downloadTokenHash: hashLanTransferToken(downloadToken),
      expiresAtMs: Date.now() + 60_000,
      manifest: testManifest,
      encryptedPackage: testEncryptedPackage,
    });

    const first = await app.inject({
      method: "POST",
      url: `/api/lan-transfer/offers/${offerId}/download`,
      payload: { downloadToken },
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/lan-transfer/offers/${offerId}/download`,
      payload: { downloadToken },
    });

    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(JSON.parse(first.body), testEncryptedPackage);
    assert.equal(second.statusCode, 404, second.body);
  }));

test("preview rejects public sender origins before fetch", async () =>
  withLanTransferApp({ LAN_TRANSFER_ENABLED: "1" }, async (app) => {
    const transferPayload = serializeLanTransferPayload({
      type: LAN_TRANSFER_TYPE,
      version: LAN_TRANSFER_VERSION,
      from: "http://8.8.8.8:7860",
      offerId: "public-offer",
      downloadToken: "download-token",
      secret: "secret",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/lan-transfer/preview",
      payload: { transferPayload },
    });

    assert.equal(response.statusCode, 400, response.body);
    assert.match(JSON.parse(response.body).error, /outside allowed LAN ranges/);
  }));

test("preview fetches a sender manifest from a validated loopback origin", async () =>
  withLanTransferApp({ LAN_TRANSFER_ENABLED: "1" }, async (app) => {
    const offerId = "route-preview-loopback";
    const downloadToken = "download-token";
    lanTransferOfferStore.delete(offerId);
    lanTransferOfferStore.put({
      offerId,
      downloadTokenHash: hashLanTransferToken(downloadToken),
      expiresAtMs: Date.now() + 60_000,
      manifest: testManifest,
      encryptedPackage: testEncryptedPackage,
    });

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.equal(typeof address, "object");
    assert.notEqual(address, null);
    const transferPayload = serializeLanTransferPayload({
      type: LAN_TRANSFER_TYPE,
      version: LAN_TRANSFER_VERSION,
      from: `http://127.0.0.1:${address.port}`,
      offerId,
      downloadToken,
      secret: "secret",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/lan-transfer/preview",
      payload: { transferPayload },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(JSON.parse(response.body), {
      from: `http://127.0.0.1:${address.port}`,
      offerId,
      expiresAt: testManifest.expiresAt,
      manifest: testManifest,
    });
  }));

test("preview fetch uses the validated sender address after DNS rebinding", async () =>
  withLanTransferApp({ LAN_TRANSFER_ENABLED: "1" }, async (app) => {
    const offerId = "route-preview-pinned-address";
    const downloadToken = "download-token";
    lanTransferOfferStore.delete(offerId);
    lanTransferOfferStore.put({
      offerId,
      downloadTokenHash: hashLanTransferToken(downloadToken),
      expiresAtMs: Date.now() + 60_000,
      manifest: testManifest,
      encryptedPackage: testEncryptedPackage,
    });

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.equal(typeof address, "object");
    assert.notEqual(address, null);
    const originalLookup = dns.lookup;
    let lookupCalls = 0;
    dns.lookup = (async () => {
      lookupCalls += 1;
      return [{ address: lookupCalls === 1 ? "127.0.0.1" : "8.8.8.8", family: 4 }];
    }) as typeof dns.lookup;

    try {
      const transferPayload = serializeLanTransferPayload({
        type: LAN_TRANSFER_TYPE,
        version: LAN_TRANSFER_VERSION,
        from: `http://sender.test:${address.port}`,
        offerId,
        downloadToken,
        secret: "secret",
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/lan-transfer/preview",
        payload: { transferPayload },
      });

      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(JSON.parse(response.body), {
        from: `http://sender.test:${address.port}`,
        offerId,
        expiresAt: testManifest.expiresAt,
        manifest: testManifest,
      });
      assert.equal(lookupCalls, 1);
    } finally {
      dns.lookup = originalLookup;
    }
  }));

test("import-from-offer downloads, decrypts, validates, and imports a remote package", async () =>
  withLanTransferApp({ LAN_TRANSFER_ENABLED: "1" }, async (app) => {
    const offerId = "route-import-from-offer";
    const downloadToken = "download-token";
    const secret = "transfer-secret";
    lanTransferOfferStore.delete(offerId);
    lanTransferOfferStore.put({
      offerId,
      downloadTokenHash: hashLanTransferToken(downloadToken),
      expiresAtMs: Date.now() + 60_000,
      manifest: testManifest,
      encryptedPackage: encryptLanTransferPackage(JSON.stringify(testPackage), secret),
    });

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.equal(typeof address, "object");
    assert.notEqual(address, null);
    const transferPayload = serializeLanTransferPayload({
      type: LAN_TRANSFER_TYPE,
      version: LAN_TRANSFER_VERSION,
      from: `http://127.0.0.1:${address.port}`,
      offerId,
      downloadToken,
      secret,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/lan-transfer/import-from-offer",
      payload: { transferPayload },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(JSON.parse(response.body), {
      imported: {
        chats: 0,
        characters: 0,
      },
      skipped: [],
    });
    assert.equal(lanTransferOfferStore.get(offerId), null);
  }));
