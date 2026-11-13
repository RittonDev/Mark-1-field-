"use client";

import clsx from "clsx";
import { SquarePen } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTicketPanel } from "./TicketPanel";

/** Abre a OS no painel lateral da tela (fora da área da central, onde não há painel, abre a página). */
function useOpenTicket() {
  const panel = useTicketPanel();
  const router = useRouter();
  return (ticketId: string) => (panel ? panel.open(ticketId) : router.push(`/chamados/${ticketId}`));
}

/** Botão "Editar" das listas (coluna fixa à direita): abre a OS completa ali mesmo, sem sair da tela. */
export function QuickEditButton({ ticketId, code, className }: { ticketId: string; code: string; className?: string }) {
  const openTicket = useOpenTicket();
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openTicket(ticketId);
      }}
      className={clsx(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-brand shadow-elev-1",
        "transition-[border-color,background-color,transform] duration-150 hover:border-brand/40 hover:bg-brand-soft active:translate-y-px",
        className,
      )}
      aria-label={`Editar ${code}`}
      title={`Editar ${code}`}
    >
      <SquarePen className="size-4" />
    </button>
  );
}

/** Texto clicável (ex.: o nº da OS no cartão do dia) que abre a OS por cima da lista. */
export function OpenTicketButton({ ticketId, className, children }: { ticketId: string; className?: string; children: React.ReactNode }) {
  const openTicket = useOpenTicket();
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openTicket(ticketId);
      }}
      className={clsx("text-left underline-offset-2 hover:underline", className)}
    >
      {children}
    </button>
  );
}
