import {
  LAN_TRANSFER_TYPE,
  LAN_TRANSFER_VERSION,
  type LanTransferPayload,
} from "@marinara-engine/shared";

export function serializeLanTransferPayload(payload: LanTransferPayload): string {
  return JSON.stringify(payload);
}

export function parseLanTransferPayload(raw: string): LanTransferPayload | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  const { type, version, from, offerId, downloadToken, secret } = parsed;

  if (
    type !== LAN_TRANSFER_TYPE ||
    version !== LAN_TRANSFER_VERSION ||
    !isNonEmptyString(from) ||
    !isNonEmptyString(offerId) ||
    !isNonEmptyString(downloadToken) ||
    !isNonEmptyString(secret) ||
    !isOriginOnlyHttpUrl(from)
  ) {
    return null;
  }

  return { type, version, from, offerId, downloadToken, secret };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOriginOnlyHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);

    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      value === url.origin
    );
  } catch {
    return false;
  }
}
