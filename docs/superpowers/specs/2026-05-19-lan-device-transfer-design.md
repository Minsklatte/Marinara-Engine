# LAN Device Transfer MVP Design

## Goal

Add a LAN-only, user-initiated transfer feature so two Marinara Engine instances on the same trusted local network can move selected chats and characters between each other without using cloud storage or weakening the app's local-first security posture.

The first target setup is a Linux Marinara instance and a separate Android/Termux Marinara instance. The feature must work in both directions.

## Non-Goals

- No cloud relay.
- No automatic sync.
- No account system.
- No background device discovery for MVP.
- No LAN scanning. Phase 2 sender-origin self-discovery is limited to bounded origins advertised by the sender in the transfer payload.
- No in-app camera requirement for MVP.
- No full profile transfer in MVP.
- No interactive merge UI. Phase 2 smart import can reuse, append, skip, or create conflict copies, but it does not ask users to manually resolve message-level conflicts.
- No transfer of arbitrary files beyond chat and character export payloads already supported by Marinara.

## Existing Capabilities To Reuse

- Chat export:
  - `GET /api/chats/:id/export?format=jsonl|text`
  - `POST /api/chats/export/bulk`
- Chat import:
  - Existing JSONL import path used by `ChatFilesDrawer`.
- Character export:
  - `GET /api/characters/:id/export?format=native|compatible`
  - `POST /api/characters/export-bulk`
- Character import:
  - Existing Marinara native import route: `POST /api/import/marinara`.
  - Existing `.marinara` package route can remain out of MVP unless selected character exports require it.
- Frontend modal patterns:
  - `ModalRenderer` and `useUIStore().openModal(...)`.
- Existing admin/auth model:
  - LAN access can require Basic Auth/admin secret depending on server config. This feature must not relax those rules globally.

## Recommended MVP Approach

Use a pull-based LAN transfer.

The sender creates a temporary local offer. The receiver fetches the offer from the sender using a pasted/scanned transfer payload, previews it, then imports it.

The sender never pushes directly into the receiver. This reduces the receiver-side attack surface because import only happens after a local user action and preview confirmation.

## User Flows

### Send From Device

1. User opens a chat/character list or settings import/export panel.
2. User chooses `Send to Device`.
3. User selects one or more supported items:
   - Chats in native LAN format by default, including referenced character cards and media dependencies.
   - Chats as JSONL only for legacy or explicit export flows.
   - Characters as native Marinara JSON.
4. Marinara creates a temporary transfer offer.
5. Sender UI shows:
   - Copyable transfer payload.
   - QR code containing the same payload.
   - Sender origin selected for the offer.
   - Expiration countdown.
   - One-time-use status.
   - Cancel button.
6. Sender keeps the offer available until it is downloaded once, cancelled, or expires.

### Receive On Device

1. User opens `Receive from Device` on the receiving Marinara instance.
2. User scans the QR with the phone camera or another external QR scanner, then pastes the payload into Marinara. No in-app camera permission is needed.
3. Receiver sends the payload to its own local backend.
4. Receiver backend validates the sender URL against LAN-only rules and fetches the manifest from the sender.
5. Receiver shows a preview:
   - Sender origin that responded.
   - Transfer type.
   - Chat count and names.
   - Character count and names.
   - Bundled character cards referenced by selected chats.
   - Smart import analysis and per-item actions where manifest metadata permits.
   - Approximate payload size.
   - Expiration status.
6. User clicks `Import`.
7. Receiver backend downloads, verifies, decrypts, validates, and imports with smart import by default.
8. Receiver shows an import summary.

Default import behavior is smart:

- Reuse exact native character cards instead of duplicating them.
- Append only strict native chat extensions when the incoming message fingerprint timeline extends the local synced timeline exactly.
- Do nothing when the local synced chat is already up to date or local history is ahead.
- Import a conflict copy when synced histories diverge.

`Import as copies` is the explicit escape hatch. It defaults off and maps to copy mode, bypassing smart reuse and append behavior.

Preview labels should avoid redundant wording. A native chat with one resolved linked card can be shown as `1 chat linked to Alicia`, not as separate duplicate chat/card phrasing.

## Transfer Payload

The QR/copy payload is plain text JSON for MVP. It can be displayed as text, copied, or encoded into a QR.

