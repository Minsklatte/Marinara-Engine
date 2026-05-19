import { promises as dns } from "node:dns";
import { isIP } from "node:net";

type ResolveHost = (host: string) => Promise<string[]>;

export interface LanTransferOriginValidationOptions {
  resolveHost?: ResolveHost;
}

export type LanTransferOriginValidationResult =
  | { ok: true; url: URL; addresses: string[] }
  | { ok: false; error: string };

export function isAllowedLanTransferAddress(address: string): boolean {
  const ipVersion = isIP(address);

  if (ipVersion === 4) {
    return isAllowedIpv4Address(address);
  }

  if (ipVersion === 6) {
    return isAllowedIpv6Address(address);
  }

  return false;
}

export async function validateLanTransferOrigin(
  origin: string,
  options: LanTransferOriginValidationOptions = {},
): Promise<LanTransferOriginValidationResult> {
  let url: URL;

  try {
    url = new URL(origin);
  } catch {
    return { ok: false, error: "Invalid LAN transfer origin URL" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "LAN transfer origin must use http or https" };
  }

  if (url.username !== "" || url.password !== "") {
    return { ok: false, error: "LAN transfer origin must not include credentials" };
  }

  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || origin !== url.origin) {
    return { ok: false, error: "LAN transfer origin must not include path, search, or hash" };
  }

  const resolveHost = options.resolveHost ?? defaultResolveHost;
  let addresses: string[];

  try {
    addresses = await resolveHost(getResolvableHostname(url));
  } catch {
    return { ok: false, error: "Unable to resolve LAN transfer origin host" };
  }

  if (addresses.length === 0) {
    return { ok: false, error: "LAN transfer origin host resolved no addresses" };
  }

  if (!addresses.every(isAllowedLanTransferAddress)) {
    return { ok: false, error: "LAN transfer origin host resolves outside allowed LAN ranges" };
  }

  return { ok: true, url, addresses };
}

function isAllowedIpv4Address(address: string): boolean {
  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  const first = octets[0];
  const second = octets[1];

  if (first === undefined || second === undefined) {
    return false;
  }

  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isAllowedIpv6Address(address: string): boolean {
  const normalized = address.toLowerCase();

  return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd");
}

async function defaultResolveHost(host: string): Promise<string[]> {
  const results = await dns.lookup(host, { all: true });
  return results.map((result) => result.address);
}

function getResolvableHostname(url: URL): string {
  const { hostname } = url;

  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }

  return hostname;
}
