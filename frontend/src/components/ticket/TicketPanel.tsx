"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { createContext, Suspense, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useConfirm } from "@/components/Confirm";
import type { UUID } from "@/lib/types";
import { TicketEditorDialog } from "./editor/TicketEditorDialog";
import { DISCARD_CONFIRM } from "./editor/useUnsavedGuard";

/**
 * A OS aberta no painel lateral, como no Field Control, fica na URL (ex.: /chamados?os=<id>):
 * - um painel só por tela, fora das listas: ele não fecha nem troca de OS quando a lista atrás muda
 *   (a OS que muda de seção na Minha fila, de coluna no Quadro, o técnico que sai de campo no Mapa);
 * - Voltar (inclusive o gesto do celular) fecha o painel e fica na lista;
 * - recarregar a página ou mandar o link mantém a OS aberta;
 * - um link de dentro do painel (cliente, loja, projeto) leva para a tela sem o painel;
 * - com alteração não salva na aba Geral, fechar o painel ou trocar de OS (busca Ctrl+K, aviso,
 *   "Outras OS desta loja") pergunta antes de descartar. O Voltar do navegador não dá para segurar:
 *   o popstate não pode ser cancelado.
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

// Fechando pelo Voltar: até o popstate chegar, a URL ainda tem ?os. Um segundo Esc ou clique nesse
// meio-tempo não pode voltar mais uma entrada (sairia da tela).
let closing = false;
if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    closing = false;
  });
}

// O painel aberto com alteração não salva registra aqui a pergunta "Descartar as alterações?".
let leaveCheck: (() => Promise<boolean>) | null = null;

/** Segue em frente direto, ou depois que a pessoa confirmar o descarte das alterações do painel. */
function afterLeaveCheck(go: () => void) {
  if (!leaveCheck) return go();
  void leaveCheck().then((ok) => {
    if (ok) go();
  });
}

function openNow(ticketId: UUID) {
  closing = false;
  const current = currentId();
  if (current === ticketId) return;
  if (current) {
    // Trocando de OS dentro do painel (ex.: "Outras OS desta loja"): a entrada é substituída, e o
    // Fechar volta direto para a lista em vez de reabrir a OS anterior. Aberto por link direto, o
    // painel continua sem entrada própria (o Fechar só tira o ?os).
    const ours = (window.history.state as { mfPanel?: string } | null)?.mfPanel === current;
    window.history.replaceState(ours ? { mfPanel: ticketId } : null, "", hrefWith(ticketId));
    return;
  }
  window.history.pushState({ mfPanel: ticketId }, "", hrefWith(ticketId));
}

function closeNow() {
  const id = currentId();
  if (!id || closing) return;
  // Aberto daqui: volta a entrada do histórico (o Avançar reabre). Aberto por link direto ou depois
  // de recarregar: só tira o ?os da URL.
  if ((window.history.state as { mfPanel?: string } | null)?.mfPanel === id) {
    closing = true;
    window.history.back();
  } else {
    window.history.replaceState(null, "", hrefWith(null));
  }
}

// O Next acompanha o pushState/replaceState nativo (useSearchParams recebe a URL nova sem ir ao
// servidor), desde que o estado passado não traga as chaves internas dele (__NA): por isso só o nosso.
const panel: TicketPanel = {
  open(ticketId) {
    const current = currentId();
    if (current === ticketId) return;
    // Trocar de OS descarta o que o painel tem por salvar: pergunta antes.
    if (current) afterLeaveCheck(() => openNow(ticketId));
    else openNow(ticketId);
  },
  close() {
    if (!currentId() || closing) return;
    afterLeaveCheck(closeNow);
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
  const confirm = useConfirm();
  const shown = useRef<string | null>(null);
  // OS do painel com alteração não salva. Trocou de OS (ou fechou): começa limpo.
  const [dirtyId, setDirtyId] = useState<string | null>(null);
  const [seenId, setSeenId] = useState(ticketId);
  // Trocando de uma OS para outra o painel já está aberto: ele não desliza de novo.
  const [entering, setEntering] = useState(true);
  if (seenId !== ticketId) {
    setSeenId(ticketId);
    setDirtyId(null);
    setEntering(seenId === null);
  }
  const dirty = ticketId !== null && dirtyId === ticketId;
  const onDirtyChange = useCallback((value: boolean) => setDirtyId(value ? ticketId : null), [ticketId]);

  useEffect(() => {
    if (!dirty) return;
    const check = () => confirm(DISCARD_CONFIRM);
    leaveCheck = check;
    return () => {
      if (leaveCheck === check) leaveCheck = null;
    };
  }, [dirty, confirm]);

  useEffect(() => {
    // Fechou (ou trocou de OS): a tela de trás busca de novo o que pode ter mudado no painel, como
    // custos aprovados, orçamentos enviados, a fila e os indicadores. Só refaz o que está na tela.
    if (shown.current && shown.current !== ticketId) {
      void queryClient.invalidateQueries({ predicate: (q) => LIST_KEYS.has(String(q.queryKey[0])) });
    }
    shown.current = ticketId;
  }, [ticketId, queryClient]);

  return ticketId ? (
    <TicketEditorDialog key={ticketId} ticketId={ticketId} onClose={panel.close} onDirtyChange={onDirtyChange} entering={entering} />
  ) : null;
}
