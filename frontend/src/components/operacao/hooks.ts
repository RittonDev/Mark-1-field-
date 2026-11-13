"use client";

// Peças comuns das telas de operação (Minha fila, Solicitações, Calendário, Atividades do dia e Quadro).

import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useToast } from "@/components/Toaster";
import { api, errorMessage } from "@/lib/api";
import { STATUS } from "@/lib/constants";
import type { TicketDetail, TicketStatus, User, UUID } from "@/lib/types";

/** Fuso da operação (o mesmo de settings.TIMEZONE na API). */
export const OPERATION_TZ = "America/Sao_Paulo";

/** OS em aberto: nem resolvida, nem fechada, nem cancelada (espelha OPEN_STATUSES da API). */
export const isOpenStatus = (status: TicketStatus) => {
  const group = STATUS[status]?.group;
  return group === "open" || group === "active" || group === "pending";
};

/**
 * A OS completa, lida agora (versão, formulários, transições permitidas). Fica no mesmo cache do
 * painel da OS; `staleTime` aproveita uma leitura de segundos atrás (ex.: a do início do arraste).
 */
export function fetchTicket(queryClient: QueryClient, id: UUID, staleTime = 0) {
  return queryClient.fetchQuery({
    queryKey: ["ticket", id],
    queryFn: () => api.get<TicketDetail>(`/tickets/${id}`),
    staleTime,
  });
}

/** Rola até um bloco da tela (sem animar com "reduzir movimento" ligado) e leva o foco para ele. */
export function revealSection(el: HTMLElement) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  el.focus({ preventScroll: true });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string | null | undefined): value is string => !!value && UUID_RE.test(value);

/** Texto sem acento e em minúsculas: "sao paulo" acha "São Paulo". */
export function fold(text: string | null | undefined): string {
  return (text ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: OPERATION_TZ });

/** Dia ("2026-11-13") de um horário no fuso da operação. */
export function operationDay(value: string | number | Date): string {
  return dayFmt.format(new Date(value));
}

/**
 * Troca parâmetros da URL sem criar entrada no histórico (o Voltar continua saindo da tela) e sem ir ao
 * servidor: recarregar ou mandar o link mantém a visão. Preserva o ?os= do painel lateral.
 */
export function replaceSearch(values: Record<string, string | null | undefined>) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(values)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (next === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
  // Com o painel da OS aberto, o estado do histórico é o dele (e o Voltar fecha o painel).
  const state = window.history.state as { mfPanel?: string } | null;
  window.history.replaceState(state?.mfPanel ? state : null, "", next);
}

/** Técnicos ativos (filtros e cores). Os desativados não entram no app nem recebem OS novas. */
export function useActiveTechnicians() {
  return useQuery({
    queryKey: ["users", { role: "technician", active: true }],
    queryFn: () => api.get<User[]>("/users", { role: "technician", active: true }),
    staleTime: 60_000,
  });
}

/**
 * Puxar a OS para a minha fila: vira o analista responsável (o técnico continua o mesmo). Cada linha
 * mostra o próprio carregamento, mesmo com várias puxadas ao mesmo tempo.
 */
export function useClaim() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [pending, setPending] = useState<ReadonlySet<UUID>>(() => new Set());
  const mutation = useMutation({
    mutationFn: (ticket: { id: UUID; code: string }) => api.post<TicketDetail>(`/tickets/${ticket.id}/claim`),
    onMutate: (ticket) => setPending((ids) => new Set(ids).add(ticket.id)),
    onSettled: (_data, _error, ticket) =>
      setPending((ids) => {
        const next = new Set(ids);
        next.delete(ticket.id);
        return next;
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(["ticket", updated.id], updated);
      void queryClient.invalidateQueries({ queryKey: ["tickets"] });
      void queryClient.invalidateQueries({ queryKey: ["solicitacoes"] });
      toast({ title: `${updated.code} está na sua fila`, tone: "success" });
    },
    onError: (error, ticket) => {
      void queryClient.invalidateQueries({ queryKey: ["tickets"] });
      toast({ title: `Não foi possível puxar a ${ticket.code}`, description: errorMessage(error), tone: "error" });
    },
  });
  return {
    claim: (ticket: { id: UUID; code: string }) => {
      if (!pending.has(ticket.id)) mutation.mutate(ticket);
    },
    isClaiming: (id: UUID) => pending.has(id),
  };
}
