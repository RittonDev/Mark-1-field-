"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Clock, Plus } from "lucide-react";
import { useState } from "react";
import { Button, EmptyState, ErrorBox, Field, Input, LoadingBlock, Table, Td, Textarea, Th } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { isStaff } from "@/lib/constants";
import { formatDateTime, formatMinutes, fromLocalInput } from "@/lib/format";
import type { UUID, Worklog } from "@/lib/types";
import { useInvalidateTicket, useTicketErrorHandler } from "./useConflictHandler";

export function WorklogsTab({ ticketId, closed }: { ticketId: UUID; closed: boolean }) {
  const { user } = useAuth();
  const invalidate = useInvalidateTicket(ticketId);
  const onError = useTicketErrorHandler(ticketId);
  const [description, setDescription] = useState("");
  const [startedAt, setStartedAt] = useState("");
  const [minutes, setMinutes] = useState("");

  const worklogs = useQuery({
    queryKey: ["ticket", ticketId, "worklogs"],
    queryFn: () => api.get<Worklog[]>(`/tickets/${ticketId}/worklogs`),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<Worklog>(`/tickets/${ticketId}/worklogs`, {
        description: description.trim(),
        started_at: fromLocalInput(startedAt),
        minutes: Number(minutes),
      }),
    onSuccess: () => {
      setDescription("");
      setStartedAt("");
      setMinutes("");
      invalidate();
    },
    onError,
  });

  const items = [...(worklogs.data ?? [])].sort((a, b) => b.started_at.localeCompare(a.started_at));
  const total = items.reduce((sum, w) => sum + w.minutes, 0);
  const canLog = isStaff(user?.role) && !closed;
  const valid = description.trim() && startedAt && Number(minutes) > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2 text-sm">
        <span className="text-ink-muted">Tempo total apontado</span>
        <span className="font-semibold text-ink tabular-nums">{formatMinutes(total)}</span>
      </div>

      {worklogs.isLoading ? (
        <LoadingBlock />
      ) : worklogs.error ? (
        <ErrorBox message={errorMessage(worklogs.error)} />
      ) : items.length === 0 ? (
        <EmptyState icon={<Clock className="size-7" />} title="Nenhum apontamento registrado" />
      ) : (
        <div className="overflow-hidden rounded-lg border border-line">
          <Table>
            <thead>
              <tr>
                <Th>Técnico</Th>
                <Th>Atividade</Th>
                <Th>Início</Th>
                <Th className="text-right">Duração</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((w) => (
                <tr key={w.id}>
                  <Td className="whitespace-nowrap">{w.user?.name ?? "—"}</Td>
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
            if (valid) create.mutate();
          }}
          className="grid gap-3 rounded-lg border border-line bg-surface-2 p-3 sm:grid-cols-[1fr_12rem_7rem]"
        >
          <Field label="Atividade executada" required className="sm:col-span-3">
            <Textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Ex.: Troca do fusor e teste de impressão"
            />
          </Field>
          <Field label="Início" required>
            <Input type="datetime-local" value={startedAt} onChange={(e) => setStartedAt(e.target.value)} />
          </Field>
          <Field label="Minutos" required>
            <Input type="number" min={1} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          </Field>
          <div className="flex items-end">
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
