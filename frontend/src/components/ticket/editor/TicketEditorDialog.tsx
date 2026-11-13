"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef } from "react";
import { createPortal } from "react-dom";
import { ErrorBox, lockScroll, Spinner } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import type { TicketDetail, UUID } from "@/lib/types";
import { TicketEditor } from "./TicketEditor";

/**
 * A OS aberta num painel à direita, como o "Editar atividade" do Field Control: a lista continua à
 * vista (escurecida) e o painel ocupa a altura toda. No celular, a tela inteira.
 */
export function TicketEditorDialog({ ticketId, onClose }: { ticketId: UUID; onClose: () => void }) {
  const ticket = useQuery({ queryKey: ["ticket", ticketId], queryFn: () => api.get<TicketDetail>(`/tickets/${ticketId}`) });
  const panel = useRef<HTMLDivElement>(null);
  // Quem abre o painel passa um onClose novo a cada render (ex.: () => setOpen(false)). O efeito não
  // depende dele: senão rodaria de novo a cada atualização da lista atrás e tiraria o foco do campo
  // que está sendo editado.
  const close = useEffectEvent(() => onClose());

  useEffect(() => {
    const unlock = lockScroll();
    // Foco no painel (teclado e leitor de tela começam pela OS, não pela lista atrás).
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      // Esc fecha, menos quando outro diálogo (horários, transição, valor) está aberto por cima.
      if (e.key === "Escape" && document.querySelectorAll('[role="dialog"]:not([data-drawer]), [role="menu"]').length === 0) close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      unlock();
    };
  }, []);

  return createPortal(
    // O painel é um portal no <body>, mas o clique ainda "sobe" pela árvore do React até quem o abriu
    // (ex.: a linha de Chamados, que abriria a OS em página inteira). Ele para aqui.
    <div className="fixed inset-0 z-40 flex justify-end" onClick={(e) => e.stopPropagation()}>
      <div className="absolute inset-0 animate-fade bg-[rgb(9_11_15/0.38)] backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={ticket.data ? `OS ${ticket.data.code}` : "OS"}
        data-drawer
        className="relative flex h-full w-full animate-drawer flex-col bg-surface shadow-pop outline-none sm:w-[min(100vw,56rem)] sm:border-l sm:border-line"
      >
        {ticket.data ? (
          <TicketEditor ticket={ticket.data} variant="dialog" onClose={onClose} />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            {ticket.error ? (
              <div className="w-full max-w-md p-6">
                <ErrorBox message={errorMessage(ticket.error)} />
              </div>
            ) : (
              <Spinner className="size-6" />
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
