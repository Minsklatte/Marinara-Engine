export const LAN_TRANSFER_TYPE = "marinara-lan-transfer" as const;
export const LAN_TRANSFER_VERSION = 1 as const;

export type LanTransferChatFormat = "jsonl" | "native";

export type LanTransferImportMode = "smart" | "copy";

export type LanTransferPreviewAction =
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

export interface LanTransferPreviewAnalysis {
  mode: "smart";
  actions: LanTransferPreviewAction[];
}

export type LanTransferItemRequest =
  | { type: "chat"; id: string; format?: LanTransferChatFormat }
  | { type: "character"; id: string; format?: "native" };

export interface LanTransferPayload {
  type: typeof LAN_TRANSFER_TYPE;
  version: typeof LAN_TRANSFER_VERSION;
  from: string;
  origins?: string[];
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
    | {
        type: "chat";
        id: string;
        syncId: string;
        name: string;
        format: "native";
        messageCount: number;
        characterCount: number;
        characterIds: string[];
        messageFingerprint: string;
        messageFingerprints: string[];
        bytes: number;
      }
    | {
        type: "character";
        id: string;
        syncId: string;
        name: string;
        format: "native";
        fingerprint: string;
        bytes: number;
      }
  >;
  totalBytes: number;
}

export interface LanTransferPackage {
  version: typeof LAN_TRANSFER_VERSION;
  manifest: LanTransferManifest;
  items: Array<
    | { type: "chat"; id: string; name: string; format: "jsonl"; content: string }
    | { type: "chat"; id: string; syncId: string; name: string; format: "native"; chat: unknown }
    | {
        type: "character";
        id: string;
        syncId: string;
        name: string;
        format: "native";
        fingerprint: string;
        envelope: unknown;
      }
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
  analysis?: LanTransferPreviewAnalysis;
}

export interface LanTransferImportFromOfferRequest {
  transferPayload: string;
  options?: {
    importMode?: LanTransferImportMode;
    chatImportMode?: "new-chat" | "branch";
    characterImportMode?: "new-copy";
  };
}

export interface LanTransferImportSummary {
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
