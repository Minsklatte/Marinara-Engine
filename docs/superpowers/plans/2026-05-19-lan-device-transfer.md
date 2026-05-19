# LAN Device Transfer MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a LAN-only, encrypted, user-initiated chat and character transfer flow between two Marinara Engine instances.

**Architecture:** Add focused shared contracts, server-side transfer services, a token-bound in-memory offer store, and a route module mounted at `/api/lan-transfer`. The browser only creates offers, copies/scans payloads, and confirms preview/import; sender and receiver backends build, fetch, decrypt, validate, and import packages.

**Tech Stack:** TypeScript, Fastify, Node `node:crypto`, `node:test`, React 19, TanStack Query, Zustand modal routing, Tailwind, Sonner, Lucide, `qrcode` for QR rendering.

---

## File Structure

Create:
- `packages/shared/src/types/lan-transfer.ts` - public request/response/package types.
- `packages/server/src/services/export/chat-export.service.ts` - reusable chat JSONL export helpers extracted from `chats.routes.ts`.
- `packages/server/src/services/export/character-export.service.ts` - reusable native character export helpers extracted from `characters.routes.ts`.
- `packages/server/src/services/lan-transfer/lan-transfer-crypto.ts` - HKDF/AES-GCM encrypt/decrypt helpers.
- `packages/server/src/services/lan-transfer/lan-transfer-offer-store.ts` - bounded in-memory offer store.
- `packages/server/src/services/lan-transfer/lan-transfer-payload.ts` - payload parse/serialize/type guards.
- `packages/server/src/services/lan-transfer/lan-transfer-url-policy.ts` - LAN-only URL and SSRF guard.
- `packages/server/src/services/lan-transfer/lan-transfer-package.ts` - package builder, validator, and import orchestrator.
- `packages/server/src/routes/lan-transfer.routes.ts` - sender and receiver HTTP endpoints.
- `packages/server/test/lan-transfer-crypto.test.ts`
- `packages/server/test/lan-transfer-offer-store.test.ts`
- `packages/server/test/lan-transfer-payload.test.ts`
- `packages/server/test/lan-transfer-url-policy.test.ts`
- `packages/server/test/lan-transfer-package.test.ts`
- `packages/client/src/hooks/use-lan-transfer.ts` - React Query mutations.
- `packages/client/src/components/modals/SendToDeviceModal.tsx`
- `packages/client/src/components/modals/ReceiveFromDeviceModal.tsx`

Modify:
- `packages/shared/src/index.ts` - export LAN transfer types.
- `packages/server/src/config/runtime-config.ts` - add `LAN_TRANSFER_ENABLED` reader.
- `packages/server/src/routes/index.ts` - register LAN transfer routes.
- `packages/server/src/routes/chats.routes.ts` - delegate chat export serialization to the new service.
- `packages/server/src/routes/characters.routes.ts` - delegate native character envelope creation to the new service.
- `packages/client/package.json` - add `qrcode`; add `@types/qrcode` as a dev dependency.
- `packages/client/src/components/layout/ModalRenderer.tsx` - lazy-load and render the new modals.
- `packages/client/src/components/chat/ChatFilesDrawer.tsx` - add chat send entry point.
- `packages/client/src/components/layout/ChatSidebar.tsx` - add selected-chat send entry point.
- `packages/client/src/components/panels/CharactersPanel.tsx` - add selected-character send entry point.
- `packages/client/src/components/panels/SettingsPanel.tsx` - add receive entry point.
- `.env.example` and `docs/CONFIGURATION.md` - document the opt-in flag.

## Implementation Notes

- Environment flag: `LAN_TRANSFER_ENABLED=true`; default is disabled.
- Offer TTL: 10 minutes.
- Max active offers: 10.
- Max encrypted package bytes: 25 MiB.
- Token format: base64url random bytes, 16 bytes for `downloadToken`, 32 bytes for `secret`.
- Sender stores the SHA-256 hash of `downloadToken`, never `secret`.
- Sender `manifest` and `download` endpoints authorize with `downloadToken` only.
- Receiver `preview` and `import-from-offer` endpoints receive the full pasted payload from the local frontend.
- Receiver backend blocks non-LAN sender origins before any fetch.
- Manifest responses never include decrypted package contents.
- Download consumes the offer once.
- Decryption failure aborts before JSON parsing.

### Task 1: Shared Contract And Config

**Files:**
- Create: `packages/shared/src/types/lan-transfer.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/server/src/config/runtime-config.ts`
- Modify: `.env.example`
- Modify: `docs/CONFIGURATION.md`

- [ ] **Step 1: Add shared transfer types**

Create `packages/shared/src/types/lan-transfer.ts`:

```ts
export const LAN_TRANSFER_TYPE = "marinara-lan-transfer" as const;
export const LAN_TRANSFER_VERSION = 1 as const;

export type LanTransferItemRequest =
  | { type: "chat"; id: string; format?: "jsonl" }
  | { type: "character"; id: string; format?: "native" };

export interface LanTransferPayload {
  type: typeof LAN_TRANSFER_TYPE;
  version: typeof LAN_TRANSFER_VERSION;
  from: string;
  offerId: string;
  downloadToken: string;
  secret: string;
}

export interface LanTransferManifest {
  version: typeof LAN_TRANSFER_VERSION;
  createdAt: string;
  expiresAt: string;
  sourceApp: "Marinara Engine";
  sourceVersion: string;
  items: Array<
    | { type: "chat"; id: string; name: string; format: "jsonl"; messageCount: number; bytes: number }
    | { type: "character"; id: string; name: string; format: "native"; bytes: number }
  >;
  totalBytes: number;
}

export interface LanTransferPackage {
  version: typeof LAN_TRANSFER_VERSION;
  manifest: LanTransferManifest;
  items: Array<
    | { type: "chat"; id: string; name: string; format: "jsonl"; content: string }
    | { type: "character"; id: string; name: string; format: "native"; envelope: unknown }
  >;
}

export interface LanTransferEncryptedPackage {
  version: typeof LAN_TRANSFER_VERSION;
  algorithm: "AES-256-GCM";
  salt: string;
  iv: string;
  aad: string;
  ciphertext: string;
  tag: string;
}

export interface LanTransferCreateOfferRequest {
  items: LanTransferItemRequest[];
}

export interface LanTransferCreateOfferResponse {
  offerId: string;
  transferPayload: string;
  expiresAt: string;
  manifest: LanTransferManifest;
}

export interface LanTransferManifestRequest {
  downloadToken: string;
}

export interface LanTransferManifestResponse {
  offerId: string;
  expiresAt: string;
  consumed: boolean;
  manifest: LanTransferManifest;
}

export interface LanTransferPreviewRequest {
  transferPayload: string;
}

export interface LanTransferPreviewResponse {
  from: string;
  offerId: string;
  expiresAt: string;
  manifest: LanTransferManifest;
}

export interface LanTransferImportFromOfferRequest {
  transferPayload: string;
  options?: {
    chatImportMode?: "new-chat" | "branch";
    characterImportMode?: "new-copy";
  };
}

export interface LanTransferImportSummary {
  imported: {
    chats: number;
    characters: number;
  };
  skipped: Array<{ type: string; name?: string; reason: string }>;
}
```

- [ ] **Step 2: Export shared transfer types**

Modify `packages/shared/src/index.ts`:

```ts
export * from "./types/lan-transfer.js";
```

Place it next to the other `types/*` exports.

- [ ] **Step 3: Add runtime config reader**

Modify `packages/server/src/config/runtime-config.ts`:

```ts
export function isLanTransferEnabled() {
  return isEnabledFlag(process.env.LAN_TRANSFER_ENABLED ?? process.env.MARINARA_LAN_TRANSFER_ENABLED);
}
```

Place it near other feature flag readers.

- [ ] **Step 4: Document the opt-in flag**

Add to `.env.example` near other network/security options:

```dotenv
# Enables encrypted LAN-only send/receive transfer offers between Marinara instances.
# Default: disabled.
LAN_TRANSFER_ENABLED=false
```

Add to `docs/CONFIGURATION.md` in the network/security configuration area:

```md
### LAN Transfer

`LAN_TRANSFER_ENABLED=true` enables encrypted, user-initiated LAN transfer offers for selected chats and characters.
The feature is disabled by default. It does not relax Basic Auth, admin-secret, IP allowlist, or CSRF behavior for normal APIs.
```

- [ ] **Step 5: Run type check for shared contract**

Run:

```bash
pnpm --filter @marinara-engine/shared build
```

Expected: exits `0`.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types/lan-transfer.ts packages/shared/src/index.ts packages/server/src/config/runtime-config.ts .env.example docs/CONFIGURATION.md
git commit -m "feat: add lan transfer contract"
```

### Task 2: Payload, Crypto, Offer Store, And URL Policy Tests

**Files:**
- Create: `packages/server/test/lan-transfer-payload.test.ts`
- Create: `packages/server/test/lan-transfer-crypto.test.ts`
- Create: `packages/server/test/lan-transfer-offer-store.test.ts`
- Create: `packages/server/test/lan-transfer-url-policy.test.ts`

- [ ] **Step 1: Write payload parser tests**

Create `packages/server/test/lan-transfer-payload.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseLanTransferPayload,
  serializeLanTransferPayload,
} from "../src/services/lan-transfer/lan-transfer-payload.js";

test("serializes and parses a valid LAN transfer payload", () => {
  const raw = serializeLanTransferPayload({
    type: "marinara-lan-transfer",
    version: 1,
    from: "http://192.168.1.50:7860",
    offerId: "offer_123",
    downloadToken: "download-token",
    secret: "secret-key",
  });

  assert.deepEqual(parseLanTransferPayload(raw), {
    type: "marinara-lan-transfer",
    version: 1,
    from: "http://192.168.1.50:7860",
    offerId: "offer_123",
    downloadToken: "download-token",
    secret: "secret-key",
  });
});

test("rejects malformed payload JSON", () => {
  assert.equal(parseLanTransferPayload("{not-json"), null);
});

test("rejects payloads with a non-origin from value", () => {
  const payload = JSON.stringify({
    type: "marinara-lan-transfer",
    version: 1,
    from: "http://192.168.1.50:7860/path?x=1",
    offerId: "offer_123",
    downloadToken: "download-token",
    secret: "secret-key",
  });

  assert.equal(parseLanTransferPayload(payload), null);
});

test("rejects payloads without token and secret", () => {
  const payload = JSON.stringify({
    type: "marinara-lan-transfer",
    version: 1,
    from: "http://192.168.1.50:7860",
    offerId: "offer_123",
  });

  assert.equal(parseLanTransferPayload(payload), null);
});
```

- [ ] **Step 2: Write crypto tests**

Create `packages/server/test/lan-transfer-crypto.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  decryptLanTransferPackage,
  encryptLanTransferPackage,
  generateLanTransferSecret,
  generateLanTransferToken,
  hashLanTransferToken,
} from "../src/services/lan-transfer/lan-transfer-crypto.js";

test("encrypts and decrypts a transfer package", () => {
  const secret = generateLanTransferSecret();
  const plaintext = JSON.stringify({ version: 1, items: [{ type: "chat", content: "hello" }] });
  const encrypted = encryptLanTransferPackage(plaintext, secret);
  const decrypted = decryptLanTransferPackage(encrypted, secret);

  assert.equal(decrypted, plaintext);
  assert.equal(encrypted.algorithm, "AES-256-GCM");
  assert.notEqual(encrypted.ciphertext, Buffer.from(plaintext, "utf8").toString("base64url"));
});

test("tampered ciphertext fails authentication", () => {
  const secret = generateLanTransferSecret();
  const encrypted = encryptLanTransferPackage(JSON.stringify({ version: 1 }), secret);
  const tampered = { ...encrypted, ciphertext: encrypted.ciphertext.replace(/.$/, "A") };

  assert.throws(() => decryptLanTransferPackage(tampered, secret));
});

test("token hashes are stable and do not equal the token", () => {
  const token = generateLanTransferToken();
  const hash = hashLanTransferToken(token);

  assert.equal(hashLanTransferToken(token), hash);
  assert.notEqual(hash, token);
});
```

- [ ] **Step 3: Write offer store tests**

Create `packages/server/test/lan-transfer-offer-store.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createLanTransferOfferStore } from "../src/services/lan-transfer/lan-transfer-offer-store.js";

const manifest = {
  version: 1 as const,
  createdAt: "2026-05-19T00:00:00.000Z",
  expiresAt: "2026-05-19T00:10:00.000Z",
  sourceApp: "Marinara Engine" as const,
  sourceVersion: "1.6.0",
  items: [],
  totalBytes: 0,
};

const encryptedPackage = {
  version: 1 as const,
  algorithm: "AES-256-GCM" as const,
  salt: "salt",
  iv: "iv",
  aad: "aad",
  ciphertext: "ciphertext",
  tag: "tag",
};

test("stores, reads, consumes, and removes offers", () => {
  const store = createLanTransferOfferStore({ maxOffers: 2, now: () => 1000 });
  store.put({
    offerId: "offer-1",
    downloadTokenHash: "hash-1",
    expiresAtMs: 2000,
    manifest,
    encryptedPackage,
  });

  assert.equal(store.get("offer-1")?.offerId, "offer-1");
  assert.equal(store.consume("offer-1")?.offerId, "offer-1");
  assert.equal(store.get("offer-1"), null);
});

test("expires offers before returning them", () => {
  const store = createLanTransferOfferStore({ maxOffers: 2, now: () => 3000 });
  store.put({
    offerId: "offer-1",
    downloadTokenHash: "hash-1",
    expiresAtMs: 2000,
    manifest,
    encryptedPackage,
  });

  assert.equal(store.get("offer-1"), null);
});

test("enforces max active offers", () => {
  const store = createLanTransferOfferStore({ maxOffers: 1, now: () => 1000 });
  store.put({
    offerId: "offer-1",
    downloadTokenHash: "hash-1",
    expiresAtMs: 2000,
    manifest,
    encryptedPackage,
  });

  assert.throws(() =>
    store.put({
      offerId: "offer-2",
      downloadTokenHash: "hash-2",
      expiresAtMs: 2000,
      manifest,
      encryptedPackage,
    }),
  );
});
```

- [ ] **Step 4: Write URL policy tests**

Create `packages/server/test/lan-transfer-url-policy.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  isAllowedLanTransferAddress,
  validateLanTransferOrigin,
} from "../src/services/lan-transfer/lan-transfer-url-policy.js";

test("allows loopback and RFC1918 addresses", () => {
  assert.equal(isAllowedLanTransferAddress("127.0.0.1"), true);
  assert.equal(isAllowedLanTransferAddress("192.168.1.10"), true);
  assert.equal(isAllowedLanTransferAddress("10.0.0.5"), true);
  assert.equal(isAllowedLanTransferAddress("172.16.0.5"), true);
  assert.equal(isAllowedLanTransferAddress("172.31.255.254"), true);
});

test("blocks public and metadata/link-local addresses", () => {
  assert.equal(isAllowedLanTransferAddress("8.8.8.8"), false);
  assert.equal(isAllowedLanTransferAddress("1.1.1.1"), false);
  assert.equal(isAllowedLanTransferAddress("169.254.169.254"), false);
});

