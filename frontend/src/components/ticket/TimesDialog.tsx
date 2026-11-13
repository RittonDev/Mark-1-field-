"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Clock } from "lucide-react";
import { useMemo, useState } from "react";
import { useToast } from "@/components/Toaster";
import { Button, Dialog, ErrorBox, Field, Input, Spinner, Textarea } from "@/components/ui";
import { useNow } from "@/components/useNow";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime, formatMinutes, fromLocalInput, toLocalInput } from "@/lib/format";
import type { TicketDetail, TicketEvent } from "@/lib/types";
import { isVersionConflict } from "./useConflictHandler";

/** Folga para o relógio do computador (a API aceita 1 minuto). */
const SKEW_MS = 60_000;

/** Saída para o local: o último deslocamento antes da chegada (o mesmo do relatório do cliente). */
function enRouteAt(events: TicketEvent[], arrivedAt: string | null | undefined): string | null {
  const limit = arrivedAt ? new Date(arrivedAt).getTime() : Number.POSITIVE_INFINITY;
  const trips = events
    .filter((e) => e.event_type === "status_changed" && e.to_value === "en_route" && new Date(e.created_at).getTime() <= limit)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  return trips.length ? trips[trips.length - 1].created_at : null;
}

const minutesBetween = (start: string, end: string) =>
  Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000));

type TimeKey = "enRoute" | "arrived" | "resolved";

/** Dá para corrigir algum horário real: o atendimento começou, ou o técnico já saiu para o local. */
export function hasRealTimes(ticket: Pick<TicketDetail, "arrived_at" | "status">) {
  return Boolean(ticket.arrived_at) || ticket.status === "en_route";
}

/**
 * Corrigir os horários reais da OS (só a central: o técnico nunca mexe no horário). Ex.: o técnico
 * esqueceu de iniciar ou de concluir no app. Muda a OS e o histórico de status, com o motivo.
 */
