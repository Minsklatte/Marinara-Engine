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
