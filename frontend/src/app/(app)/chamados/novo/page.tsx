"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, Hand, Inbox, Save, TriangleAlert, UserRoundCog } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { LocationPicker } from "@/components/LocationPicker";
import { IntakePanel } from "@/components/new-ticket/IntakePanel";
import { HelpersField, SuggestedTechnicians } from "@/components/new-ticket/SuggestedTechnicians";
import { PriorityBadge, StatusBadge } from "@/components/badges";
import { ConflictHint, ConflictList, scheduleConflicts } from "@/components/ScheduleConflict";
import { useToast } from "@/components/Toaster";
import { Button, Card, ErrorBox, Field, Input, Kbd, PageHeader, Select, Textarea } from "@/components/ui";
import { useNow } from "@/components/useNow";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets, computePriority, isStaff, LEVEL, LEVEL_ORDER, PRIORITY, PRIORITY_ORDER, ROLE, TICKET_TYPE } from "@/lib/constants";
import { formatDateTime, formatMinutes, formatTime, fromLocalInput } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { useProjects } from "@/lib/projects";
import { useAssignable, useCategories, useCustomers, useServiceTypes } from "@/lib/queries";
import type {
  ConflictItem,
  IntakeContext,
  Level,
  Location,
  Page,
  QueuesOut,
  SlaPolicy,
  TechnicianSuggestion,
  TicketCreatePayload,
  TicketDetail,
  TicketListItem,
  TicketPriority,
  TicketType,
  UUID,
} from "@/lib/types";

const TEXT_LIMIT = 5000;

interface FormState {
  title: string;
  description: string;
  type: TicketType;
  category_id: string;
  urgency: Level;
  priority: "" | TicketPriority;
  customer_id: string;
  location_id: string;
  service_address: string;
  service_type_id: string;
  estimated_minutes: string;
  project_id: string;
  assignee_id: string;
  date: string;
  time: string;
}

const INITIAL: FormState = {
  title: "",
  description: "",
  type: "incident",
  category_id: "",
  urgency: "medium",
  priority: "",
  customer_id: "",
  location_id: "",
  service_address: "",
  service_type_id: "",
  estimated_minutes: "",
  project_id: "",
  assignee_id: "",
  date: "",
  time: "",
};

type OwnerMode = "me" | "none" | "other";

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function Section({
  step,
  title,
  description,
  children,
}: {
  step: number;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <div className="flex items-start gap-3 border-b border-line px-5 py-3.5">
        <span className="mt-px flex size-6 shrink-0 items-center justify-center rounded-full bg-ink text-[11px] font-semibold text-surface tabular-nums">
          {step}
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-[-0.005em] text-ink">{title}</h2>
          {description ? <p className="mt-0.5 text-xs text-ink-muted">{description}</p> : null}
        </div>
      </div>
      <div className="p-5">{children}</div>
    </Card>
  );
}

