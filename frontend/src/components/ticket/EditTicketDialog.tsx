"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useToast } from "@/components/Toaster";
import { Button, Dialog, ErrorBox, Field, Input, Select, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { computePriority, LEVEL, LEVEL_ORDER, PRIORITY, PRIORITY_ORDER, TICKET_TYPE } from "@/lib/constants";
import { useCategories, useTeams } from "@/lib/queries";
import type { Level, TicketDetail, TicketPriority, TicketType, TicketUpdatePayload } from "@/lib/types";
import { useTicketErrorHandler } from "./useConflictHandler";

/** Edição dos dados da OS. Monte só quando aberto para o formulário nascer com os dados atuais. */
export function EditTicketDialog({ ticket, onClose }: { ticket: TicketDetail; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const onError = useTicketErrorHandler(ticket.id);
  const categories = useCategories();
  const teams = useTeams();
  const [title, setTitle] = useState(ticket.title);
  const [description, setDescription] = useState(ticket.description);
  const [type, setType] = useState<TicketType>(ticket.type);
  const [categoryId, setCategoryId] = useState(ticket.category?.id ?? "");
  const [teamId, setTeamId] = useState(ticket.team?.id ?? "");
  const [impact, setImpact] = useState<Level>(ticket.impact);
  const [urgency, setUrgency] = useState<Level>(ticket.urgency);
  const [priority, setPriority] = useState<TicketPriority>(ticket.priority);

  const sortedCategories = useMemo(
    () => [...(categories.data ?? [])].sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [categories.data],
  );

  const mutation = useMutation({
    mutationFn: () => {
      const payload: TicketUpdatePayload = { expected_version: ticket.version };
      if (title.trim() !== ticket.title) payload.title = title.trim();
      if (description !== ticket.description) payload.description = description;
      if (type !== ticket.type) payload.type = type;
      if (categoryId !== (ticket.category?.id ?? "")) payload.category_id = categoryId || null;
      if (teamId !== (ticket.team?.id ?? "")) payload.team_id = teamId || null;
      if (impact !== ticket.impact) payload.impact = impact;
      if (urgency !== ticket.urgency) payload.urgency = urgency;
      if (priority !== ticket.priority) payload.priority = priority;
      return api.patch<TicketDetail>(`/tickets/${ticket.id}`, payload);
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(["ticket", ticket.id], updated);
      queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id] });
      queryClient.invalidateQueries({ queryKey: ["tickets"] });
      toast({ title: `${updated.code} atualizada`, tone: "success" });
      onClose();
    },
    onError: (error) => {
      onError(error);
      onClose();
    },
  });

  const onLevelChange = (nextImpact: Level, nextUrgency: Level) => {
    setImpact(nextImpact);
    setUrgency(nextUrgency);
    setPriority(computePriority(nextImpact, nextUrgency));
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Editar ${ticket.code}`}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" type="submit" form="edit-ticket" loading={mutation.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      <form
        id="edit-ticket"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
        className="grid gap-4 sm:grid-cols-2"
      >
        <Field label="Título" required className="sm:col-span-2">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} minLength={3} maxLength={200} required />
        </Field>
        <Field label="Descrição" className="sm:col-span-2">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={5} />
        </Field>
        <Field label="Tipo">
          <Select value={type} onChange={(e) => setType(e.target.value as TicketType)}>
            {Object.entries(TICKET_TYPE).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Categoria">
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Sem categoria</option>
            {sortedCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.full_name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Grupo técnico">
          <Select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            <option value="">Sem grupo</option>
            {teams.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Impacto">
            <Select value={impact} onChange={(e) => onLevelChange(e.target.value as Level, urgency)}>
              {LEVEL_ORDER.map((l) => (
                <option key={l} value={l}>
                  {LEVEL[l]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Urgência">
            <Select value={urgency} onChange={(e) => onLevelChange(impact, e.target.value as Level)}>
              {LEVEL_ORDER.map((l) => (
                <option key={l} value={l}>
                  {LEVEL[l]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Prioridade" hint="Recalculada pela matriz ao mudar impacto/urgência; pode ser ajustada.">
          <Select value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)}>
            {PRIORITY_ORDER.map((p) => (
              <option key={p} value={p}>
                {PRIORITY[p].code} · {PRIORITY[p].label}
              </option>
            ))}
          </Select>
        </Field>
        {mutation.error ? (
          <div className="sm:col-span-2">
            <ErrorBox message={errorMessage(mutation.error)} />
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}