Example:

```json
{
  "type": "marinara-lan-transfer",
  "version": 1,
  "from": "http://192.168.1.50:7860",
  "origins": ["http://192.168.1.50:7860", "http://marinara.local:7860"],
  "offerId": "01HZ7P5Q7JYH3K8K1E6Q2F4W8D",
  "downloadToken": "base64url-random-128-bit-token",
  "secret": "base64url-random-256-bit-secret"
}
```

The `downloadToken` authorizes access to the temporary offer. The `secret` decrypts the package. Keeping these separate lets the receiver prove it has the offer payload without sending the decryption key back to the sender.

The `from` field is an origin only: scheme, host, and optional port. It must not include credentials, a path, a query string, or a fragment.

Phase 2 payloads may include bounded `origins` alongside backward-compatible `from`. These origins are sender-advertised self-discovery candidates, not LAN scanning. Receivers cap the candidate list, try candidates in order, validate every candidate against the LAN/SSRF policy before each fetch, and return the origin that actually worked in preview responses.

There is no receiver background scan. The receiver only attempts origins included in the pasted sender payload and only during explicit preview/import actions.

The payload may later be represented as a `marinara-transfer:` URI, but raw JSON is easier to debug for MVP. A URI wrapper must still carry the same fields.

## Encryption And Authentication

MVP includes encryption because the feature is intended for public Marinara and should not train users to move plaintext over LAN.

### Encryption Model

- Sender builds a transfer package locally.
- Sender generates a random 256-bit `secret` using a cryptographically secure RNG.
- Sender generates a separate random `downloadToken` using a cryptographically secure RNG.
- Sender derives an encryption key from the secret using HKDF with a per-offer salt.
- Sender encrypts the package with authenticated encryption.
- Sender and receiver backends use Node crypto APIs for MVP. A later browser-side variant can use Web Crypto AES-GCM.
- The offer manifest and encrypted package include a format version and algorithm metadata.

### Secret Handling

- The `secret` is only present in the transfer payload shown to the user.
- The sender API does not expose the secret after offer creation.
- The secret must not be logged.
- The sender stores only ciphertext, non-secret offer metadata, and a hash of the `downloadToken`.
- The receiver sends only the `offerId` and `downloadToken` to the sender to retrieve the manifest or encrypted package. It does not send the decryption secret back to the sender.

### Why No Short Code As Key

A short human code is not enough entropy to use as an encryption key. If a short code is added later, it must either:

- Only identify the transfer while the QR/paste payload carries the real secret, or
- Use a PAKE design, which is out of scope for MVP.

## LAN-Only Boundary

The feature is LAN-only by policy and UX, but the implementation must not assume LAN equals safe.

Controls:

- The send endpoint refuses to create offers unless LAN transfer is enabled in settings or environment config.
- Offers are explicit user actions, never automatic.
- Offer URLs must use local addresses shown to the user.
- If the server is reached from a public IP or a non-private address, the receive UI warns and blocks by default.
- Receiver-side fetches must defend against SSRF:
  - Allow only `http:` and `https:` URLs.
  - Reject URLs with credentials, path traversal, query strings, or fragments in the `from` origin.
  - Resolve hostnames before fetch and allow only loopback or RFC1918 private addresses by default.
  - Block link-local metadata ranges such as `169.254.0.0/16`.
  - Revalidate the resolved address after redirects, or disable redirects for MVP.
  - Apply short timeouts and small response-size limits.
- Existing Basic Auth and admin-secret checks stay intact for normal app APIs and for creating/cancelling offers. Manifest and download endpoints are separately authorized by the high-entropy `downloadToken` and expose only the prepared temporary offer.
- When global Basic Auth is enabled, only the token-gated manifest and download endpoints are exempt from that global challenge. Normal app APIs and offer creation/cancellation remain protected.
- This feature must not set `ALLOW_UNAUTHENTICATED_PRIVATE_NETWORK` or bypass normal app auth globally.
- Offer endpoints do not list active offers.

## Server API

Add a new route module registered at `/api/lan-transfer`.

The sender and receiver roles use different endpoints. The receiver frontend talks to its own Marinara backend. That backend fetches the sender's offer, decrypts the package locally on the receiving instance, validates it, and imports it. This avoids browser cross-origin LAN fetch issues and keeps the MVP independent of in-app camera permissions.

