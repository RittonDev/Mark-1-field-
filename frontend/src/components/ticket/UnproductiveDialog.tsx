"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useToast } from "@/components/Toaster";
import { Button, Dialog, ErrorBox, Field, Select, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { RESPONSIBILITY } from "@/lib/constants";
import { useUnproductiveReasons } from "@/lib/queries";
import type { TicketDetail, TicketStatus } from "@/lib/types";

/** Estados em que a visita pode ser improdutiva (espelha UNPRODUCTIVE_FROM no backend). */
export const UNPRODUCTIVE_FROM: TicketStatus[] = ["assigned", "scheduled", "en_route", "in_progress"];

export function UnproductiveDialog({ ticket, onClose }: { ticket: TicketDetail; onClose: () => void }) {
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
      toast({ title: `${ticket.code}: visita improdutiva registrada`, description: "A OS voltou para reagendar.", tone: "success" });
      onClose();
    },
  });
  const selected = reasons.data?.find((r) => r.id === reasonId);

  return (
    <Dialog
      open
      onClose={onClose}
      title="Visita improdutiva"
      description="O técnico foi ao local e não conseguiu atender. A OS volta para Atribuído, sem agenda, para reagendar."
      footer={
        <>
          <Button onClick={onClose}>Voltar</Button>
          <Button variant="danger" disabled={!reasonId} loading={save.isPending} onClick={() => save.mutate()}>
            Registrar
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Motivo" required>
          <Select value={reasonId} onChange={(e) => setReasonId(e.target.value)}>
            <option value="">Selecione...</option>
            {(reasons.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        {selected ? (
          <p className="-mt-2 text-xs text-ink-muted">Responsabilidade: {RESPONSIBILITY[selected.responsibility].label}</p>
        ) : null}
        <Field label="Observação">
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: loja fechada para inventário, gerente pediu retorno amanhã" />
        </Field>
        {save.error ? <ErrorBox message={errorMessage(save.error)} /> : null}
      </div>
    </Dialog>
  );
}
