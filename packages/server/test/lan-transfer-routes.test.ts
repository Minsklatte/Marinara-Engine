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
import {
  parseLanTransferPayload,
  serializeLanTransferPayload,
} from "../src/services/lan-transfer/lan-transfer-payload.js";
import { createCharactersStorage } from "../src/services/storage/characters.storage.js";

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
