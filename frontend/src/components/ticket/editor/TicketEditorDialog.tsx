"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { ErrorBox, lockScroll, Spinner } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import type { TicketDetail, UUID } from "@/lib/types";
import { TicketEditor } from "./TicketEditor";

/** A OS aberta por cima da lista (como o "Editar atividade" do Field Control), sem sair da tela. */
export function TicketEditorDialog({ ticketId, onClose }: { ticketId: UUID; onClose: () => void }) {
  const ticket = useQuery({ queryKey: ["ticket", ticketId], queryFn: () => api.get<TicketDetail>(`/tickets/${ticketId}`) });

  useEffect(() => {
    const unlock = lockScroll();
    const onKey = (e: KeyboardEvent) => {
      // Esc fecha, menos quando outro diálogo (horários, transição) está aberto por cima.
      if (e.key === "Escape" && document.querySelectorAll('[role="dialog"]').length === 0) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      unlock();
    };
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-40 flex animate-fade items-stretch justify-center bg-[rgb(9_11_15/0.42)] p-3 backdrop-blur-[3px] sm:p-6">
      <div className="absolute inset-0" onClick={onClose} aria-hidden />
      <div className="relative flex w-full max-w-5xl animate-pop flex-col" role="region" aria-label="OS">
        {ticket.data ? (
          <TicketEditor ticket={ticket.data} variant="dialog" onClose={onClose} />
        ) : (
          <div className="flex flex-1 items-center justify-center rounded-2xl border border-line bg-surface">
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
