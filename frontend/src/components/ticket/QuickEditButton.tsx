"use client";

import clsx from "clsx";
import { SquarePen } from "lucide-react";
import { TicketLink } from "./TicketLink";

/**
 * Botão "Editar" das listas (coluna fixa à direita): abre a OS completa no painel lateral, sem sair da
 * tela. É um link, como o nº da OS: Ctrl+clique ou o botão do meio abrem a página da OS em outra aba
 * (fora da área da central, onde não há painel, o clique abre a página).
 */
export function QuickEditButton({ ticketId, code, className }: { ticketId: string; code: string; className?: string }) {
  return (
    <TicketLink
      ticketId={ticketId}
      label={`Editar ${code}`}
      title={`Editar ${code}`}
      className={clsx(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-brand shadow-elev-1",
        "transition-[border-color,background-color,transform] duration-150 hover:border-brand/40 hover:bg-brand-soft active:translate-y-px",
        className,
      )}
    >
      <SquarePen aria-hidden className="size-4" />
    </TicketLink>
  );
}

/**
 * Texto clicável (ex.: o nº da OS no cartão do dia) que abre a OS por cima da lista. É um link: o
 * clique abre no painel e Ctrl+clique ou o botão do meio abrem a página da OS em outra aba.
 */
export function OpenTicketButton({ ticketId, className, children }: { ticketId: string; className?: string; children: React.ReactNode }) {
  return (
    <TicketLink ticketId={ticketId} className={clsx("text-left underline-offset-2 hover:underline", className)}>
      {children}
    </TicketLink>
  );
}
