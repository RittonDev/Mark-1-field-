"use client";

import { useQuery } from "@tanstack/react-query";
import { SquarePen, X } from "lucide-react";
import { useEffect, useEffectEvent, useRef } from "react";
import { createPortal } from "react-dom";
import { Button, ErrorBox, isTopLayer, lockScroll, restoreFocus, Spinner, trapTab } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import type { TicketDetail, UUID } from "@/lib/types";
import { TicketEditor } from "./TicketEditor";

/**
 * A OS aberta num painel à direita, como o "Editar atividade" do Field Control: a lista continua à
 * vista (escurecida) e o painel ocupa a altura toda. No celular, a tela inteira. Quem abre é o
 * TicketPanelProvider (um painel por tela, pela URL ?os=).
 */
export function TicketEditorDialog({ ticketId, onClose }: { ticketId: UUID; onClose: () => void }) {
  const ticket = useQuery({ queryKey: ["ticket", ticketId], queryFn: () => api.get<TicketDetail>(`/tickets/${ticketId}`) });
  const panel = useRef<HTMLDivElement>(null);
  // O efeito não depende de onClose: se dependesse, rodaria de novo a cada render de quem abriu e
  // tiraria o foco do campo que está sendo editado.
  const close = useEffectEvent(() => onClose());

  useEffect(() => {
    // Quem abriu (o link ou o botão da lista): o foco volta para ele quando o painel fecha.
    const opener = document.activeElement;
    const unlock = lockScroll();
    // Foco no painel: teclado e leitor de tela começam pela OS, não pela lista atrás.
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      const node = panel.current;
      // Já tratado (busca Ctrl+K, legenda de anexo, foto ampliada) ou com outra camada por cima
      // (horários, transição, menu do relatório): o Esc e o Tab são dela.
      if (e.defaultPrevented || !node) return;
      if (e.key === "Escape" && isTopLayer(node)) close();
      else if (e.key === "Tab" && isTopLayer(node, false)) trapTab(e, node);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      unlock();
      restoreFocus(opener);
    };
  }, []);

  return createPortal(
    // O painel é um portal no <body>, mas o clique ainda "sobe" pela árvore do React até quem o
    // renderiza. Ele para aqui.
    <div className="fixed inset-0 z-40 flex justify-end" onClick={(e) => e.stopPropagation()}>
      <div
        className="absolute inset-0 animate-fade bg-[rgb(9_11_15/0.38)] backdrop-blur-[2px]"
        // Num duplo clique na lista, o 2º clique (detail 2) cairia aqui e fecharia o painel recém-aberto.
        onClick={(e) => {
          if (e.detail <= 1) onClose();
        }}
        aria-hidden
      />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={ticket.data ? `${ticket.data.code}: ${ticket.data.title}` : "Abrindo a OS"}
        data-drawer
        className="relative flex h-full w-full animate-drawer flex-col bg-surface shadow-pop outline-none sm:w-[min(100vw,56rem)] sm:border-l sm:border-line"
      >
        {ticket.data ? (
          <TicketEditor ticket={ticket.data} variant="dialog" onClose={onClose} />
        ) : (
          <>
            {/* Enquanto carrega (ou se der erro) também há como fechar: no celular o painel cobre tudo. */}
            <div className="flex items-center gap-3 bg-brand px-5 py-3 text-white dark:bg-brand-strong">
              <SquarePen className="size-4 shrink-0" />
              <p className="min-w-0 flex-1 truncate text-[15px] font-semibold">
                {ticket.error ? "Não foi possível abrir a OS" : "Abrindo a OS..."}
              </p>
              <button type="button" onClick={onClose} className="rounded-md p-1 text-white hover:bg-white/15" aria-label="Fechar">
                <X className="size-5" />
              </button>
            </div>
            <div className="flex flex-1 items-center justify-center">
              {ticket.error ? (
                <div className="flex w-full max-w-md flex-col gap-3 p-6">
                  <ErrorBox message={errorMessage(ticket.error)} />
                  <div className="flex justify-end gap-2">
                    <Button onClick={onClose}>Fechar</Button>
                    <Button variant="primary" loading={ticket.isFetching} onClick={() => void ticket.refetch()}>
                      Tentar de novo
                    </Button>
                  </div>
                </div>
              ) : (
                <Spinner className="size-6" />
              )}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