### Sender Endpoints

### `POST /api/lan-transfer/offers`

Creates an encrypted offer.

Request body:

```ts
{
  items: Array<
    | { type: "chat"; id: string; format?: "jsonl" | "native" }
    | { type: "character"; id: string; format?: "native" }
  >;
}
```

Response:

```ts
{
  offerId: string;
  transferPayload: string;
  expiresAt: string;
  manifest: LanTransferManifest;
}
```

The sender origins are embedded in `transferPayload` as backward-compatible `from` plus optional bounded `origins`; they are not repeated as top-level response fields.

Native LAN chat offers are the default for chat sends. They include the selected chat plus referenced native character cards so the receiver can preview and import a self-contained transfer.

### `POST /api/lan-transfer/offers/:offerId/manifest`

Returns public non-secret manifest fields for preview. It requires the one-time offer token from the payload, but not the encryption secret.

Request body:

```ts
{
  downloadToken: string;
}
```

Response:

```ts
{
  offerId: string;
  expiresAt: string;
  consumed: boolean;
  manifest: LanTransferManifest;
}
```

### `POST /api/lan-transfer/offers/:offerId/download`

Downloads the encrypted package and marks the offer consumed. Requires the one-time offer token. The token is sent in the request body rather than a URL so it is less likely to appear in proxy, browser, or server access logs.

Request body:

```ts
{
  downloadToken: string;
}
```

Response body:

```ts
{
  version: 1;
  algorithm: "AES-256-GCM";
  salt: string;
  iv: string;
  aad: string;
  ciphertext: string;
  tag: string;
}
```

### `DELETE /api/lan-transfer/offers/:offerId`

Cancels a live offer from the sender UI. Requires the same local authorization as creating the offer.

### Receiver Endpoints

### `POST /api/lan-transfer/preview`

Receives the pasted transfer payload from the local frontend, validates its shape, verifies the sender address is allowed by LAN policy, and asks the sender for the manifest.

Request body:

```ts
{
  transferPayload: string;
}
```

Response:

```ts
{
  from: string;
  offerId: string;
  expiresAt: string;
  manifest: LanTransferManifest;
  analysis?: LanTransferPreviewAnalysis;
}
```

`analysis` is generated by the receiving backend from sanitized manifest metadata. It is advisory preview data, not an import authority. Missing or malformed sync IDs, fingerprints, character dependency lists, or message timelines must degrade conservatively to copy/conflict-copy/skip actions rather than trusting sender-provided claims.

### `POST /api/lan-transfer/import-from-offer`

Receives the pasted transfer payload after preview confirmation, fetches the encrypted package from the sender, decrypts it with the payload secret, validates it, and imports it.

Request body:

```ts
{
  transferPayload: string;
  options?: {
    importMode?: "smart" | "copy";
    chatImportMode?: "new-chat" | "branch";
    characterImportMode?: "new-copy";
  };
}
```

`options.importMode` defaults to `"smart"`. `"copy"` is used only when the user enables `Import as copies`. The older per-type options are kept for type compatibility, but smart import decisions are controlled by `importMode`.

Response:

```ts
{
  imported: {
    chats: number;
    characters: number;
  };
  reused?: {
    chats: number;
    characters: number;
  };
  appended?: {
    chats: number;
    messages: number;
  };
  copied?: {
    chats: number;
    characters: number;
  };
  skipped: Array<{ type: string; name?: string; reason: string }>;
  characterIdMap?: Record<string, string>;
  chatIdMap?: Record<string, string>;
}
```

Preview returns the working sender origin for display. Import returns the import summary only.

The implementation uses internal helpers for decrypted package validation and import. It must not expose a public route that accepts arbitrary decrypted transfer packages for MVP.

## Package Format

