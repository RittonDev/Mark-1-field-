"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Button, ErrorBox, Field, Input, LoadingBlock, Table, Td, Textarea, Th } from "@/components/ui";
import { useNow } from "@/components/useNow";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets } from "@/lib/constants";
import { formatDateTime, formatMinutes, fromLocalInput, toLocalInput } from "@/lib/format";
import type { UUID, Worklog } from "@/lib/types";
import { useInvalidateTicket, useTicketErrorHandler } from "./useConflictHandler";

const nowInput = () => toLocalInput(new Date().toISOString());

/** Apontamentos de horas da central (o tempo do técnico é o da OS: corre do início à conclusão). */
export function WorklogsTab({ ticketId, closed }: { ticketId: UUID; closed: boolean }) {
  const { user } = useAuth();
  const now = useNow(60_000);
  const invalidate = useInvalidateTicket(ticketId, { lists: false, parts: ["worklogs"] });
  const onError = useTicketErrorHandler(ticketId);
  const [description, setDescription] = useState("");
  const [startedAt, setStartedAt] = useState(nowInput);
  const [minutes, setMinutes] = useState("");

  const worklogs = useQuery({
    queryKey: ["ticket", ticketId, "worklogs"],
    queryFn: () => api.get<Worklog[]>(`/tickets/${ticketId}/worklogs`),
  });

  // O campo está no horário da operação (São Paulo): a conta usa o instante convertido, não o fuso do computador.
  const startedIso = fromLocalInput(startedAt);
  const create = useMutation({
    mutationFn: () =>
      api.post<Worklog>(`/tickets/${ticketId}/worklogs`, {
        description: description.trim(),
        started_at: startedIso,
        minutes: Number(minutes),
      }),
    onSuccess: () => {
      setDescription("");
      setStartedAt(nowInput());
      setMinutes("");
      invalidate();
    },
    onError,
  });

  const items = [...(worklogs.data ?? [])].sort((a, b) => b.started_at.localeCompare(a.started_at));
  const total = items.reduce((sum, w) => sum + w.minutes, 0);
  const canLog = canManageTickets(user?.role) && !closed;
  const minutesValue = Number(minutes);
  const minutesOk = Number.isInteger(minutesValue) && minutesValue >= 1 && minutesValue <= 1440;
  const minutesError = minutes && !minutesOk ? "Use minutos inteiros, de 1 a 1440" : null;
  const startedError = startedIso && Date.parse(startedIso) > now + 60_000 ? "O início não pode ficar no futuro" : null;
  const valid = Boolean(description.trim() && startedIso && minutes && !minutesError && !startedError);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2 text-sm">
        <span className="text-ink-muted">Tempo total apontado</span>
        <span className="font-semibold text-ink tabular-nums">{formatMinutes(total)}</span>
      </div>

      {worklogs.isLoading ? (
        <LoadingBlock rows={2} />
      ) : worklogs.error ? (
        <ErrorBox message={errorMessage(worklogs.error)} />
      ) : items.length === 0 ? (
        <p className="text-sm text-ink-muted">Nenhum apontamento registrado.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line">
          <Table>
            <thead>
              <tr>
                <Th>Quem apontou</Th>
                <Th>Atividade</Th>
                <Th>Início</Th>
                <Th className="text-right">Duração</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((w) => (
                <tr key={w.id}>
                  <Td className="font-semibold whitespace-nowrap">{w.user?.name ?? "—"}</Td>
                  <Td className="whitespace-pre-wrap">{w.description}</Td>
                  <Td className="text-xs whitespace-nowrap text-ink-muted">{formatDateTime(w.started_at)}</Td>
                  <Td className="text-right tabular-nums">{formatMinutes(w.minutes)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}

      {canLog ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !create.isPending) create.mutate();
          }}
          noValidate
          className="grid gap-3 rounded-lg border border-line bg-surface-2 p-3 sm:grid-cols-[1fr_12rem_7rem] sm:items-start"
        >
          <Field label="Atividade executada" required className="sm:col-span-3">
            <Textarea
              rows={2}
              value={description}
              maxLength={5000}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Ex.: Troca do fusor e teste de impressão"
            />
          </Field>
          <Field label="Início" required>
            <Input
              type="datetime-local"
              value={startedAt}
              max={toLocalInput(new Date(now).toISOString())}
              onChange={(e) => setStartedAt(e.target.value)}
              aria-invalid={startedError ? true : undefined}
            />
            {startedError ? <span className="text-xs font-medium text-red-700 dark:text-red-300">{startedError}</span> : null}
          </Field>
          <Field label="Minutos" required>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={1440}
              step={1}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              aria-invalid={minutesError ? true : undefined}
            />
            {minutesError ? <span className="text-xs font-medium text-red-700 dark:text-red-300">{minutesError}</span> : null}
          </Field>
          <div className="flex items-end self-stretch">
            <Button type="submit" variant="primary" className="w-full" disabled={!valid} loading={create.isPending}>
              {create.isPending ? null : <Plus className="size-4" />}
              Apontar
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
