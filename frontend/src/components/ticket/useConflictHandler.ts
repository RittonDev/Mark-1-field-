"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useToast } from "@/components/Toaster";
import { ApiError, errorMessage } from "@/lib/api";
import type { ConflictItem, UUID } from "@/lib/types";

/** "Fulano já tem OS neste horário" com os nomes que a API devolveu em cada OS em choque. */
export function busyTitle(items: ConflictItem[], fallback: string): string {
  const names = [...new Set(items.map((c) => c.who).filter((who): who is string => Boolean(who)))];
  if (names.length > 1) return `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]} já têm OS neste horário`;
  return `${names[0] ?? fallback} já tem OS neste horário`;
}

/**
 * O 409 de versão: a OS mudou desde que a tela a leu (a API devolve a versão atual). Não é o 409 de
 * agenda (técnico ocupado) nem o de registro duplicado, que têm o próprio motivo.
 */
export function isVersionConflict(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 409) return false;
  const body = error.body;
  return typeof body === "object" && body !== null && "current_version" in body;
}

/** Trata erros de mutações na OS: 409 recarrega a OS; demais viram toast com o motivo. */
export function useTicketErrorHandler(ticketId: UUID) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useCallback(
    (error: unknown) => {
      if (error instanceof ApiError && error.status === 409) {
        queryClient.invalidateQueries({ queryKey: ["ticket", ticketId] });
        if (isVersionConflict(error)) {
          queryClient.invalidateQueries({ queryKey: ["tickets"] });
          toast({
            title: "A OS foi alterada por outra pessoa",
            description: "Recarregamos os dados. Confira e tente de novo.",
            tone: "error",
          });
          return;
        }
      }
      toast({ title: "Não foi possível concluir", description: errorMessage(error), tone: "error" });
    },
    [queryClient, toast, ticketId],
  );
}

/** Partes da OS que têm consulta própria (["ticket", id, parte]). */
type TicketPart = "comments" | "worklogs" | "attachments" | "events" | "quotes";

/**
 * Recarrega a OS depois de uma mudança. Padrão: a OS inteira e as listas e indicadores da tela de
 * trás. Com `lists: false` (acompanhamento, apontamento), só a OS, o histórico e as `parts` que
 * mudaram: as listas atrás do painel já se atualizam pelo tempo real e quando o painel fecha.
 */
export function useInvalidateTicket(ticketId: UUID, options?: { lists?: boolean; parts?: TicketPart[] }) {
  const queryClient = useQueryClient();
  const lists = options?.lists ?? true;
  const parts = (options?.parts ?? []).join(",");
  return useCallback(() => {
    if (lists) {
      queryClient.invalidateQueries({ queryKey: ["ticket", ticketId] });
      queryClient.invalidateQueries({ queryKey: ["tickets"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["assignable"] });
      return;
    }
    queryClient.invalidateQueries({ queryKey: ["ticket", ticketId], exact: true });
    queryClient.invalidateQueries({ queryKey: ["ticket", ticketId, "events"] });
    for (const part of parts ? parts.split(",") : []) {
      queryClient.invalidateQueries({ queryKey: ["ticket", ticketId, part] });
    }
  }, [queryClient, ticketId, lists, parts]);
}
