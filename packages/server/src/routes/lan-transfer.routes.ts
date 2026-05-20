import type { FastifyInstance, FastifyRequest } from "fastify";
import { isIP } from "node:net";
import { Agent, request as undiciRequest } from "undici";
import type {
  LanTransferEncryptedPackage,
  LanTransferItemRequest,
  LanTransferManifest,
  LanTransferManifestRequest,
  LanTransferPayload,
} from "@marinara-engine/shared";
import { LAN_TRANSFER_TYPE, LAN_TRANSFER_VERSION } from "@marinara-engine/shared";
import { getLanTransferPublicOrigin, getPort, isLanTransferEnabled } from "../config/runtime-config.js";
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
import { analyzeLanTransferManifest } from "../services/lan-transfer/lan-transfer-smart-import.js";
import {
  parseLanTransferPayload,
  serializeLanTransferPayload,
} from "../services/lan-transfer/lan-transfer-payload.js";
import { resolveLanTransferOrigins } from "../services/lan-transfer/lan-transfer-origins.js";
import {
  validateLanTransferOrigin,
  type LanTransferOriginValidationResult,
} from "../services/lan-transfer/lan-transfer-url-policy.js";

const OFFER_TTL_MS = 10 * 60_000;
const REMOTE_REQUEST_TIMEOUT_MS = 8_000;
const ORIGIN_VALIDATION_TIMEOUT_MS = 1_000;
const MAX_SENDER_ORIGIN_CANDIDATES = 5;
const REMOTE_MANIFEST_RESPONSE_MAX_BYTES = 1024 * 1024;
const REMOTE_ENCRYPTED_RESPONSE_MAX_BYTES = LAN_TRANSFER_PACKAGE_MAX_BYTES * 4;
const DISABLED_RESPONSE = { error: "LAN transfer is disabled" };
type UndiciRequestOptions = NonNullable<Parameters<typeof undiciRequest>[1]> & { maxRedirections: 0 };
type ValidatedLanTransferOrigin = Extract<LanTransferOriginValidationResult, { ok: true }>;

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
      const origins = getRequestOrigins(request);
      const transferPayload = serializeLanTransferPayload({
        type: LAN_TRANSFER_TYPE,
        version: LAN_TRANSFER_VERSION,
        from: origins[0] ?? getRequestOrigin(request),
        origins,
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

    try {
      const result = await fetchFromAnySenderOrigin<{
        offerId: string;
        expiresAt: string;
        manifest: unknown;
      }>(payloadResult.payload, "manifest");

      return reply.send({
        from: result.origin,
        offerId: result.value.offerId,
        expiresAt: result.value.expiresAt,
        manifest: result.value.manifest,
        analysis: await analyzeLanTransferManifest(app, result.value.manifest as LanTransferManifest),
      });
    } catch (err) {
      return reply.code(getLanTransferFetchStatusCode(err)).send({ error: getErrorMessage(err) });
    }
  });

  app.post("/import-from-offer", async (request, reply) => {
    const payloadResult = getTransferPayload(request.body);
    if (!payloadResult.ok) return reply.code(400).send({ error: payloadResult.error });

    try {
      const { value: encryptedPackage } = await fetchFromAnySenderOrigin<LanTransferEncryptedPackage>(
        payloadResult.payload,
        "download",
      );
      const plaintext = decryptLanTransferPackage(encryptedPackage, payloadResult.payload.secret);
      const parsedPackage = JSON.parse(plaintext) as unknown;
      const validation = validateLanTransferPackage(parsedPackage);
      if (!validation.ok) return reply.code(400).send({ error: validation.error });

      const summary = await importLanTransferPackage(app, validation.package, {
        importMode: getImportMode(request.body),
      });
      return reply.send(summary);
    } catch (err) {
      return reply.code(getLanTransferFetchStatusCode(err)).send({ error: getErrorMessage(err) });
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

function getImportMode(value: unknown): "smart" | "copy" {
  const body = readBody(value);
  const options = isRecord(body.options) ? body.options : {};
  return options.importMode === "copy" ? "copy" : "smart";
}

function getRequestOrigin(request: FastifyRequest): string {
  const host = request.headers.host ?? "localhost";
  const protocol = request.protocol || "http";
  return `${protocol}://${host}`;
}

function getRequestOrigins(request: FastifyRequest): string[] {
  const host = request.headers.host ?? "localhost";
  const protocol = (request.protocol || "http") as "http" | "https";
  return resolveLanTransferOrigins({
    protocol,
    requestHost: host,
    configuredOrigin: getLanTransferPublicOrigin(),
    port: getPort(),
  });
}

async function fetchFromAnySenderOrigin<T>(
  payload: LanTransferPayload,
  endpoint: "manifest" | "download",
): Promise<{ origin: string; value: T }> {
  const origins = getSenderOriginCandidates(payload);
  const requestDeadlineMs = Date.now() + getRemoteRequestTimeoutMs();
  const errors: string[] = [];
  let attemptedFetch = false;

  for (const origin of origins) {
    const validationTimeoutMs = getRemainingTimeoutMs(requestDeadlineMs, getOriginValidationTimeoutMs());
    if (validationTimeoutMs <= 0) {
      errors.push(`${origin}: LAN transfer sender request timed out`);
      break;
    }

    const originResult = await validateLanTransferOriginWithTimeout(origin, validationTimeoutMs);
    if (!originResult.ok) {
      errors.push(`${origin}: ${originResult.error}`);
      continue;
    }

    attemptedFetch = true;

    try {
      const fetchTimeoutMs = getRemainingTimeoutMs(requestDeadlineMs);
      if (fetchTimeoutMs <= 0) throw new Error("LAN transfer sender request timed out");

      const value = await fetchSenderJson<T>({ ...payload, from: origin }, originResult, endpoint, fetchTimeoutMs);
      return { origin, value };
    } catch (err) {
      if (err instanceof NonRetryableLanTransferSenderError) {
        throw new LanTransferOriginFetchError(getErrorMessage(err), 502);
      }

      errors.push(`${origin}: ${getErrorMessage(err)}`);
    }
  }

  throw new LanTransferOriginFetchError(
    `Unable to reach sender. Tried ${origins.length} origin${origins.length === 1 ? "" : "s"}: ${errors.join("; ")}`,
    attemptedFetch ? 502 : 400,
  );
}

function getSenderOriginCandidates(payload: LanTransferPayload): string[] {
  const origins = Array.from(new Set(payload.origins ?? []));
  if (!origins.includes(payload.from)) {
    if (origins.length >= MAX_SENDER_ORIGIN_CANDIDATES) origins[MAX_SENDER_ORIGIN_CANDIDATES - 1] = payload.from;
    else origins.push(payload.from);
  }

  return origins.slice(0, MAX_SENDER_ORIGIN_CANDIDATES);
}

function getRemainingTimeoutMs(deadlineMs: number, capMs = Number.POSITIVE_INFINITY): number {
  return Math.min(Math.max(0, deadlineMs - Date.now()), capMs);
}

async function validateLanTransferOriginWithTimeout(
  origin: string,
  timeoutMs: number,
): Promise<LanTransferOriginValidationResult> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ ok: false, error: "LAN transfer origin validation timed out" });
    }, timeoutMs);

    validateLanTransferOrigin(origin)
      .then(resolve)
      .catch(() => resolve({ ok: false, error: "Unable to resolve LAN transfer origin host" }))
      .finally(() => clearTimeout(timeout));
  });
}

