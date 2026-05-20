import { networkInterfaces } from "node:os";

export interface ResolveLanTransferOriginsInput {
  protocol: "http" | "https";
  requestHost: string;
  configuredOrigin?: string | null;
  interfaceAddresses?: string[];
  port: number;
}

export function getPrivateIpv4InterfaceAddresses(): string[] {
  const result: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (isPrivateIpv4(entry.address)) result.push(entry.address);
    }
  }
  return Array.from(new Set(result));
}

export function resolveLanTransferOrigins(input: ResolveLanTransferOriginsInput): string[] {
  const candidates: string[] = [];
  if (input.configuredOrigin) candidates.push(input.configuredOrigin);
  for (const address of input.interfaceAddresses ?? getPrivateIpv4InterfaceAddresses()) {
    candidates.push(`${input.protocol}://${address}:${input.port}`);
  }
  const requestOrigin = normalizeOrigin(`${input.protocol}://${input.requestHost}`);
  if (requestOrigin) candidates.push(requestOrigin);

  const origins = Array.from(new Set(candidates.map(normalizeOrigin).filter((origin): origin is string => !!origin)));
  if (!requestOrigin) return origins.slice(0, 5);

  const requestOriginIndex = origins.indexOf(requestOrigin);
  if (origins.length <= 5 || requestOriginIndex === -1 || requestOriginIndex < 5) {
    return origins.slice(0, 5);
  }

  return [...origins.slice(0, 4), requestOrigin];
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.pathname = "";
    url.search = "";
    url.hash = "";
    url.username = "";
    url.password = "";
    return url.origin;
  } catch {
    return null;
  }
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127;
}
