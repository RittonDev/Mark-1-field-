"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useToast } from "@/components/Toaster";
import { ApiError, errorMessage } from "@/lib/api";
import type { UUID } from "@/lib/types";

/** Trata erros de mutações na OS: 409 recarrega a OS; demais viram toast. */
export function useTicketErrorHandler(ticketId: UUID) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useCallback(
    (error: unknown) => {
      if (error instanceof ApiError && error.status === 409) {
        queryClient.invalidateQueries({ queryKey: ["ticket", ticketId] });
        queryClient.invalidateQueries({ queryKey: ["tickets"] });
        toast({
          title: "A OS foi alterada por outra pessoa",
          description: "Recarregamos os dados. Confira e tente de novo.",
          tone: "error",
        });
        return;
      }
      toast({ title: "Não foi possível concluir", description: errorMessage(error), tone: "error" });
    },
    [queryClient, toast, ticketId],
  );
}

export function useInvalidateTicket(ticketId: UUID) {
  const queryClient = useQueryClient();
  return useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["ticket", ticketId] });
    queryClient.invalidateQueries({ queryKey: ["tickets"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    queryClient.invalidateQueries({ queryKey: ["assignable"] });
  }, [queryClient, ticketId]);
}
