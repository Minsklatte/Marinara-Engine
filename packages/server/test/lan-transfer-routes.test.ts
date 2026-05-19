import test from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileNativeDB } from "../src/db/file-backed-store.js";

type EnvPatch = Record<string, string | undefined>;

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
