"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { LocationPicker } from "@/components/LocationPicker";
import { useToast } from "@/components/Toaster";
import { Button, Dialog, ErrorBox, Field, Input, Select, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets, computePriority, LEVEL, LEVEL_ORDER, PRIORITY, PRIORITY_ORDER, TICKET_TYPE } from "@/lib/constants";
import { useProjects } from "@/lib/projects";
import { useCategories, useServiceTypes } from "@/lib/queries";
import Link from "next/link";
import { formatDateTime, formatMinutes } from "@/lib/format";
import type { Level, Location, TicketDetail, TicketPriority, TicketType, TicketUpdatePayload } from "@/lib/types";
import { useTicketErrorHandler } from "./useConflictHandler";

/** Edição dos dados da OS. Monte só quando aberto para o formulário nascer com os dados atuais. */
export function EditTicketDialog({
  ticket,
  onClose,
  headerExtra,
}: {
  ticket: TicketDetail;
  onClose: () => void;
  /** Resumo da situação (status etc.), usado quando o lápis abre a edição a partir das listas. */
  headerExtra?: React.ReactNode;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const onError = useTicketErrorHandler(ticket.id);
  const categories = useCategories();
  const [title, setTitle] = useState(ticket.title);
  const [description, setDescription] = useState(ticket.description);
  const [type, setType] = useState<TicketType>(ticket.type);
  const [categoryId, setCategoryId] = useState(ticket.category?.id ?? "");
  const { user } = useAuth();
  const projects = useProjects({ enabled: canManageTickets(user?.role) });
  const [projectId, setProjectId] = useState(ticket.project?.id ?? "");
  const [urgency, setUrgency] = useState<Level>(ticket.urgency);
  const [priority, setPriority] = useState<TicketPriority>(ticket.priority);
  // Troca de local: busca restrita ao cliente da OS; null = manter o atual.
  const [newLocation, setNewLocation] = useState<Location | null>(null);
  const [serviceAddress, setServiceAddress] = useState(ticket.service_address ?? "");
  const serviceTypes = useServiceTypes({ customerId: ticket.customer?.id ?? null, active: true });
  const [serviceTypeId, setServiceTypeId] = useState(ticket.service_type?.id ?? "");
  const [estimated, setEstimated] = useState(ticket.estimated_minutes ? String(ticket.estimated_minutes) : "");

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
      if (projectId !== (ticket.project?.id ?? "")) payload.project_id = projectId || null;
      if (urgency !== ticket.urgency) payload.urgency = urgency;
      if (priority !== ticket.priority) payload.priority = priority;
      if (newLocation && newLocation.id !== ticket.location?.id) payload.location_id = newLocation.id;
      if (serviceAddress.trim() !== (ticket.service_address ?? "")) {
        payload.service_address = serviceAddress.trim() || null;
      }
      if (serviceTypeId && serviceTypeId !== (ticket.service_type?.id ?? "")) payload.service_type_id = serviceTypeId;
      const estimatedNumber = estimated ? Number(estimated) : null;
      if (estimatedNumber !== ticket.estimated_minutes) payload.estimated_minutes = estimatedNumber;
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

  // A urgência recalcula a prioridade pela matriz (com o impacto que a OS já tem).
  const onUrgencyChange = (nextUrgency: Level) => {
    setUrgency(nextUrgency);
    setPriority(computePriority(ticket.impact, nextUrgency));
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Editar ${ticket.code}`}
      description={
        headerExtra ? (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {headerExtra}
            <span>{ticket.assignee ? ticket.assignee.name : "Sem responsável"}</span>
            {ticket.scheduled_start ? <span>Agendada {formatDateTime(ticket.scheduled_start)}</span> : null}
            <Link href={`/chamados/${ticket.id}`} className="text-brand hover:underline">
              Abrir OS completa
            </Link>
          </span>
        ) : undefined
      }
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
        <Field
          label="Local de atendimento"
          hint={`Atual: ${ticket.location ? ticket.location.name : "nenhum"}. Busque para trocar.`}
          className="sm:col-span-2"
        >
          <LocationPicker customerId={ticket.customer?.id ?? null} value={newLocation} onChange={setNewLocation} />
        </Field>
        {canManageTickets(user?.role) ? (
          <Field label="Projeto" hint="OS de projeto seguem os valores e a equipe do projeto" className="sm:col-span-2">
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Não é de projeto (OS avulsa)</option>
              {(projects.data ?? [])
                .filter((p) => p.status === "active" || p.status === "planning" || p.id === projectId)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} · {p.name}
                    {p.customer ? ` (${p.customer.name})` : ""}
                  </option>
                ))}
            </Select>
          </Field>
        ) : null}
        <Field label="Tipo de serviço">
          <Select
            value={serviceTypeId}
            onChange={(e) => {
              const st = serviceTypes.data?.find((t) => t.id === e.target.value);
              setServiceTypeId(e.target.value);
              if (st) setEstimated(String(st.estimated_minutes));
            }}
          >
            <option value="">Nenhum</option>
            {serviceTypes.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · {formatMinutes(t.estimated_minutes)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Duração estimada (minutos)">
          <Input type="number" min={1} max={10080} value={estimated} onChange={(e) => setEstimated(e.target.value)} />
        </Field>
        <Field label="Endereço do atendimento (se diferente do local)" className="sm:col-span-2">
          <Input
            value={serviceAddress}
            onChange={(e) => setServiceAddress(e.target.value)}
            placeholder="Ex.: Doca 3, entrada pelos fundos"
            maxLength={255}
          />
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
        <Field label="Urgência">
          <Select value={urgency} onChange={(e) => onUrgencyChange(e.target.value as Level)}>
            {LEVEL_ORDER.map((l) => (
              <option key={l} value={l}>
                {LEVEL[l]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Prioridade (prazo)" hint="Recalculada ao mudar a urgência; pode ser ajustada.">
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
