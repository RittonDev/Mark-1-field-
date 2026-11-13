"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Hand, MapPin, Phone, Star, ThumbsUp, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { LocationPicker } from "@/components/LocationPicker";
import { ConflictHint, ConflictList, scheduleConflicts } from "@/components/ScheduleConflict";
import { useToast } from "@/components/Toaster";
import { HelpersField, SuggestedTechnicians } from "@/components/new-ticket/SuggestedTechnicians";
import { PayoutLine } from "@/components/ticket/PayoutsCard";
import { TransitionDialog } from "@/components/ticket/TransitionDialog";
import { ErrorBox, Field, Input, SectionTitle, Select, Textarea } from "@/components/ui";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { PRIORITY, PRIORITY_ORDER, STATUS, STATUS_ORDER } from "@/lib/constants";
import { formatDateTime, formatMinutes, formatMoney, fromLocalInput, toLocalInput } from "@/lib/format";
import { useProjects } from "@/lib/projects";
import { useAssignable, useCategories, useCustomers, useServiceTypes } from "@/lib/queries";
import type {
  ConflictItem,
  IntakeContext,
  Location,
  QueuesOut,
  Tag,
  TechnicianSuggestion,
  TicketDetail,
  TicketPriority,
  TicketStatus,
  TicketUpdatePayload,
  UUID,
} from "@/lib/types";

export const GENERAL_FORM_ID = "ticket-general";

const split = (iso: string | null | undefined) => {
  const local = toLocalInput(iso);
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
};
const join = (date: string, time: string) => (date && time ? fromLocalInput(`${date}T${time}`) : null);
const sameList = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

interface FormState {
  title: string;
  serviceTypeId: string;
  categoryId: string;
  priority: TicketPriority;
  tags: Tag[];
  customerId: string;
  locationId: string;
  locationLabel: string;
  serviceAddress: string;
  description: string;
  estimated: string;
  date: string;
  time: string;
  assigneeId: string;
  helperIds: UUID[];
  ownerId: string;
  projectId: string;
  visitNote: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  resolutionNotes: string;
  timesReason: string;
}

function initial(t: TicketDetail): FormState {
  const scheduled = split(t.scheduled_start);
  const start = split(t.arrived_at);
  const end = split(t.resolved_at);
  return {
    title: t.title,
    serviceTypeId: t.service_type?.id ?? "",
    categoryId: t.category?.id ?? "",
    priority: t.priority,
    tags: t.tags ?? [],
    customerId: t.customer?.id ?? "",
    locationId: t.location?.id ?? "",
    locationLabel: t.location ? [t.location.name, t.location.code].filter(Boolean).join(" - ") : "",
    serviceAddress: t.service_address ?? "",
    description: t.description ?? "",
    estimated: t.estimated_minutes ? String(t.estimated_minutes) : "",
    date: scheduled.date,
    time: scheduled.time,
    assigneeId: t.assignee?.id ?? "",
    helperIds: (t.helpers ?? []).map((h) => h.id),
    ownerId: t.owner?.id ?? "",
    projectId: t.project?.id ?? "",
    visitNote: t.visit_note ?? "",
    startDate: start.date,
    startTime: start.time,
    endDate: end.date,
    endTime: end.time,
    resolutionNotes: t.resolution_notes ?? "",
    timesReason: "",
  };
}

function Counter({ value, max }: { value: string; max: number }) {
  return (
    <span className={clsx("self-end text-[11px] tabular-nums", value.length > max ? "text-red-600" : "text-ink-subtle")}>
      {value.length} / {max}
    </span>
  );
}

