import type { FastifyInstance, FastifyRequest } from "fastify";
import { request as undiciRequest } from "undici";
import type {
  LanTransferEncryptedPackage,
  LanTransferItemRequest,
  LanTransferManifestRequest,
  LanTransferPayload,
} from "@marinara-engine/shared";
import { LAN_TRANSFER_TYPE, LAN_TRANSFER_VERSION } from "@marinara-engine/shared";
import { isLanTransferEnabled } from "../config/runtime-config.js";
import { newId } from "../utils/id-generator.js";
import {
  decryptLanTransferPackage,
  encryptLanTransferPackage,
  generateLanTransferSecret,
  generateLanTransferToken,
  hashLanTransferToken,
  verifyLanTransferToken,
} from "../services/lan-transfer/lan-transfer-crypto.js";
import { lanTransferOfferStore } from "../services/lan-transfer/lan-transfer-offer-store.js";
import {
  buildLanTransferPackage,
  importLanTransferPackage,
  LAN_TRANSFER_PACKAGE_MAX_BYTES,
  validateLanTransferPackage,
} from "../services/lan-transfer/lan-transfer-package.js";
import {
  parseLanTransferPayload,
  serializeLanTransferPayload,
} from "../services/lan-transfer/lan-transfer-payload.js";
import { validateLanTransferOrigin } from "../services/lan-transfer/lan-transfer-url-policy.js";

const OFFER_TTL_MS = 10 * 60_000;
const REMOTE_REQUEST_TIMEOUT_MS = 8_000;
const REMOTE_RESPONSE_MAX_BYTES = LAN_TRANSFER_PACKAGE_MAX_BYTES;
const DISABLED_RESPONSE = { error: "LAN transfer is disabled" };
type UndiciRequestOptions = NonNullable<Parameters<typeof undiciRequest>[1]> & { maxRedirections: 0 };

export async function lanTransferRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (_request, reply) => {
    if (!isLanTransferEnabled()) {
      return reply.code(403).send(DISABLED_RESPONSE);
    }
  });

  app.post("/offers", async (request, reply) => {
    const body = readBody(request.body);
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return reply.code(400).send({ error: "items must be a non-empty array" });
    }

    const offerId = newId();
    const downloadToken = generateLanTransferToken();
    const secret = generateLanTransferSecret();
    const expiresAtMs = Date.now() + OFFER_TTL_MS;
    const expiresAt = new Date(expiresAtMs).toISOString();

    try {
      const pkg = await buildLanTransferPackage(app, body.items as LanTransferItemRequest[], expiresAt);
      const encryptedPackage = encryptLanTransferPackage(JSON.stringify(pkg), secret);
      const from = getRequestOrigin(request);
      const transferPayload = serializeLanTransferPayload({
        type: LAN_TRANSFER_TYPE,
        version: LAN_TRANSFER_VERSION,
        from,
        offerId,
        downloadToken,
        secret,
      });

      lanTransferOfferStore.put({
        offerId,
        downloadTokenHash: hashLanTransferToken(downloadToken),
        expiresAtMs,
        manifest: pkg.manifest,
        encryptedPackage,
      });

      return reply.send({
        offerId,
        transferPayload,
        expiresAt,
        manifest: pkg.manifest,
      });
    } catch (err) {
      return reply.code(400).send({ error: getErrorMessage(err) });
    }
  });

  app.post<{ Params: { offerId: string } }>("/offers/:offerId/manifest", async (request, reply) => {
    const tokenResult = getDownloadToken(request.body);
    if (!tokenResult.ok) return reply.code(400).send({ error: tokenResult.error });

    const offer = lanTransferOfferStore.get(request.params.offerId);
    if (!offer) return reply.code(404).send({ error: "LAN transfer offer not found" });
    if (!verifyLanTransferToken(tokenResult.downloadToken, offer.downloadTokenHash)) {
      return reply.code(403).send({ error: "Invalid LAN transfer token" });
    }

    return reply.send({
      offerId: offer.offerId,
      expiresAt: offer.manifest.expiresAt,
      consumed: false,
      manifest: offer.manifest,
    });
  });

  app.post<{ Params: { offerId: string } }>("/offers/:offerId/download", async (request, reply) => {
    const tokenResult = getDownloadToken(request.body);
    if (!tokenResult.ok) return reply.code(400).send({ error: tokenResult.error });

    const offer = lanTransferOfferStore.get(request.params.offerId);
    if (!offer) return reply.code(404).send({ error: "LAN transfer offer not found" });
    if (!verifyLanTransferToken(tokenResult.downloadToken, offer.downloadTokenHash)) {
      return reply.code(403).send({ error: "Invalid LAN transfer token" });
    }

    const consumedOffer = lanTransferOfferStore.consume(request.params.offerId);
    if (!consumedOffer) return reply.code(404).send({ error: "LAN transfer offer not found" });

    return reply.send(consumedOffer.encryptedPackage);
  });

  app.delete<{ Params: { offerId: string } }>("/offers/:offerId", async (request) => {
    lanTransferOfferStore.delete(request.params.offerId);
    return { success: true };
  });

  app.post("/preview", async (request, reply) => {
    const payloadResult = getTransferPayload(request.body);
    if (!payloadResult.ok) return reply.code(400).send({ error: payloadResult.error });

    const originResult = await validateLanTransferOrigin(payloadResult.payload.from);
    if (!originResult.ok) return reply.code(400).send({ error: originResult.error });

    try {
      const manifest = await fetchSenderJson<{
        offerId: string;
        expiresAt: string;
        manifest: unknown;
      }>(payloadResult.payload, "manifest");

      return reply.send({
        from: payloadResult.payload.from,
        offerId: manifest.offerId,
        expiresAt: manifest.expiresAt,
        manifest: manifest.manifest,
      });
    } catch (err) {
      return reply.code(502).send({ error: getErrorMessage(err) });
    }
  });

  app.post("/import-from-offer", async (request, reply) => {
    const payloadResult = getTransferPayload(request.body);
    if (!payloadResult.ok) return reply.code(400).send({ error: payloadResult.error });

    const originResult = await validateLanTransferOrigin(payloadResult.payload.from);
    if (!originResult.ok) return reply.code(400).send({ error: originResult.error });

    try {
      const encryptedPackage = await fetchSenderJson<LanTransferEncryptedPackage>(
        payloadResult.payload,
        "download",
      );
      const plaintext = decryptLanTransferPackage(encryptedPackage, payloadResult.payload.secret);
      const parsedPackage = JSON.parse(plaintext) as unknown;
      const validation = validateLanTransferPackage(parsedPackage);
      if (!validation.ok) return reply.code(400).send({ error: validation.error });

      const summary = await importLanTransferPackage(app, validation.package);
      return reply.send(summary);
    } catch (err) {
      return reply.code(502).send({ error: getErrorMessage(err) });
    }
  });
}