export default function NewTicketPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const staff = isStaff(user?.role);
  // Técnico só pode atribuir a si mesmo: técnicos, fila e agenda ficam com analista/gestor.
  const canAssign = canManageTickets(user?.role);
  const [form, setForm] = useState<FormState>(INITIAL);
  const [titleTouched, setTitleTouched] = useState(false);
  const [otherAddress, setOtherAddress] = useState(false);
  const [helperIds, setHelperIds] = useState<UUID[]>([]);
  const [ownerMode, setOwnerMode] = useState<OwnerMode>("me");
  const [ownerId, setOwnerId] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const now = useNow(60_000);

  const categories = useCategories();
  const customers = useCustomers();
  // Local escolhido no seletor com busca (o form guarda só o id).
  const [location, setLocation] = useState<Location | null>(null);
  const assignable = useAssignable(null, canAssign);
  const projects = useProjects({ enabled: canAssign });
  // Tipos gerais + catálogo do cliente da OS (só para quem gerencia OS).
  const serviceTypes = useServiceTypes({ customerId: form.customer_id || null, active: true, enabled: canAssign });
  const sla = useQuery({
    queryKey: ["sla-policies"],
    queryFn: () => api.get<SlaPolicy[]>("/sla-policies"),
    staleTime: 5 * 60_000,
    enabled: staff,
  });
  const queues = useQuery({
    queryKey: ["tickets", "queues"],
    queryFn: () => api.get<QueuesOut>("/queues"),
    enabled: canAssign && ownerMode === "other",
    staleTime: 60_000,
  });

  // Cliente e loja: etiquetas, avaliação, histórico, contato e prazo de chegada.
  const intake = useQuery({
    queryKey: ["intake", form.location_id || null, form.location_id ? null : form.customer_id || null],
    queryFn: () =>
      api.get<IntakeContext>("/intake/context", {
        location_id: form.location_id || undefined,
        customer_id: form.location_id ? undefined : form.customer_id || undefined,
      }),
    enabled: canAssign && Boolean(form.location_id || form.customer_id),
    staleTime: 30_000,
  });
  // OS ainda abertas na mesma loja: evita mandar dois técnicos para o mesmo problema.
  const openAtLocation = useQuery({
    queryKey: ["tickets", "open-at-location", form.location_id],
    queryFn: () => api.get<Page<TicketListItem>>("/tickets", { location_id: form.location_id, open_only: true, page_size: 5 }),
    enabled: staff && Boolean(form.location_id),
  });

  const startIso = form.date && form.time ? fromLocalInput(`${form.date}T${form.time}`) : null;
  const minutes = form.estimated_minutes ? Number(form.estimated_minutes) : null;
  const debouncedTitle = useDebounced(form.title.trim(), 600);
  // Técnicos mais indicados para a loja, o serviço e o horário (mesmo ranking da OS aberta).
  const suggestions = useQuery({
    queryKey: ["technician-suggest", form.location_id, form.service_type_id, form.category_id, form.project_id, startIso, minutes, debouncedTitle],
    queryFn: () =>
      api.get<TechnicianSuggestion[]>("/technicians/suggest", {
        location_id: form.location_id,
        service_type_id: form.service_type_id || undefined,
        category_id: form.category_id || undefined,
        project_id: form.project_id || undefined,
        title: debouncedTitle || undefined,
        start: startIso ?? undefined,
        estimated_minutes: minutes ?? undefined,
        limit: 5,
      }),
    enabled: canAssign && Boolean(form.location_id),
    staleTime: 30_000,
  });

  // A API barrou por conflito de agenda: o próximo envio confirma (até mudar técnico ou horário).
  const [conflicts, setConflicts] = useState<ConflictItem[] | null>(null);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    if (key === "assignee_id" || key === "date" || key === "time" || key === "estimated_minutes") setConflicts(null);
    setForm((f) => ({ ...f, [key]: value }));
  };
  // Sem o campo de impacto, a prioridade automática segue a urgência (impacto médio).
  const computed = computePriority("medium", form.urgency);
  const effectivePriority = form.priority || computed;
  const policy = sla.data?.find((p) => p.priority === effectivePriority);

  const sortedCategories = useMemo(
    () => [...(categories.data ?? [])].filter((c) => c.is_active).sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [categories.data],
  );
  // Técnicos primeiro, depois analistas; por carga.
  const people = useMemo(
    () =>
      [...(assignable.data ?? [])].sort(
        (a, b) =>
          (a.role === "technician" ? 0 : 1) - (b.role === "technician" ? 0 : 1) ||
          a.open_tickets - b.open_tickets ||
          a.name.localeCompare(b.name),
      ),
    [assignable.data],
  );
  const names = useMemo(() => {
    const map: Record<UUID, string> = {};
    for (const u of assignable.data ?? []) map[u.id] = u.name;
    for (const s of suggestions.data ?? []) map[s.id] = s.name;
    return map;
  }, [assignable.data, suggestions.data]);
  const assigneeName = form.assignee_id ? names[form.assignee_id] : undefined;

  const mutation = useMutation({
    mutationFn: (payload: TicketCreatePayload) => api.post<TicketDetail>("/tickets", payload),
    onSuccess: (ticket) => {
      queryClient.invalidateQueries({ queryKey: ["tickets"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      toast({ title: `${ticket.code} aberta`, description: ticket.title, tone: "success" });
      router.push(`/chamados/${ticket.id}`);
    },
    onError: (error) => setConflicts(scheduleConflicts(error)),
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (mutation.isPending) return;
    const payload: TicketCreatePayload = {
      title: form.title.trim(),
      description: form.description.trim(),
      type: form.type,
      urgency: form.urgency,
      priority: form.priority || null,
      category_id: form.category_id || null,
      customer_id: form.customer_id || null,
      location_id: form.location_id || null,
      service_address: otherAddress ? form.service_address.trim() || null : null,
      service_type_id: canAssign ? form.service_type_id || null : null,
      estimated_minutes: canAssign && minutes ? minutes : null,
    };
    if (staff) {
      payload.scheduled_start = startIso;
      if (conflicts) payload.allow_conflict = true;
    }
    if (canAssign) {
      payload.project_id = form.project_id || null;
      payload.assignee_id = form.assignee_id || null;
      payload.helper_ids = helperIds;
      // "Assumir" é o padrão: quem abre leva a OS para a própria fila.
      if (ownerMode === "none") payload.owner_id = null;
      else if (ownerMode === "other" && ownerId) payload.owner_id = ownerId;
    }
    mutation.mutate(payload);
  }

  function pickDay(offset: 0 | 1) {
    const day = new Date(now);
    day.setDate(day.getDate() + offset);
    let time = form.time;
    if (!time) {
      if (offset === 0) {
        const next = new Date(now);
        next.setMinutes(0, 0, 0);
        next.setHours(next.getHours() + (new Date(now).getMinutes() > 0 ? 2 : 1));
        time = `${pad(Math.min(next.getHours(), 22))}:00`;
      } else {
        time = "08:00";
      }
    }
    setConflicts(null);
    setForm((f) => ({ ...f, date: ymd(day), time }));
  }

  const endLabel = startIso ? formatTime(new Date(new Date(startIso).getTime() + (minutes ?? 60) * 60_000).toISOString()) : null;
  const ctx = intake.data;
  const address = ctx?.location
    ? [ctx.location.address_line, ctx.location.district, [ctx.location.city, ctx.location.state].filter(Boolean).join("-")]
        .filter(Boolean)
        .join(", ")
    : "";

  return (
    <div className="mx-auto max-w-6xl">
      <Link href="/chamados" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
        <ArrowLeft className="size-4" />
        Chamados
      </Link>
      <PageHeader title="Nova ordem de serviço" description="Loja, problema, agenda e técnico em um só lugar" />

      <form
        ref={formRef}
        onSubmit={onSubmit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            formRef.current?.requestSubmit();
          }
        }}
        className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]"
      >
        <div className="flex min-w-0 flex-col gap-4">
          <Section step={1} title="Onde" description="A loja define o cliente, o endereço e os técnicos sugeridos">
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Loja (local de atendimento)" className="md:col-span-2">
                <LocationPicker
                  customerId={form.customer_id || null}
                  value={location}
                  onChange={(loc) => {
                    setLocation(loc);
                    setConflicts(null);
                    // O local define o cliente (a filial pertence a um cliente).
                    setForm((f) => ({
                      ...f,
                      location_id: loc?.id ?? "",
                      customer_id: loc ? loc.customer_id : f.customer_id,
                    }));
                  }}
                />
              </Field>
              <Field label="Cliente">
                <Select
                  value={form.customer_id}
                  onChange={(e) => {
                    setLocation(null);
                    setForm((f) => ({ ...f, customer_id: e.target.value, location_id: "" }));
                  }}
                >
                  <option value="">Selecione o cliente...</option>
                  {customers.data?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>

              {form.location_id ? (
                <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2/60 px-3.5 py-3 md:col-span-3">
                  <p className="text-xs font-medium text-ink-subtle">Endereço da OS</p>
                  <p className="text-sm text-ink">{address || (intake.isLoading ? "Carregando..." : "Loja sem endereço no cadastro")}</p>
                  <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-ink-muted">
                    <input
                      type="checkbox"
                      checked={otherAddress}
                      onChange={(e) => setOtherAddress(e.target.checked)}
                      className="size-3.5 accent-[var(--brand)]"
                    />
                    Atender em outro endereço ou ponto de referência
                  </label>
                  {otherAddress ? (
                    <Input
                      value={form.service_address}
                      onChange={(e) => set("service_address", e.target.value)}
                      placeholder="Ex.: Doca 3, entrada pelos fundos"
                      maxLength={255}
                      autoFocus
                      aria-label="Endereço do atendimento"
                    />
                  ) : null}
                </div>
              ) : null}

              {openAtLocation.data && openAtLocation.data.total > 0 ? (
                <div className="animate-enter rounded-lg border border-amber-200 bg-amber-50/70 p-3 md:col-span-3 dark:border-amber-500/30 dark:bg-amber-500/10">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-amber-900 dark:text-amber-200">
                    <TriangleAlert className="size-4" />
                    {openAtLocation.data.total === 1
                      ? "Já existe 1 OS aberta nesta loja"
                      : `Já existem ${openAtLocation.data.total} OS abertas nesta loja`}
                  </p>
                  <ul className="mt-2 flex flex-col gap-1">
                    {openAtLocation.data.items.slice(0, 3).map((t) => (
                      <li key={t.id} className="flex flex-wrap items-center gap-2 text-sm">
                        <Link href={`/chamados/${t.id}`} target="_blank" className="text-ink hover:text-brand hover:underline">
                          <span className="mr-1 font-mono text-xs text-ink-subtle">{t.code}</span>
                          {t.title}
                        </Link>
                        <StatusBadge status={t.status} />
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-amber-800/80 dark:text-amber-200/80">
                    Confira se não é o mesmo problema antes de abrir outra (evita mandar dois técnicos).
                  </p>
                </div>
              ) : null}
            </div>
          </Section>

          <Section step={2} title="O quê" description="O tipo de serviço já traz a duração e sugere o título">
            <div className="grid gap-4 md:grid-cols-6">
              {canAssign ? (
                <>
                  <Field label="Tipo de serviço" className="md:col-span-4">
                    <Select
                      value={form.service_type_id}
                      onChange={(e) => {
                        const st = serviceTypes.data?.find((t) => t.id === e.target.value);
                        setConflicts(null);
                        setForm((f) => ({
                          ...f,
                          service_type_id: e.target.value,
                          estimated_minutes: st ? String(st.estimated_minutes) : f.estimated_minutes,
                          // Sem título digitado, o tipo de serviço vira o título (dá para editar).
                          title: st && (!titleTouched || !f.title.trim()) ? st.name : f.title,
                        }));
                      }}
                    >
                      <option value="">Nenhum</option>
                      {serviceTypes.data?.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} · {formatMinutes(t.estimated_minutes)}
                          {t.customer ? ` · ${t.customer.name}` : ""}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Duração estimada (min)" hint={minutes ? formatMinutes(minutes) : "Vazio: a agenda reserva 1h"} className="md:col-span-2">
                    <Input
                      type="number"
                      min={1}
                      max={10080}
                      value={form.estimated_minutes}
                      onChange={(e) => set("estimated_minutes", e.target.value)}
                      placeholder="60"
                    />
                  </Field>
                </>
              ) : null}
              <Field label="Título" required className="md:col-span-6">
                <Input
                  value={form.title}
                  onChange={(e) => {
                    setTitleTouched(true);
                    set("title", e.target.value);
                  }}
                  placeholder="Ex.: PDV 2 sem rede"
                  minLength={3}
                  maxLength={200}
                  required
                />
              </Field>
              <div className="flex flex-col gap-1 md:col-span-6">
                <Field label="Descrição do problema">
                  <Textarea
                    value={form.description}
                    onChange={(e) => set("description", e.target.value.slice(0, TEXT_LIMIT))}
                    rows={4}
                    placeholder="O que o cliente relatou: sintomas, mensagens de erro, desde quando, quem é afetado..."
                  />
                </Field>
                <span className="text-right text-[11px] text-ink-subtle tabular-nums">
                  {form.description.length.toLocaleString("pt-BR")} / {TEXT_LIMIT.toLocaleString("pt-BR")}
                </span>
              </div>
              <Field label="Categoria" className="md:col-span-3">
                <Select value={form.category_id} onChange={(e) => set("category_id", e.target.value)}>
                  <option value="">Selecione...</option>
                  {sortedCategories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.full_name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Tipo" className="md:col-span-3">
                <Select value={form.type} onChange={(e) => set("type", e.target.value as TicketType)}>
                  {Object.entries(TICKET_TYPE).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Urgência" className="md:col-span-3">
                <Select value={form.urgency} onChange={(e) => set("urgency", e.target.value as Level)}>
                  {LEVEL_ORDER.map((l) => (
                    <option key={l} value={l}>
                      {LEVEL[l]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Prioridade (prazo)" className="md:col-span-3">
                <Select value={form.priority} onChange={(e) => set("priority", e.target.value as FormState["priority"])}>
                  <option value="">
                    Automática ({PRIORITY[computed].code} · {PRIORITY[computed].label})
                  </option>
                  {PRIORITY_ORDER.map((p) => (
                    <option key={p} value={p}>
                      {PRIORITY[p].code} · {PRIORITY[p].label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </Section>

          {staff ? (
            <Section
              step={3}
              title="Quando e quem"
              description={canAssign ? "Agende a visita e escolha entre os técnicos mais indicados para a loja" : "Agenda da visita"}
            >
              <div className="flex flex-col gap-5">
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_9rem_minmax(0,1fr)]">
                  <div className="flex flex-col gap-1.5">
                    <span className="flex items-center justify-between text-sm font-medium text-ink">
                      Data da visita
                      <span className="flex gap-1">
                        {([0, 1] as const).map((offset) => (
                          <button
                            key={offset}
                            type="button"
                            onClick={() => pickDay(offset)}
                            className="rounded-md border border-line px-1.5 py-px text-[11px] font-medium text-ink-muted hover:border-brand hover:text-brand"
                          >
                            {offset === 0 ? "Hoje" : "Amanhã"}
                          </button>
                        ))}
                      </span>
                    </span>
                    <Input type="date" value={form.date} onChange={(e) => set("date", e.target.value)} aria-label="Data da visita" />
                  </div>
                  <Field label="Hora">
                    <Input type="time" step={300} value={form.time} required={Boolean(form.date)} onChange={(e) => set("time", e.target.value)} />
                  </Field>
                  <div className="flex flex-col justify-end gap-1 pb-2 text-xs text-ink-muted">
                    {startIso ? (
                      <>
                        <span>
                          Das <span className="font-medium text-ink">{form.time}</span> às{" "}
                          <span className="font-medium text-ink">{endLabel}</span>
                          {minutes ? "" : " (1h reservada)"}
                        </span>
                        <button
                          type="button"
                          onClick={() => setForm((f) => ({ ...f, date: "", time: "" }))}
                          className="w-fit text-ink-subtle hover:text-red-600"
                        >
                          Deixar sem agenda
                        </button>
                      </>
                    ) : (
                      <span>Sem data, a OS fica na fila para agendar depois.</span>
                    )}
                  </div>
                </div>

                {canAssign ? (
                  <>
                    <div className="flex flex-col gap-2">
                      <p className="flex items-center justify-between text-sm font-medium text-ink">
                        Técnicos sugeridos para a loja
                        {suggestions.isFetching ? <span className="text-xs font-normal text-ink-subtle">atualizando...</span> : null}
                      </p>
                      <SuggestedTechnicians
                        items={suggestions.data}
                        loading={suggestions.isLoading}
                        hasPlace={Boolean(form.location_id)}
                        scheduled={Boolean(startIso)}
                        assigneeId={form.assignee_id}
                        helperIds={helperIds}
                        onAssign={(t) => {
                          set("assignee_id", t?.id ?? "");
                          if (t) setHelperIds((ids) => ids.filter((id) => id !== t.id));
                        }}
                        onToggleHelper={(t) => {
                          setConflicts(null);
                          setHelperIds((ids) => (ids.includes(t.id) ? ids.filter((id) => id !== t.id) : [...ids, t.id].slice(0, 6)));
                        }}
                      />
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                      <Field label="Técnico responsável" hint="Inicia, conclui e colhe a assinatura">
                        <Select
                          value={form.assignee_id}
                          onChange={(e) => {
                            const id = e.target.value;
                            set("assignee_id", id);
                            setHelperIds((ids) => ids.filter((h) => h !== id));
                          }}
                        >
                          <option value="">Deixar sem técnico (na fila)</option>
                          {people.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.name} · {u.role === "technician" ? u.team_name ?? "técnico" : ROLE[u.role]} · {u.open_tickets} em aberto
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Projeto" hint="Se a OS faz parte de um projeto">
                        <Select value={form.project_id} onChange={(e) => set("project_id", e.target.value)}>
                          <option value="">OS avulsa</option>
                          {(projects.data ?? [])
                            .filter((p) => p.status === "active" || p.status === "planning")
                            .map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.code} · {p.name}
                              </option>
                            ))}
                        </Select>
                      </Field>
                      <div className="md:col-span-2">
                        <HelpersField
                          options={people.map((u) => ({ id: u.id, name: u.name, detail: u.role === "technician" ? u.team_name ?? undefined : ROLE[u.role] }))}
                          assigneeId={form.assignee_id}
                          helperIds={helperIds}
                          names={names}
                          onChange={(ids) => {
                            setConflicts(null);
                            setHelperIds(ids);
                          }}
                        />
                      </div>
                    </div>
                  </>
                ) : null}

                {conflicts ? (
                  <ConflictList
                    tone="error"
                    items={conflicts}
                    title="Há técnico ocupado neste horário. Envie de novo para abrir mesmo assim."
                  />
                ) : startIso ? (
                  <>
                    {form.assignee_id ? (
                      <ConflictHint assigneeId={form.assignee_id} assigneeName={assigneeName} start={startIso} estimatedMinutes={minutes} />
                    ) : null}
                    {helperIds.map((id) => (
                      <ConflictHint key={id} assigneeId={id} assigneeName={names[id]} start={startIso} estimatedMinutes={minutes} />
                    ))}
                  </>
                ) : null}
              </div>
            </Section>
          ) : null}
        </div>

        <aside className="flex flex-col gap-4 lg:sticky lg:top-4">
          {canAssign ? (
            <Card className="p-4">
              <p className="mb-2.5 text-xs font-medium text-ink-subtle">Analista responsável</p>
              <div className="grid grid-cols-3 gap-1 rounded-lg bg-surface-2 p-1" role="radiogroup" aria-label="Analista responsável">
                {(
                  [
                    ["me", "Assumir", Hand],
                    ["none", "Sem analista", Inbox],
                    ["other", "Outro", UserRoundCog],
                  ] as const
                ).map(([mode, label, Icon]) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={ownerMode === mode}
                    onClick={() => setOwnerMode(mode)}
                    className={clsx(
                      "inline-flex h-8 items-center justify-center gap-1 rounded-md text-xs font-medium transition-colors",
                      ownerMode === mode ? "bg-surface text-ink shadow-elev-1" : "text-ink-muted hover:text-ink",
                    )}
                  >
                    <Icon className="size-3.5" />
                    {label}
                  </button>
                ))}
              </div>
              {ownerMode === "other" ? (
                <Select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className="mt-2" aria-label="Analista" required>
                  <option value="">Escolher analista...</option>
                  {(queues.data?.queues ?? [])
                    .filter((q) => q.user.id !== user?.id)
                    .map((q) => (
                      <option key={q.user.id} value={q.user.id}>
                        {q.user.name} ({q.open} abertas)
                      </option>
                    ))}
                </Select>
              ) : null}
              <p className="mt-2 text-xs text-ink-muted">
                {ownerMode === "me"
                  ? "A OS vai para a sua fila."
                  : ownerMode === "none"
                    ? "Fica em “Sem analista” até alguém assumir."
                    : "Vai para a fila do analista escolhido."}
              </p>
            </Card>
          ) : null}

          {canAssign ? (
            <Card>
              <IntakePanel context={ctx} loading={intake.isLoading} />
            </Card>
          ) : null}

          <Card className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-ink-subtle">Prazos desta OS</span>
              <PriorityBadge priority={effectivePriority} />
            </div>
            {policy ? (
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
                <dt className="text-ink-muted">1ª resposta</dt>
                <dd className="text-right font-medium text-ink tabular-nums">até {formatDateTime(new Date(now + policy.response_minutes * 60_000).toISOString())}</dd>
                <dt className="text-ink-muted">Solução</dt>
                <dd className="text-right font-medium text-ink tabular-nums">até {formatDateTime(new Date(now + policy.resolution_minutes * 60_000).toISOString())}</dd>
                {ctx?.location?.arrival_hours ? (
                  <>
                    <dt className="text-ink-muted">Chegada</dt>
                    <dd className="text-right font-medium text-ink">em até {ctx.location.arrival_hours}h</dd>
                  </>
                ) : null}
              </dl>
            ) : (
              <p className="mt-2 text-xs text-ink-muted">Os prazos seguem a prioridade escolhida.</p>
            )}
          </Card>

          {mutation.error && !conflicts ? <ErrorBox message={errorMessage(mutation.error)} /> : null}
          <Button type="submit" variant="primary" size="lg" loading={mutation.isPending} className="w-full">
            {mutation.isPending ? null : <Save className="size-4" />}
            {conflicts ? "Abrir OS mesmo assim" : "Abrir OS"}
          </Button>
          <p className="-mt-2 text-center text-[11px] text-ink-subtle">
            <Kbd>Ctrl</Kbd> + <Kbd>Enter</Kbd> abre a OS de qualquer campo
          </p>
        </aside>
      </form>
    </div>
  );
}
