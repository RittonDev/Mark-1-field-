"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ClipboardList } from "lucide-react";
import { useState } from "react";
import { StatusBadge } from "@/components/badges";
import { ConflictHint, ConflictList, scheduleConflicts } from "@/components/ScheduleConflict";
import { useToast } from "@/components/Toaster";
import { Button, Dialog, ErrorBox, Field, Input, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { STATUS, TRANSITION_ACTION } from "@/lib/constants";
import { formatMinutes, fromLocalInput, toLocalInput } from "@/lib/format";
import { changedViolation, type ViolationValues, ViolationFields } from "./ViolationFields";
import { busyTitle, isVersionConflict } from "./useConflictHandler";
import type { ConflictItem, TicketDetail, TicketForm, TicketStatus, TicketTransitionPayload, UUID, ViolationReasonRef } from "@/lib/types";
import { transitionRequirements } from "@/lib/workflow";

export interface TransitionTarget {
  id: UUID;
  code: string;
  title: string;
  status: TicketStatus;
  version: number;
  scheduled_start: string | null;
  scheduled_end: string | null;
  assignee?: { id: UUID; name: string } | null;
  /** Só o detalhe tem (o quadro não): usado na dica do fim da visita. */
  estimated_minutes?: number | null;
  /** Só o detalhe tem: ao resolver uma OS que furou o prazo, pede o motivo de cada relógio. */
  response_breached?: boolean;
  resolution_breached?: boolean;
  response_violation_reason?: ViolationReasonRef | null;
  resolution_violation_reason?: ViolationReasonRef | null;
  violation_note?: string | null;
  /** Só o detalhe tem: numa OS reaberta, a solução anterior já vem preenchida para ajustar. */
  resolution_notes?: string | null;
  /** Só o detalhe tem: o que ainda trava a conclusão (formulários obrigatórios e assinatura). */
  forms?: TicketForm[];
  signature_required?: boolean;
  signed_at?: string | null;
  /** Só o detalhe tem: os destinos que a API aceita agora (avisa quando a OS mudou por fora). */
  allowed_transitions?: TicketStatus[];
}

/** Texto do destino quando o de STATUS não diz o que acontece com a OS. */
const WHAT_HAPPENS: Partial<Record<TicketStatus, string>> = {
  closed: "A OS sai das filas; o relatório do cliente mostra o resultado final.",
  reopened: "A OS volta para a fila; as datas de conclusão, fechamento e cancelamento são apagadas.",
};

/**
 * Confirma a mudança de status pedindo só o que o destino exige (agenda, solução, motivo). Monte
 * com `key={destino}` para zerar o formulário. Na web quem muda é a central: a localização do
 * navegador nunca vai junto (o ponto de GPS da OS é a prova de presença do técnico, pelo app).
 */
export function TransitionDialog({
  ticket: given,
  to,
  onClose,
  onOpenForms,
}: {
  ticket: TransitionTarget;
  to: TicketStatus;
  onClose: () => void;
  /** Leva para a aba Formulários quando eles travam a conclusão (no editor da OS). */
  onOpenForms?: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  // A OS mais nova que se conhece: a recebida (o editor passa a OS ao vivo) ou a relida depois de um
  // 409 (o quadro passa a cópia da lista, que não se atualiza sozinha). O que foi digitado fica.
  const [latest, setLatest] = useState<TicketDetail | null>(null);
  const ticket: TransitionTarget = latest && latest.version > given.version ? latest : given;
  const req = transitionRequirements(to);
  const [note, setNote] = useState("");
  const [resolution, setResolution] = useState(ticket.resolution_notes ?? "");
  const [start, setStart] = useState(() => toLocalInput(ticket.scheduled_start));
  // Fim em branco por padrão: num reagendamento, o fim antigo ficaria antes do novo início.
  // Em branco, a API usa início + duração estimada.
  const [end, setEnd] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  // A API barrou por conflito de agenda: mostra as OS em choque e o próximo envio confirma.
  const [conflicts, setConflicts] = useState<ConflictItem[] | null>(null);
  const askViolation = req.needsResolution && Boolean(ticket.response_breached || ticket.resolution_breached);
  const currentViolation = { response: ticket.response_violation_reason, resolution: ticket.resolution_violation_reason };
  const [violation, setViolation] = useState<ViolationValues>({
    response: ticket.response_violation_reason?.id ?? "",
    resolution: ticket.resolution_violation_reason?.id ?? "",
    note: ticket.violation_note ?? "",
  });
  // Concluir exige os formulários obrigatórios concluídos e, se pedida, a assinatura (a API barra).
  const closing = (to === "resolved" || to === "closed") && ticket.status !== "resolved" && ticket.status !== "closed";
  const pendingForms = closing ? (ticket.forms ?? []).filter((f) => f.required && f.status !== "completed").map((f) => f.name) : [];
  const missingSignature = closing && Boolean(ticket.signature_required) && !ticket.signed_at;
  // A OS mudou por fora (ex.: o técnico concluiu no app) e este destino não vale mais.
  const gone = Boolean(ticket.allowed_transitions && !ticket.allowed_transitions.includes(to));
  const blocked = pendingForms.length > 0 || missingSignature || gone;
  // Sem técnico, quem confirma (analista) vira o responsável pela visita.
  const selfAssign = STATUS[to].requiresAssignee && !ticket.assignee;

  const mutation = useMutation({
    mutationFn: () => {
      const payload: TicketTransitionPayload = {
        to_status: to,
        note: note.trim() || null,
        expected_version: ticket.version,
      };
      if (req.needsResolution) payload.resolution_notes = resolution.trim();
      if (askViolation) {
        const changed = changedViolation(violation, currentViolation);
        if (ticket.response_breached) payload.response_violation_reason_id = changed.response;
        if (ticket.resolution_breached) payload.resolution_violation_reason_id = changed.resolution;
        payload.violation_note = violation.note.trim() || null;
      }
      if (req.needsSchedule) {
        payload.scheduled_start = fromLocalInput(start);
        payload.scheduled_end = fromLocalInput(end);
        if (conflicts) payload.allow_conflict = true;
      }
      return api.post<TicketDetail>(`/tickets/${ticket.id}/transition`, payload);
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(["ticket", ticket.id], updated);
      queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id] });
      queryClient.invalidateQueries({ queryKey: ["tickets"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      toast({ title: `${updated.code} → ${STATUS[updated.status].label}`, tone: "success" });
      onClose();
    },
    onError: (error) => {
      const clash = scheduleConflicts(error);
      if (clash) {
        setConflicts(clash);
        return;
      }
      if (isVersionConflict(error)) {
        // Relê a OS (o próximo envio vai com a versão nova) e o diálogo fica aberto com o que foi digitado.
        void queryClient.invalidateQueries({ queryKey: ["tickets"] });
        void queryClient
          .fetchQuery({ queryKey: ["ticket", given.id], queryFn: () => api.get<TicketDetail>(`/tickets/${given.id}`), staleTime: 0 })
          .then(setLatest, () => undefined);
      }
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);
    if (blocked || mutation.isPending) return;
    if (req.needsSchedule && !start) return setLocalError("Informe a data e hora da visita.");
    if (req.needsResolution && !resolution.trim()) return setLocalError("Descreva a solução aplicada.");
    if (req.needsNote && !note.trim()) return setLocalError("Informe o motivo.");
    mutation.mutate();
  }

  const error =
    localError ??
    (mutation.error && !conflicts
      ? isVersionConflict(mutation.error)
        ? "A OS mudou enquanto isso (outra pessoa ou o app do técnico). Atualizamos os dados: confira e confirme de novo."
        : errorMessage(mutation.error)
      : null);

  // Texto digitado (motivo, solução): o Esc ou o clique fora perguntam antes de descartar.
  const typed = Boolean(note.trim()) || (req.needsResolution && resolution.trim() !== (given.resolution_notes ?? "").trim());

  return (
    <Dialog
      open
      onClose={onClose}
      dirty={typed}
      busy={mutation.isPending}
      title={TRANSITION_ACTION[to]}
      description={
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-xs">{ticket.code}</span>
          <StatusBadge status={ticket.status} />
          <span>→</span>
          <StatusBadge status={to} />
        </span>
      }
      footer={
        <>
          <Button onClick={onClose}>Voltar</Button>
          <Button
            variant={to === "cancelled" ? "danger" : "primary"}
            loading={mutation.isPending}
            disabled={blocked}
            type="submit"
            form="transition-form"
          >
            {conflicts ? "Agendar mesmo assim" : TRANSITION_ACTION[to]}
          </Button>
        </>
      }
    >
      <form id="transition-form" onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm text-ink-muted">{WHAT_HAPPENS[to] ?? STATUS[to].description}</p>
        {gone ? (
          <p
            role="alert"
            className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            A OS mudou para {STATUS[ticket.status].label} enquanto isso: esta mudança não vale mais. Volte e confira a situação atual.
          </p>
        ) : blocked ? (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
            <p className="flex items-center gap-1.5 font-semibold">
              <ClipboardList className="size-4 shrink-0" />
              Falta para concluir a OS
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {pendingForms.map((name) => (
                <li key={name}>Formulário obrigatório: {name}</li>
              ))}
              {missingSignature ? <li>Assinatura do responsável no local (o técnico colhe no app, depois dos formulários)</li> : null}
            </ul>
            {onOpenForms ? (
              <button type="button" onClick={onOpenForms} className="mt-1.5 text-xs font-semibold underline underline-offset-2 hover:no-underline">
                Abrir a aba Formulários
              </button>
            ) : (
              <p className="mt-1.5 text-xs">Confira na aba Formulários da OS.</p>
            )}
          </div>
        ) : null}
        {selfAssign && !blocked ? (
          <p className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
            <AlertTriangle className="mt-px size-3.5 shrink-0" />
            Esta OS está sem técnico: ao confirmar, você fica como responsável pela visita. Para pôr um técnico, escolha o
            Colaborador na aba Geral.
          </p>
        ) : null}
        {req.needsSchedule ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Início da visita" required>
              <Input
                type="datetime-local"
                value={start}
                onChange={(e) => {
                  setStart(e.target.value);
                  setConflicts(null);
                }}
                required
              />
            </Field>
            <Field
              label="Fim previsto"
              hint={
                ticket.estimated_minutes
                  ? `Em branco, a visita dura o estimado: ${formatMinutes(ticket.estimated_minutes)}`
                  : "Opcional"
              }
            >
              <Input
                type="datetime-local"
                value={end}
                min={start || undefined}
                onChange={(e) => {
                  setEnd(e.target.value);
                  setConflicts(null);
                }}
              />
            </Field>
          </div>
        ) : null}
        {req.needsSchedule && conflicts ? (
          <ConflictList
            tone="error"
            items={conflicts}
            title={`${busyTitle(conflicts, ticket.assignee?.name ?? "O técnico")}. Confirme para agendar mesmo assim.`}
          />
        ) : req.needsSchedule && start ? (
          <ConflictHint
            assigneeId={ticket.assignee?.id}
            assigneeName={ticket.assignee?.name}
            start={fromLocalInput(start)}
            end={fromLocalInput(end)}
            estimatedMinutes={ticket.estimated_minutes}
            excludeId={ticket.id}
          />
        ) : null}
        {req.needsResolution ? (
          <Field label="Solução aplicada" required hint="Aparece no relatório do cliente e no histórico da OS.">
            <Textarea
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              rows={4}
              maxLength={20000}
              placeholder="O que foi feito para resolver?"
              autoFocus={!blocked}
            />
          </Field>
        ) : null}
        {askViolation ? (
          <ViolationFields
            responseBreached={Boolean(ticket.response_breached)}
            resolutionBreached={Boolean(ticket.resolution_breached)}
            values={violation}
            onChange={setViolation}
            current={currentViolation}
            required
          />
        ) : null}
        <Field label={req.needsNote ? "Motivo" : "Observação"} required={req.needsNote} hint="Fica no histórico da OS.">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={5000}
            placeholder={req.needsNote ? "Explique o motivo" : "Opcional"}
            autoFocus={!blocked && !req.needsResolution && !req.needsSchedule}
          />
        </Field>
        {error ? <ErrorBox message={error} /> : null}
      </form>
    </Dialog>
  );
}
