"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Clock } from "lucide-react";
import { useMemo, useState } from "react";
import { useToast } from "@/components/Toaster";
import { Button, Dialog, ErrorBox, Field, Input, Spinner, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { formatMinutes, fromLocalInput, toLocalInput } from "@/lib/format";
import type { TicketDetail, TicketEvent } from "@/lib/types";

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

/**
 * Corrigir os horários reais da OS (só a central: o técnico nunca mexe no horário). Ex.: o técnico
 * esqueceu de iniciar ou de concluir no app. Muda a OS e o histórico de status, com o motivo.
 */
export function TimesDialog({ ticket, onClose }: { ticket: TicketDetail; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
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
  // Valores digitados (datetime-local); sem edição, vale o atual.
  const [edits, setEdits] = useState<{ enRoute?: string; arrived?: string; resolved?: string }>({});
  const [minutes, setMinutes] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const value = (key: "enRoute" | "arrived" | "resolved") => edits[key] ?? toLocalInput(original[key]);
  const iso = (key: "enRoute" | "arrived" | "resolved") => (edits[key] !== undefined ? fromLocalInput(edits[key]!) : original[key]);
  // Tempo de atendimento: acompanha início e término enquanto a central não digitar outro (pausa).
  const start = iso("arrived");
  const end = iso("resolved");
  const autoMinutes = start && end ? minutesBetween(start, end) : (ticket.actual_minutes ?? 0);
  const shownMinutes = minutes ?? String(edits.arrived !== undefined || edits.resolved !== undefined ? autoMinutes : (ticket.actual_minutes ?? 0));

  const changed = (key: "enRoute" | "arrived" | "resolved") =>
    edits[key] !== undefined && edits[key] !== toLocalInput(original[key]) && Boolean(fromLocalInput(edits[key]!));

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { reason: reason.trim(), expected_version: ticket.version };
      if (changed("enRoute")) body.en_route_at = fromLocalInput(edits.enRoute!);
      if (changed("arrived")) body.arrived_at = fromLocalInput(edits.arrived!);
      if (changed("resolved")) body.resolved_at = fromLocalInput(edits.resolved!);
      if (finished && minutes !== null && Number(minutes) !== (ticket.actual_minutes ?? 0)) body.work_minutes = Number(minutes);
      return api.put<TicketDetail>(`/tickets/${ticket.id}/times`, body);
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(["ticket", ticket.id], updated);
      void queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id] });
      void queryClient.invalidateQueries({ queryKey: ["tickets"] });
      toast({ title: "Horários corrigidos", description: `${ticket.code}: o histórico registra o motivo.`, tone: "success" });
      onClose();
    },
  });

  const nothing =
    !changed("enRoute") &&
    !changed("arrived") &&
    !changed("resolved") &&
    !(finished && minutes !== null && Number(minutes) !== (ticket.actual_minutes ?? 0));
  const minutesInvalid = finished && (!/^\d+$/.test(shownMinutes) || Number(shownMinutes) > 60 * 24 * 14);

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Corrigir horários · ${ticket.code}`}
      description="Só a central mexe no horário. Use quando o técnico esqueceu de iniciar ou de concluir no app."
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={nothing || reason.trim().length < 3 || minutesInvalid}
            onClick={() => save.mutate()}
          >
            Salvar horários
          </Button>
        </>
      }
    >
      {!ticket.arrived_at ? (
        <p className="text-sm text-ink-muted">O atendimento desta OS ainda não começou: não há horário real para corrigir.</p>
      ) : events.isLoading ? (
        <div className="flex justify-center py-6">
          <Spinner className="size-5" />
        </div>
      ) : (
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!nothing && reason.trim().length >= 3 && !minutesInvalid) save.mutate();
          }}
        >
          {original.enRoute ? (
            <Field label="Saída para o local">
              <Input
                type="datetime-local"
                value={value("enRoute")}
                onChange={(e) => setEdits((d) => ({ ...d, enRoute: e.target.value }))}
              />
            </Field>
          ) : null}
          <Field label="Início do atendimento" hint="Quando o técnico começou na loja (o tempo conta daqui)">
            <Input
              type="datetime-local"
              value={value("arrived")}
              onChange={(e) => setEdits((d) => ({ ...d, arrived: e.target.value }))}
            />
          </Field>
          {ticket.resolved_at ? (
            <Field label="Término" hint="Quando o atendimento acabou">
              <Input
                type="datetime-local"
                value={value("resolved")}
                onChange={(e) => setEdits((d) => ({ ...d, resolved: e.target.value }))}
              />
            </Field>
          ) : null}
          {finished ? (
            <Field
              label="Tempo de atendimento (minutos)"
              hint={
                /^\d+$/.test(shownMinutes)
                  ? `${formatMinutes(Number(shownMinutes))}. Menor que o intervalo quando houve pausa.`
                  : "Só números."
              }
            >
              <Input
                inputMode="numeric"
                value={shownMinutes}
                onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ""))}
                className={clsx(minutesInvalid && "border-red-400")}
              />
            </Field>
          ) : running ? (
            <p className="self-end text-xs text-ink-subtle sm:col-span-1">
              O atendimento está correndo: o tempo é corrigido depois que a OS for concluída.
            </p>
          ) : null}
          <div className="sm:col-span-2">
            <Field label="Motivo" required hint="Fica no histórico da OS (o técnico não vê).">
              <Textarea
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Ex.: técnico esqueceu de concluir no app; confirmado com a loja por telefone."
              />
            </Field>
          </div>
          {save.error ? (
            <div className="sm:col-span-2">
              <ErrorBox message={errorMessage(save.error)} />
            </div>
          ) : null}
        </form>
      )}
    </Dialog>
  );
}

/** Botão de relógio das listas (ao lado do "Editar"): abre a correção dos horários ali mesmo. */
export function TimesButton({ ticketId, code }: { ticketId: string; code: string }) {
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
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-ink-muted shadow-elev-1 transition-[border-color,background-color,transform] duration-150 hover:border-brand/40 hover:bg-brand-soft hover:text-brand active:translate-y-px"
        aria-label={`Corrigir horários de ${code}`}
        title={`Corrigir horários de ${code}`}
      >
        {open && ticket.isLoading ? <Spinner className="size-4" /> : <Clock className="size-4" />}
      </button>
      {open && ticket.data ? <TimesDialog ticket={ticket.data} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
