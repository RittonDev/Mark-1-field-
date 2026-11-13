"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { createContext, Suspense, useContext, useEffect, useRef } from "react";
import type { UUID } from "@/lib/types";
import { TicketEditorDialog } from "./editor/TicketEditorDialog";

/**
 * A OS aberta no painel lateral, como no Field Control, fica na URL (ex.: /chamados?os=<id>):
 * - um painel só por tela, fora das listas: ele não fecha nem troca de OS quando a lista atrás muda
 *   (a OS que muda de seção na Minha fila, de coluna no Quadro, o técnico que sai de campo no Mapa);
 * - Voltar (inclusive o gesto do celular) fecha o painel e fica na lista;
 * - recarregar a página ou mandar o link mantém a OS aberta;
 * - um link de dentro do painel (cliente, loja, projeto) leva para a tela sem o painel.
 */
const PARAM = "os";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O que a tela de trás pode estar mostrando e muda com o que se edita no painel. */
const LIST_KEYS = new Set([
  "tickets",
  "expenses",
  "quotes",
  "project",
  "projects",
  "customer",
  "location",
  "payouts",
  "solicitacoes",
  "dashboard",
  "tracking",
  "repairs",
  "reports",
  "technicians",
]);

export type TicketPanel = { open: (ticketId: UUID) => void; close: () => void };

const TicketPanelContext = createContext<TicketPanel | null>(null);

function currentId() {
  return new URLSearchParams(window.location.search).get(PARAM);
}

function hrefWith(ticketId: UUID | null) {
  const url = new URL(window.location.href);
  if (ticketId) url.searchParams.set(PARAM, ticketId);
  else url.searchParams.delete(PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

// O Next acompanha o pushState/replaceState nativo (useSearchParams recebe a URL nova sem ir ao
// servidor), desde que o estado passado não traga as chaves internas dele (__NA): por isso só o nosso.
const panel: TicketPanel = {
  open(ticketId) {
    if (currentId() === ticketId) return;
    window.history.pushState({ mfPanel: ticketId }, "", hrefWith(ticketId));
  },
  close() {
    const id = currentId();
    if (!id) return;
    // Aberto daqui: volta a entrada do histórico (o Avançar reabre). Aberto por link direto ou depois
    // de recarregar: só tira o ?os da URL.
    if ((window.history.state as { mfPanel?: string } | null)?.mfPanel === id) window.history.back();
    else window.history.replaceState(null, "", hrefWith(null));
  },
};

/** Abre e fecha a OS no painel lateral. Fora da área da central (sem o provedor) devolve null. */
export function useTicketPanel() {
  return useContext(TicketPanelContext);
}

export function TicketPanelProvider({ children }: { children: React.ReactNode }) {
  return (
    <TicketPanelContext.Provider value={panel}>
      {children}
      {/* useSearchParams pede um Suspense em volta (senão a tela inteira esperaria a URL). */}
      <Suspense fallback={null}>
        <PanelFromUrl />
      </Suspense>
    </TicketPanelContext.Provider>
  );
}

function PanelFromUrl() {
  const param = useSearchParams().get(PARAM);
  const ticketId = param && UUID_RE.test(param) ? param : null;
  const queryClient = useQueryClient();
  const shown = useRef<string | null>(null);

  useEffect(() => {
    // Fechou (ou trocou de OS): a tela de trás busca de novo o que pode ter mudado no painel, como
    // custos aprovados, orçamentos enviados, a fila e os indicadores. Só refaz o que está na tela.
    if (shown.current && shown.current !== ticketId) {
      void queryClient.invalidateQueries({ predicate: (q) => LIST_KEYS.has(String(q.queryKey[0])) });
    }
    shown.current = ticketId;
  }, [ticketId, queryClient]);

  return ticketId ? <TicketEditorDialog key={ticketId} ticketId={ticketId} onClose={panel.close} /> : null;
}