test("validates origin shape", async () => {
  const valid = await validateLanTransferOrigin("http://192.168.1.10:7860", {
    resolveHost: async () => ["192.168.1.10"],
  });
  assert.equal(valid.ok, true);

  const withPath = await validateLanTransferOrigin("http://192.168.1.10:7860/path", {
    resolveHost: async () => ["192.168.1.10"],
  });
  assert.equal(withPath.ok, false);

  const publicHost = await validateLanTransferOrigin("http://example.com", {
    resolveHost: async () => ["93.184.216.34"],
  });
  assert.equal(publicHost.ok, false);
});
```

- [ ] **Step 5: Run tests and confirm they fail for missing modules**

Run:

```bash
packages/server/node_modules/.bin/tsx --test packages/server/test/lan-transfer-payload.test.ts packages/server/test/lan-transfer-crypto.test.ts packages/server/test/lan-transfer-offer-store.test.ts packages/server/test/lan-transfer-url-policy.test.ts
```

Expected: FAIL with module-not-found errors for `services/lan-transfer/*`.

- [ ] **Step 6: Commit failing tests**

```bash
git add packages/server/test/lan-transfer-payload.test.ts packages/server/test/lan-transfer-crypto.test.ts packages/server/test/lan-transfer-offer-store.test.ts packages/server/test/lan-transfer-url-policy.test.ts
git commit -m "test: cover lan transfer primitives"
```

### Task 3: Implement Server Transfer Primitives

**Files:**
- Create: `packages/server/src/services/lan-transfer/lan-transfer-crypto.ts`
- Create: `packages/server/src/services/lan-transfer/lan-transfer-offer-store.ts`
- Create: `packages/server/src/services/lan-transfer/lan-transfer-payload.ts`
- Create: `packages/server/src/services/lan-transfer/lan-transfer-url-policy.ts`

- [ ] **Step 1: Implement crypto helpers**

Create `packages/server/src/services/lan-transfer/lan-transfer-crypto.ts`:

```ts
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { LanTransferEncryptedPackage } from "@marinara-engine/shared";

const ALGORITHM = "AES-256-GCM";
const KEY_INFO = Buffer.from("marinara-lan-transfer-v1", "utf8");

function randomBase64Url(byteLength: number) {
  return randomBytes(byteLength).toString("base64url");
}

function deriveKey(secret: string, salt: Buffer) {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), salt, KEY_INFO, 32));
}

export function generateLanTransferToken() {
  return randomBase64Url(16);
}

export function generateLanTransferSecret() {
  return randomBase64Url(32);
}

export function hashLanTransferToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

export function verifyLanTransferToken(token: string, expectedHash: string) {
  const actual = Buffer.from(hashLanTransferToken(token), "utf8");
  const expected = Buffer.from(expectedHash, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function encryptLanTransferPackage(plaintext: string, secret: string): LanTransferEncryptedPackage {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const aad = Buffer.from("marinara-lan-transfer-package-v1", "utf8");
  const cipher = createCipheriv(ALGORITHM, deriveKey(secret, salt), iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    algorithm: ALGORITHM,
    salt: salt.toString("base64url"),
    iv: iv.toString("base64url"),
    aad: aad.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: tag.toString("base64url"),
  };
}

export function decryptLanTransferPackage(encrypted: LanTransferEncryptedPackage, secret: string) {
  if (encrypted.version !== 1 || encrypted.algorithm !== ALGORITHM) {
    throw new Error("Unsupported LAN transfer package encryption format");
  }
  const salt = Buffer.from(encrypted.salt, "base64url");
  const iv = Buffer.from(encrypted.iv, "base64url");
  const aad = Buffer.from(encrypted.aad, "base64url");
  const tag = Buffer.from(encrypted.tag, "base64url");
  const ciphertext = Buffer.from(encrypted.ciphertext, "base64url");
  const decipher = createDecipheriv(ALGORITHM, deriveKey(secret, salt), iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
```

- [ ] **Step 2: Implement payload helpers**

Create `packages/server/src/services/lan-transfer/lan-transfer-payload.ts`:

```ts
import type { LanTransferPayload } from "@marinara-engine/shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOriginOnly(value: string) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

export function serializeLanTransferPayload(payload: LanTransferPayload) {
  return JSON.stringify(payload);
}

export function parseLanTransferPayload(raw: string): LanTransferPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  if (parsed.type !== "marinara-lan-transfer" || parsed.version !== 1) return null;
  if (!isNonEmptyString(parsed.from) || !isOriginOnly(parsed.from)) return null;
  if (!isNonEmptyString(parsed.offerId)) return null;
  if (!isNonEmptyString(parsed.downloadToken)) return null;
  if (!isNonEmptyString(parsed.secret)) return null;

  return {
    type: "marinara-lan-transfer",
    version: 1,
    from: parsed.from,
    offerId: parsed.offerId,
    downloadToken: parsed.downloadToken,
    secret: parsed.secret,
  };
}
```

- [ ] **Step 3: Implement offer store**

Create `packages/server/src/services/lan-transfer/lan-transfer-offer-store.ts`:

```ts
import type { LanTransferEncryptedPackage, LanTransferManifest } from "@marinara-engine/shared";

export interface LanTransferStoredOffer {
  offerId: string;
  downloadTokenHash: string;
  expiresAtMs: number;
  manifest: LanTransferManifest;
  encryptedPackage: LanTransferEncryptedPackage;
}

export interface LanTransferOfferStoreOptions {
  maxOffers: number;
  now?: () => number;
}

export function createLanTransferOfferStore(options: LanTransferOfferStoreOptions) {
  const offers = new Map<string, LanTransferStoredOffer>();
  const now = options.now ?? Date.now;

  function pruneExpired() {
    const current = now();
    for (const [id, offer] of offers) {
      if (offer.expiresAtMs <= current) offers.delete(id);
    }
  }

  return {
    put(offer: LanTransferStoredOffer) {
      pruneExpired();
      if (!offers.has(offer.offerId) && offers.size >= options.maxOffers) {
        throw new Error("LAN transfer offer store is full");
      }
      offers.set(offer.offerId, offer);
    },
    get(offerId: string) {
      pruneExpired();
      return offers.get(offerId) ?? null;
    },
    consume(offerId: string) {
      pruneExpired();
      const offer = offers.get(offerId) ?? null;
      if (offer) offers.delete(offerId);
      return offer;
    },
    delete(offerId: string) {
      return offers.delete(offerId);
    },
    size() {
      pruneExpired();
      return offers.size;
    },
  };
}

export const lanTransferOfferStore = createLanTransferOfferStore({ maxOffers: 10 });
```

- [ ] **Step 4: Implement URL policy**

Create `packages/server/src/services/lan-transfer/lan-transfer-url-policy.ts`:

```ts
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface LanTransferOriginValidationOptions {
  resolveHost?: (hostname: string) => Promise<string[]>;
}

function ipv4ToNumber(value: string) {
  const parts = value.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

function inRange(value: number, cidrBase: string, bits: number) {
  const base = ipv4ToNumber(cidrBase);
  if (base === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (base & mask);
}

export function isAllowedLanTransferAddress(address: string) {
  if (address === "::1") return true;
  if (address.startsWith("fc") || address.startsWith("fd")) return true;
  if (isIP(address) !== 4) return false;
  const value = ipv4ToNumber(address);
  if (value === null) return false;
  if (inRange(value, "127.0.0.0", 8)) return true;
  if (inRange(value, "10.0.0.0", 8)) return true;
  if (inRange(value, "172.16.0.0", 12)) return true;
  if (inRange(value, "192.168.0.0", 16)) return true;
  return false;
}

async function resolveDefault(hostname: string) {
  const result = await lookup(hostname, { all: true, verbatim: true });
  return result.map((entry) => entry.address);
}

export async function validateLanTransferOrigin(
  origin: string,
  options: LanTransferOriginValidationOptions = {},
): Promise<{ ok: true; url: URL; addresses: string[] } | { ok: false; error: string }> {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return { ok: false, error: "Invalid sender URL" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: "Sender URL must use HTTP" };
  if (url.username || url.password) return { ok: false, error: "Sender URL must not contain credentials" };
  if (url.pathname !== "/" || url.search || url.hash) return { ok: false, error: "Sender URL must be an origin only" };

  const resolveHost = options.resolveHost ?? resolveDefault;
  const addresses = await resolveHost(url.hostname);
  if (addresses.length === 0) return { ok: false, error: "Could not resolve sender host" };
  if (!addresses.every(isAllowedLanTransferAddress)) {
    return { ok: false, error: "Sender host is not a loopback or private LAN address" };
  }

  return { ok: true, url, addresses };
}
```

- [ ] **Step 5: Run primitive tests**

Run:

```bash
packages/server/node_modules/.bin/tsx --test packages/server/test/lan-transfer-payload.test.ts packages/server/test/lan-transfer-crypto.test.ts packages/server/test/lan-transfer-offer-store.test.ts packages/server/test/lan-transfer-url-policy.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/services/lan-transfer packages/server/test/lan-transfer-*.test.ts
git commit -m "feat: add lan transfer primitives"
```

### Task 4: Extract Reusable Chat And Character Export Services

**Files:**
- Create: `packages/server/src/services/export/chat-export.service.ts`
- Create: `packages/server/src/services/export/character-export.service.ts`
- Modify: `packages/server/src/routes/chats.routes.ts`
- Modify: `packages/server/src/routes/characters.routes.ts`

- [ ] **Step 1: Move chat serialization into a service**

Create `packages/server/src/services/export/chat-export.service.ts` with the route-local chat export helpers from `chats.routes.ts`. Export:

```ts
import type { FastifyInstance } from "fastify";
import { inArray } from "drizzle-orm";
import { characters } from "../../db/schema/index.js";

export type ChatExportFormat = "jsonl" | "text";

export interface ChatExportRow {
  id: string;
  name: string;
  mode?: string | null;
  groupId?: string | null;
  folderId?: string | null;
  characterIds?: unknown;
  metadata?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface SerializedChatTranscript {
  content: string;
  extension: "jsonl" | "txt";
  contentType: string;
  messageCount: number;
  branchName: string;
}

export function normalizeChatExportFormat(value: unknown): ChatExportFormat {
  return typeof value === "string" && value.toLowerCase() === "text" ? "text" : "jsonl";
}

export function safeChatExportNamePart(value: unknown, fallback: string): string {
  const source = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return (
    source
      .normalize("NFKD")
      .replace(/[^\w .-]+/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || fallback
  );
}

export async function serializeChatTranscript(
  app: FastifyInstance,
  storage: { listMessages: (chatId: string) => Promise<Array<any>> },
  chat: ChatExportRow,
  format: ChatExportFormat,
): Promise<SerializedChatTranscript> {
  const msgs = await storage.listMessages(chat.id);
  const charIds = parseExportCharacterIds(chat.characterIds);
  const metadata = parseExportMetadata(chat.metadata);
  const branchName = typeof metadata.branchName === "string" ? metadata.branchName : "";

  const charNameMap = new Map<string, string>();
  if (charIds.length > 0) {
    try {
      const rows = await app.db.select().from(characters).where(inArray(characters.id, charIds));
      for (const row of rows) {
        const data = JSON.parse(row.data);
        if (data?.name) charNameMap.set(row.id, data.name);
      }
    } catch {
      // Keep export usable when character metadata cannot be read.
    }
  }

  const primaryCharName = (charIds[0] && charNameMap.get(charIds[0])) ?? chat.name;
  const getDisplayName = (msg: { role: string; characterId?: string | null }) => {
    if (msg.role === "user") return "User";
    if (msg.role === "system") return "System";
    if (msg.role === "narrator") return "Narrator";
    if (msg.characterId && charNameMap.has(msg.characterId)) return charNameMap.get(msg.characterId)!;
    return primaryCharName;
  };

  if (format === "text") {
    const header = `Chat: ${chat.name}\nDate: ${chat.createdAt}\n${"─".repeat(50)}\n`;
    const body = msgs
      .map((msg) => {
        const name = getDisplayName(msg);
        const ts = msg.createdAt ? new Date(msg.createdAt).toLocaleString() : "";
        return `[${name}]${ts ? ` (${ts})` : ""}\n${msg.content}`;
      })
      .join("\n\n");
    return { content: header + body, extension: "txt", contentType: "text/plain; charset=utf-8", messageCount: msgs.length, branchName };
  }

  const lines = [
    JSON.stringify({ user_name: "User", character_name: primaryCharName, create_date: chat.createdAt, chat_metadata: {} }),
    ...msgs.map((msg) =>
      JSON.stringify({
        name: getDisplayName(msg),
        is_user: msg.role === "user",
        is_system: msg.role === "system" || msg.role === "narrator",
        mes: msg.content,
        send_date: msg.createdAt,
      }),
    ),
  ];
  return { content: lines.join("\n"), extension: "jsonl", contentType: "application/jsonl", messageCount: msgs.length, branchName };
}

function parseExportCharacterIds(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((id): id is string => typeof id === "string");
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function parseExportMetadata(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
```

- [ ] **Step 2: Update chat route imports and delegates**

In `packages/server/src/routes/chats.routes.ts`, import:

```ts
import {
  normalizeChatExportFormat,
  safeChatExportNamePart,
  serializeChatTranscript,
  type ChatExportFormat,
} from "../services/export/chat-export.service.js";
```

Replace route-local `ExportFormat`, `normalizeExportFormat`, `safeExportNamePart`, and `serializeChatTranscript` with service calls:

```ts
const format = normalizeChatExportFormat(req.body?.format);
const serialized = await serializeChatTranscript(app, storage, chat as ChatRow, format);
```

Use `safeChatExportNamePart` inside `buildBulkExportFilename`.

- [ ] **Step 3: Move native character envelope helpers into a service**

Create `packages/server/src/services/export/character-export.service.ts` by moving these functions from `characters.routes.ts`:

```ts
export async function buildNativeCharacterEnvelope(
  char: { id: string; createdAt: string; updatedAt: string; comment?: string | null; avatarPath?: string | null },
  data: any,
  galleryStorage: { listByCharacterId: (id: string) => Promise<any[]> },
): Promise<ExportEnvelope> {
  // Move the existing implementation from characters.routes.ts unchanged.
}

export function buildCompatibleCharacterExport(data: any) {
  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data,
  };
}
```

Move helper dependencies with it: `readImageAsDataUrl`, `readAvatarDataUrl`, `readSpritesForId`, `readGalleryForCharacter`, `CHARACTER_GALLERY_ROOT`, and image/security imports.

- [ ] **Step 4: Update character route imports and delegates**

In `packages/server/src/routes/characters.routes.ts`, import:

```ts
import {
  buildCompatibleCharacterExport,
  buildNativeCharacterEnvelope,
} from "../services/export/character-export.service.js";
```

Remove the moved helper implementations from the route file.

- [ ] **Step 5: Run existing export validation**

Run:

```bash
pnpm --filter @marinara-engine/server lint
```

Expected: exits `0`.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/services/export packages/server/src/routes/chats.routes.ts packages/server/src/routes/characters.routes.ts
git commit -m "refactor: share export builders"
```

### Task 5: Package Builder, Validator, And Import Orchestrator

**Files:**
- Create: `packages/server/test/lan-transfer-package.test.ts`
- Create: `packages/server/src/services/lan-transfer/lan-transfer-package.ts`

- [ ] **Step 1: Write package service tests**

Create `packages/server/test/lan-transfer-package.test.ts`:

```ts
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
```

- [ ] **Step 2: Run package test and confirm failure**

Run:

```bash
packages/server/node_modules/.bin/tsx --test packages/server/test/lan-transfer-package.test.ts
```

Expected: FAIL with module-not-found for `lan-transfer-package`.

- [ ] **Step 3: Implement package service**

Create `packages/server/src/services/lan-transfer/lan-transfer-package.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { APP_VERSION } from "@marinara-engine/shared";
import type {
  LanTransferImportSummary,
  LanTransferItemRequest,
  LanTransferManifest,
  LanTransferPackage,
} from "@marinara-engine/shared";
import { createChatsStorage } from "../storage/chats.storage.js";
import { createCharactersStorage } from "../storage/characters.storage.js";
import { createCharacterGalleryStorage } from "../storage/character-gallery.storage.js";
import { serializeChatTranscript } from "../export/chat-export.service.js";
import { buildNativeCharacterEnvelope } from "../export/character-export.service.js";
import { importSTChat } from "../import/st-chat.importer.js";
import { importMarinara } from "../import/marinara.importer.js";

export const LAN_TRANSFER_PACKAGE_MAX_BYTES = 25 * 1024 * 1024;

export async function buildLanTransferPackage(
  app: FastifyInstance,
  items: LanTransferItemRequest[],
  expiresAt: string,
): Promise<LanTransferPackage> {
  const chats = createChatsStorage(app.db);
  const characters = createCharactersStorage(app.db);
  const gallery = createCharacterGalleryStorage(app.db);
  const createdAt = new Date().toISOString();
  const packageItems: LanTransferPackage["items"] = [];
  const manifestItems: LanTransferManifest["items"] = [];

  for (const item of items) {
    if (item.type === "chat") {
      const chat = await chats.getById(item.id);
      if (!chat) throw new Error(`Chat not found: ${item.id}`);
      const serialized = await serializeChatTranscript(app, chats, chat as any, "jsonl");
      const bytes = Buffer.byteLength(serialized.content, "utf8");
      packageItems.push({ type: "chat", id: chat.id, name: chat.name, format: "jsonl", content: serialized.content });
      manifestItems.push({
        type: "chat",
        id: chat.id,
        name: chat.name,
        format: "jsonl",
        messageCount: serialized.messageCount,
        bytes,
      });
      continue;
    }

    if (item.type === "character") {
      const character = await characters.getById(item.id);
      if (!character) throw new Error(`Character not found: ${item.id}`);
      const data = JSON.parse(character.data);
      const envelope = await buildNativeCharacterEnvelope(character, data, gallery);
      const bytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
      const name = typeof data?.name === "string" && data.name.trim() ? data.name.trim() : "Character";
      packageItems.push({ type: "character", id: character.id, name, format: "native", envelope });
      manifestItems.push({ type: "character", id: character.id, name, format: "native", bytes });
      continue;
    }

    const exhaustive: never = item;
    throw new Error(`Unsupported transfer item: ${JSON.stringify(exhaustive)}`);
  }

  const totalBytes = manifestItems.reduce((sum, item) => sum + item.bytes, 0);
  if (totalBytes > LAN_TRANSFER_PACKAGE_MAX_BYTES) throw new Error("LAN transfer package exceeds size limit");

  return {
    version: 1,
    manifest: {
      version: 1,
      createdAt,
      expiresAt,
      sourceApp: "Marinara Engine",
      sourceVersion: APP_VERSION,
      items: manifestItems,
      totalBytes,
    },
    items: packageItems,
  };
}

export function validateLanTransferPackage(
  value: unknown,
  options: { maxBytes?: number } = {},
): { ok: true; package: LanTransferPackage } | { ok: false; error: string } {
  const maxBytes = options.maxBytes ?? LAN_TRANSFER_PACKAGE_MAX_BYTES;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "Package is not an object" };
  const pkg = value as LanTransferPackage;
  if (pkg.version !== 1) return { ok: false, error: "Unsupported package version" };
  if (!pkg.manifest || typeof pkg.manifest !== "object") return { ok: false, error: "Package manifest is missing" };
  if (!Array.isArray(pkg.items)) return { ok: false, error: "Package items are missing" };
  if (pkg.manifest.version !== 1 || pkg.manifest.sourceApp !== "Marinara Engine") {
    return { ok: false, error: "Package manifest is invalid" };
  }
  if (!Number.isFinite(pkg.manifest.totalBytes) || pkg.manifest.totalBytes > maxBytes) {
    return { ok: false, error: "Package is too large" };
  }

  for (const item of pkg.items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false, error: "Package item is invalid" };
    if (item.type === "chat") {
      if (item.format !== "jsonl" || typeof item.content !== "string") return { ok: false, error: "Chat item is invalid" };
      continue;
    }
    if (item.type === "character") {
      if (item.format !== "native" || !item.envelope || typeof item.envelope !== "object") {
        return { ok: false, error: "Character item is invalid" };
      }
      continue;
    }
    return { ok: false, error: "Unsupported package item type" };
  }

  return { ok: true, package: pkg };
}

export async function importLanTransferPackage(
  app: FastifyInstance,
  pkg: LanTransferPackage,
): Promise<LanTransferImportSummary> {
  const summary: LanTransferImportSummary = { imported: { chats: 0, characters: 0 }, skipped: [] };

  for (const item of pkg.items) {
    try {
      if (item.type === "chat") {
        await importSTChat(item.content, app.db, { chatName: item.name });
        summary.imported.chats += 1;
      } else if (item.type === "character") {
        await importMarinara(item.envelope as any, app.db);
        summary.imported.characters += 1;
      }
    } catch (err) {
      summary.skipped.push({
        type: item.type,
        name: item.name,
        reason: err instanceof Error ? err.message : "Import failed",
      });
    }
  }

  return summary;
}
```

- [ ] **Step 4: Run package test**

Run:

```bash
packages/server/node_modules/.bin/tsx --test packages/server/test/lan-transfer-package.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/lan-transfer/lan-transfer-package.ts packages/server/test/lan-transfer-package.test.ts
git commit -m "feat: build lan transfer packages"
```

### Task 6: LAN Transfer Routes

**Files:**
- Create: `packages/server/src/routes/lan-transfer.routes.ts`
- Modify: `packages/server/src/routes/index.ts`
- Create: `packages/server/test/lan-transfer-routes.test.ts`

- [ ] **Step 1: Write route tests**

Create `packages/server/test/lan-transfer-routes.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileNativeDB } from "../src/db/file-backed-store.js";

async function withRoutes<T>(fn: (app: ReturnType<typeof Fastify>) => Promise<T>) {
  const root = mkdtempSync(join(tmpdir(), "marinara-lan-transfer-routes-"));
  const previous = {
    LAN_TRANSFER_ENABLED: process.env.LAN_TRANSFER_ENABLED,
    DATA_DIR: process.env.DATA_DIR,
    FILE_STORAGE_DIR: process.env.FILE_STORAGE_DIR,
  };
  process.env.LAN_TRANSFER_ENABLED = "true";
  process.env.DATA_DIR = join(root, "data");
  process.env.FILE_STORAGE_DIR = join(root, "storage");
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
    if (previous.LAN_TRANSFER_ENABLED === undefined) delete process.env.LAN_TRANSFER_ENABLED;
    else process.env.LAN_TRANSFER_ENABLED = previous.LAN_TRANSFER_ENABLED;
    if (previous.DATA_DIR === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous.DATA_DIR;
    if (previous.FILE_STORAGE_DIR === undefined) delete process.env.FILE_STORAGE_DIR;
    else process.env.FILE_STORAGE_DIR = previous.FILE_STORAGE_DIR;
  }
}

test("rejects create offer with no items", async () =>
  withRoutes(async (app) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/lan-transfer/offers",
      payload: { items: [] },
    });

    assert.equal(res.statusCode, 400, res.body);
  }));

test("rejects invalid preview payload", async () =>
  withRoutes(async (app) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/lan-transfer/preview",
      payload: { transferPayload: "{bad" },
    });

    assert.equal(res.statusCode, 400, res.body);
  }));
```

- [ ] **Step 2: Run route tests and confirm failure**

Run:

```bash
packages/server/node_modules/.bin/tsx --test packages/server/test/lan-transfer-routes.test.ts
```

Expected: FAIL with module-not-found for `lan-transfer.routes`.

- [ ] **Step 3: Implement route module**

Create `packages/server/src/routes/lan-transfer.routes.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { request } from "undici";
import { newId } from "../utils/id-generator.js";
import { isLanTransferEnabled } from "../config/runtime-config.js";
import {
  decryptLanTransferPackage,
  encryptLanTransferPackage,
  generateLanTransferSecret,
  generateLanTransferToken,
  hashLanTransferToken,
  verifyLanTransferToken,
} from "../services/lan-transfer/lan-transfer-crypto.js";
import { lanTransferOfferStore } from "../services/lan-transfer/lan-transfer-offer-store.js";
import { parseLanTransferPayload, serializeLanTransferPayload } from "../services/lan-transfer/lan-transfer-payload.js";
import {
  buildLanTransferPackage,
  importLanTransferPackage,
  validateLanTransferPackage,
} from "../services/lan-transfer/lan-transfer-package.js";
import { validateLanTransferOrigin } from "../services/lan-transfer/lan-transfer-url-policy.js";
import type {
  LanTransferCreateOfferRequest,
  LanTransferEncryptedPackage,
  LanTransferImportFromOfferRequest,
  LanTransferManifestRequest,
  LanTransferPreviewRequest,
} from "@marinara-engine/shared";

const TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_FETCH_BYTES = 25 * 1024 * 1024;

function ensureEnabled(reply: { status: (code: number) => { send: (payload: unknown) => unknown } }) {
  if (isLanTransferEnabled()) return true;
  reply.status(403).send({ error: "LAN transfer is disabled" });
  return false;
}

async function readJsonFromSender<T>(url: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await request(url, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", accept: "application/json" },
      maxRedirections: 0,
      signal: controller.signal,
    });
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_FETCH_BYTES) throw new Error("Sender response is too large");
      chunks.push(buffer);
    }
    if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`Sender returned HTTP ${res.statusCode}`);
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function lanTransferRoutes(app: FastifyInstance) {
  app.post<{ Body: LanTransferCreateOfferRequest }>("/offers", async (req, reply) => {
    if (!ensureEnabled(reply)) return;
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) return reply.status(400).send({ error: "At least one transfer item is required" });

    const offerId = newId();
    const downloadToken = generateLanTransferToken();
    const secret = generateLanTransferSecret();
    const expiresAtMs = Date.now() + TTL_MS;
    const expiresAt = new Date(expiresAtMs).toISOString();
    const pkg = await buildLanTransferPackage(app, items, expiresAt);
    const encryptedPackage = encryptLanTransferPackage(JSON.stringify(pkg), secret);
    const host = req.headers.host ?? `127.0.0.1:${process.env.PORT ?? "7860"}`;
    const protocol = req.protocol ?? "http";
    const transferPayload = serializeLanTransferPayload({
      type: "marinara-lan-transfer",
      version: 1,
      from: `${protocol}://${host}`,
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

    return { offerId, transferPayload, expiresAt, manifest: pkg.manifest };
  });

  app.post<{ Params: { offerId: string }; Body: LanTransferManifestRequest }>("/offers/:offerId/manifest", async (req, reply) => {
    if (!ensureEnabled(reply)) return;
    const offer = lanTransferOfferStore.get(req.params.offerId);
    if (!offer) return reply.status(404).send({ error: "Transfer offer not found or expired" });
    if (!verifyLanTransferToken(req.body?.downloadToken ?? "", offer.downloadTokenHash)) {
      return reply.status(403).send({ error: "Invalid transfer token" });
    }
    return { offerId: offer.offerId, expiresAt: offer.manifest.expiresAt, consumed: false, manifest: offer.manifest };
  });

  app.post<{ Params: { offerId: string }; Body: LanTransferManifestRequest }>("/offers/:offerId/download", async (req, reply) => {
    if (!ensureEnabled(reply)) return;
    const offer = lanTransferOfferStore.get(req.params.offerId);
    if (!offer) return reply.status(404).send({ error: "Transfer offer not found or expired" });
    if (!verifyLanTransferToken(req.body?.downloadToken ?? "", offer.downloadTokenHash)) {
      return reply.status(403).send({ error: "Invalid transfer token" });
    }
    lanTransferOfferStore.consume(req.params.offerId);
    return offer.encryptedPackage;
  });

  app.delete<{ Params: { offerId: string } }>("/offers/:offerId", async (req, reply) => {
    if (!ensureEnabled(reply)) return;
    lanTransferOfferStore.delete(req.params.offerId);
    return { success: true };
  });

  app.post<{ Body: LanTransferPreviewRequest }>("/preview", async (req, reply) => {
    if (!ensureEnabled(reply)) return;
    const payload = parseLanTransferPayload(req.body?.transferPayload ?? "");
    if (!payload) return reply.status(400).send({ error: "Invalid transfer payload" });
    const validOrigin = await validateLanTransferOrigin(payload.from);
    if (!validOrigin.ok) return reply.status(400).send({ error: validOrigin.error });
    const manifest = await readJsonFromSender<any>(`${payload.from}/api/lan-transfer/offers/${payload.offerId}/manifest`, {
      downloadToken: payload.downloadToken,
    });
    return { from: payload.from, offerId: payload.offerId, expiresAt: manifest.expiresAt, manifest: manifest.manifest };
  });

  app.post<{ Body: LanTransferImportFromOfferRequest }>("/import-from-offer", async (req, reply) => {
    if (!ensureEnabled(reply)) return;
    const payload = parseLanTransferPayload(req.body?.transferPayload ?? "");
    if (!payload) return reply.status(400).send({ error: "Invalid transfer payload" });
    const validOrigin = await validateLanTransferOrigin(payload.from);
    if (!validOrigin.ok) return reply.status(400).send({ error: validOrigin.error });
    const encrypted = await readJsonFromSender<LanTransferEncryptedPackage>(
      `${payload.from}/api/lan-transfer/offers/${payload.offerId}/download`,
      { downloadToken: payload.downloadToken },
    );
    const decrypted = decryptLanTransferPackage(encrypted, payload.secret);
    const parsed = JSON.parse(decrypted);
    const validation = validateLanTransferPackage(parsed);
    if (!validation.ok) return reply.status(400).send({ error: validation.error });
    return importLanTransferPackage(app, validation.package);
  });
}
```

- [ ] **Step 4: Register route module**

Modify `packages/server/src/routes/index.ts`:

```ts
import { lanTransferRoutes } from "./lan-transfer.routes.js";
```

Register near other API routes:

```ts
await app.register(lanTransferRoutes, { prefix: "/api/lan-transfer" });
```

- [ ] **Step 5: Run route tests**

Run:

```bash
packages/server/node_modules/.bin/tsx --test packages/server/test/lan-transfer-routes.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run server lint**

Run:

```bash
pnpm --filter @marinara-engine/server lint
```

Expected: exits `0`.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/routes/lan-transfer.routes.ts packages/server/src/routes/index.ts packages/server/test/lan-transfer-routes.test.ts
git commit -m "feat: add lan transfer routes"
```

### Task 7: Client Hook And Dependency

**Files:**
- Modify: `packages/client/package.json`
- Create: `packages/client/src/hooks/use-lan-transfer.ts`

- [ ] **Step 1: Add QR dependency**

Run:

```bash
pnpm --filter @marinara-engine/client add qrcode
pnpm --filter @marinara-engine/client add -D @types/qrcode
```

Expected: `packages/client/package.json` and `pnpm-lock.yaml` update.

- [ ] **Step 2: Add client hook**

Create `packages/client/src/hooks/use-lan-transfer.ts`:

```ts
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  LanTransferCreateOfferRequest,
  LanTransferCreateOfferResponse,
  LanTransferImportFromOfferRequest,
  LanTransferImportSummary,
  LanTransferPreviewRequest,
  LanTransferPreviewResponse,
} from "@marinara-engine/shared";
import { api } from "../lib/api-client";
import { chatKeys } from "./use-chats";
import { characterKeys } from "./use-characters";

export function useCreateLanTransferOffer() {
  return useMutation({
    mutationFn: (body: LanTransferCreateOfferRequest) =>
      api.post<LanTransferCreateOfferResponse>("/lan-transfer/offers", body),
  });
}

export function useCancelLanTransferOffer() {
  return useMutation({
    mutationFn: (offerId: string) => api.delete<{ success: boolean }>(`/lan-transfer/offers/${offerId}`),
  });
}

export function usePreviewLanTransfer() {
  return useMutation({
    mutationFn: (body: LanTransferPreviewRequest) => api.post<LanTransferPreviewResponse>("/lan-transfer/preview", body),
  });
}

export function useImportLanTransferFromOffer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LanTransferImportFromOfferRequest) =>
      api.post<LanTransferImportSummary>("/lan-transfer/import-from-offer", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: chatKeys.list() });
      qc.invalidateQueries({ queryKey: characterKeys.list() });
    },
  });
}
```

- [ ] **Step 3: Run client lint**

Run:

```bash
pnpm --filter @marinara-engine/client lint
```

Expected: exits `0`.

- [ ] **Step 4: Commit**

```bash
git add packages/client/package.json pnpm-lock.yaml packages/client/src/hooks/use-lan-transfer.ts
git commit -m "feat: add lan transfer client hook"
```

### Task 8: Send To Device Modal

**Files:**
- Create: `packages/client/src/components/modals/SendToDeviceModal.tsx`
- Modify: `packages/client/src/components/layout/ModalRenderer.tsx`

- [ ] **Step 1: Create send modal**

Create `packages/client/src/components/modals/SendToDeviceModal.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
import { Copy, Loader2, QrCode, X } from "lucide-react";
import QRCode from "qrcode";
import { toast } from "sonner";
import type { LanTransferItemRequest } from "@marinara-engine/shared";
import { useCancelLanTransferOffer, useCreateLanTransferOffer } from "../../hooks/use-lan-transfer";
import { Modal } from "../ui/Modal";

interface SendToDeviceModalProps {
  open: boolean;
  onClose: () => void;
  items: LanTransferItemRequest[];
  title?: string;
}

export function SendToDeviceModal({ open, onClose, items, title = "Send to Device" }: SendToDeviceModalProps) {
  const createOffer = useCreateLanTransferOffer();
  const cancelOffer = useCancelLanTransferOffer();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  const offer = createOffer.data;
  const itemLabel = useMemo(() => {
    const chats = items.filter((item) => item.type === "chat").length;
    const characters = items.filter((item) => item.type === "character").length;
    return [chats ? `${chats} chat${chats === 1 ? "" : "s"}` : "", characters ? `${characters} character${characters === 1 ? "" : "s"}` : ""]
      .filter(Boolean)
      .join(", ");
  }, [items]);

  useEffect(() => {
    if (!open || items.length === 0 || createOffer.data || createOffer.isPending) return;
    createOffer.mutate({ items });
  }, [createOffer, items, open]);

  useEffect(() => {
    let cancelled = false;
    if (!offer?.transferPayload) {
      setQrDataUrl(null);
      return;
    }
    QRCode.toDataURL(offer.transferPayload, { margin: 1, scale: 6 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [offer?.transferPayload]);

  const handleCopy = async () => {
    if (!offer?.transferPayload) return;
    await navigator.clipboard.writeText(offer.transferPayload);
    toast.success("Transfer payload copied");
  };

  const handleCancel = async () => {
    if (offer?.offerId) await cancelOffer.mutateAsync(offer.offerId);
    onClose();
  };

  return (
    <Modal open={open} onClose={handleCancel} title={title} width="max-w-lg">
      <div className="flex flex-col gap-4">
        <div className="text-xs text-[var(--muted-foreground)]">
          {itemLabel || "Selected items"} will be available on this local network for 10 minutes or one download.
        </div>

        {createOffer.isPending && (
          <div className="flex items-center justify-center gap-2 rounded-lg border border-[var(--border)] px-3 py-8 text-sm">
            <Loader2 size="1rem" className="animate-spin" />
            Preparing transfer
          </div>
        )}

        {createOffer.error && (
          <div className="rounded-lg border border-[var(--destructive)]/40 bg-[var(--destructive)]/10 px-3 py-2 text-xs text-[var(--destructive)]">
            {createOffer.error instanceof Error ? createOffer.error.message : "Could not create transfer offer"}
          </div>
        )}

        {offer && (
          <>
            <div className="flex items-center justify-center rounded-lg border border-[var(--border)] bg-white p-3">
              {qrDataUrl ? (
                <img src={qrDataUrl} alt="LAN transfer QR code" className="h-56 w-56" />
              ) : (
                <QrCode size="5rem" className="text-neutral-400" />
              )}
            </div>
            <textarea
              readOnly
              value={offer.transferPayload}
              className="min-h-24 rounded-lg border border-[var(--border)] bg-[var(--secondary)] p-2 text-[0.6875rem] text-[var(--foreground)]"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleCopy}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-[var(--primary)] px-3 py-2 text-xs font-semibold text-[var(--primary-foreground)] active:scale-[0.98]"
              >
                <Copy size="0.875rem" />
                Copy
              </button>
              <button
                type="button"
                onClick={handleCancel}
                className="flex items-center justify-center gap-2 rounded-lg bg-[var(--secondary)] px-3 py-2 text-xs font-semibold ring-1 ring-[var(--border)] active:scale-[0.98]"
              >
                <X size="0.875rem" />
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
```

- [ ] **Step 2: Register send modal**

Modify `packages/client/src/components/layout/ModalRenderer.tsx`:

```tsx
const SendToDeviceModal = lazy(() =>
  import("../modals/SendToDeviceModal").then((module) => ({ default: module.SendToDeviceModal })),
);
```

Add switch case:

```tsx
case "send-to-device":
  content = (
    <SendToDeviceModal
      open
      onClose={closeModal}
      items={(modal?.props?.items as any[]) ?? []}
      title={(modal?.props?.title as string | undefined) ?? "Send to Device"}
    />
  );
  break;
```

- [ ] **Step 3: Run client lint**

Run:

```bash
pnpm --filter @marinara-engine/client lint
```

Expected: exits `0`.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/components/modals/SendToDeviceModal.tsx packages/client/src/components/layout/ModalRenderer.tsx
git commit -m "feat: add send to device modal"
```

### Task 9: Receive From Device Modal

**Files:**
- Create: `packages/client/src/components/modals/ReceiveFromDeviceModal.tsx`
- Modify: `packages/client/src/components/layout/ModalRenderer.tsx`

- [ ] **Step 1: Create receive modal**

Create `packages/client/src/components/modals/ReceiveFromDeviceModal.tsx`:

```tsx
import { useState } from "react";
import { Download, Loader2, SearchCheck } from "lucide-react";
import { toast } from "sonner";
import { useImportLanTransferFromOffer, usePreviewLanTransfer } from "../../hooks/use-lan-transfer";
import { Modal } from "../ui/Modal";

interface ReceiveFromDeviceModalProps {
  open: boolean;
  onClose: () => void;
}

export function ReceiveFromDeviceModal({ open, onClose }: ReceiveFromDeviceModalProps) {
  const [transferPayload, setTransferPayload] = useState("");
  const preview = usePreviewLanTransfer();
  const importFromOffer = useImportLanTransferFromOffer();

  const handlePreview = async () => {
    await preview.mutateAsync({ transferPayload });
  };

  const handleImport = async () => {
    const result = await importFromOffer.mutateAsync({ transferPayload });
    toast.success(`Imported ${result.imported.chats} chat${result.imported.chats === 1 ? "" : "s"} and ${result.imported.characters} character${result.imported.characters === 1 ? "" : "s"}`);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Receive from Device" width="max-w-lg">
      <div className="flex flex-col gap-4">
        <textarea
          value={transferPayload}
          onChange={(event) => setTransferPayload(event.target.value)}
          placeholder="Paste transfer payload"
          className="min-h-32 rounded-lg border border-[var(--border)] bg-[var(--secondary)] p-2 text-xs text-[var(--foreground)]"
        />

        {(preview.error || importFromOffer.error) && (
          <div className="rounded-lg border border-[var(--destructive)]/40 bg-[var(--destructive)]/10 px-3 py-2 text-xs text-[var(--destructive)]">
            {(preview.error ?? importFromOffer.error) instanceof Error
              ? (preview.error ?? importFromOffer.error as Error).message
              : "LAN transfer failed"}
          </div>
        )}

        {preview.data && (
          <div className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs">
            <div className="font-semibold">{preview.data.manifest.items.length} item{preview.data.manifest.items.length === 1 ? "" : "s"}</div>
            <div className="mt-1 text-[var(--muted-foreground)]">From {preview.data.from}</div>
            <div className="mt-2 flex flex-col gap-1">
              {preview.data.manifest.items.map((item) => (
                <div key={`${item.type}:${item.id}`} className="flex items-center justify-between gap-3">
                  <span className="truncate">{item.name}</span>
                  <span className="shrink-0 text-[var(--muted-foreground)]">{item.type}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={handlePreview}
            disabled={!transferPayload.trim() || preview.isPending || importFromOffer.isPending}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-[var(--secondary)] px-3 py-2 text-xs font-semibold ring-1 ring-[var(--border)] active:scale-[0.98] disabled:opacity-50"
          >
            {preview.isPending ? <Loader2 size="0.875rem" className="animate-spin" /> : <SearchCheck size="0.875rem" />}
            Preview
          </button>
          <button
            type="button"
            onClick={handleImport}
            disabled={!preview.data || importFromOffer.isPending}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-[var(--primary)] px-3 py-2 text-xs font-semibold text-[var(--primary-foreground)] active:scale-[0.98] disabled:opacity-50"
          >
            {importFromOffer.isPending ? <Loader2 size="0.875rem" className="animate-spin" /> : <Download size="0.875rem" />}
            Import
          </button>
        </div>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 2: Register receive modal**

Modify `packages/client/src/components/layout/ModalRenderer.tsx`:

```tsx
const ReceiveFromDeviceModal = lazy(() =>
  import("../modals/ReceiveFromDeviceModal").then((module) => ({ default: module.ReceiveFromDeviceModal })),
);
```

Add switch case:

```tsx
case "receive-from-device":
  content = <ReceiveFromDeviceModal open onClose={closeModal} />;
  break;
```

- [ ] **Step 3: Run client lint**

Run:

```bash
pnpm --filter @marinara-engine/client lint
```

Expected: exits `0`.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/components/modals/ReceiveFromDeviceModal.tsx packages/client/src/components/layout/ModalRenderer.tsx
git commit -m "feat: add receive from device modal"
```

### Task 10: UI Entry Points

**Files:**
- Modify: `packages/client/src/components/chat/ChatFilesDrawer.tsx`
- Modify: `packages/client/src/components/layout/ChatSidebar.tsx`
- Modify: `packages/client/src/components/panels/CharactersPanel.tsx`
- Modify: `packages/client/src/components/panels/SettingsPanel.tsx`

- [ ] **Step 1: Add chat send entry point**

Modify `packages/client/src/components/chat/ChatFilesDrawer.tsx` imports:

```tsx
import { X, Trash2, FileText, MessageSquare, Download, Pencil, Upload, Send } from "lucide-react";
import { useUIStore } from "../../stores/ui.store";
```

Inside `ChatFilesDrawer`, add:

```tsx
const openModal = useUIStore((s) => s.openModal);
```

Add a button next to JSONL/Text export in both export button groups:

```tsx
<button
  onClick={() =>
    openModal("send-to-device", {
      items: [{ type: "chat", id: activeChatId ?? chat.id, format: "jsonl" }],
      title: "Send Chat to Device",
    })
  }
  className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-[var(--secondary)] px-3 py-2.5 text-xs font-medium text-[var(--foreground)] ring-1 ring-[var(--border)] transition-all hover:bg-[var(--accent)] active:scale-[0.98]"
>
  <Send size="0.8125rem" />
  Send
</button>
```

- [ ] **Step 2: Add selected-chat send entry point**

Modify `packages/client/src/components/layout/ChatSidebar.tsx` imports:

```tsx
import { Send } from "lucide-react";
```

Inside `ChatSidebar`, add the modal opener with the other `useUIStore` selectors:

```tsx
const openModal = useUIStore((s) => s.openModal);
```

`ChatSidebar` already has `selectedChatIds` and `multiSelectMode`. Add a selected action in the bottom multi-select toolbar near the existing Export button:

```tsx
<button
  type="button"
  onClick={() =>
    openModal("send-to-device", {
      items: [...selectedChatIds].map((id) => ({ type: "chat", id, format: "jsonl" })),
      title: "Send Chats to Device",
    })
  }
  disabled={selectedChatIds.size === 0}
  className="flex items-center justify-center gap-1.5 rounded-lg bg-[var(--secondary)] px-2.5 py-1.5 text-xs font-medium ring-1 ring-[var(--border)] transition-all hover:bg-[var(--accent)] active:scale-[0.98] disabled:opacity-50"
>
  <Send size="0.8125rem" />
  Send
</button>
```

- [ ] **Step 3: Add selected-character send entry point**

Modify `packages/client/src/components/panels/CharactersPanel.tsx` imports:

```tsx
import { Send } from "lucide-react";
```

Add a selected action beside selected export/delete controls:

```tsx
<button
  type="button"
  onClick={() =>
    openModal("send-to-device", {
      items: [...selectedCharacterIds].map((id) => ({ type: "character", id, format: "native" })),
      title: "Send Characters to Device",
    })
  }
  disabled={selectedCharacterIds.size === 0}
  className="flex items-center justify-center gap-1.5 rounded-lg bg-[var(--secondary)] px-2.5 py-1.5 text-xs font-medium ring-1 ring-[var(--border)] transition-all hover:bg-[var(--accent)] active:scale-[0.98] disabled:opacity-50"
>
  <Send size="0.8125rem" />
  Send
</button>
```

Place it in the existing selection toolbar where `handleExportSelected` is available.

- [ ] **Step 4: Add receive entry point to settings import tab**

Modify `packages/client/src/components/panels/SettingsPanel.tsx` imports:

```tsx
import { Smartphone } from "lucide-react";
```

In `ImportSettings`, add a button before the Marinara file import section:

```tsx
<button
  type="button"
  onClick={() => openModal("receive-from-device")}
  className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-sky-500/20 to-cyan-500/20 px-3 py-3 text-xs font-semibold ring-1 ring-sky-500/30 transition-all hover:ring-sky-500/50 active:scale-[0.98]"
>
  <Smartphone size="1rem" />
  Receive from Device
</button>
```

- [ ] **Step 5: Run client lint**

Run:

```bash
pnpm --filter @marinara-engine/client lint
```

Expected: exits `0`.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/components/chat/ChatFilesDrawer.tsx packages/client/src/components/layout/ChatSidebar.tsx packages/client/src/components/panels/CharactersPanel.tsx packages/client/src/components/panels/SettingsPanel.tsx
git commit -m "feat: add lan transfer entry points"
```

### Task 11: End-To-End Validation

**Files:**
- All touched files.

- [ ] **Step 1: Run server LAN transfer tests**

Run:

```bash
packages/server/node_modules/.bin/tsx --test packages/server/test/lan-transfer-*.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full baseline**

Run:

```bash
pnpm check
```

Expected: exits `0`.

- [ ] **Step 3: Start app with LAN transfer enabled**

Run:

```bash
LAN_TRANSFER_ENABLED=true pnpm dev
```

Expected:
- Client starts on `http://localhost:5173/`.
- Server starts on `http://127.0.0.1:7860/`.
- `/api/health` returns `status: "ok"`.

- [ ] **Step 4: Manual smoke Linux to same instance**

Use one running instance first:

1. Open a chat.
2. Open `Manage Chat Files`.
3. Click `Send`.
4. Copy the payload.
5. Open Settings -> Import -> `Receive from Device`.
6. Paste payload.
7. Click `Preview`.
8. Confirm the chat name appears.
9. Click `Import`.
10. Confirm a new imported chat appears.

Expected:
- Preview lists the selected chat.
- Import succeeds once.
- Reusing the same payload fails with consumed/not-found transfer.

- [ ] **Step 5: Manual smoke with Android instance**

Run the receiver Marinara instance on Android/Termux with `LAN_TRANSFER_ENABLED=true`.

Expected Linux -> Android:
- Linux sender shows QR and copy payload.
- Android receives pasted payload.
- Android preview shows selected chat/character names.
- Android import creates new copies.

Expected Android -> Linux:
- Android sender shows QR and copy payload.
- Linux receives pasted payload.
- Linux preview shows selected chat/character names.
- Linux import creates new copies.

- [ ] **Step 6: Security smoke**

Use the receiver modal with edited payloads:

```json
{"type":"marinara-lan-transfer","version":1,"from":"http://8.8.8.8:7860","offerId":"x","downloadToken":"x","secret":"x"}
```

Expected: preview rejects public sender address.

```json
{"type":"marinara-lan-transfer","version":1,"from":"http://169.254.169.254","offerId":"x","downloadToken":"x","secret":"x"}
```

Expected: preview rejects metadata/link-local sender address.

```json
{"type":"marinara-lan-transfer","version":1,"from":"http://192.168.1.10:7860/path","offerId":"x","downloadToken":"x","secret":"x"}
```

Expected: preview rejects non-origin sender URL.

- [ ] **Step 7: Final commit**

```bash
git status --short
git log --oneline --max-count=12
```

Expected:
- Working tree clean.
- Commits show the LAN transfer tasks in order.

## Self-Review Checklist

- Shared payload contains both `downloadToken` and `secret`.
- Sender stores only encrypted package, manifest, expiry, and token hash.
- Secret is never sent back to sender after offer creation.
- Receiver backend performs sender fetch, decrypt, validate, and import.
- Browser does not directly fetch the remote LAN origin.
- Browser does not request camera access.
- Offer download consumes the offer.
- LAN URL policy blocks public, metadata, malformed, and non-HTTP targets.
- Normal Basic Auth/admin behavior remains intact for existing routes.
- `LAN_TRANSFER_ENABLED` gates every LAN transfer route.
- Chat transfer uses JSONL.
- Character transfer uses native Marinara envelopes.
- Manual smoke covers both directions.
