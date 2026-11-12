"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { HelpersField } from "@/components/new-ticket/SuggestedTechnicians";
import { ConflictList, scheduleConflicts } from "@/components/ScheduleConflict";
import { useToast } from "@/components/Toaster";
import { Button, Card } from "@/components/ui";
import { api } from "@/lib/api";
import { ROLE, STATUS } from "@/lib/constants";
import { initials } from "@/lib/format";
import { useAssignable } from "@/lib/queries";
import type { ConflictItem, TicketDetail, UUID } from "@/lib/types";
import { useInvalidateTicket, useTicketErrorHandler } from "./useConflictHandler";

/** Outros técnicos da visita (além do responsável): veem a OS no app e registram fotos,
 *  acompanhamentos e horas. A gestão inclui e tira; a agenda deles é conferida. */
export function VisitTeamCard({ ticket }: { ticket: TicketDetail }) {
  const helpers = ticket.helpers ?? [];
  const editable = ticket.can_assign && !STATUS[ticket.status].final;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const onError = useTicketErrorHandler(ticket.id);
  const invalidate = useInvalidateTicket(ticket.id);
  const assignable = useAssignable(null, editable);
  const [clash, setClash] = useState<{ ids: UUID[]; items: ConflictItem[] } | null>(null);

  const save = useMutation({
    mutationFn: ({ ids, allow }: { ids: UUID[]; allow: boolean }) =>
      api.patch<TicketDetail>(`/tickets/${ticket.id}`, { helper_ids: ids, allow_conflict: allow }),
    onSuccess: (updated) => {
      setClash(null);
      queryClient.setQueryData(["ticket", ticket.id], updated);
      invalidate();
      toast({ title: "Técnicos da visita atualizados", tone: "success" });
    },
    onError: (error, vars) => {
      const items = scheduleConflicts(error);
      if (items) setClash({ ids: vars.ids, items });
      else onError(error);
    },
  });

  if (!helpers.length && !editable) return null;
  const names: Record<UUID, string> = {};
  for (const u of assignable.data ?? []) names[u.id] = u.name;
  for (const h of helpers) names[h.id] = h.name;
  const options = [...(assignable.data ?? [])]
    .sort((a, b) => (a.role === "technician" ? 0 : 1) - (b.role === "technician" ? 0 : 1) || a.open_tickets - b.open_tickets)
    .map((u) => ({ id: u.id, name: u.name, detail: u.role === "technician" ? u.team_name ?? undefined : ROLE[u.role] }));

  return (
    <Card className="p-4">
      <p className="mb-3 text-xs font-medium text-ink-subtle">Outros técnicos da visita</p>
      {editable ? (
        <HelpersField
          options={options}
          assigneeId={ticket.assignee?.id ?? ""}
          helperIds={clash?.ids ?? helpers.map((h) => h.id)}
          names={names}
          onChange={(ids) => save.mutate({ ids, allow: false })}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {helpers.map((h) => (
            <li key={h.id} className="flex items-center gap-2 text-sm text-ink">
              <span className="flex size-7 items-center justify-center rounded-full bg-emerald-50 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200">
                {initials(h.name)}
              </span>
              {h.name}
            </li>
          ))}
        </ul>
      )}
      {clash ? (
        <div className="mt-3 flex flex-col gap-2">
          <ConflictList tone="error" items={clash.items} title="Ocupado neste horário." />
          <div className="flex gap-2">
            <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate({ ids: clash.ids, allow: true })}>
              Incluir mesmo assim
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setClash(null)}>
              Cancelar
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