export function TimesDialog({ ticket, onClose }: { ticket: TicketDetail; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const now = useNow(30_000);
  const events = useQuery({
    queryKey: ["ticket", ticket.id, "events"],
    queryFn: () => api.get<TicketEvent[]>(`/tickets/${ticket.id}/events`),
  });
  const original = useMemo(
    () => ({
      enRoute: events.data ? enRouteAt(events.data, ticket.arrived_at) : null,
      arrived: ticket.arrived_at ?? null,
      resolved: ticket.resolved_at ?? null,
    }),
    [events.data, ticket.arrived_at, ticket.resolved_at],
  );
  const running = Boolean(ticket.work_started_at);
  const finished = Boolean(ticket.resolved_at) && !running;
  // A caminho e ainda sem início: só a saída para o local tem horário real.
  const departureOnly = !ticket.arrived_at && ticket.status === "en_route";
  // Valores digitados (datetime-local); sem edição, vale o atual.
  const [edits, setEdits] = useState<{ enRoute?: string; arrived?: string; resolved?: string }>({});
  const [minutes, setMinutes] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  // Tentou salvar sem o motivo: a mensagem aparece embaixo do campo (o botão não fica mudo).
  const [tried, setTried] = useState(false);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const value = (key: TimeKey) => edits[key] ?? toLocalInput(original[key]);
  const iso = (key: TimeKey) => (edits[key] !== undefined ? fromLocalInput(edits[key]!) : original[key]);
  // Tempo de atendimento: acompanha início e término enquanto a central não digitar outro (pausa).
  const start = iso("arrived");
  const end = iso("resolved");
  const departure = iso("enRoute");
  const autoMinutes = start && end ? minutesBetween(start, end) : (ticket.actual_minutes ?? 0);
  const shownMinutes = minutes ?? String(edits.arrived !== undefined || edits.resolved !== undefined ? autoMinutes : (ticket.actual_minutes ?? 0));

  const changed = (key: TimeKey) =>
    edits[key] !== undefined && edits[key] !== toLocalInput(original[key]) && Boolean(fromLocalInput(edits[key]!));
  const minutesChanged = finished && minutes !== null && Number(minutes) !== (ticket.actual_minutes ?? 0);
  const nothing = !changed("enRoute") && !changed("arrived") && !changed("resolved") && !minutesChanged;

  // As mesmas regras da API, com o motivo ao lado do campo antes de salvar.
  const created = Date.parse(ticket.created_at);
  const timeError = (at: string | null): string | null => {
    if (!at) return null;
    const t = Date.parse(at);
    if (t > now + SKEW_MS) return "O horário não pode ficar no futuro";
    if (t < created - SKEW_MS) return `Não pode ser antes da abertura da OS (${formatDateTime(ticket.created_at)})`;
    return null;
  };
  const errors: Partial<Record<TimeKey | "minutes" | "reason", string>> = {};
  for (const key of ["enRoute", "arrived", "resolved"] as const) {
    if (edits[key] !== undefined && !fromLocalInput(edits[key]!)) errors[key] = "Informe a data e a hora";
    else if (changed(key)) {
      const problem = timeError(iso(key));
      if (problem) errors[key] = problem;
    }
  }
  // A ordem só é cobrada quando um dos dois horários mudou aqui (o que já estava gravado não trava).
  const departureMoved = changed("enRoute") || changed("arrived");
  if (!errors.enRoute && departureMoved && departure && start && Date.parse(departure) > Date.parse(start)) {
    errors.enRoute = "A saída deve ser antes do início do atendimento";
  }
  const workMoved = changed("arrived") || changed("resolved");
  if (!errors.resolved && workMoved && start && end && Date.parse(start) > Date.parse(end)) {
    errors.resolved = "O término deve ser depois do início";
  }
  if (!errors.resolved && changed("resolved") && end && ticket.closed_at && Date.parse(end) > Date.parse(ticket.closed_at) + SKEW_MS) {
    errors.resolved = `O término não pode ser depois do fechamento (${formatDateTime(ticket.closed_at)})`;
  }
  if (finished && minutes !== null) {
    if (!/^\d+$/.test(minutes) || Number(minutes) > 60 * 24 * 14) errors.minutes = "Use minutos inteiros (até 14 dias)";
    else if (start && end && Number(minutes) > minutesBetween(start, end)) {
      errors.minutes = `Passa do intervalo entre o início e o término (${formatMinutes(minutesBetween(start, end))})`;
    }
  }
  const shortReason = reason.trim().length < 3;
  if ((tried || reason) && shortReason) errors.reason = "Explique o motivo (pelo menos 3 letras)";
  const invalid = Object.keys(errors).length > 0 || shortReason;

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { reason: reason.trim(), expected_version: ticket.version };
      if (changed("enRoute")) body.en_route_at = fromLocalInput(edits.enRoute!);
      if (changed("arrived")) body.arrived_at = fromLocalInput(edits.arrived!);
      if (changed("resolved")) body.resolved_at = fromLocalInput(edits.resolved!);
      if (minutesChanged) body.work_minutes = Number(minutes);
      return api.put<TicketDetail>(`/tickets/${ticket.id}/times`, body);
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(["ticket", ticket.id], updated);
      void queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id] });
      void queryClient.invalidateQueries({ queryKey: ["tickets"] });
      toast({ title: "Horários corrigidos", description: `${ticket.code}: o histórico registra o motivo.`, tone: "success" });
      onClose();
    },
    onError: (error) => {
      // A OS mudou enquanto isso (ex.: o técnico concluiu): recarrega; o que foi digitado fica.
      if (isVersionConflict(error)) void queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id] });
    },
  });

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (nothing || save.isPending) return;
    if (invalid) {
      setTried(true);
      // Leva ao primeiro horário com problema; sem nenhum, ao motivo.
      const target = e.currentTarget.querySelector<HTMLElement>('[aria-invalid="true"]');
      (target ?? reasonRef.current)?.focus();
      return;
    }
    save.mutate();
  };
  const field = (key: TimeKey, label: string, hint?: string) => (
    <Field label={label} hint={errors[key] ? undefined : hint}>
      <Input
        type="datetime-local"
        value={value(key)}
        min={toLocalInput(ticket.created_at)}
        max={toLocalInput(new Date(now).toISOString())}
        onChange={(e) => setEdits((d) => ({ ...d, [key]: e.target.value }))}
        aria-invalid={errors[key] ? true : undefined}
      />
      {errors[key] ? <span className="text-xs font-medium text-red-700 dark:text-red-300">{errors[key]}</span> : null}
    </Field>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      dirty={!nothing || Boolean(reason.trim())}
      busy={save.isPending}
      title={`Corrigir horários · ${ticket.code}`}
      description="Só a central mexe no horário. Use quando o técnico esqueceu de iniciar ou de concluir no app."
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" type="submit" form="times-form" loading={save.isPending} disabled={nothing}>
            Salvar horários
          </Button>
        </>
      }
    >
      {!hasRealTimes(ticket) ? (
        <p className="text-sm text-ink-muted">O atendimento desta OS ainda não começou: não há horário real para corrigir.</p>
      ) : events.isLoading ? (
        <div className="flex justify-center py-6">
          <Spinner className="size-5" />
        </div>
      ) : events.error ? (
        <ErrorBox message={`Não foi possível ler o histórico da OS: ${errorMessage(events.error)}`} onRetry={() => void events.refetch()} />
      ) : departureOnly && !original.enRoute ? (
        <p className="text-sm text-ink-muted">A saída para o local não foi registrada no histórico: não há horário para corrigir.</p>
      ) : (
        <form id="times-form" className="grid gap-4 sm:grid-cols-2" onSubmit={submit} noValidate>
          {original.enRoute ? field("enRoute", "Saída para o local") : null}
          {departureOnly ? null : field("arrived", "Início do atendimento", "Quando o técnico começou na loja (o tempo conta daqui)")}
          {ticket.resolved_at ? field("resolved", "Término", "Quando o atendimento acabou") : null}
          {finished ? (
            <Field
              label="Tempo de atendimento (minutos)"
              hint={errors.minutes ? undefined : `${formatMinutes(Number(shownMinutes))}. Menor que o intervalo quando houve pausa.`}
            >
              <Input
                inputMode="numeric"
                value={shownMinutes}
                onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ""))}
                className={clsx(errors.minutes && "border-red-400")}
                aria-invalid={errors.minutes ? true : undefined}
              />
              {errors.minutes ? <span className="text-xs font-medium text-red-700 dark:text-red-300">{errors.minutes}</span> : null}
            </Field>
          ) : running ? (
            <p className="self-end text-xs text-ink-subtle sm:col-span-1">
              O atendimento está correndo: o tempo é corrigido depois que a OS for concluída.
            </p>
          ) : null}
          <div className="sm:col-span-2">
            <Field label="Motivo" required hint={errors.reason ? undefined : "Fica no histórico da OS (o técnico não vê)."}>
              <Textarea
                rows={2}
                value={reason}
                maxLength={500}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Ex.: técnico esqueceu de concluir no app; confirmado com a loja por telefone."
                aria-invalid={errors.reason ? true : undefined}
              />
              {errors.reason ? <span className="text-xs font-medium text-red-700 dark:text-red-300">{errors.reason}</span> : null}
            </Field>
          </div>
          {save.error ? (
            <div className="sm:col-span-2">
              <ErrorBox
                message={
                  isVersionConflict(save.error)
                    ? "A OS mudou enquanto isso. Conferimos os horários: revise e salve de novo."
                    : errorMessage(save.error)
                }
              />
            </div>
          ) : null}
        </form>
      )}
    </Dialog>
  );
}

