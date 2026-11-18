"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, PencilLine } from "lucide-react";
import { useState } from "react";
import { isOpenStatus } from "@/components/operacao/hooks";
import { SLA_AT_RISK_RATIO } from "@/components/ticket/editor/TicketHeader";
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
  // Motivo escolhido ou detalhe digitado: fechar pergunta antes de descartar.
  const dirty =
    values.response !== (ticket.response_violation_reason?.id ?? "") ||
    values.resolution !== (ticket.resolution_violation_reason?.id ?? "") ||
    values.note.trim() !== (ticket.violation_note ?? "").trim();
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
      dirty={dirty}
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

/**
 * Prazo de solução encerrado antes da conclusão (na OS migrada, a visita com que o Field Control deu o prazo
 * como cumprido, mesmo improdutiva): o fim do relógio quando veio antes da conclusão (como a API calcula).
 */
function fieldControlEnd(ticket: TicketDetail): string | null {
  const met = ticket.resolution_sla_met_at ?? null;
  if (!met) return null;
  const concluded = (ticket.status === "resolved" || ticket.status === "closed") && ticket.resolved_at;
  return concluded && Date.parse(concluded) < Date.parse(met) ? null : met;
}

/** Os dois relógios de SLA lado a lado — limite, concluído, situação e motivo (como no Field Control). */
export function SlaCard({ ticket }: { ticket: TicketDetail }) {
  const { user } = useAuth();
  const now = useNow(30_000);
  const [justifying, setJustifying] = useState(false);
  const canJustify = canManageTickets(user?.role) && (ticket.response_breached || ticket.resolution_breached);
  const clocks: {
    label: string;
    due: string | null;
    done: string | null;
    /** O relógio parou antes da conclusão (prazo encerrado pelo Field Control). */
    stoppedAt: string | null;
    breached: boolean;
    reason: ViolationReasonRef | null;
  }[] = [
    {
      label: "1ª resposta",
      due: ticket.response_due_at,
      done: ticket.first_response_at,
      stoppedAt: null,
      breached: ticket.response_breached,
      reason: ticket.response_violation_reason,
    },
    {
      label: "Solução",
      due: ticket.resolution_due_at,
      done: ticket.resolved_at,
      stoppedAt: fieldControlEnd(ticket),
      breached: ticket.resolution_breached,
      reason: ticket.resolution_violation_reason,
    },
  ];
  type Clock = (typeof clocks)[number];
  // Vencido agora, contado ao vivo como o chip do cabeçalho e o alerta da aba: a marca da API só muda
  // quando a OS é relida. Pausado, o limite anda quando retomar.
  const lapsed = (c: Clock) =>
    !c.done && !c.stoppedAt && !ticket.sla_paused_at && isOpenStatus(ticket.status) && !!c.due && Date.parse(c.due) < now;
  const violated = (c: Clock) => c.breached || lapsed(c);
  // "Em risco" vale para a OS toda: fica em âmbar o relógio aberto que mais consumiu o prazo.
  const open = clocks.filter((c) => !c.done && !c.stoppedAt && c.due && !violated(c));
  const ratios = open.map((c) => elapsedRatio(ticket.created_at, c.due!, ticket.sla_paused_seconds, now));
  const top = Math.max(...ratios);
  const atRisk = open.length && (ticket.sla_status === "at_risk" || top >= SLA_AT_RISK_RATIO) ? open[ratios.indexOf(top)] : null;
  const situation = (c: Clock): { text: string; tone: string; hint?: string } => {
    if (c.stoppedAt && ticket.status !== "cancelled") {
      // O veredito do Field Control: a contagem não anda mais (no prazo ou fora dele).
      const when = formatShort(c.stoppedAt);
      const hint = "Na OS migrada, o Field Control encerra o prazo de solução na visita, mesmo improdutiva.";
      return c.breached
        ? { text: `Cumprido fora do prazo em ${when} · Field Control`, tone: RED, hint }
        : { text: `Cumprido em ${when} · Field Control`, tone: "text-ink", hint };
    }
    if (c.done) return c.breached ? { text: "Concluído fora do prazo", tone: RED } : { text: "Concluído no prazo", tone: "text-ink" };
    if (ticket.status === "cancelled") return { text: "OS cancelada (sem prazo)", tone: "text-ink-muted" };
    if (!c.due) return { text: "Sem prazo", tone: "text-ink-muted" };
    if (violated(c)) return { text: `Violado: venceu ${formatRelative(c.due, now)}`, tone: RED };
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
                <dd className={`font-medium ${s.tone}`} title={s.hint}>
                  {s.text}
                </dd>
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