/** Etiquetas da OS (ex.: "Adicional Noturno"): tira com o ×, inclui escolhendo ou digitando. */
function TagsField({ value, onChange }: { value: Tag[]; onChange: (tags: Tag[]) => void }) {
  const [draft, setDraft] = useState("");
  const known = useQuery({ queryKey: ["ticket-tags"], queryFn: () => api.get<Tag[]>("/ticket-tags"), staleTime: 5 * 60_000 });
  const add = (name: string) => {
    const clean = name.trim();
    if (!clean || value.some((t) => t.name.toLowerCase() === clean.toLowerCase())) return setDraft("");
    const match = known.data?.find((t) => t.name.toLowerCase() === clean.toLowerCase());
    onChange([...value, match ?? { name: clean, color: null }]);
    setDraft("");
  };
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1.5">
      {value.map((t) => (
        <span key={t.name} className="inline-flex items-center gap-1 rounded-full bg-brand-soft py-0.5 pr-1 pl-2.5 text-xs font-medium text-brand-ink">
          {t.name}
          <button
            type="button"
            onClick={() => onChange(value.filter((x) => x.name !== t.name))}
            className="rounded-full p-0.5 hover:bg-brand/15"
            aria-label={`Tirar a etiqueta ${t.name}`}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        list="ticket-tags-list"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(draft);
          }
        }}
        onBlur={() => draft && add(draft)}
        placeholder={value.length ? "+ etiqueta" : "Incluir etiqueta (ex.: Adicional Noturno)"}
        className="h-7 min-w-44 flex-1 rounded-md bg-transparent px-1.5 text-xs text-ink outline-none placeholder:text-ink-subtle"
        aria-label="Incluir etiqueta"
      />
      <datalist id="ticket-tags-list">
        {(known.data ?? []).map((t) => (
          <option key={t.name} value={t.name} />
        ))}
      </datalist>
    </div>
  );
}

/**
 * Aba "Geral" da OS, no formato do "Editar atividade" do Field Control: tudo editável pela central a
 * qualquer momento (inclusive com a OS fechada), com os técnicos mais indicados para a loja.
 */
