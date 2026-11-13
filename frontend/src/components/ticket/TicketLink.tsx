"use client";

import Link from "next/link";
import type { UUID } from "@/lib/types";
import { useTicketPanel } from "./TicketPanel";

/** Clique simples com o botão esquerdo. Com Ctrl, Cmd, Shift ou Alt o navegador segue o link (nova aba, nova janela). */
export function isPlainClick(e: React.MouseEvent) {
  return e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
}

/**
 * Link para uma OS nas listas: o clique abre a OS no painel lateral, sem sair da tela (como no Field
 * Control); Ctrl+clique ou o botão do meio abrem a página da OS em outra aba, como um link comum.
 */
export function TicketLink({
  ticketId,
  className,
  title,
  children,
}: {
  ticketId: UUID;
  className?: string;
  title?: string;
  children: React.ReactNode;
}) {
  const panel = useTicketPanel();
  return (
    <Link
      href={`/chamados/${ticketId}`}
      className={className}
      title={title}
      onClick={(e) => {
        // A linha ou o cartão em volta pode ter o próprio clique: o do link vale sozinho.
        e.stopPropagation();
        if (!panel || !isPlainClick(e)) return;
        e.preventDefault();
        panel.open(ticketId);
      }}
    >
      {children}
    </Link>
  );
}
