import { createHash } from "node:crypto";

const LAN_TRANSFER_EXTENSION_KEY = "marinara_lan_transfer";

export interface LanTransferCharacterSyncMetadata {
  syncId: string;
  fingerprint: string;
}

export interface LanTransferMessageFingerprintInput {
  role: string;
  characterId: string | null;
  content: string;
  createdAt?: string | null;
}

export function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? "undefined";
}

export function fingerprintNativeCharacterEnvelope(envelope: unknown): string {
  return sha256Base64Url(stableStringify(stripVolatileCharacterEnvelopeFields(envelope)));
}

export function fingerprintLanTransferMessage(message: LanTransferMessageFingerprintInput): string {
  return sha256Base64Url(
    stableStringify({
      role: message.role,
      characterId: message.characterId ?? null,
      content: message.content,
      createdAt: message.createdAt ?? null,
    }),
  );
}

export function fingerprintLanTransferMessageSequence(messages: LanTransferMessageFingerprintInput[]): string {
  return sha256Base64Url(stableStringify(messages.map(fingerprintLanTransferMessage)));
}

export function compareFingerprintSequences(
  local: string[],
  incoming: string[],
):
  | { kind: "same" }
  | { kind: "incoming_extends_local"; appendFrom: number }
  | { kind: "local_ahead" }
  | { kind: "diverged" } {
  const min = Math.min(local.length, incoming.length);
  for (let i = 0; i < min; i += 1) {
    if (local[i] !== incoming[i]) return { kind: "diverged" };
  }
  if (local.length === incoming.length) return { kind: "same" };
  if (local.length < incoming.length) return { kind: "incoming_extends_local", appendFrom: local.length };
  return { kind: "local_ahead" };
}

export function readLanTransferSyncId(value: unknown): string | null {
  const metadata = readLanTransferMetadata(value);
  const syncId = metadata?.syncId;
  return typeof syncId === "string" && syncId.trim().length > 0 ? syncId : null;
}

export function withLanTransferCharacterSyncMetadata<T>(
  envelope: T,
  metadata: LanTransferCharacterSyncMetadata,
): T {
  if (!isRecord(envelope)) return envelope;
  const outerData = envelope.data;
  if (!isRecord(outerData)) return envelope;
  const cardData = outerData.data;
  if (!isRecord(cardData)) return envelope;
  const extensions = isRecord(cardData.extensions) ? { ...cardData.extensions } : {};
  extensions.marinara_lan_transfer = metadata;
  return {
    ...envelope,
    data: {
      ...outerData,
      data: {
        ...cardData,
        extensions,
      },
    },
  } as T;
}

function stripVolatileCharacterEnvelopeFields(value: unknown): unknown {
  const cloned = canonicalize(value);
  if (!isRecord(cloned)) return cloned;
  delete cloned.exportedAt;
  if (isRecord(cloned.data) && isRecord(cloned.data.data)) {
    const cardData = cloned.data.data;
    if (isRecord(cardData.extensions)) {
      delete cardData.extensions[LAN_TRANSFER_EXTENSION_KEY];
      if (Object.keys(cardData.extensions).length === 0) {
        delete cardData.extensions;
      }
    }
  }
  return cloned;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (entry !== undefined) out[key] = canonicalize(entry);
  }
  return out;
}

function readLanTransferMetadata(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;

  const outerData = value.data;
  if (!isRecord(outerData)) return null;
  const cardData = outerData.data;
  if (!isRecord(cardData)) return null;
  const extensions = cardData.extensions;
  if (!isRecord(extensions)) return null;
  const metadata = extensions[LAN_TRANSFER_EXTENSION_KEY];
  return isRecord(metadata) ? metadata : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
