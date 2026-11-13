"use client";

import { Pause } from "lucide-react";
import { PRIORITY, SLA_STATUS, STATUS } from "@/lib/constants";
import { formatRelative } from "@/lib/format";
import type { SlaStatus, TicketListItem, TicketPriority, TicketStatus } from "@/lib/types";
import { useNow } from "./useNow";
import { Pill } from "./ui";

export function StatusBadge({ status }: { status: TicketStatus }) {
  const info = STATUS[status];
  return (
    <Pill color={info?.color ?? "#64748b"}>
      <span className="size-1.5 rounded-full" style={{ backgroundColor: info?.color ?? "#64748b" }} />
      {info?.label ?? status}
    </Pill>
  );
}

export function PriorityBadge({ priority, compact }: { priority: TicketPriority; compact?: boolean }) {
  const info = PRIORITY[priority];
  return (
    <Pill color={info.color}>
      {info.code}
      {compact ? null : <span className="font-normal">· {info.label}</span>}
    </Pill>
  );
}

export function SlaBadge({ status }: { status: SlaStatus }) {
  const info = SLA_STATUS[status];
  return (
    <Pill color={info.color}>
      {status === "paused" ? <Pause className="size-3" /> : null}
      {info.label}
    </Pill>
  );
}

/** Próximo prazo relevante: resposta (se ainda não houve) ou solução. */
export function nextDue(ticket: TicketListItem): { label: string; at: string } | null {
  if (ticket.resolved_at || STATUS[ticket.status].final) return null;
  if (!ticket.first_response_at && ticket.response_due_at) return { label: "Resposta", at: ticket.response_due_at };
  if (ticket.resolution_due_at) return { label: "Solução", at: ticket.resolution_due_at };
  return null;
}

export function SlaCountdown({ ticket }: { ticket: TicketListItem }) {
  const now = useNow(30_000);
  const due = nextDue(ticket);
  if (!due) return null; // sem prazo pendente: nada embaixo do selo (um traço solto era ruído)
  if (ticket.sla_paused_at) return <span className="text-xs text-ink-muted">pausado</span>;
  const late = new Date(due.at).getTime() < now;
  return (
    <span className={late ? "text-xs font-medium text-red-600 dark:text-red-400" : "text-xs text-ink-muted"}>
      {due.label} {formatRelative(due.at, now)}
    </span>
  );
}
