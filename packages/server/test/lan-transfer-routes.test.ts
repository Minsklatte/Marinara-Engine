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
import { buildLanTransferPackage } from "../src/services/lan-transfer/lan-transfer-package.js";
import { lanTransferOfferStore } from "../src/services/lan-transfer/lan-transfer-offer-store.js";
import {
  parseLanTransferPayload,
  serializeLanTransferPayload,
} from "../src/services/lan-transfer/lan-transfer-payload.js";
import { basicAuthHook } from "../src/middleware/basic-auth.js";
import { createCharactersStorage } from "../src/services/storage/characters.storage.js";
import { createChatsStorage } from "../src/services/storage/chats.storage.js";

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
  options: { basicAuth?: boolean } = {},
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
      if (options.basicAuth) app.addHook("onRequest", basicAuthHook);
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

function seedLanTransferOffer(offerId: string, downloadToken: string) {
  lanTransferOfferStore.delete(offerId);
  lanTransferOfferStore.put({
    offerId,
    downloadTokenHash: hashLanTransferToken(downloadToken),
    expiresAtMs: Date.now() + 60_000,
    manifest: testManifest,
    encryptedPackage: testEncryptedPackage,
  });
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

test("origin helper ranks public configured origin before loopback request origin", async () => {
  const { resolveLanTransferOrigins } = await import("../src/services/lan-transfer/lan-transfer-origins.js");
  const origins = resolveLanTransferOrigins({
    protocol: "http",
    requestHost: "localhost:7860",
    configuredOrigin: "http://192.168.1.230:7860",
    interfaceAddresses: ["192.168.1.230", "10.12.42.103"],
    port: 7860,
  });

  assert.deepEqual(origins, [
    "http://192.168.1.230:7860",
    "http://10.12.42.103:7860",
    "http://localhost:7860",
  ]);
});

test("origin helper preserves request origin under the candidate cap", async () => {
  const { resolveLanTransferOrigins } = await import("../src/services/lan-transfer/lan-transfer-origins.js");
  const origins = resolveLanTransferOrigins({
    protocol: "http",
    requestHost: "localhost:7860",
    configuredOrigin: "http://192.168.1.230:7860",
    interfaceAddresses: [
      "192.168.1.230",
      "10.12.42.103",
      "10.12.42.104",
      "10.12.42.105",
      "10.12.42.106",
    ],
    port: 7860,
  });

  assert.equal(origins.length, 5);
  assert.equal(origins[0], "http://192.168.1.230:7860");
  assert.equal(origins.at(-1), "http://localhost:7860");
});

test("origin helper normalizes and dedupes configured origin", async () => {
  const { resolveLanTransferOrigins } = await import("../src/services/lan-transfer/lan-transfer-origins.js");
  const origins = resolveLanTransferOrigins({
    protocol: "http",
    requestHost: "localhost:7860",
    configuredOrigin: "http://user:pass@localhost:7860/path?debug=1#section",
    interfaceAddresses: [],
    port: 7860,
  });

  assert.deepEqual(origins, ["http://localhost:7860"]);
});

test("create offer advertises configured public origin first", async () =>
  withLanTransferApp(
    {
      LAN_TRANSFER_ENABLED: "1",
      LAN_TRANSFER_PUBLIC_ORIGIN: "http://192.168.1.230:7860",
      PORT: "7860",
    },
    async (app) => {
      const characters = createCharactersStorage(app.db);
      const character = await characters.create({
        name: "LAN Origin Test Character",
        description: "",
        personality: "",
        scenario: "",
        first_mes: "Hello.",
        mes_example: "",
        creator_notes: "",
        system_prompt: "",
        post_history_instructions: "",
        tags: [],
        creator: "",
        character_version: "",
        alternate_greetings: [],
        extensions: {
          talkativeness: 0.5,
          fav: false,
          world: "",
          depth_prompt: { prompt: "", depth: 4, role: "system" },
          backstory: "",
          appearance: "",
        },
        character_book: null,
      });
      assert.notEqual(character, null);

      const response = await app.inject({
        method: "POST",
        url: "/api/lan-transfer/offers",
        headers: { host: "localhost:7860" },
        payload: { items: [{ type: "character", id: character.id }] },
      });

      assert.equal(response.statusCode, 200, response.body);
      const parsed = JSON.parse(response.body) as { transferPayload: string };
      const payload = parseLanTransferPayload(parsed.transferPayload);
      assert.notEqual(payload, null);
      assert.equal(payload?.from, "http://192.168.1.230:7860");
      assert.equal(payload?.origins?.[0], "http://192.168.1.230:7860");
      assert.ok(payload?.origins?.includes("http://localhost:7860"));
    },
  ));

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

test("sender offer status tracks preview and download lifecycle", async () =>
  withLanTransferApp({ LAN_TRANSFER_ENABLED: "1" }, async (app) => {
    const chats = createChatsStorage(app.db);
    const chat = await chats.create({ name: "Status smoke", mode: "roleplay", characterIds: [] });
    assert.ok(chat?.id);

    const create = await app.inject({
      method: "POST",
      url: "/api/lan-transfer/offers",
      payload: { items: [{ type: "chat", id: chat.id }] },
    });
    assert.equal(create.statusCode, 200, create.body);
    const created = JSON.parse(create.body) as { offerId: string; expiresAt: string; transferPayload: string };
    const payload = parseLanTransferPayload(created.transferPayload);
    assert.notEqual(payload, null);

    const waiting = await app.inject({
      method: "GET",
      url: `/api/lan-transfer/offers/${created.offerId}/status`,
    });
    assert.equal(waiting.statusCode, 200, waiting.body);
    assert.deepEqual(JSON.parse(waiting.body), {
      offerId: created.offerId,
      expiresAt: created.expiresAt,
      state: "waiting",
    });

    const manifest = await app.inject({
      method: "POST",
      url: `/api/lan-transfer/offers/${created.offerId}/manifest`,
      payload: { downloadToken: payload?.downloadToken },
    });
    assert.equal(manifest.statusCode, 200, manifest.body);

    const previewed = await app.inject({
      method: "GET",
      url: `/api/lan-transfer/offers/${created.offerId}/status`,
    });
    assert.equal(previewed.statusCode, 200, previewed.body);
    const previewedBody = JSON.parse(previewed.body) as { state: string; previewedAt?: unknown };
    assert.equal(previewedBody.state, "previewed");
    assert.equal(typeof previewedBody.previewedAt, "string");

    const download = await app.inject({
      method: "POST",
      url: `/api/lan-transfer/offers/${created.offerId}/download`,
      payload: { downloadToken: payload?.downloadToken },
    });
    assert.equal(download.statusCode, 200, download.body);

    const downloaded = await app.inject({
      method: "GET",
      url: `/api/lan-transfer/offers/${created.offerId}/status`,
    });
    assert.equal(downloaded.statusCode, 200, downloaded.body);
    const downloadedBody = JSON.parse(downloaded.body) as {
      state: string;
      previewedAt?: unknown;
      downloadedAt?: unknown;
    };
    assert.equal(downloadedBody.state, "downloaded");
    assert.equal(typeof downloadedBody.previewedAt, "string");
    assert.equal(typeof downloadedBody.downloadedAt, "string");

    const downloadAgain = await app.inject({
      method: "POST",
      url: `/api/lan-transfer/offers/${created.offerId}/download`,
      payload: { downloadToken: payload?.downloadToken },
    });
    assert.equal(downloadAgain.statusCode, 404, downloadAgain.body);

    const manifestAfterDownload = await app.inject({
      method: "POST",
      url: `/api/lan-transfer/offers/${created.offerId}/manifest`,
      payload: { downloadToken: payload?.downloadToken },
    });
    assert.equal(manifestAfterDownload.statusCode, 404, manifestAfterDownload.body);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/lan-transfer/offers/${created.offerId}`,
    });
    assert.equal(deleted.statusCode, 200, deleted.body);

    const missing = await app.inject({
      method: "GET",
      url: `/api/lan-transfer/offers/${created.offerId}/status`,
    });
    assert.equal(missing.statusCode, 200, missing.body);
    assert.deepEqual(JSON.parse(missing.body), {
      offerId: created.offerId,
      expiresAt: new Date(0).toISOString(),
      state: "missing",
    });
  }));

test("Basic Auth lets token-gated LAN manifest and download requests reach route validation", async () =>
  withLanTransferApp(
    {
      LAN_TRANSFER_ENABLED: "1",
      BASIC_AUTH_USER: "sender",
      BASIC_AUTH_PASS: "secret",
      ALLOW_UNAUTHENTICATED_PRIVATE_NETWORK: undefined,
      ALLOW_UNAUTHENTICATED_REMOTE: undefined,
    },
    async (app) => {
      for (const endpoint of ["manifest", "download"] as const) {
        const offerId = `route-basic-auth-missing-token-${endpoint}`;
        seedLanTransferOffer(offerId, "download-token");

        try {
          const response = await app.inject({
            method: "POST",
            url: `/api/lan-transfer/offers/${offerId}/${endpoint}`,
            remoteAddress: "203.0.113.10",
            payload: {},
          });

          assert.equal(response.statusCode, 400, response.body);
          assert.deepEqual(JSON.parse(response.body), { error: "downloadToken is required" });
          assert.equal(response.headers["www-authenticate"], undefined);
        } finally {
          lanTransferOfferStore.delete(offerId);
        }
      }
    },
    { basicAuth: true },
  ));

test("Basic Auth lets valid LAN manifest and download tokens through without credentials", async () =>
  withLanTransferApp(
    {
      LAN_TRANSFER_ENABLED: "1",
      BASIC_AUTH_USER: "sender",
      BASIC_AUTH_PASS: "secret",
      ALLOW_UNAUTHENTICATED_PRIVATE_NETWORK: undefined,
      ALLOW_UNAUTHENTICATED_REMOTE: undefined,
    },
    async (app) => {
      const manifestOfferId = "route-basic-auth-valid-manifest";
      const downloadOfferId = "route-basic-auth-valid-download";
      seedLanTransferOffer(manifestOfferId, "manifest-token");
      seedLanTransferOffer(downloadOfferId, "download-token");

      try {
        const manifest = await app.inject({
          method: "POST",
          url: `/api/lan-transfer/offers/${manifestOfferId}/manifest`,
          remoteAddress: "203.0.113.10",
          payload: { downloadToken: "manifest-token" },
        });
        const download = await app.inject({
          method: "POST",
          url: `/api/lan-transfer/offers/${downloadOfferId}/download`,
          remoteAddress: "203.0.113.10",
          payload: { downloadToken: "download-token" },
        });

        assert.equal(manifest.statusCode, 200, manifest.body);
        assert.deepEqual(JSON.parse(manifest.body), {
          offerId: manifestOfferId,
          expiresAt: testManifest.expiresAt,
          consumed: false,
          manifest: testManifest,
        });
        assert.equal(download.statusCode, 200, download.body);
        assert.deepEqual(JSON.parse(download.body), testEncryptedPackage);
      } finally {
        lanTransferOfferStore.delete(manifestOfferId);
        lanTransferOfferStore.delete(downloadOfferId);
      }
    },
    { basicAuth: true },
  ));

test("Basic Auth lets wrong LAN manifest and download tokens fail at route level", async () =>
  withLanTransferApp(
    {
      LAN_TRANSFER_ENABLED: "1",
      BASIC_AUTH_USER: "sender",
      BASIC_AUTH_PASS: "secret",
      ALLOW_UNAUTHENTICATED_PRIVATE_NETWORK: undefined,
      ALLOW_UNAUTHENTICATED_REMOTE: undefined,
    },
    async (app) => {
      for (const endpoint of ["manifest", "download"] as const) {
        const offerId = `route-basic-auth-wrong-token-${endpoint}`;
        seedLanTransferOffer(offerId, "correct-token");

        try {
          const response = await app.inject({
            method: "POST",
            url: `/api/lan-transfer/offers/${offerId}/${endpoint}`,
            remoteAddress: "203.0.113.10",
            payload: { downloadToken: "wrong-token" },
          });

          assert.equal(response.statusCode, 403, response.body);
          assert.deepEqual(JSON.parse(response.body), { error: "Invalid LAN transfer token" });
          assert.equal(response.headers["www-authenticate"], undefined);
        } finally {
          lanTransferOfferStore.delete(offerId);
        }
      }
    },
    { basicAuth: true },
  ));

test("Basic Auth still challenges other LAN transfer routes without credentials", async () =>
  withLanTransferApp(
    {
      LAN_TRANSFER_ENABLED: "1",
      BASIC_AUTH_USER: "sender",
      BASIC_AUTH_PASS: "secret",
      ALLOW_UNAUTHENTICATED_PRIVATE_NETWORK: undefined,
      ALLOW_UNAUTHENTICATED_REMOTE: undefined,
    },
    async (app) => {
      const requests = [
        { method: "POST", url: "/api/lan-transfer/offers", payload: { items: [] } },
        { method: "POST", url: "/api/lan-transfer/preview", payload: { transferPayload: "not-json" } },
        { method: "POST", url: "/api/lan-transfer/import-from-offer", payload: { transferPayload: "not-json" } },
        { method: "DELETE", url: "/api/lan-transfer/offers/route-basic-auth-cancel", payload: undefined },
        { method: "GET", url: "/api/lan-transfer/offers/route-basic-auth-manifest/manifest", payload: undefined },
        {
          method: "POST",
          url: "/api/lan-transfer/offers/route-basic-auth-download/download/extra",
          payload: { downloadToken: "download-token" },
        },
      ] as const;

      for (const request of requests) {
        const response = await app.inject({
          ...request,
          remoteAddress: "203.0.113.10",
        });

        assert.equal(response.statusCode, 401, response.body);
        assert.deepEqual(JSON.parse(response.body), { error: "Authentication required" });
        assert.match(String(response.headers["www-authenticate"]), /^Basic /);
      }
    },
    { basicAuth: true },
  ));

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
      analysis: {
        mode: "smart",
        actions: [],
      },
    });
  }));

test("preview includes smart import analysis for native chat dependencies", async () =>
  withLanTransferApp({ LAN_TRANSFER_ENABLED: "1" }, async (app) => {
    const characters = createCharactersStorage(app.db);
    const chats = createChatsStorage(app.db);
    const character = await characters.create({ name: "Alicia", description: "same", first_mes: "Hi" } as any);
    assert.ok(character?.id);

    const existing = await chats.create({ name: "Alicia thread", mode: "roleplay", characterIds: [character.id] });
    assert.ok(existing?.id);
    await chats.patchMetadata(existing.id, { lanTransfer: { syncId: "route-preview-chat" } }, { touchUpdatedAt: false });
    await chats.createMessagesBatch(existing.id, [
      { role: "assistant", characterId: character.id, content: "One", createdAt: "2026-05-20T12:00:00.000Z" },
    ]);

    const source = await chats.create({ name: "Alicia thread", mode: "roleplay", characterIds: [character.id] });
    assert.ok(source?.id);
    await chats.patchMetadata(source.id, { lanTransfer: { syncId: "route-preview-chat" } }, { touchUpdatedAt: false });
    await chats.createMessagesBatch(source.id, [
      { role: "assistant", characterId: character.id, content: "One", createdAt: "2026-05-20T12:00:00.000Z" },
      { role: "user", characterId: null, content: "Two", createdAt: "2026-05-20T12:01:00.000Z" },
    ]);

    const pkg = await buildLanTransferPackage(
      app,
      [{ type: "chat", id: source.id, format: "native" }],
      "2999-05-19T00:10:00.000Z",
    );
    await chats.remove(source.id);

    const offerId = "route-preview-native-analysis";
    const downloadToken = "download-token";
    lanTransferOfferStore.delete(offerId);
    lanTransferOfferStore.put({
      offerId,
      downloadTokenHash: hashLanTransferToken(downloadToken),
      expiresAtMs: Date.now() + 60_000,
      manifest: pkg.manifest,
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
    const parsed = JSON.parse(response.body);
    assert.deepEqual(parsed.analysis, {
      mode: "smart",
      actions: [
        {
          type: "character",
          sourceId: character.id,
          name: "Alicia",
          action: "reuse",
          targetId: character.id,
          reason: "Exact matching native character already exists",
        },
        {
          type: "chat",
          sourceId: "route-preview-chat",
          name: "Alicia thread",
          action: "append",
          targetId: existing.id,
          messageCount: 2,
          appendCount: 1,
          linkedCharacterNames: ["Alicia"],
          reason: "Existing synced chat is missing 1 newer message",
        },
      ],
    });
  }));

test("preview tries sender origins in order until one succeeds", async () =>
  withLanTransferApp({ LAN_TRANSFER_ENABLED: "1" }, async (app) => {
    const offerId = "route-preview-origin-fallback";
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
    const workingOrigin = `http://127.0.0.1:${address.port}`;

    const transferPayload = serializeLanTransferPayload({
      type: LAN_TRANSFER_TYPE,
      version: LAN_TRANSFER_VERSION,
      from: "http://127.0.0.1:1",
      origins: ["http://127.0.0.1:1", workingOrigin],
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
    assert.equal(JSON.parse(response.body).from, workingOrigin);
  }));

test("preview skips invalid sender origins before trying a later valid origin", async () =>
  withLanTransferApp({ LAN_TRANSFER_ENABLED: "1" }, async (app) => {
    const offerId = "route-preview-origin-validation-skip";
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
    const workingOrigin = `http://127.0.0.1:${address.port}`;

    const transferPayload = serializeLanTransferPayload({
      type: LAN_TRANSFER_TYPE,
      version: LAN_TRANSFER_VERSION,
      from: "http://8.8.8.8:7860",
      origins: ["http://8.8.8.8:7860", workingOrigin],
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
    assert.equal(JSON.parse(response.body).from, workingOrigin);
  }));

test("preview preserves from as a fallback candidate when origins are capped", async () =>
  withLanTransferApp({ LAN_TRANSFER_ENABLED: "1" }, async (app) => {
    const offerId = "route-preview-origin-cap-keeps-from";
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
    const workingOrigin = `http://127.0.0.1:${address.port}`;

    const transferPayload = serializeLanTransferPayload({
      type: LAN_TRANSFER_TYPE,
      version: LAN_TRANSFER_VERSION,
      from: workingOrigin,
      origins: [
        "http://8.8.8.8:7860",
        "http://1.1.1.1:7860",
        "http://9.9.9.9:7860",
        "http://208.67.222.222:7860",
        "http://203.0.113.10:7860",
      ],
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
    assert.equal(JSON.parse(response.body).from, workingOrigin);
  }));

test("preview bounds sender origin validation time before trying a later origin", async () =>
  withLanTransferApp(
    { LAN_TRANSFER_ENABLED: "1", LAN_TRANSFER_ORIGIN_VALIDATION_TIMEOUT_MS: "25" },
    async (app) => {
      const offerId = "route-preview-validation-timeout";
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
      const workingOrigin = `http://sender.test:${address.port}`;
      const originalLookup = dns.lookup;
      dns.lookup = (async (hostname: string) => {
        if (hostname === "slow.test") {
          return new Promise((resolve) => {
            setTimeout(() => resolve([{ address: "127.0.0.1", family: 4 }]), 1_000);
          });
        }
        return [{ address: "127.0.0.1", family: 4 }];
      }) as typeof dns.lookup;

      try {
        const transferPayload = serializeLanTransferPayload({
          type: LAN_TRANSFER_TYPE,
          version: LAN_TRANSFER_VERSION,
          from: "http://slow.test:7860",
          origins: ["http://slow.test:7860", workingOrigin],
          offerId,
          downloadToken,
          secret: "secret",
        });

        const response = await Promise.race([
          app.inject({
            method: "POST",
            url: "/api/lan-transfer/preview",
            payload: { transferPayload },
          }),
          new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 250)),
        ]);

        assert.notEqual(response, "timed-out", "validation did not respect the request timeout");
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(JSON.parse(response.body).from, workingOrigin);
      } finally {
        dns.lookup = originalLookup;
      }
    },
  ));

test("preview accepts phase-2 payloads with multiple LAN origins", async () =>
  withLanTransferApp({ LAN_TRANSFER_ENABLED: "1" }, async (app) => {
    const offerId = "route-preview-multi-origin";
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
      origins: [
        ` http://127.0.0.1:${address.port} `,
        "http://8.8.8.8:7860",
        `http://127.0.0.1:${address.port}`,
        "http://192.168.1.25:7860",
        "http://10.0.0.5:7860",
        "http://172.16.0.5:7860",
      ],
      offerId,
      downloadToken,
      secret: "secret",
    });
    assert.deepEqual(parseLanTransferPayload(transferPayload)?.origins, [
      `http://127.0.0.1:${address.port}`,
      "http://8.8.8.8:7860",
      "http://192.168.1.25:7860",
      "http://10.0.0.5:7860",
      "http://172.16.0.5:7860",
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/api/lan-transfer/preview",
      payload: { transferPayload },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(JSON.parse(response.body).from, `http://127.0.0.1:${address.port}`);
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
        analysis: {
          mode: "smart",
          actions: [],
        },
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

test("import-from-offer accepts copy import mode and preserves duplicate behavior", async () =>
  withLanTransferApp({ LAN_TRANSFER_ENABLED: "1" }, async (app) => {
    const characters = createCharactersStorage(app.db);
    const existing = await characters.create({ name: "Alicia", description: "same", first_mes: "Hi" } as any);
    const source = await characters.create({ name: "Alicia", description: "same", first_mes: "Hi" } as any);
    assert.ok(existing?.id);
    assert.ok(source?.id);

    const pkg = await buildLanTransferPackage(
      app,
      [{ type: "character", id: source.id }],
      "2999-05-19T00:10:00.000Z",
    );
    await characters.remove(source.id);

    const offerId = "route-import-copy-mode";
    const downloadToken = "download-token";
    const secret = "transfer-secret";
    lanTransferOfferStore.delete(offerId);
    lanTransferOfferStore.put({
      offerId,
      downloadTokenHash: hashLanTransferToken(downloadToken),
      expiresAtMs: Date.now() + 60_000,
      manifest: pkg.manifest,
      encryptedPackage: encryptLanTransferPackage(JSON.stringify(pkg), secret),
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
      payload: { transferPayload, options: { importMode: "copy" } },
    });

    assert.equal(response.statusCode, 200, response.body);
    const parsed = JSON.parse(response.body);
    assert.equal(typeof parsed.characterIdMap[source.id], "string");
    assert.notEqual(parsed.characterIdMap[source.id], existing.id);
    assert.deepEqual(parsed, {
      imported: {
        chats: 0,
        characters: 1,
      },
      copied: {
        chats: 0,
        characters: 1,
      },
      skipped: [],
      characterIdMap: {
        [source.id]: parsed.characterIdMap[source.id],
      },
    });
    assert.equal((await characters.list()).length, 2);
  }));

test("import-from-offer rejects invalid explicit import mode before consuming the offer", async () =>
  withLanTransferApp({ LAN_TRANSFER_ENABLED: "1" }, async (app) => {
    const offerId = "route-import-invalid-mode";
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

    const transferPayload = serializeLanTransferPayload({
      type: LAN_TRANSFER_TYPE,
      version: LAN_TRANSFER_VERSION,
      from: "http://127.0.0.1:1",
      offerId,
      downloadToken,
      secret,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/lan-transfer/import-from-offer",
      payload: { transferPayload, options: { importMode: "duplicate" } },
    });

    try {
      assert.equal(response.statusCode, 400, response.body);
      assert.deepEqual(JSON.parse(response.body), { error: "Invalid LAN transfer import mode" });
      assert.notEqual(lanTransferOfferStore.get(offerId), null);
    } finally {
      lanTransferOfferStore.delete(offerId);
    }
  }));

test("import-from-offer tries sender origins before download consumption", async () =>
  withLanTransferApp({ LAN_TRANSFER_ENABLED: "1" }, async (app) => {
    const offerId = "route-import-origin-fallback";
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
    const workingOrigin = `http://127.0.0.1:${address.port}`;
    const transferPayload = serializeLanTransferPayload({
      type: LAN_TRANSFER_TYPE,
      version: LAN_TRANSFER_VERSION,
      from: "http://127.0.0.1:1",
      origins: ["http://127.0.0.1:1", workingOrigin],
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

test("import-from-offer does not retry after a consuming download response fails", async () =>
  withLanTransferApp({ LAN_TRANSFER_ENABLED: "1" }, async (app) => {
    const offerId = "route-import-post-consumption-failure";
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

    const badSender = Fastify({ logger: false });
    badSender.post(`/api/lan-transfer/offers/${offerId}/download`, async (_request, reply) =>
      reply.type("application/json").send("{not-json"),
    );
    await badSender.listen({ host: "127.0.0.1", port: 0 });

    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const goodAddress = app.server.address();
      const badAddress = badSender.server.address();
      assert.equal(typeof goodAddress, "object");
      assert.notEqual(goodAddress, null);
      assert.equal(typeof badAddress, "object");
      assert.notEqual(badAddress, null);
      const badOrigin = `http://127.0.0.1:${badAddress.port}`;
      const workingOrigin = `http://127.0.0.1:${goodAddress.port}`;
      const transferPayload = serializeLanTransferPayload({
        type: LAN_TRANSFER_TYPE,
        version: LAN_TRANSFER_VERSION,
        from: badOrigin,
        origins: [badOrigin, workingOrigin],
        offerId,
        downloadToken,
        secret,
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/lan-transfer/import-from-offer",
        payload: { transferPayload },
      });

      assert.equal(response.statusCode, 502, response.body);
      assert.match(JSON.parse(response.body).error, /invalid JSON/);
      assert.notEqual(lanTransferOfferStore.get(offerId), null);
    } finally {
      await badSender.close();
    }
  }));

test("import-from-offer rejects public-only sender origins before fetch", async () =>
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
      url: "/api/lan-transfer/import-from-offer",
      payload: { transferPayload },
    });

    assert.equal(response.statusCode, 400, response.body);
    assert.match(JSON.parse(response.body).error, /outside allowed LAN ranges/);
  }));
