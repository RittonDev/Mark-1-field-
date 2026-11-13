"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useToast } from "@/components/Toaster";
import { Button, Dialog, ErrorBox, Field, Select, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { RESPONSIBILITY } from "@/lib/constants";
import { useUnproductiveReasons } from "@/lib/queries";
import type { TicketDetail, TicketStatus } from "@/lib/types";
import { isVersionConflict } from "./useConflictHandler";

/** Estados em que a visita pode ser improdutiva (espelha UNPRODUCTIVE_FROM no backend). */
export const UNPRODUCTIVE_FROM: TicketStatus[] = ["assigned", "scheduled", "en_route", "in_progress"];

/**
 * Registra a visita improdutiva (o técnico foi e não atendeu). A OS volta para Atribuído sem agenda;
 * com `onDone`, quem abriu já segue para o reagendamento.
 */
export function UnproductiveDialog({
  ticket,
  onClose,
  onDone,
}: {
  ticket: TicketDetail;
  onClose: () => void;
  /** Depois de registrar (ex.: o editor abre o "Agendar visita"). */
  onDone?: (updated: TicketDetail) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const reasons = useUnproductiveReasons(true);
  const [reasonId, setReasonId] = useState("");
  const [note, setNote] = useState("");
  const save = useMutation({
    mutationFn: () =>
      api.post<TicketDetail>(`/tickets/${ticket.id}/unproductive`, {
        reason_id: reasonId,
        note: note.trim() || null,
        expected_version: ticket.version,
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(["ticket", ticket.id], updated);
      queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id] });
      queryClient.invalidateQueries({ queryKey: ["tickets"] });
      toast({
        title: `${ticket.code}: visita improdutiva registrada`,
        description: onDone ? "Agora escolha a nova data da visita." : "A OS voltou para Atribuído, sem agenda, para reagendar.",
        tone: "success",
      });
      onClose();
      onDone?.(updated);
    },
    onError: (error) => {
      // A OS mudou enquanto isso: recarrega e a pessoa confirma de novo com os dados novos.
      if (isVersionConflict(error)) void queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id] });
    },
  });
  const selected = reasons.data?.find((r) => r.id === reasonId);
  const submit = () => {
    if (reasonId && !save.isPending) save.mutate();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      dirty={Boolean(reasonId || note.trim())}
      busy={save.isPending}
      title="Visita improdutiva"
      description="O técnico foi ao local e não conseguiu atender. A OS volta para Atribuído, sem agenda, para reagendar."
      footer={
        <>
          <Button onClick={onClose}>Voltar</Button>
          <Button variant="danger" type="submit" form="unproductive-form" disabled={!reasonId} loading={save.isPending}>
            Registrar
          </Button>
        </>
      }
    >
      <form
        id="unproductive-form"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Motivo" required>
          <Select value={reasonId} onChange={(e) => setReasonId(e.target.value)} disabled={reasons.isLoading} autoFocus>
            <option value="">{reasons.isLoading ? "Carregando motivos..." : "Selecione..."}</option>
            {(reasons.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        {reasons.error ? <ErrorBox message={`Não foi possível carregar os motivos: ${errorMessage(reasons.error)}`} /> : null}
        {selected ? (
          <p className="-mt-2 text-xs text-ink-muted">Responsabilidade: {RESPONSIBILITY[selected.responsibility].label}</p>
        ) : null}
        <Field label="Observação" hint="Fica no histórico da OS.">
          <Textarea
            rows={3}
            value={note}
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Ex.: loja fechada para inventário, gerente pediu retorno amanhã"
          />
        </Field>
        {save.error ? (
          <ErrorBox
            message={
              isVersionConflict(save.error)
                ? "A OS mudou enquanto isso. Atualizamos os dados: confira e registre de novo."
                : errorMessage(save.error)
            }
          />
        ) : null}
      </form>
    </Dialog>
  );
}
