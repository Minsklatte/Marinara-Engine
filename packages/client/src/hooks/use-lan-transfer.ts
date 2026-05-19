// ──────────────────────────────────────────────
// React Query: LAN transfer hooks
// ──────────────────────────────────────────────
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
import { characterKeys } from "./use-characters";
import { chatKeys } from "./use-chats";

export function useCreateLanTransferOffer() {
  return useMutation({
    mutationFn: (data: LanTransferCreateOfferRequest) =>
      api.post<LanTransferCreateOfferResponse>("/lan-transfer/offers", data),
  });
}

export function useCancelLanTransferOffer() {
  return useMutation({
    mutationFn: (offerId: string) => api.delete<{ success: boolean }>(`/lan-transfer/offers/${offerId}`),
  });
}

export function usePreviewLanTransfer() {
  return useMutation({
    mutationFn: (data: LanTransferPreviewRequest) => api.post<LanTransferPreviewResponse>("/lan-transfer/preview", data),
  });
}

export function useImportLanTransferFromOffer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: LanTransferImportFromOfferRequest) =>
      api.post<LanTransferImportSummary>("/lan-transfer/import-from-offer", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: chatKeys.list() });
      qc.invalidateQueries({ queryKey: characterKeys.list() });
    },
  });
}