function readBody(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function getDownloadToken(value: unknown): { ok: true; downloadToken: string } | { ok: false; error: string } {
  const body = readBody(value);
  if (typeof body.downloadToken !== "string" || body.downloadToken.length === 0) {
    return { ok: false, error: "downloadToken is required" };
  }

  return { ok: true, downloadToken: body.downloadToken };
}

function getTransferPayload(value: unknown): { ok: true; payload: LanTransferPayload } | { ok: false; error: string } {
  const body = readBody(value);
  if (typeof body.transferPayload !== "string") {
    return { ok: false, error: "transferPayload is required" };
  }

  const payload = parseLanTransferPayload(body.transferPayload);
  if (!payload) return { ok: false, error: "Invalid LAN transfer payload" };

  return { ok: true, payload };
}

function getRequestOrigin(request: FastifyRequest): string {
  const host = request.headers.host ?? "localhost";
  const protocol = request.protocol || "http";
  return `${protocol}://${host}`;
}

async function fetchSenderJson<T>(payload: LanTransferPayload, endpoint: "manifest" | "download"): Promise<T> {
  const url = new URL(`/api/lan-transfer/offers/${encodeURIComponent(payload.offerId)}/${endpoint}`, payload.from);
  const requestOptions: UndiciRequestOptions = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ downloadToken: payload.downloadToken } satisfies LanTransferManifestRequest),
    maxRedirections: 0,
    signal: AbortSignal.timeout(REMOTE_REQUEST_TIMEOUT_MS),
  };
  const response = await undiciRequest(url, requestOptions);
  const text = await readRemoteBody(response.body, REMOTE_RESPONSE_MAX_BYTES);

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`LAN transfer sender returned HTTP ${response.statusCode}`);
  }

  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error("LAN transfer sender returned invalid JSON", { cause: err });
  }
}

async function readRemoteBody(
  body: AsyncIterable<Buffer | Uint8Array | string>,
  maxBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      throw new Error("LAN transfer response exceeds maximum size");
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "LAN transfer request failed";
}
