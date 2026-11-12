"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, PencilLine } from "lucide-react";
import { useState } from "react";
import { useToast } from "@/components/Toaster";
import { Button, Card, CardHeader, Dialog, ErrorBox, Pill } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets, RESPONSIBILITY } from "@/lib/constants";
import { formatDateTime } from "@/lib/format";
import type { TicketDetail, ViolationReasonRef } from "@/lib/types";
import { type ViolationValues, ViolationFields } from "./ViolationFields";

function JustifyDialog({ ticket, onClose }: { ticket: TicketDetail; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [values, setValues] = useState<ViolationValues>({
    response: ticket.response_violation_reason?.id ?? "",
    resolution: ticket.resolution_violation_reason?.id ?? "",
    note: ticket.violation_note ?? "",
  });
  const mutation = useMutation({
    mutationFn: () =>
      api.patch<TicketDetail>(`/tickets/${ticket.id}/violation`, {
        response_violation_reason_id: values.response || null,
        resolution_violation_reason_id: values.resolution || null,
        violation_note: values.note,
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(["ticket", ticket.id], updated);
      queryClient.invalidateQueries({ queryKey: ["tickets"] });
      queryClient.invalidateQueries({ queryKey: ["reports"] });
      toast({ title: `${updated.code}: motivo da violação registrado`, tone: "success" });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Justificar violação · ${ticket.code}`}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" type="submit" form="justify-form" loading={mutation.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      <form
        id="justify-form"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
        className="space-y-3"
      >
        <ViolationFields
          responseBreached={ticket.response_breached}
          resolutionBreached={ticket.resolution_breached}
          values={values}
          onChange={setValues}
          required
        />
        {mutation.error ? <ErrorBox message={errorMessage(mutation.error)} /> : null}
      </form>
    </Dialog>
  );
}

function Reason({ reason, breached }: { reason: ViolationReasonRef | null; breached: boolean }) {
  if (!breached) return <span className="text-ink-muted">—</span>;
  if (!reason) return <span className="font-medium text-amber-600 dark:text-amber-400">não informado</span>;
  const info = RESPONSIBILITY[reason.responsibility];
  return (
    <span>
      {reason.name}{" "}
      <Pill color={info.color} className="ml-1 align-middle">
        {info.label}
      </Pill>
    </span>
  );
}

/** Os dois relógios de SLA lado a lado — limite, concluído, situação e motivo (como no Field Control). */
export function SlaCard({ ticket }: { ticket: TicketDetail }) {
  const { user } = useAuth();
  const [justifying, setJustifying] = useState(false);
  const canJustify = canManageTickets(user?.role) && (ticket.response_breached || ticket.resolution_breached);
  const clocks = [
    {
      label: "1ª resposta",
      due: ticket.response_due_at,
      done: ticket.first_response_at,
      breached: ticket.response_breached,
      reason: ticket.response_violation_reason,
    },
    {
      label: "Solução",
      due: ticket.resolution_due_at,
      done: ticket.resolved_at,
      breached: ticket.resolution_breached,
      reason: ticket.resolution_violation_reason,
    },
  ];
  const situation = (c: (typeof clocks)[number]) =>
    c.done
      ? c.breached
        ? { text: "Concluído fora do prazo", tone: "text-red-600 dark:text-red-400" }
        : { text: "Concluído no prazo", tone: "text-emerald-600 dark:text-emerald-400" }
      : c.breached
        ? { text: "Violado", tone: "text-red-600 dark:text-red-400" }
        : ticket.sla_paused_at
          ? { text: "Pausado", tone: "text-purple-600 dark:text-purple-400" }
          : { text: "Em andamento", tone: "text-ink-muted" };

  return (
    <Card>
      <CardHeader
        title="Prazos (SLA)"
        actions={
          canJustify ? (
            <Button size="sm" variant="ghost" onClick={() => setJustifying(true)}>
              <PencilLine className="size-3.5" />
              {ticket.response_violation_reason || ticket.resolution_violation_reason ? "Editar motivo" : "Justificar"}
            </Button>
          ) : null
        }
      />
      {ticket.violation_reason_pending ? (
        <p className="mx-4 mt-3 flex items-center gap-1.5 rounded-md bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
          <AlertTriangle className="size-3.5" />
          Pendente de justificativa
        </p>
      ) : null}
      <div className="divide-y divide-line px-4 py-1">
        {clocks.map((c) => {
          const s = situation(c);
          return (
            <dl key={c.label} className="grid grid-cols-[7.5rem_1fr] gap-x-2 gap-y-1 py-2.5 text-sm">
              <dt className="col-span-2 text-xs font-semibold tracking-wide text-ink-muted uppercase">{c.label}</dt>
              <dt className="text-ink-muted">Limite</dt>
              <dd>{formatDateTime(c.due)}</dd>
              <dt className="text-ink-muted">Concluído em</dt>
              <dd>{formatDateTime(c.done)}</dd>
              <dt className="text-ink-muted">Situação</dt>
              <dd className={`font-medium ${s.tone}`}>{s.text}</dd>
              <dt className="text-ink-muted">Motivo</dt>
              <dd>
                <Reason reason={c.reason} breached={c.breached} />
              </dd>
            </dl>
          );
        })}
        {ticket.violation_note ? <p className="py-2.5 text-xs text-ink-muted">Detalhe: {ticket.violation_note}</p> : null}
      </div>
      {justifying ? <JustifyDialog ticket={ticket} onClose={() => setJustifying(false)} /> : null}
    </Card>
  );
}