/** Botão de relógio das listas (ao lado do "Editar"): abre a correção dos horários ali mesmo. */
export function TimesButton({ ticketId, code }: { ticketId: string; code: string }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const queryFn = () => api.get<TicketDetail>(`/tickets/${ticketId}`);
  const ticket = useQuery({ queryKey: ["ticket", ticketId], queryFn, enabled: open });
  const start = async () => {
    setLoading(true);
    try {
      // Carrega a OS antes de abrir: se falhar, avisa (o botão não fica parado sem resposta).
      await queryClient.fetchQuery({ queryKey: ["ticket", ticketId], queryFn, staleTime: 10_000 });
      setOpen(true);
    } catch (error) {
      toast({ title: `Não foi possível abrir ${code}`, description: errorMessage(error), tone: "error" });
    } finally {
      setLoading(false);
    }
  };
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!loading) void start();
        }}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-ink-muted shadow-elev-1 transition-[border-color,background-color,transform] duration-150 hover:border-brand/40 hover:bg-brand-soft hover:text-brand active:translate-y-px"
        aria-label={`Corrigir horários de ${code}`}
        title={`Corrigir horários de ${code}`}
        aria-busy={loading || undefined}
      >
        {loading ? <Spinner className="size-4" /> : <Clock className="size-4" />}
      </button>
      {open && ticket.data ? <TimesDialog ticket={ticket.data} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
