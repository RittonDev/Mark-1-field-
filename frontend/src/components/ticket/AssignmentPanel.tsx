"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Hand, UserMinus, UserPlus } from "lucide-react";
import { useState } from "react";
import { ConflictHint, ConflictList, scheduleConflicts } from "@/components/ScheduleConflict";
import { useToast } from "@/components/Toaster";
import { Button, Card, CardHeader, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets, isStaff, STATUS } from "@/lib/constants";
import { initials } from "@/lib/format";
import { useAssignable } from "@/lib/queries";
import type { ConflictItem, TicketDetail } from "@/lib/types";
import { useInvalidateTicket, useTicketErrorHandler } from "./useConflictHandler";

export function AssignmentPanel({ ticket }: { ticket: TicketDetail }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const onError = useTicketErrorHandler(ticket.id);
  const invalidate = useInvalidateTicket(ticket.id);
  const staff = isStaff(user?.role);
  const assignable = useAssignable(null, staff && ticket.can_assign);
  const [selected, setSelected] = useState(ticket.assignee?.id ?? "");
  const [conflicts, setConflicts] = useState<ConflictItem[] | null>(null);

  const isFinal = STATUS[ticket.status].final;
  // Espelha can_take: técnico só assume OS sem responsável; analista/supervisor assume qualquer uma.
  const canTake =
    staff && ticket.assignee?.id !== user?.id && !isFinal && (canManageTickets(user?.role) || !ticket.assignee);

  const onSuccess = (updated: TicketDetail, message: string) => {
    queryClient.setQueryData(["ticket", ticket.id], updated);
    invalidate();
    toast({ title: message, tone: "success" });
  };

  const assign = useMutation({
    mutationFn: ({ assigneeId, allowConflict = false }: { assigneeId: string | null; allowConflict?: boolean }) =>
      api.post<TicketDetail>(`/tickets/${ticket.id}/assign`, {
        assignee_id: assigneeId,
        expected_version: ticket.version,
        allow_conflict: allowConflict,
      }),
    onSuccess: (updated) => {
      setConflicts(null);
      onSuccess(updated, updated.assignee ? `Atribuída a ${updated.assignee.name}` : "Responsável removido");
    },
    onError: (error) => {
      const clash = scheduleConflicts(error);
      if (clash) setConflicts(clash);
      else onError(error);
    },
  });

  const take = useMutation({
    mutationFn: () => api.post<TicketDetail>(`/tickets/${ticket.id}/take`),
    onSuccess: (updated) => onSuccess(updated, "Você assumiu esta OS"),
    onError,
  });

  // Equipe da OS primeiro, depois os demais, por carga.
  const options = [...(assignable.data ?? [])].sort((a, b) => {
    const aTeam = a.team_id === ticket.team?.id ? 0 : 1;
    const bTeam = b.team_id === ticket.team?.id ? 0 : 1;
    return aTeam - bTeam || a.open_tickets - b.open_tickets || a.name.localeCompare(b.name);
  });
  const selectedName = options.find((u) => u.id === selected)?.name;

  return (
    <Card>
      <CardHeader title="Responsável" description={ticket.team ? `Grupo: ${ticket.team.name}` : "Sem grupo técnico"} />
      <div className="flex flex-col gap-3 p-4">
        {ticket.assignee ? (
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-full bg-brand/10 text-xs font-semibold text-brand">
              {initials(ticket.assignee.name)}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">{ticket.assignee.name}</p>
              <p className="truncate text-xs text-ink-muted">{ticket.assignee.email}</p>
            </div>
          </div>
        ) : (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            Ninguém está tratando esta OS.
          </p>
        )}

        {canTake ? (
          <Button variant="primary" onClick={() => take.mutate()} loading={take.isPending}>
            {take.isPending ? null : <Hand className="size-4" />}
            Assumir OS
          </Button>
        ) : null}

        {ticket.can_assign && !isFinal ? (
          <div className="flex flex-col gap-2 border-t border-line pt-3">
            <Select
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setConflicts(null);
              }}
              aria-label="Responsável"
            >
              <option value="">Selecione o responsável...</option>
              {options.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} — {u.open_tickets} em aberto{u.team_name ? ` · ${u.team_name}` : ""}
                </option>
              ))}
            </Select>
            {conflicts ? (
              <ConflictList
                tone="error"
                items={conflicts}
                title={`${selectedName ?? "O técnico"} já está ocupado no horário desta OS.`}
              />
            ) : selected && selected !== ticket.assignee?.id && ticket.scheduled_start ? (
              <ConflictHint
                assigneeId={selected}
                assigneeName={selectedName}
                start={ticket.scheduled_start}
                end={ticket.scheduled_end}
                estimatedMinutes={ticket.estimated_minutes}
                excludeId={ticket.id}
              />
            ) : null}
            <div className="flex gap-2">
              <Button
                className="flex-1"
                onClick={() => assign.mutate({ assigneeId: selected, allowConflict: conflicts !== null })}
                disabled={!selected || selected === ticket.assignee?.id}
                loading={assign.isPending && assign.variables?.assigneeId !== null}
              >
                <UserPlus className="size-4" />
                {conflicts ? "Atribuir mesmo assim" : "Atribuir"}
              </Button>
              {ticket.assignee ? (
                <Button
                  variant="ghost"
                  onClick={() => assign.mutate({ assigneeId: null })}
                  loading={assign.isPending && assign.variables?.assigneeId === null}
                  title="Remover responsável (OS volta para a fila)"
                >
                  <UserMinus className="size-4" />
                  Remover
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
