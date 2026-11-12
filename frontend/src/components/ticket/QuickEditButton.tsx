"use client";

import { useQuery } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { useState } from "react";
import { StatusBadge } from "@/components/badges";
import { Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import type { TicketDetail } from "@/lib/types";
import { EditTicketDialog } from "./EditTicketDialog";

/** Lápis ao lado da OS nas listas: abre a edição ali mesmo, sem sair da tela. */
export function QuickEditButton({ ticketId, code }: { ticketId: string; code: string }) {
  const [open, setOpen] = useState(false);
  const ticket = useQuery({
    queryKey: ["ticket", ticketId],
    queryFn: () => api.get<TicketDetail>(`/tickets/${ticketId}`),
    enabled: open,
  });
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
        className="rounded-md p-1.5 text-ink-muted hover:bg-surface-2 hover:text-brand"
        aria-label={`Editar ${code}`}
        title={`Editar ${code}`}
      >
        {open && ticket.isLoading ? <Spinner className="size-4" /> : <Pencil className="size-4" />}
      </button>
      {open && ticket.data ? (
        <EditTicketDialog
          ticket={ticket.data}
          headerExtra={<StatusBadge status={ticket.data.status} />}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