async function fetchSenderJson<T>(
  payload: LanTransferPayload,
  origin: ValidatedLanTransferOrigin,
  endpoint: "manifest" | "download",
  timeoutMs: number,
): Promise<T> {
  const url = new URL(`/api/lan-transfer/offers/${encodeURIComponent(payload.offerId)}/${endpoint}`, origin.url);
  const dispatcher = createPinnedSenderAgent(origin.addresses);
  const requestOptions: UndiciRequestOptions = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ downloadToken: payload.downloadToken } satisfies LanTransferManifestRequest),
    dispatcher,
    maxRedirections: 0,
    signal: AbortSignal.timeout(timeoutMs),
  };

  try {
    const response = await undiciRequest(url, requestOptions);
    const isConsumingDownloadResponse =
      endpoint === "download" && response.statusCode >= 200 && response.statusCode < 300;
    const maxBytes =
      endpoint === "download" ? REMOTE_ENCRYPTED_RESPONSE_MAX_BYTES : REMOTE_MANIFEST_RESPONSE_MAX_BYTES;
    let text: string;
    try {
      text = await readRemoteBody(response.body, maxBytes);
    } catch (err) {
      if (isConsumingDownloadResponse) {
        throw new NonRetryableLanTransferSenderError(getErrorMessage(err));
      }

      throw err;
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`LAN transfer sender returned HTTP ${response.statusCode}`);
    }

    try {
      return JSON.parse(text) as T;
    } catch (err) {
      if (isConsumingDownloadResponse) {
        throw new NonRetryableLanTransferSenderError("LAN transfer sender returned invalid JSON");
      }

      throw new Error("LAN transfer sender returned invalid JSON", { cause: err });
    }
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
}

function createPinnedSenderAgent(addresses: string[]): Agent {
  return new Agent({
    connect: {
      lookup(_hostname, options, callback) {
        const family = options.family === 4 || options.family === 6 ? options.family : undefined;
        const selected = addresses.find((address) => !family || isIP(address) === family) ?? addresses[0];
        if (!selected) {
          callback(new Error("LAN transfer origin has no validated addresses"), "", 4);
          return;
        }

        const selectedFamily = isIP(selected);
        if (selectedFamily !== 4 && selectedFamily !== 6) {
          callback(new Error("LAN transfer origin has an invalid validated address"), "", 4);
          return;
        }

        if (options.all) callback(null, [{ address: selected, family: selectedFamily }]);
        else callback(null, selected, selectedFamily);
      },
    },
  });
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

function getRemoteRequestTimeoutMs(): number {
  return getPositiveIntegerEnv("LAN_TRANSFER_REMOTE_REQUEST_TIMEOUT_MS", REMOTE_REQUEST_TIMEOUT_MS);
}

function getOriginValidationTimeoutMs(): number {
  return getPositiveIntegerEnv("LAN_TRANSFER_ORIGIN_VALIDATION_TIMEOUT_MS", ORIGIN_VALIDATION_TIMEOUT_MS);
}

function getPositiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getLanTransferFetchStatusCode(err: unknown): 400 | 502 {
  return err instanceof LanTransferOriginFetchError ? err.statusCode : 502;
}

class NonRetryableLanTransferSenderError extends Error {}

class LanTransferOriginFetchError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 502,
  ) {
    super(message);
  }
}