```ts
interface LanTransferPayload {
  type: "marinara-lan-transfer";
  version: 1;
  from: string;
  origins?: string[];
  offerId: string;
  downloadToken: string;
  secret: string;
}

interface LanTransferManifest {
  version: 1;
  createdAt: string;
  expiresAt: string;
  sourceApp: "Marinara Engine";
  sourceVersion: string;
  items: Array<
    | { type: "chat"; id: string; name: string; format: "jsonl"; messageCount: number; bytes: number }
    | {
        type: "chat";
        id: string;
        syncId?: string;
        name: string;
        format: "native";
        messageCount: number;
        characterCount: number;
        characterIds?: string[];
        messageFingerprint?: string;
        messageFingerprints?: string[];
        bytes: number;
      }
    | {
        type: "character";
        id: string;
        syncId?: string;
        name: string;
        format: "native";
        fingerprint?: string;
        bytes: number;
      }
  >;
  totalBytes: number;
}

interface LanTransferPackage {
  version: 1;
  manifest: LanTransferManifest;
  items: Array<
    | { type: "chat"; id: string; name: string; format: "jsonl"; content: string }
    | { type: "chat"; id: string; syncId?: string; name: string; format: "native"; chat: unknown }
    | {
        type: "character";
        id: string;
        syncId?: string;
        name: string;
        format: "native";
        fingerprint?: string;
        envelope: unknown;
      }
  >;
}

type LanTransferImportMode = "smart" | "copy";

type LanTransferPreviewAction =
  | {
      type: "character";
      sourceId: string;
      name: string;
      action: "reuse" | "import-copy";
      targetId?: string;
      reason: string;
    }
  | {
      type: "chat";
      sourceId: string;
      name: string;
      action: "skip" | "append" | "import-copy" | "conflict-copy";
      targetId?: string;
      messageCount: number;
      appendCount?: number;
      linkedCharacterNames?: string[];
      reason: string;
    };

interface LanTransferPreviewAnalysis {
  mode: "smart";
  actions: LanTransferPreviewAction[];
}
```

Native chat packages are the default for LAN send. They bundle referenced character cards and media dependencies so the receiving instance can import a self-contained chat. JSONL remains supported for legacy compatibility and explicit export paths.

Native sync metadata:

- Characters carry a stable LAN `syncId` plus a native card `fingerprint` when available. Smart import reuses an existing local card only when the native fingerprint or comparable envelope matches exactly.
- Native chats carry a stable LAN `syncId`, referenced `characterIds`, a whole-chat `messageFingerprint`, and ordered `messageFingerprints`.
- Chat settings such as agents, presets, model connections, and other local configuration do not participate in smart matching. The ordered message fingerprint timeline, after character ID remapping, determines whether a chat is already current, local-ahead, a strict append, or a conflict copy.
- Appending is strict. If any local or incoming message fingerprint differs before the append point, smart import creates a conflict copy rather than merging.

## Frontend UX

### Send Entry Points

- Chat file drawer: add `Send to Device` near JSONL/Text export for the active chat.
- Chat sidebar multi-select: add `Send to Device` next to batch export.
- Characters panel: add `Send to Device` for selected characters.
- Settings import/export panel: add generic `Receive from Device`.

### Receive Entry Point

- Settings -> Import area: `Receive from Device`.
- Optional later: a persistent import button in the sidebar or command palette.

### QR Handling

MVP does not request camera access.

Sender shows a QR code of the transfer payload. Receiver supports paste. Users can scan with Android's system camera or scanner app, copy the decoded payload/link, and paste into Marinara.

Later enhancement: optional `Scan QR` button using browser camera APIs, behind explicit user click and permission prompt.

The receive preview renders smart actions when present, including reuse, append, skip/up-to-date, import-copy, and conflict-copy. The `Import as copies` checkbox overrides displayed actions to copy mode and remains off by default.

## Storage And Expiration

Use an in-memory server store for MVP.

- Default TTL: 10 minutes.
- Max active offers: small bounded count, e.g. 10.
- Max package size: explicit cap, e.g. 25 MB for MVP.
- One-time download: consuming a package removes it.
- Cancel removes immediately.
- Server restart clears offers.

This is acceptable for MVP because the transfer is interactive and LAN-only.

## Import Safety

Treat decrypted packages as untrusted input.

Controls:

- Treat preview metadata as untrusted. The receiving backend sanitizes manifest fields before analysis, and the frontend normalizes preview responses before rendering.
- Validate package schema before import.
- Validate item counts and byte sizes.
- Reject unknown item types.
- Reject oversized package content.
- Reuse existing chat and character import functions where possible.
- Import package items in dependency order: characters first, then chats. When a chat references a transferred character, remap the old character ID to the newly imported character ID.
- Skip or fail closed on unmapped dependencies instead of producing broken chat-character links.
- Decrypt and authenticate the encrypted package before parsing, then validate the decrypted package before import.
- Do not execute embedded data.
- Do not overwrite existing chats/characters. Smart import may reuse exact cards, append strict chat extensions, skip up-to-date/local-ahead chats, or create conflict copies.
- Show a preview before import.

