"use client";

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { SquarePen } from "lucide-react";
import { useState } from "react";
import { StatusBadge } from "@/components/badges";
import { Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import type { TicketDetail } from "@/lib/types";
import { EditTicketDialog } from "./EditTicketDialog";

/** Botão "Editar" das listas (coluna fixa à direita): abre a edição da OS ali mesmo, sem sair da tela. */
export function QuickEditButton({ ticketId, code, className }: { ticketId: string; code: string; className?: string }) {
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
        className={clsx(
          "inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-brand shadow-elev-1",
          "transition-[border-color,background-color,transform] duration-150 hover:border-brand/40 hover:bg-brand-soft active:translate-y-px",
          className,
        )}
        aria-label={`Editar ${code}`}
        title={`Editar ${code}`}
      >
        {open && ticket.isLoading ? <Spinner className="size-4" /> : <SquarePen className="size-4" />}
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
