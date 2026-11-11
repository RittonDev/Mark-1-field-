"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { StatusBadge } from "@/components/badges";
import { useToast } from "@/components/Toaster";
import { Button, Checkbox, Dialog, ErrorBox, Field, Input, Textarea } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api";
import { STATUS, TRANSITION_ACTION } from "@/lib/constants";
import { fromLocalInput, toLocalInput } from "@/lib/format";
import type { TicketDetail, TicketStatus, TicketTransitionPayload, UUID } from "@/lib/types";
import { transitionRequirements } from "@/lib/workflow";

export interface TransitionTarget {
  id: UUID;
  code: string;
  title: string;
  status: TicketStatus;
  version: number;
  scheduled_start: string | null;
  scheduled_end: string | null;
}

function currentPosition(): Promise<{ latitude: number; longitude: number } | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 },
    );
  });
}

/**
 * Confirma a mudança de status pedindo só o que o destino exige
 * (agenda, solução, motivo). Monte com `key={destino}` para zerar o formulário.
 */
export function TransitionDialog({
  ticket,
  to,
  onClose,
}: {
  ticket: TransitionTarget;
  to: TicketStatus;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const req = transitionRequirements(to);
  const [note, setNote] = useState("");
  const [resolution, setResolution] = useState("");
  const [start, setStart] = useState(() => toLocalInput(ticket.scheduled_start));
  const [end, setEnd] = useState(() => toLocalInput(ticket.scheduled_end));
  const [shareLocation, setShareLocation] = useState(req.offersLocation);
  const [localError, setLocalError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: TicketTransitionPayload = {
        to_status: to,
        note: note.trim() || null,
        expected_version: ticket.version,
      };
      if (req.needsResolution) payload.resolution_notes = resolution.trim();
      if (req.needsSchedule) {
        payload.scheduled_start = fromLocalInput(start);
        payload.scheduled_end = fromLocalInput(end);
      }
      if (req.offersLocation && shareLocation) {
        const pos = await currentPosition();
        if (pos) Object.assign(payload, pos);
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
      if (error instanceof ApiError && error.status === 409) {
        queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id] });
        queryClient.invalidateQueries({ queryKey: ["tickets"] });
        toast({
          title: "A OS foi alterada por outra pessoa",
          description: "Recarregamos os dados. Confira o status atual e tente de novo.",
          tone: "error",
        });
        onClose();
      }
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);
    if (req.needsSchedule && !start) return setLocalError("Informe a data e hora da visita.");
    if (req.needsResolution && !resolution.trim()) return setLocalError("Descreva a solução aplicada.");
    if (req.needsNote && !note.trim()) return setLocalError("Informe o motivo.");
    mutation.mutate();
  }

  const error = localError ?? (mutation.error ? errorMessage(mutation.error) : null);

  return (
    <Dialog
      open
      onClose={onClose}
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
            type="submit"
            form="transition-form"
          >
            Confirmar
          </Button>
        </>
      }
    >
      <form id="transition-form" onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm text-ink-muted">{STATUS[to].description}</p>
        {req.needsSchedule ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Início da visita" required>
              <Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} required />
            </Field>
            <Field label="Fim previsto">
              <Input type="datetime-local" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} />
            </Field>
          </div>
        ) : null}
        {req.needsResolution ? (
          <Field label="Solução aplicada" required hint="Fica visível para o solicitante e no histórico da OS.">
            <Textarea
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              rows={4}
              placeholder="O que foi feito para resolver?"
              autoFocus
            />
          </Field>
        ) : null}
        <Field label={req.needsNote ? "Motivo" : "Observação"} required={req.needsNote}>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder={req.needsNote ? "Explique o motivo" : "Opcional"}
            autoFocus={!req.needsResolution && !req.needsSchedule}
          />
        </Field>
        {req.offersLocation ? (
          <Checkbox
            label="Registrar minha localização (check-in de campo)"
            checked={shareLocation}
            onChange={setShareLocation}
          />
        ) : null}
        {error ? <ErrorBox message={error} /> : null}
      </form>
    </Dialog>
  );
}