## Error Handling

Receiver errors:

- Cannot reach sender host.
- Transfer expired.
- Transfer already consumed.
- Invalid transfer payload.
- Decryption failed.
- Package schema invalid.
- Import partially failed.

Sender errors:

- Selected item no longer exists.
- Package exceeds size limit.
- LAN transfer disabled.
- Offer store full.

All errors should be actionable and short in the UI.

## Security Review Checklist

- No plaintext transfer package leaves the sender process.
- Offer endpoint does not list active offers.
- Offer IDs and tokens are high entropy.
- Secrets are not logged.
- Download is one-time and TTL-bound.
- Import is explicit and previewed.
- Existing auth/admin rules are not relaxed for normal app APIs or offer creation/cancellation.
- Manifest and download access is limited to the token-bound offer capability.
- The download token and encryption secret remain separate. The receiver sends only the token to the sender and never sends the secret back.
- Receiver URL validation blocks SSRF to public, metadata, and non-HTTP targets.
- Payload size and item count are bounded.
- Decryption/authentication failure aborts before parsing package content.
- Decrypted package content is schema-validated before import.
- Preview metadata is untrusted and sanitized before analysis or display.
- Unknown package versions fail closed.
- Public/non-private source addresses are blocked or require explicit override.
- Sender-advertised origins are bounded and user-payload-driven; the receiver performs no background LAN scanning.

## Testing Strategy

Unit tests:

- Package builder includes selected chat JSONL and native character envelope.
- Package builder rejects unsupported types and missing records.
- Offer store expires offers and consumes once.
- Transfer payload parser rejects malformed payloads.
- Encryption round-trip succeeds and tamper fails.
- Import validator rejects malformed/oversized packages.

Route tests:

- Create offer returns manifest and payload.
- Manifest fetch works with valid token and fails without it.
- Download consumes offer once.
- Expired offer cannot be fetched.
- Preview rejects public, metadata, malformed, and non-HTTP sender URLs.
- Preview includes sanitized smart analysis/actions for native chat dependencies where metadata permits.
- Import-from-offer defaults to smart mode.
- Import-from-offer accepts `options.importMode: "copy"` for explicit copy mode and rejects unknown modes.
- Smart import reuses exact character cards instead of duplicating them.
- Smart import appends strict native chat extensions and preserves local settings such as agents, presets, and connections.
- Smart import skips identical and local-ahead synced chats.
- Smart import creates conflict copies when message fingerprint timelines diverge.
- Native package export writes stable sync IDs, character fingerprints, and message fingerprint timelines.

Manual smoke:

- Linux sends one native chat to Android; preview lists bundled character cards and smart actions.
- Android sends one native chat to Linux; preview lists bundled character cards and smart actions.
- Repeat Linux -> Android and Android -> Linux with an exact card/chat already present; smart import reuses/skips without duplicates.
- Repeat with the receiver missing only newer incoming messages; smart import appends the missing messages.
- Repeat with the receiver chat containing divergent message history; smart import creates a conflict copy.
- Repeat with `Import as copies` enabled; import creates copies even when smart reuse/append would otherwise apply.
- Linux sends one character to Android.
- Android sends one character to Linux.
- Expired transfer is blocked.
- Already consumed transfer is blocked.
- Wrong secret fails decrypt/import.
- Confirm no receiver action occurs until the user previews/imports a pasted sender payload.

## MVP Acceptance Criteria

- User can transfer selected chats both Linux -> Android and Android -> Linux on the same LAN.
- User can transfer selected characters both directions.
- No cloud service is involved.
- No camera permission is required.
- Receiver previews contents before import.
- Receiver preview shows smart import actions where metadata permits.
- Smart import is the default; explicit copy mode is available through `Import as copies`.
- Transfers expire and are one-time use.
- Transfer package is encrypted before it leaves the sender instance.
- Existing export/import functionality continues to work unchanged.
