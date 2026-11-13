"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, PencilLine } from "lucide-react";
import { useState } from "react";
import { useToast } from "@/components/Toaster";
import { Button, Card, CardHeader, Dialog, ErrorBox, Pill } from "@/components/ui";
import { useNow } from "@/components/useNow";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets, RESPONSIBILITY } from "@/lib/constants";
import { formatDateTime, formatRelative, formatShort } from "@/lib/format";
import type { TicketDetail, ViolationReasonRef } from "@/lib/types";
import { changedViolation, type ViolationValues, ViolationFields } from "./ViolationFields";

function JustifyDialog({ ticket, onClose }: { ticket: TicketDetail; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const current = { response: ticket.response_violation_reason, resolution: ticket.resolution_violation_reason };
  const [values, setValues] = useState<ViolationValues>({
    response: ticket.response_violation_reason?.id ?? "",
    resolution: ticket.resolution_violation_reason?.id ?? "",
    note: ticket.violation_note ?? "",
  });
  const mutation = useMutation({
    mutationFn: () => {
      const changed = changedViolation(values, current);
      return api.patch<TicketDetail>(`/tickets/${ticket.id}/violation`, {
        response_violation_reason_id: changed.response,
        resolution_violation_reason_id: changed.resolution,
        violation_note: values.note,
      });
    },
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
      busy={mutation.isPending}
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
          current={current}
          required
        />
        {mutation.error ? <ErrorBox message={errorMessage(mutation.error)} /> : null}
      </form>
    </Dialog>
  );
}

function Reason({ reason, breached }: { reason: ViolationReasonRef | null; breached: boolean }) {
  if (!breached) return <span className="text-ink-muted">—</span>;
  if (!reason) return <span className="font-medium text-amber-700 dark:text-amber-300">não informado</span>;
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

const RED = "text-red-600 dark:text-red-400";

/** Parte do prazo já consumida (sem o tempo pausado), como o backend calcula o "em risco". */
function elapsedRatio(createdAt: string, due: string, pausedSeconds: number, now: number) {
  const created = Date.parse(createdAt);
  const total = Date.parse(due) - created - pausedSeconds * 1000;
  return total <= 0 ? 1 : (now - created - pausedSeconds * 1000) / total;
}

/** Os dois relógios de SLA lado a lado — limite, concluído, situação e motivo (como no Field Control). */
export function SlaCard({ ticket }: { ticket: TicketDetail }) {
  const { user } = useAuth();
  const now = useNow(30_000);
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
  // "Em risco" vale para a OS toda: fica em âmbar o relógio aberto que mais consumiu o prazo.
  const open = clocks.filter((c) => !c.done && c.due && !c.breached);
  const ratios = open.map((c) => elapsedRatio(ticket.created_at, c.due!, ticket.sla_paused_seconds, now));
  const atRisk = ticket.sla_status === "at_risk" && open.length ? open[ratios.indexOf(Math.max(...ratios))] : null;
  const situation = (c: (typeof clocks)[number]) => {
    if (c.done) return c.breached ? { text: "Concluído fora do prazo", tone: RED } : { text: "Concluído no prazo", tone: "text-ink" };
    if (ticket.status === "cancelled") return { text: "OS cancelada (sem prazo)", tone: "text-ink-muted" };
    if (!c.due) return { text: "Sem prazo", tone: "text-ink-muted" };
    if (c.breached) return { text: `Violado: venceu ${formatRelative(c.due, now)}`, tone: RED };
    // Concluída sem a marca deste relógio (ex.: OS migrada sem a 1ª resposta registrada).
    if (ticket.status === "resolved" || ticket.status === "closed") return { text: "Sem registro", tone: "text-ink-muted" };
    if (ticket.sla_paused_at) {
      return { text: `Pausado desde ${formatShort(ticket.sla_paused_at)}: o limite anda quando retomar`, tone: "text-ink-muted" };
    }
    return { text: `Vence ${formatRelative(c.due, now)}`, tone: c === atRisk ? "text-amber-700 dark:text-amber-300" : "text-ink" };
  };

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
            <div key={c.label} className="py-2.5 text-sm">
              <h3 className="text-xs font-bold tracking-wide text-ink-muted uppercase">{c.label}</h3>
              <dl className="mt-1 grid grid-cols-[7.5rem_1fr] gap-x-2 gap-y-1">
                <dt className="text-ink-muted">Limite</dt>
                <dd className="text-ink">{formatDateTime(c.due)}</dd>
                <dt className="text-ink-muted">Concluído em</dt>
                <dd className="text-ink">{formatDateTime(c.done)}</dd>
                <dt className="text-ink-muted">Situação</dt>
                <dd className={`font-medium ${s.tone}`}>{s.text}</dd>
                <dt className="text-ink-muted">Motivo</dt>
                <dd>
                  <Reason reason={c.reason} breached={c.breached} />
                </dd>
              </dl>
            </div>
          );
        })}
        {ticket.violation_note ? <p className="py-2.5 text-xs text-ink-muted">Detalhe: {ticket.violation_note}</p> : null}
      </div>
      {justifying ? <JustifyDialog ticket={ticket} onClose={() => setJustifying(false)} /> : null}
    </Card>
  );
}