export function GeneralTab({
  ticket,
  onSaveState,
}: {
  ticket: TicketDetail;
  /** Para o botão Salvar do rodapé (fora do formulário). */
  onSaveState: (state: { dirty: boolean; pending: boolean }) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const [form, setForm] = useState<FormState>(() => initial(ticket));
  const [base] = useState<FormState>(() => initial(ticket));
  const [changingLocation, setChangingLocation] = useState(false);
  const [conflicts, setConflicts] = useState<ConflictItem[] | null>(null);
  const [target, setTarget] = useState<TicketStatus | null>(null);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    if (key === "assigneeId" || key === "date" || key === "time" || key === "estimated" || key === "helperIds") setConflicts(null);
    setForm((f) => ({ ...f, [key]: value }));
  };

  const customers = useCustomers();
  const categories = useCategories();
  const serviceTypes = useServiceTypes({ customerId: form.customerId || null, active: true });
  const assignable = useAssignable(null);
  const projects = useProjects({ enabled: true });
  const queues = useQuery({ queryKey: ["tickets", "queues"], queryFn: () => api.get<QueuesOut>("/queues"), staleTime: 60_000 });
  const intake = useQuery({
    queryKey: ["intake", form.locationId || null, form.locationId ? null : form.customerId || null],
    queryFn: () =>
      api.get<IntakeContext>("/intake/context", {
        location_id: form.locationId || undefined,
        customer_id: form.locationId ? undefined : form.customerId || undefined,
      }),
    enabled: Boolean(form.locationId || form.customerId),
    staleTime: 30_000,
  });

  const minutes = form.estimated ? Number(form.estimated) : null;
  const startIso = join(form.date, form.time);
  // Os 5 técnicos mais indicados para a loja, o serviço e o horário (o mesmo ranking da abertura).
  const suggestions = useQuery({
    queryKey: ["technician-suggest", form.locationId, form.serviceTypeId, form.categoryId, form.projectId, startIso, minutes, ticket.id],
    queryFn: () =>
      api.get<TechnicianSuggestion[]>("/technicians/suggest", {
        location_id: form.locationId,
        service_type_id: form.serviceTypeId || undefined,
        category_id: form.categoryId || undefined,
        project_id: form.projectId || undefined,
        title: form.title.trim() || undefined,
        start: startIso ?? undefined,
        estimated_minutes: minutes ?? undefined,
        limit: 5,
      }),
    enabled: Boolean(form.locationId),
    staleTime: 30_000,
  });

  const people = useMemo(
    () =>
      [...(assignable.data ?? [])].sort(
        (a, b) => (a.role === "technician" ? 0 : 1) - (b.role === "technician" ? 0 : 1) || a.name.localeCompare(b.name),
      ),
    [assignable.data],
  );
  const names = useMemo(() => {
    const map: Record<UUID, string> = {};
    for (const p of people) map[p.id] = p.name;
    for (const h of ticket.helpers ?? []) map[h.id] ??= h.name;
    if (ticket.assignee) map[ticket.assignee.id] ??= ticket.assignee.name;
    return map;
  }, [people, ticket.helpers, ticket.assignee]);
  const analysts = useMemo(() => {
    const list = (queues.data?.queues ?? []).map((q) => q.user);
    if (ticket.owner && !list.some((u) => u.id === ticket.owner!.id)) list.push(ticket.owner);
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }, [queues.data, ticket.owner]);

  // ── o que mudou ──
  const schedChanged = form.date !== base.date || form.time !== base.time || form.estimated !== base.estimated;
  const timesChanged =
    form.startDate !== base.startDate || form.startTime !== base.startTime || form.endDate !== base.endDate || form.endTime !== base.endTime;
  const patch = useMemo<TicketUpdatePayload>(() => {
    const p: TicketUpdatePayload = {};
    if (form.title.trim() !== base.title) p.title = form.title.trim();
    if (form.description !== base.description) p.description = form.description;
    if (form.categoryId !== base.categoryId) p.category_id = form.categoryId || null;
    if (form.priority !== base.priority) p.priority = form.priority;
    if (form.serviceTypeId !== base.serviceTypeId && form.serviceTypeId) p.service_type_id = form.serviceTypeId;
    if (form.estimated !== base.estimated) p.estimated_minutes = minutes;
    if (form.customerId !== base.customerId) p.customer_id = form.customerId || null;
    if (form.locationId !== base.locationId) p.location_id = form.locationId || null;
    if (form.serviceAddress.trim() !== base.serviceAddress) p.service_address = form.serviceAddress.trim() || null;
    if (form.visitNote !== base.visitNote) p.visit_note = form.visitNote.trim() || null;
    if (!sameList(form.helperIds, base.helperIds)) p.helper_ids = form.helperIds;
    if (form.ownerId !== base.ownerId) p.owner_id = form.ownerId || null;
    if (form.projectId !== base.projectId) p.project_id = form.projectId || null;
    if (form.resolutionNotes !== base.resolutionNotes) p.resolution_notes = form.resolutionNotes.trim() || null;
    if (JSON.stringify(form.tags) !== JSON.stringify(base.tags)) p.tags = form.tags;
    if (schedChanged && startIso) {
      // Fim = início + duração (estimada ou a da agenda atual), para não sobrar um fim antigo.
      const current =
        ticket.scheduled_start && ticket.scheduled_end
          ? Math.round((new Date(ticket.scheduled_end).getTime() - new Date(ticket.scheduled_start).getTime()) / 60000)
          : null;
      const duration = minutes ?? current ?? 60;
      p.scheduled_start = startIso;
      p.scheduled_end = new Date(new Date(startIso).getTime() + duration * 60000).toISOString();
    }
    return p;
  }, [form, base, minutes, schedChanged, startIso, ticket.scheduled_start, ticket.scheduled_end]);
  const assigneeChanged = form.assigneeId !== base.assigneeId;
  const dirty = Object.keys(patch).length > 0 || assigneeChanged || timesChanged;

  const save = useMutation({
    mutationFn: async () => {
      const allow = Boolean(conflicts);
      let current = ticket;
      if (Object.keys(patch).length) {
        current = await api.patch<TicketDetail>(`/tickets/${ticket.id}`, {
          ...patch,
          expected_version: current.version,
          allow_conflict: allow,
        });
      }
      if (assigneeChanged) {
        current = await api.post<TicketDetail>(`/tickets/${ticket.id}/assign`, {
          assignee_id: form.assigneeId || null,
          expected_version: current.version,
          allow_conflict: allow,
        });
      }
      if (timesChanged) {
        const body: Record<string, unknown> = { reason: form.timesReason.trim(), expected_version: current.version };
        if (form.startDate !== base.startDate || form.startTime !== base.startTime) body.arrived_at = join(form.startDate, form.startTime);
        if (form.endDate !== base.endDate || form.endTime !== base.endTime) body.resolved_at = join(form.endDate, form.endTime);
        current = await api.put<TicketDetail>(`/tickets/${ticket.id}/times`, body);
      }
      return current;
    },
    onSuccess: (updated) => {
      setConflicts(null);
      queryClient.setQueryData(["ticket", ticket.id], updated);
      void queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id] });
      void queryClient.invalidateQueries({ queryKey: ["tickets"] });
      void queryClient.invalidateQueries({ queryKey: ["assignable"] });
      toast({ title: `${updated.code} salva`, tone: "success" });
    },
    onError: (error) => {
      const found = scheduleConflicts(error);
      if (found) return setConflicts(found);
      if (error instanceof ApiError && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id] });
      }
    },
  });

  useEffect(() => {
    onSaveState({ dirty, pending: save.isPending });
  }, [dirty, save.isPending, onSaveState]);

  const intakeCustomer = intake.data?.customer ?? null;
  const intakeLocation = intake.data?.location ?? null;
  // Convite pelo WhatsApp: só o básico (o técnico é parceiro), o bastante para ele topar ou não.
  const chosenType = serviceTypes.data?.find((s) => s.id === form.serviceTypeId) ?? null;
  const invite = (name?: string) => {
    const city = [intakeLocation?.city, intakeLocation?.state].filter(Boolean).join(" - ");
    const place = [intakeLocation?.district, city].filter(Boolean).join(", ");
    const fee = chosenType?.technician_fee ?? null;
    return [
      name ? `Olá, ${name.split(" ")[0]}! Temos um chamado da Maxx para você:` : "Pessoal, temos um chamado da Maxx:",
      `• ${chosenType?.name ?? form.title.trim()}`,
      `• ${place || "local a confirmar"}`,
      `• ${startIso ? formatDateTime(startIso) : "data a combinar"}`,
      fee != null ? `• Valor: ${formatMoney(fee)}` : null,
      name ? "Topa? Responda aqui que eu te coloco na OS." : "Quem pega? Responda aqui.",
    ]
      .filter(Boolean)
      .join("\n");
  };
  const address =
    form.serviceAddress.trim() ||
    (intakeLocation
      ? [intakeLocation.address_line, intakeLocation.district, [intakeLocation.city, intakeLocation.state].filter(Boolean).join(" - "), intakeLocation.zip_code]
          .filter(Boolean)
          .join(", ")
      : "");
  const statusOptions = [ticket.status, ...[...ticket.allowed_transitions].sort((a, b) => STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b))];
  const timesInvalid = timesChanged && form.timesReason.trim().length < 3;

  return (
    <form
      id={GENERAL_FORM_ID}
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !timesInvalid && form.title.trim().length >= 3) save.mutate();
      }}
      className="grid grid-cols-12 gap-x-4 gap-y-4"
    >
      <Field label="Identificador" className="col-span-12 sm:col-span-3">
        <Input value={ticket.code} readOnly className="bg-surface-2 font-mono text-ink-muted" />
      </Field>
      <Field label="Tipo de OS" className="col-span-12 sm:col-span-6">
        <Select
          value={form.serviceTypeId}
          onChange={(e) => {
            const st = serviceTypes.data?.find((t) => t.id === e.target.value);
            set("serviceTypeId", e.target.value);
            if (st) set("estimated", String(st.estimated_minutes));
          }}
        >
          <option value="">Sem tipo de serviço</option>
          {serviceTypes.data?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} - {t.estimated_minutes} minutos
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Categoria" className="col-span-12 sm:col-span-3">
        <Select value={form.categoryId} onChange={(e) => set("categoryId", e.target.value)}>
          <option value="">Sem categoria</option>
          {(categories.data ?? [])
            .filter((c) => c.is_active || c.id === form.categoryId)
            .sort((a, b) => a.full_name.localeCompare(b.full_name))
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.full_name}
              </option>
            ))}
        </Select>
      </Field>

      <div className="col-span-12">
        <TagsField value={form.tags} onChange={(tags) => set("tags", tags)} />
      </div>

      <Field label="Título" required className="col-span-12">
        <Input value={form.title} onChange={(e) => set("title", e.target.value)} minLength={3} maxLength={200} required />
      </Field>

      <div className="col-span-12 flex flex-col gap-1.5">
        <Field label="Cliente">
          <Select
            value={form.customerId}
            onChange={(e) => {
              const id = e.target.value;
              setForm((f) => ({ ...f, customerId: id, locationId: "", locationLabel: "" }));
              setChangingLocation(Boolean(id));
            }}
          >
            <option value="">Sem cliente</option>
            {(customers.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        {intakeCustomer ? (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
            <span>
              Total de OS: <b className="text-ink">{intakeCustomer.total_tickets}</b>
            </span>
            {intakeCustomer.rating_average != null ? (
              <span className="inline-flex items-center gap-1">
                <Star className="size-3 fill-amber-400 text-amber-400" /> Média de avaliação: <b className="text-ink">{intakeCustomer.rating_average}</b>
              </span>
            ) : null}
            {intakeCustomer.rating_last != null ? (
              <span className="inline-flex items-center gap-1">
                <ThumbsUp className="size-3" /> Última avaliação: <b className="text-ink">{intakeCustomer.rating_last}</b>
              </span>
            ) : null}
            {intakeLocation?.contact_phone ? (
              <span className="inline-flex items-center gap-1">
                <Phone className="size-3" /> {intakeLocation.contact_phone}
                {intakeLocation.contact_name ? ` · ${intakeLocation.contact_name}` : ""}
              </span>
            ) : null}
            <Link href={`/clientes/${intakeCustomer.id}`} className="font-medium text-brand hover:underline">
              + Ver mais
            </Link>
          </p>
        ) : null}
      </div>

      <div className="col-span-12">
        <Field label="Localização">
          {changingLocation || !form.locationId ? (
            <LocationPicker
              customerId={form.customerId || null}
              value={null}
              onChange={(loc: Location | null) => {
                if (!loc) return;
                setForm((f) => ({
                  ...f,
                  locationId: loc.id,
                  locationLabel: [loc.name, loc.code].filter(Boolean).join(" - "),
                  customerId: loc.customer_id ?? f.customerId,
                }));
                setChangingLocation(false);
              }}
            />
          ) : (
            <div className="flex h-10 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-sm">
              <span className="min-w-0 flex-1 truncate text-ink">{form.locationLabel}</span>
              <button type="button" onClick={() => setChangingLocation(true)} className="text-xs font-medium text-brand hover:underline">
                Trocar
              </button>
              <button
                type="button"
                onClick={() => setForm((f) => ({ ...f, locationId: "", locationLabel: "" }))}
                className="rounded-full p-0.5 text-ink-subtle hover:bg-surface-2 hover:text-ink"
                aria-label="Tirar a loja"
              >
                <X className="size-4" />
              </button>
            </div>
          )}
        </Field>
      </div>

      <div className="col-span-12 rounded-lg border border-line px-3 py-2.5">
        <p className="text-xs font-semibold text-ink/80">Endereço da ordem de serviço</p>
        <p className="mt-1 flex items-start gap-1.5 text-sm text-ink">
          <MapPin className="mt-0.5 size-4 shrink-0 text-ink-subtle" />
          {address || <span className="text-ink-subtle">Sem endereço (escolha a loja)</span>}
        </p>
        <Input
          value={form.serviceAddress}
          onChange={(e) => set("serviceAddress", e.target.value)}
          placeholder="Outro endereço para este atendimento (opcional)"
          maxLength={255}
          className="mt-2"
        />
      </div>

      <Field label="Contrato de prazo (prioridade)" className="col-span-12">
        <Select value={form.priority} onChange={(e) => set("priority", e.target.value as TicketPriority)}>
          {PRIORITY_ORDER.map((p) => (
            <option key={p} value={p}>
              {PRIORITY[p].code} - {PRIORITY[p].label}
            </option>
          ))}
        </Select>
      </Field>

      <div className="col-span-12 flex flex-col gap-1">
        <Field label="Descrição da ordem de serviço">
          <Textarea rows={3} value={form.description} onChange={(e) => set("description", e.target.value)} maxLength={20000} />
        </Field>
        <Counter value={form.description} max={20000} />
      </div>

      <Field label="Duração estimada (min)" required className="col-span-12 sm:col-span-4" hint={minutes ? formatMinutes(minutes) : undefined}>
        <Input type="number" min={1} max={10080} value={form.estimated} onChange={(e) => set("estimated", e.target.value)} />
      </Field>
      <Field label="Data do agendamento" className="col-span-6 sm:col-span-4">
        <Input type="date" value={form.date} onChange={(e) => set("date", e.target.value)} />
      </Field>
      <Field label="Hora do agendamento" className="col-span-6 sm:col-span-4">
        <Input type="time" value={form.time} onChange={(e) => set("time", e.target.value)} />
      </Field>

      <Field label="Colaborador" className="col-span-12 sm:col-span-6">
        <Select value={form.assigneeId} onChange={(e) => set("assigneeId", e.target.value)}>
          <option value="">Sem colaborador</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.role === "technician" ? "" : " (analista)"} · {p.open_tickets} em aberto
            </option>
          ))}
          {ticket.assignee && !people.some((p) => p.id === ticket.assignee!.id) ? (
            <option value={ticket.assignee.id}>{ticket.assignee.name}</option>
          ) : null}
        </Select>
      </Field>
      <div className="col-span-12 sm:col-span-6">
        <span className="mb-1.5 block text-xs font-semibold text-ink/80">Outros colaboradores</span>
        <HelpersField
          hideLabel
          options={people.filter((p) => p.role === "technician").map((p) => ({ id: p.id, name: p.name }))}
          assigneeId={form.assigneeId as UUID | ""}
          helperIds={form.helperIds}
          names={names}
          onChange={(ids) => set("helperIds", ids)}
        />
      </div>
      {ticket.assignee ? (
        <div className="col-span-12">
          <PayoutLine ticket={ticket} />
        </div>
      ) : null}

      <div className="col-span-12 rounded-xl border border-line bg-surface-2/40 p-3">
        <SectionTitle
          className="mb-2 flex-wrap"
          aside={
            form.locationId ? (
              <button
                type="button"
                onClick={async () => {
                  await navigator.clipboard.writeText(invite());
                  toast({ title: "Convite copiado: cole no grupo de técnicos do WhatsApp", tone: "success" });
                }}
                className="text-xs font-medium text-brand hover:underline"
              >
                Copiar convite para o grupo
              </button>
            ) : null
          }
        >
          Técnicos mais indicados para esta loja
        </SectionTitle>
        <SuggestedTechnicians
          items={suggestions.data}
          loading={suggestions.isLoading}
          hasPlace={Boolean(form.locationId)}
          scheduled={Boolean(startIso)}
          assigneeId={form.assigneeId as UUID | ""}
          helperIds={form.helperIds}
          onAssign={(t) => set("assigneeId", t?.id ?? "")}
          onToggleHelper={(t) =>
            set("helperIds", form.helperIds.includes(t.id) ? form.helperIds.filter((h) => h !== t.id) : [...form.helperIds, t.id])
          }
          invite={(t) => invite(t.name)}
        />
      </div>
      {conflicts ? (
        <div className="col-span-12">
          <ConflictList tone="error" items={conflicts} title="Há técnico ocupado neste horário. Salve de novo para confirmar mesmo assim." />
        </div>
      ) : startIso && (form.assigneeId || form.helperIds.length) && (assigneeChanged || schedChanged || !sameList(form.helperIds, base.helperIds)) ? (
        <div className="col-span-12 flex flex-col gap-2">
          {form.assigneeId ? (
            <ConflictHint
              assigneeId={form.assigneeId}
              assigneeName={names[form.assigneeId]}
              start={startIso}
              estimatedMinutes={minutes}
              excludeId={ticket.id}
            />
          ) : null}
          {form.helperIds.map((id) => (
            <ConflictHint key={id} assigneeId={id} assigneeName={names[id]} start={startIso} estimatedMinutes={minutes} excludeId={ticket.id} />
          ))}
        </div>
      ) : null}

      <Field label="Analista responsável" className="col-span-12 sm:col-span-6">
        <div className="flex items-center gap-2">
          <Select value={form.ownerId} onChange={(e) => set("ownerId", e.target.value)} className="flex-1">
            <option value="">Sem analista (fila geral)</option>
            {analysts.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
          {user && form.ownerId !== user.id ? (
            <button
              type="button"
              onClick={() => set("ownerId", user.id)}
              className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-line px-3 text-xs font-medium text-ink hover:bg-surface-2"
            >
              <Hand className="size-3.5" />
              Assumir
            </button>
          ) : null}
        </div>
      </Field>
      <Field label="Projeto" className="col-span-12 sm:col-span-6">
        <Select value={form.projectId} onChange={(e) => set("projectId", e.target.value)}>
          <option value="">Não é de projeto (OS avulsa)</option>
          {(projects.data ?? [])
            .filter((p) => p.status === "active" || p.status === "planning" || p.id === form.projectId)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} · {p.name}
              </option>
            ))}
        </Select>
      </Field>

      <div className="col-span-12 flex flex-col gap-1">
        <Field label="Observação da visita" hint="Recado para o técnico (aparece em destaque no app)">
          <Textarea rows={2} value={form.visitNote} onChange={(e) => set("visitNote", e.target.value)} maxLength={5000} />
        </Field>
        <Counter value={form.visitNote} max={5000} />
      </div>

      <Field label="Situação" className="col-span-12 sm:col-span-4">
        <Select
          value={ticket.status}
          onChange={(e) => e.target.value !== ticket.status && setTarget(e.target.value as TicketStatus)}
          disabled={statusOptions.length <= 1 || dirty}
          title={dirty ? "Salve as alterações antes de mudar a situação" : undefined}
        >
          {statusOptions.map((s) => (
            <option key={s} value={s}>
              {STATUS[s].label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Data de início" className="col-span-6 sm:col-span-2">
        <Input type="date" value={form.startDate} disabled={!ticket.arrived_at} onChange={(e) => set("startDate", e.target.value)} />
      </Field>
      <Field label="Hora de início" className="col-span-6 sm:col-span-2">
        <Input type="time" value={form.startTime} disabled={!ticket.arrived_at} onChange={(e) => set("startTime", e.target.value)} />
      </Field>
      <Field label="Data de conclusão" className="col-span-6 sm:col-span-2">
        <Input type="date" value={form.endDate} disabled={!ticket.resolved_at} onChange={(e) => set("endDate", e.target.value)} />
      </Field>
      <Field label="Hora de conclusão" className="col-span-6 sm:col-span-2">
        <Input type="time" value={form.endTime} disabled={!ticket.resolved_at} onChange={(e) => set("endTime", e.target.value)} />
      </Field>
      {timesChanged ? (
        <Field label="Motivo da correção do horário" required className="col-span-12" hint="Fica no histórico da OS (o técnico não vê)">
          <Input
            value={form.timesReason}
            onChange={(e) => set("timesReason", e.target.value)}
            placeholder="Ex.: técnico esqueceu de concluir no app; confirmado com a loja"
            maxLength={500}
          />
        </Field>
      ) : null}

      <div className="col-span-12 flex flex-col gap-1">
        <Field label="Descrição da conclusão">
          <Textarea rows={5} value={form.resolutionNotes} onChange={(e) => set("resolutionNotes", e.target.value)} maxLength={20000} />
        </Field>
        <Counter value={form.resolutionNotes} max={20000} />
      </div>

      {save.error && !conflicts ? (
        <div className="col-span-12">
          <ErrorBox message={errorMessage(save.error)} />
        </div>
      ) : null}
      {target ? <TransitionDialog key={target} ticket={ticket} to={target} onClose={() => setTarget(null)} /> : null}
    </form>
  );
}
