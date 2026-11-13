"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Hand,
  History,
  Inbox,
  Lightbulb,
  Mail,
  MessageCircle,
  MoreHorizontal,
  Phone,
  Save,
  TriangleAlert,
  UserRoundCog,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useId, useMemo, useRef, useState } from "react";
import { PriorityBadge } from "@/components/badges";
import { LocationPicker } from "@/components/LocationPicker";
import { CreatedTicket, type CreatedResult } from "@/components/new-ticket/CreatedTicket";
import { CustomerPicker } from "@/components/new-ticket/CustomerPicker";
import { dayTimeLabel } from "@/components/new-ticket/dayTime";
import {
  blankDraft,
  DRAFT_VERSION,
  draftKey,
  isFilled,
  ORIGIN_KEY,
  withCustomer,
  withLocation,
  withServiceType,
  type NewTicketDraft,
  type NewTicketForm,
  type Origin,
  type OwnerMode,
  type StoredDraft,
} from "@/components/new-ticket/draft";
import { OpenAtLocation, SameClientReference } from "@/components/new-ticket/Duplicates";
import { FormsPicker } from "@/components/new-ticket/FormsPicker";
import { IntakePanel } from "@/components/new-ticket/IntakePanel";
import { inviteText } from "@/components/new-ticket/invite";
import { MessageIntake, type IntakeSuggestion } from "@/components/new-ticket/MessageIntake";
import { parseIntake } from "@/components/new-ticket/parseIntake";
import { SegmentedRadio } from "@/components/new-ticket/SegmentedRadio";
import { ServiceTypePicker } from "@/components/new-ticket/ServiceTypePicker";
import { readStored, writeStored } from "@/components/new-ticket/storage";
import { HelpersField, SuggestedTechnicians } from "@/components/new-ticket/SuggestedTechnicians";
import { ConflictHint, ConflictList, scheduleConflicts } from "@/components/ScheduleConflict";
import { TagsInput } from "@/components/TagChips";
import { useTicketPanel } from "@/components/ticket/TicketPanel";
import { useToast } from "@/components/Toaster";
import { Button, Card, ErrorBox, Field, Input, Kbd, LoadingBlock, PageHeader, SectionTitle, Select, Skeleton, Textarea } from "@/components/ui";
import { useNow } from "@/components/useNow";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { PRIORITY, PRIORITY_ORDER, ROLE, TICKET_TYPE } from "@/lib/constants";
import { dayKey, formatMinutes, formatMoney, formatTime, fromLocalInput, toLocalInput } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { useProjects } from "@/lib/projects";
import { useAssignable, useCategories, useCustomers } from "@/lib/queries";
import { copyText } from "@/lib/whatsapp";
import type {
  ConflictItem,
  FormTemplate,
  IntakeContext,
  Location,
  Page,
  QueuesOut,
  ServiceType,
  SlaPolicy,
  Tag,
  TechnicianSuggestion,
  TicketCreatePayload,
  TicketDetail,
  TicketType,
  UUID,
} from "@/lib/types";

/** Limites da API (TicketCreate): descrição e recado para o técnico. */
const TEXT_LIMIT = 20_000;
const NOTE_LIMIT = 5_000;
const MAX_MINUTES = 60 * 24 * 7;

const ORIGINS: { value: Origin; label: string; icon: LucideIcon }[] = [
  { value: "whatsapp", label: "WhatsApp", icon: MessageCircle },
  { value: "email", label: "E-mail", icon: Mail },
  { value: "phone", label: "Telefone", icon: Phone },
  { value: "web", label: "Outro", icon: MoreHorizontal },
];
const ORIGIN_LABEL: Record<Origin, string> = { whatsapp: "WhatsApp", email: "E-mail", phone: "Telefone", web: "Outro" };
const isOrigin = (value: unknown): value is Origin => typeof value === "string" && value in ORIGIN_LABEL;

const OWNER_MODES: { value: OwnerMode; label: string; icon: LucideIcon }[] = [
  { value: "me", label: "Assumir", icon: Hand },
  { value: "none", label: "Sem analista", icon: Inbox },
  { value: "other", label: "Outro", icon: UserRoundCog },
];

// Campos que barram o envio, na ordem da tela (o foco vai para o primeiro).
type ErrorKey = "location" | "customer" | "address" | "title" | "minutes" | "date" | "time" | "owner";
const ERROR_ORDER: ErrorKey[] = ["location", "customer", "address", "title", "minutes", "date", "time", "owner"];
const ERROR_FIELD: Record<ErrorKey, string> = {
  location: "nova-loja",
  customer: "nova-cliente",
  address: "nova-endereco",
  title: "nova-titulo",
  minutes: "nova-duracao",
  date: "nova-data",
  time: "nova-hora",
  owner: "nova-analista",
};
const ERROR_NAME: Record<ErrorKey, string> = {
  location: "loja",
  customer: "cliente",
  address: "endereço",
  title: "título",
  minutes: "duração",
  date: "data",
  time: "hora",
  owner: "analista",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pré-preenchimento pela URL (lista filtrada, ficha da loja ou do cliente, tipo de serviço). */
function readPrefill(params: { get(name: string): string | null }) {
  const id = (key: string) => {
    const value = params.get(key) ?? "";
    return UUID_RE.test(value) ? value : "";
  };
  return { locationId: id("location_id"), customerId: id("customer_id"), serviceTypeId: id("service_type_id") };
}

const iso = (ms: number) => new Date(ms).toISOString();
const SLOT_MS = 30 * 60_000;

/**
 * Próximo horário redondo (meia hora) daqui a pelo menos 1h, no fuso da operação, como os campos de
 * data e hora: à noite passa para amanhã sozinho. Ex.: { date: "2026-11-13", time: "14:30" }.
 */
function nextSlot(now: number): { date: string; time: string } {
  // O fuso de São Paulo é de horas inteiras: a meia hora redonda em UTC é a mesma de lá.
  const value = toLocalInput(iso(Math.ceil((now + 60 * 60_000) / SLOT_MS) * SLOT_MS));
  return { date: value.slice(0, 10), time: value.slice(11, 16) };
}

/** O dia seguinte no calendário ("2026-11-13" -> "2026-11-14"). */
function nextDay(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

interface Filled {
  key: string;
  label: string;
  /** Desfaz só se o campo ainda tem o que veio da mensagem (o que foi editado depois fica). */
  undo: (d: NewTicketDraft) => NewTicketDraft;
}

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
        {/* Número da etapa nas cores da logo (faz o papel da marca do CardHeader). */}
        <span className="mt-px flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[11px] font-bold text-brand-ink tabular-nums">
          {step}
        </span>
        <div className="min-w-0">
          <h2 className="text-[15px] leading-5 font-bold tracking-[-0.01em] text-ink">{title}</h2>
          {description ? <p className="mt-0.5 text-xs text-ink-muted">{description}</p> : null}
        </div>
      </div>
      <div className="p-5">{children}</div>
    </Card>
  );
}

function FieldError({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <span id={id} className="text-xs font-medium text-red-600 dark:text-red-400">
      {children}
    </span>
  );
}

/** Rótulo de um campo que não fica dentro de <label> (busca com lista, grupo de botões). */
function FieldLabel({ id, required, children }: { id: string; required?: boolean; children: React.ReactNode }) {
  return (
    <span id={id} className="text-xs font-semibold text-ink/80">
      {children}
      {required ? <span className="text-red-500"> *</span> : null}
    </span>
  );
}

export default function NewTicketPage() {
  // useSearchParams pede um Suspense em volta (pré-preenchimento pela URL).
  return (
    <Suspense fallback={<LoadingBlock />}>
      <NewTicket />
    </Suspense>
  );
}

function NewTicket() {
  const { user } = useAuth();
  // Na central o usuário sempre existe (o layout só mostra a tela com a sessão aberta).
  const userId = user?.id ?? "";
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const panel = useTicketPanel();
  const now = useNow(60_000);
  const ids = {
    store: useId(),
    customer: useId(),
    type: useId(),
    tags: useId(),
    origin: useId(),
  };

  // Começo da tela: o que veio pela URL tem prioridade; senão, o rascunho guardado nesta aba.
  const [prefill] = useState(() => readPrefill(params));
  const [start] = useState(() => {
    const stored = readStored<Origin>("local", ORIGIN_KEY);
    const fresh = blankDraft(isOrigin(stored) ? stored : "whatsapp");
    if (prefill.locationId || prefill.customerId || prefill.serviceTypeId) {
      return { draft: { ...fresh, form: { ...fresh.form, customer_id: prefill.customerId } }, savedAt: null };
    }
    const saved = userId ? readStored<StoredDraft>("session", draftKey(userId)) : null;
    return saved?.v === DRAFT_VERSION && saved.draft?.form && isFilled(saved.draft)
      ? { draft: saved.draft, savedAt: saved.savedAt }
      : { draft: fresh, savedAt: null };
  });
  const [d, setD] = useState<NewTicketDraft>(start.draft);
  const [restoredAt, setRestoredAt] = useState<number | null>(start.savedAt);
  const [pendingLocationId, setPendingLocationId] = useState(prefill.locationId);
  const [pendingTypeId, setPendingTypeId] = useState(prefill.serviceTypeId);
  const [created, setCreated] = useState<CreatedResult | null>(null);
  // A API barrou por conflito de agenda: o próximo envio confirma (até mudar técnico ou horário).
  const [conflicts, setConflicts] = useState<ConflictItem[] | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [filled, setFilled] = useState<Filled[]>([]);
  const [urgentHint, setUrgentHint] = useState(false);
  // Loja citada na mensagem: a busca abre já com ela (a chave nova remonta o campo).
  const [storeHint, setStoreHint] = useState<{ text: string; n: number } | null>(null);
  const [pasteOffer, setPasteOffer] = useState<string | null>(null);
  const [pasteCut, setPasteCut] = useState(false);
  const submitting = useRef(false);
  const f = d.form;

  const customers = useCustomers();
  const categories = useCategories();
  const assignable = useAssignable(null);
  const projects = useProjects({ enabled: true });
  // Tipos gerais + o catálogo do cliente. Ao trocar de cliente, a lista anterior fica até a nova chegar.
  const serviceTypes = useQuery({
    queryKey: ["service-types", f.customer_id, true],
    queryFn: () => api.get<ServiceType[]>("/service-types", { customer_id: f.customer_id || undefined, active: true }),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
  const templates = useQuery({
    queryKey: ["form-templates", "active"],
    queryFn: () => api.get<FormTemplate[]>("/form-templates", { active: true }),
    staleTime: 5 * 60_000,
  });
  const sla = useQuery({
    queryKey: ["sla-policies"],
    queryFn: () => api.get<SlaPolicy[]>("/sla-policies"),
    staleTime: 5 * 60_000,
  });
  const queues = useQuery({
    queryKey: ["tickets", "queues"],
    queryFn: () => api.get<QueuesOut>("/queues"),
    enabled: d.ownerMode === "other",
    staleTime: 60_000,
  });
  const prefillLocation = useQuery({
    queryKey: ["location", pendingLocationId],
    queryFn: () => api.get<Location>(`/locations/${pendingLocationId}`),
    enabled: Boolean(pendingLocationId),
  });

  // Pré-preenchimento: aplica a loja e o tipo de serviço quando chegam (uma vez só).
  if (pendingLocationId && (prefillLocation.data || prefillLocation.error)) {
    setPendingLocationId("");
    const loc = prefillLocation.data;
    if (loc) setD((x) => withLocation(x, loc, projects.data));
  }
  if (pendingTypeId && serviceTypes.data && !serviceTypes.isPlaceholderData) {
    setPendingTypeId("");
    const st = serviceTypes.data.find((t) => t.id === pendingTypeId);
    if (st) setD((x) => withServiceType(x, st, templates.data));
  }

  // Cliente e loja: etiquetas, avaliação, histórico, contato e prazo de chegada.
  const intake = useQuery({
    queryKey: ["intake", f.location_id || null, f.location_id ? null : f.customer_id || null],
    queryFn: () =>
      api.get<IntakeContext>("/intake/context", {
        location_id: f.location_id || undefined,
        customer_id: f.location_id ? undefined : f.customer_id || undefined,
      }),
    enabled: Boolean(f.location_id || f.customer_id),
    staleTime: 30_000,
  });

  const startIso = f.date && f.time ? fromLocalInput(`${f.date}T${f.time}`) : null;
  const minutesText = f.estimated_minutes.trim();
  const minutesNumber = minutesText ? Number(minutesText) : null;
  const minutesValid = minutesNumber === null || (Number.isInteger(minutesNumber) && minutesNumber >= 1 && minutesNumber <= MAX_MINUTES);
  const minutes = minutesValid ? minutesNumber : null;
  const debouncedTitle = useDebounced(f.title.trim(), 1000);
  const serviceTypeId = d.serviceType?.id ?? "";
  // Técnicos mais indicados para a loja, o serviço e o horário (o mesmo ranking da OS aberta).
  const suggestions = useQuery({
    queryKey: [
      "technician-suggest",
      f.location_id,
      serviceTypeId,
      f.category_id,
      f.project_id,
      startIso,
      minutes,
      // Com tipo de serviço, o título não entra: a lista não pisca nem muda de ordem a cada letra.
      serviceTypeId ? "" : debouncedTitle,
    ],
    queryFn: () =>
      api.get<TechnicianSuggestion[]>("/technicians/suggest", {
        location_id: f.location_id,
        service_type_id: serviceTypeId || undefined,
        category_id: f.category_id || undefined,
        project_id: f.project_id || undefined,
        title: serviceTypeId ? undefined : debouncedTitle.slice(0, 200) || undefined,
        start: startIso ?? undefined,
        estimated_minutes: minutes ?? undefined,
        limit: 5,
      }),
    enabled: Boolean(f.location_id),
    staleTime: 30_000,
    // Enquanto atualiza, a lista anterior fica (só se for a mesma loja).
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === f.location_id ? previous : undefined),
  });

  const sortedCategories = useMemo(
    () => [...(categories.data ?? [])].filter((c) => c.is_active).sort((a, b) => a.full_name.localeCompare(b.full_name, "pt-BR")),
    [categories.data],
  );
  // Técnicos primeiro, depois analistas; por carga.
  const people = useMemo(
    () =>
      [...(assignable.data ?? [])].sort(
        (a, b) =>
          (a.role === "technician" ? 0 : 1) - (b.role === "technician" ? 0 : 1) ||
          a.open_tickets - b.open_tickets ||
          a.name.localeCompare(b.name, "pt-BR"),
      ),
    [assignable.data],
  );
  const names = useMemo(() => {
    const map: Record<UUID, string> = {};
    for (const u of assignable.data ?? []) map[u.id] = u.name;
    for (const s of suggestions.data ?? []) map[s.id] = s.name;
    return map;
  }, [assignable.data, suggestions.data]);
  const projectOptions = (projects.data ?? []).filter(
    (p) =>
      (p.status === "active" || p.status === "planning" || p.id === f.project_id) &&
      (!p.customer || !f.customer_id || p.customer.id === f.customer_id),
  );
  const customerName = customers.data?.find((c) => c.id === f.customer_id)?.name ?? null;
  const location = d.location;
  const st = d.serviceType;

  // Prazos: SLA (24x7) e chegada contam da abertura; a visita marcada depois deles já nasce atrasada.
  const effectivePriority = f.priority || "medium";
  const policy = sla.data?.find((p) => p.priority === effectivePriority);
  const responseDue = policy ? now + policy.response_minutes * 60_000 : null;
  const resolutionDue = policy ? now + policy.resolution_minutes * 60_000 : null;
  const arrivalHours = location ? (intake.data?.location?.arrival_hours ?? null) : null;
  const arrivalDue = arrivalHours ? now + arrivalHours * 3_600_000 : null;
  const startMs = startIso ? new Date(startIso).getTime() : null;
  const startPassed = startMs !== null && startMs < now - 5 * 60_000;
  const lateFor =
    startMs === null || startPassed
      ? null
      : resolutionDue && startMs > resolutionDue
        ? "resolution"
        : arrivalDue && startMs > arrivalDue
          ? "arrival"
          : null;
  const endLabel = startIso ? formatTime(iso(new Date(startIso).getTime() + (minutes ?? 60) * 60_000)) : null;
  const storeAddress = location
    ? [location.address_line, location.district, [location.city, location.state].filter(Boolean).join("-")].filter(Boolean).join(", ")
    : "";

  // Validação antes de enviar (mensagem junto do campo; o foco vai para o primeiro problema).
  const errors: Partial<Record<ErrorKey, string>> = {};
  if (d.noStore) {
    if (!f.customer_id) errors.customer = "Escolha o cliente da loja.";
    if (!f.service_address.trim()) errors.address = "Informe o endereço do atendimento.";
  } else if (!f.location_id) {
    errors.location = "Escolha a loja do atendimento.";
  }
  if (f.title.trim().length < 3) errors.title = "Escreva um título com pelo menos 3 letras.";
  if (!minutesValid) errors.minutes = "Use de 1 a 10.080 minutos (7 dias).";
  if (f.time && !f.date) errors.date = "Informe a data da visita.";
  if (f.date && !f.time) errors.time = "Informe a hora da visita.";
  if (d.ownerMode === "other" && !d.ownerId) errors.owner = "Escolha o analista.";
  const shown = showErrors ? errors : {};
  const missing = ERROR_ORDER.filter((k) => shown[k]);
  const dirty = isFilled(d);

  // Rascunho nesta aba (sessionStorage some ao fechar a aba): volta ao recarregar ou ao voltar à tela.
  useEffect(() => {
    if (created || !userId) return;
    const timer = window.setTimeout(() => {
      const stored: StoredDraft = { v: DRAFT_VERSION, savedAt: Date.now(), draft: d };
      writeStored("session", draftKey(userId), isFilled(d) ? stored : null);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [d, created, userId]);

  // Fechar ou recarregar a aba com a OS pela metade pede confirmação ao navegador.
  useEffect(() => {
    if (!dirty || created) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, created]);

  const create = useMutation({
    mutationFn: async (input: {
      payload: TicketCreatePayload;
      tags: Tag[];
      forms: { id: UUID; name: string }[];
      formsRequired: boolean;
    }): Promise<CreatedResult> => {
      const ticket = await api.post<TicketDetail>("/tickets", input.payload);
      // A OS já existe: daqui em diante nada pode falhar a abertura (o analista reenviaria e duplicaria).
      const problems: string[] = [];
      let current = ticket;
      const saved = ticket.tags ?? [];
      const missingTags = input.tags.some((t) => !saved.some((s) => s.name.toLowerCase() === t.name.toLowerCase()));
      if (missingTags) {
        try {
          current = await api.patch<TicketDetail>(`/tickets/${ticket.id}`, { tags: input.tags, expected_version: current.version });
        } catch (err) {
          problems.push(`Etiquetas (${input.tags.map((t) => t.name).join(", ")}): ${errorMessage(err)}`);
        }
      }
      // Um formulário por vez: duas gravações ao mesmo tempo na mesma OS dão conflito de versão.
      let attached = 0;
      for (const form of input.forms) {
        try {
          await api.post(`/tickets/${ticket.id}/forms`, { template_id: form.id, required: input.formsRequired });
          attached += 1;
        } catch (err) {
          problems.push(`Formulário “${form.name}”: ${errorMessage(err)}`);
        }
      }
      if (attached) {
        try {
          current = await api.get<TicketDetail>(`/tickets/${ticket.id}`);
        } catch {
          // O resumo segue com a versão de antes dos formulários.
        }
      }
      return { ticket: current, problems };
    },
    onSuccess: (result) => {
      writeStored("session", draftKey(userId), null);
      setCreated(result);
      setConflicts(null);
      setShowErrors(false);
      for (const key of ["tickets", "dashboard", "intake", "assignable", "technician-suggest", "customers"]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
      window.scrollTo({ top: 0 });
    },
    onError: (error) => setConflicts(scheduleConflicts(error)),
    onSettled: () => {
      submitting.current = false;
    },
  });

  const setForm = <K extends keyof NewTicketForm>(key: K, value: NewTicketForm[K]) => {
    if (key === "assignee_id" || key === "date" || key === "time" || key === "estimated_minutes") setConflicts(null);
    setD((x) => ({
      ...x,
      form: { ...x.form, [key]: value },
      // Digitou: deixa de ser o que veio do tipo de serviço.
      titleFromType: key === "title" ? false : x.titleFromType,
      minutesFromType: key === "estimated_minutes" ? false : x.minutesFromType,
    }));
  };
  const onLocation = (loc: Location | null) => {
    setConflicts(null);
    setD((x) => withLocation(x, loc, projects.data));
  };
  const onCustomer = (customerId: string) => {
    setConflicts(null);
    setD((x) => withCustomer(x, customerId, projects.data));
  };
  const onServiceType = (type: ServiceType | null) => {
    setConflicts(null);
    setD((x) => withServiceType(x, type, templates.data));
  };
  const onOrigin = (source: Origin) => {
    setForm("source", source);
    writeStored("local", ORIGIN_KEY, source);
  };
  const toggleForm = (id: UUID) =>
    setD((x) => ({
      ...x,
      formIds: x.formIds.includes(id) ? x.formIds.filter((v) => v !== id) : [...x.formIds, id],
      autoFormIds: x.autoFormIds.filter((v) => v !== id),
    }));

  function pickDay(offset: 0 | 1) {
    // Dias e horas no fuso da operação (o mesmo dos campos), mesmo num computador em outro fuso.
    let date: string;
    let time = f.time;
    if (offset === 1) {
      date = nextDay(dayKey(now));
      time = time || "08:00";
    } else if (time) {
      date = dayKey(now);
    } else {
      ({ date, time } = nextSlot(now));
    }
    setConflicts(null);
    setD((x) => ({ ...x, form: { ...x.form, date, time } }));
  }

  /** Lê a mensagem colada e preenche só os campos vazios; cada campo vira um chip que desfaz. */
  function fillFromMessage(text: string, pastedInDescription = false) {
    const parsed = parseIntake(text);
    const chips: Filled[] = [];
    let next = d;
    const put = (key: "title" | "description" | "requester_name" | "requester_contact" | "client_reference", value: string | null, label: string) => {
      if (!value) return;
      const current = next.form[key].trim();
      // A descrição colada crua vira o texto limpo da mesma mensagem.
      const replace = key === "description" && pastedInDescription && current === text.trim();
      if (current && !replace) return;
      const previous = next.form[key];
      next = { ...next, form: { ...next.form, [key]: value }, titleFromType: key === "title" ? false : next.titleFromType };
      chips.push({
        key,
        label,
        undo: (x) => (x.form[key] === value ? { ...x, form: { ...x.form, [key]: previous } } : x),
      });
    };
    if (parsed.source && parsed.source !== next.form.source) {
      const previous = next.form.source;
      const source = parsed.source;
      next = { ...next, form: { ...next.form, source } };
      chips.push({
        key: "source",
        label: `Origem: ${ORIGIN_LABEL[source]}`,
        undo: (x) => (x.form.source === source ? { ...x, form: { ...x.form, source: previous } } : x),
      });
    }
    put("title", parsed.title, "Título");
    put("description", parsed.description.slice(0, TEXT_LIMIT), "Descrição");
    put("requester_name", parsed.contactName, `Quem pediu: ${parsed.contactName}`);
    put("requester_contact", parsed.contact, `Contato: ${parsed.contact}`);
    put("client_reference", parsed.clientReference, `Chamado do cliente: ${parsed.clientReference}`);
    setD(next);
    setFilled((old) => [...old.filter((c) => !chips.some((n) => n.key === c.key)), ...chips]);
    setUrgentHint(parsed.urgent && !next.form.priority);
    if (!chips.length && !parsed.cnpj && !parsed.storeHint) {
      toast({ title: "Nada para preencher", description: "Os campos já estavam preenchidos ou a mensagem não trouxe loja, contato nem nº do chamado." });
    }
    if (next.form.location_id || next.noStore) return;
    if (parsed.cnpj) void findStore(parsed.cnpj, parsed.storeHint);
    else if (parsed.storeHint) setStoreHint((h) => ({ text: parsed.storeHint ?? "", n: (h?.n ?? 0) + 1 }));
  }

  /** CNPJ da mensagem: uma loja só com ele já entra na OS; senão, a busca abre com a pista. */
  async function findStore(cnpj: string, hint: string | null) {
    try {
      const found = await api.get<Page<Location>>("/locations", { q: cnpj, active: true, page_size: 2 });
      if (found.total === 1) {
        const loc = found.items[0];
        setD((x) => (x.form.location_id ? x : withLocation(x, loc, projects.data)));
        setFilled((old) => [
          ...old.filter((c) => c.key !== "location"),
          {
            key: "location",
            label: `Loja: ${[loc.code, loc.name].filter(Boolean).join(" · ")}`,
            undo: (x) => (x.form.location_id === loc.id ? withLocation(x, null, projects.data) : x),
          },
        ]);
        return;
      }
    } catch {
      // Sem a busca pelo CNPJ, abre a busca com o que a mensagem diz.
    }
    setStoreHint((h) => ({ text: hint ?? cnpj, n: (h?.n ?? 0) + 1 }));
  }

  const undoFilled = (key: string) => {
    const chip = filled.find((c) => c.key === key);
    if (chip) setD((x) => chip.undo(x));
    setFilled((old) => old.filter((c) => c.key !== key));
  };

  const suggestionsForMessage: IntakeSuggestion[] =
    urgentHint && !f.priority
      ? [
          {
            key: "urgente",
            label: "A mensagem fala em urgência.",
            action: `Usar ${PRIORITY.high.code} · ${PRIORITY.high.label}`,
            onApply: () => {
              setForm("priority", "high");
              setUrgentHint(false);
            },
          },
        ]
      : [];

  const invite = (name: string | null) =>
    inviteText({
      name,
      service: st?.name ?? f.title,
      district: location?.district,
      city: location?.city,
      state: location?.state,
      startIso,
      fee: st?.technician_fee ?? null,
    });
  const copyGroupInvite = async () => {
    const ok = await copyText(invite(null));
    toast(
      ok
        ? { title: "Convite copiado: cole no grupo de técnicos do WhatsApp", tone: "success" }
        : { title: "Não deu para copiar o convite", description: "Use “Convidar” em um dos técnicos.", tone: "error" },
    );
  };
  const openPanel = panel ? (ticketId: UUID) => panel.open(ticketId) : undefined;

  function submit() {
    if (submitting.current || create.isPending || created) return;
    const first = ERROR_ORDER.find((k) => errors[k]);
    if (first) {
      setShowErrors(true);
      const el = document.getElementById(ERROR_FIELD[first]);
      el?.focus();
      el?.scrollIntoView({ block: "center" });
      return;
    }
    submitting.current = true;
    const address = f.service_address.trim();
    const payload: TicketCreatePayload = {
      title: f.title.trim(),
      description: f.description.trim(),
      type: f.type,
      priority: f.priority || null,
      source: f.source,
      category_id: f.category_id || null,
      customer_id: f.customer_id || null,
      location_id: d.noStore ? null : f.location_id || null,
      service_address: d.noStore || d.otherAddress ? address || null : null,
      service_type_id: st?.id ?? null,
      estimated_minutes: minutes,
      client_reference: f.client_reference.trim() || null,
      requester_name: f.requester_name.trim() || null,
      requester_contact: f.requester_contact.trim() || null,
      visit_note: f.visit_note.trim() || null,
      project_id: f.project_id || null,
      assignee_id: f.assignee_id || null,
      helper_ids: d.helperIds,
      scheduled_start: startIso,
      tags: d.tags,
    };
    if (conflicts) payload.allow_conflict = true;
    // "Assumir" é o padrão: sem owner_id, quem abre leva a OS para a própria fila.
    if (d.ownerMode === "none") payload.owner_id = null;
    else if (d.ownerMode === "other") payload.owner_id = d.ownerId;
    const forms = d.formIds.map((id) => ({ id, name: templates.data?.find((t) => t.id === id)?.name ?? "formulário" }));
    create.mutate({ payload, tags: d.tags, forms, formsRequired: d.formsRequired });
  }

  function startOver(keep?: { location: Location | null; customerId: string }) {
    setD(blankDraft(d.form.source, keep));
    setCreated(null);
    setConflicts(null);
    setShowErrors(false);
    setFilled([]);
    setUrgentHint(false);
    setStoreHint(null);
    setPasteOffer(null);
    setPasteCut(false);
    setRestoredAt(null);
    create.reset();
    window.scrollTo({ top: 0 });
  }

  const header = (
    <>
      <Link href="/chamados" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
        <ArrowLeft aria-hidden className="size-4" />
        Chamados
      </Link>
      <PageHeader title="Nova ordem de serviço" description="Loja, problema, agenda e técnico em um só lugar" />
    </>
  );

  if (created) {
    return (
      <div className="mx-auto max-w-6xl">
        {header}
        <CreatedTicket
          result={created}
          onNew={() => startOver()}
          onSameStore={() => startOver({ location: d.location, customerId: d.form.customer_id })}
        />
      </div>
    );
  }

  const storeText = location
    ? [location.code, location.name].filter(Boolean).join(" · ")
    : d.noStore
      ? "Loja não cadastrada"
      : "Sem loja";
  const summary = [
    storeText,
    startIso ? dayTimeLabel(startIso, now) : "sem agenda",
    f.assignee_id ? (names[f.assignee_id] ?? "técnico escolhido") : "sem técnico",
  ].join(" · ");

  return (
    <div className="mx-auto max-w-6xl">
      {header}

      {restoredAt ? (
        <div role="status" className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface px-4 py-2.5 text-sm text-ink-muted shadow-elev-1">
          <History aria-hidden className="size-4 shrink-0 text-ink-subtle" />
          <span>Rascunho recuperado (salvo {dayTimeLabel(iso(restoredAt), now, true)}): continue de onde parou.</span>
          <button
            type="button"
            onClick={() => {
              writeStored("session", draftKey(userId), null);
              startOver();
            }}
            className="font-semibold text-brand-ink hover:underline"
          >
            Descartar rascunho
          </button>
          <button
            type="button"
            onClick={() => setRestoredAt(null)}
            className="ml-auto rounded-md p-1 text-ink-subtle hover:bg-surface-2 hover:text-ink"
            aria-label="Fechar o aviso do rascunho"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>
      ) : null}

      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          // Já tratado pelo campo (busca com lista, etiqueta, mensagem do cliente): não é com o formulário.
          if (e.key !== "Enter" || e.defaultPrevented) return;
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            submit();
            return;
          }
          // Enter puro num campo de uma linha não abre a OS pela metade (só Ctrl+Enter ou o botão).
          if ((e.target as HTMLElement).tagName === "INPUT") e.preventDefault();
        }}
        className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]"
      >
        <div className="flex min-w-0 flex-col gap-4">
          <MessageIntake
            onFill={(text) => fillFromMessage(text)}
            filled={filled.map(({ key, label }) => ({ key, label }))}
            onUndo={undoFilled}
            suggestions={suggestionsForMessage}
          />

          <Section step={1} title="Onde" description="A loja define o cliente, o endereço e os técnicos sugeridos">
            <div className="grid gap-4 xl:grid-cols-3">
              {d.noStore ? (
                <Field label="Endereço do atendimento" required className="xl:col-span-2">
                  <Input
                    id={ERROR_FIELD.address}
                    value={f.service_address}
                    onChange={(e) => setForm("service_address", e.target.value)}
                    placeholder="Rua, número, bairro e cidade"
                    maxLength={255}
                    aria-invalid={shown.address ? true : undefined}
                    aria-describedby={shown.address ? "nova-endereco-erro" : undefined}
                  />
                  {shown.address ? <FieldError id="nova-endereco-erro">{shown.address}</FieldError> : null}
                </Field>
              ) : (
                <div className="flex flex-col gap-1.5 xl:col-span-2">
                  <FieldLabel id={ids.store} required>
                    Loja (local de atendimento)
                  </FieldLabel>
                  <LocationPicker
                    key={storeHint ? `pista-${storeHint.n}` : "loja"}
                    customerId={f.customer_id || null}
                    customerName={customerName}
                    onClearCustomer={() => onCustomer("")}
                    value={location}
                    onChange={onLocation}
                    initialQuery={storeHint?.text}
                    autoFocus={Boolean(storeHint)}
                    inputId={ERROR_FIELD.location}
                    labelledBy={ids.store}
                    invalid={Boolean(shown.location)}
                    describedBy={shown.location ? "nova-loja-erro" : undefined}
                  />
                  {shown.location ? <FieldError id="nova-loja-erro">{shown.location}</FieldError> : null}
                </div>
              )}
              <div className="flex flex-col gap-1.5">
                <FieldLabel id={ids.customer} required={d.noStore}>
                  Cliente
                </FieldLabel>
                <CustomerPicker
                  customers={customers.data}
                  loading={customers.isLoading}
                  value={f.customer_id}
                  onChange={(c) => onCustomer(c?.id ?? "")}
                  id={ERROR_FIELD.customer}
                  labelledBy={ids.customer}
                  invalid={Boolean(shown.customer)}
                  describedBy={shown.customer ? "nova-cliente-erro" : undefined}
                />
                {shown.customer ? (
                  <FieldError id="nova-cliente-erro">{shown.customer}</FieldError>
                ) : d.noStore ? null : (
                  <span className="text-xs text-ink-subtle">Opcional: limita a busca às lojas dele.</span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 xl:col-span-3">
                <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-ink-muted">
                  <input
                    type="checkbox"
                    checked={d.noStore}
                    onChange={(e) => {
                      const noStore = e.target.checked;
                      setConflicts(null);
                      setD((x) => ({
                        ...(noStore ? withLocation(x, null, projects.data) : x),
                        noStore,
                        otherAddress: false,
                        form: { ...(noStore ? withLocation(x, null, projects.data) : x).form, service_address: "" },
                      }));
                    }}
                    className="size-3.5 accent-[var(--brand)]"
                  />
                  Loja ainda não cadastrada
                </label>
                {d.noStore ? (
                  <span className="text-xs text-ink-muted">
                    A OS sai com o cliente e o endereço.{" "}
                    <Link href="/locais" target="_blank" className="font-semibold text-brand-ink hover:underline">
                      Cadastrar a loja
                    </Link>{" "}
                    (outra aba) deixa os próximos chamados mais rápidos.
                  </span>
                ) : null}
              </div>

              {location && !d.noStore ? (
                <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2/60 px-3.5 py-3 xl:col-span-3">
                  <p className="text-xs font-semibold text-ink/80">Endereço da OS</p>
                  {storeAddress ? (
                    <p className="text-sm text-ink">{storeAddress}</p>
                  ) : (
                    <p className="text-sm text-amber-700 dark:text-amber-300">Loja sem endereço no cadastro.</p>
                  )}
                  <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-ink-muted">
                    <input
                      type="checkbox"
                      checked={d.otherAddress}
                      onChange={(e) => {
                        const other = e.target.checked;
                        setD((x) => ({ ...x, otherAddress: other, form: { ...x.form, service_address: other ? x.form.service_address : "" } }));
                      }}
                      className="size-3.5 accent-[var(--brand)]"
                    />
                    Atender em outro endereço ou ponto de referência
                  </label>
                  {d.otherAddress ? (
                    <Input
                      value={f.service_address}
                      onChange={(e) => setForm("service_address", e.target.value)}
                      placeholder="Ex.: Doca 3, entrada pelos fundos"
                      maxLength={255}
                      autoFocus
                      aria-label="Endereço do atendimento"
                    />
                  ) : null}
                </div>
              ) : null}

              {f.location_id && !d.noStore ? (
                <div className="xl:col-span-3">
                  <OpenAtLocation locationId={f.location_id} />
                </div>
              ) : null}
            </div>
          </Section>

          <Section step={2} title="O quê" description="O tipo de serviço já traz a duração e sugere o título">
            <div className="grid gap-4 md:grid-cols-6">
              <div className="flex flex-col gap-1.5 md:col-span-4">
                <FieldLabel id={ids.type}>Tipo de serviço</FieldLabel>
                <ServiceTypePicker
                  types={serviceTypes.data}
                  loading={serviceTypes.isLoading}
                  value={st}
                  customerId={f.customer_id || null}
                  onChange={onServiceType}
                  id="nova-tipo"
                  labelledBy={ids.type}
                />
                {st?.technician_fee != null ? (
                  <span className="text-xs text-ink-muted">Valor do técnico por esta OS: {formatMoney(st.technician_fee)}</span>
                ) : null}
              </div>
              <div className="flex flex-col gap-1.5 md:col-span-2">
                <Field label="Duração estimada (min)">
                  <Input
                    id={ERROR_FIELD.minutes}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={MAX_MINUTES}
                    value={f.estimated_minutes}
                    onChange={(e) => setForm("estimated_minutes", e.target.value)}
                    placeholder="60"
                    aria-invalid={shown.minutes ? true : undefined}
                    aria-describedby={shown.minutes ? "nova-duracao-erro" : undefined}
                  />
                </Field>
                {shown.minutes ? (
                  <FieldError id="nova-duracao-erro">{shown.minutes}</FieldError>
                ) : (
                  <span className="text-xs text-ink-subtle">{minutes ? formatMinutes(minutes) : "Vazio: a agenda reserva 1h"}</span>
                )}
              </div>
              {st?.suggested_minutes && st.observed_median_minutes != null && minutes !== st.suggested_minutes ? (
                // A estimativa aprende: a mediana das OS concluídas deste tipo, com um clique para usar.
                <p className="-mt-2 flex flex-wrap items-center gap-x-1.5 text-xs text-ink-muted md:col-span-6">
                  <Lightbulb aria-hidden className="size-3.5 text-ink-subtle" />
                  Na prática, “{st.name}” leva ~{formatMinutes(st.observed_median_minutes)} (mediana de{" "}
                  {st.observed_count.toLocaleString("pt-BR")} OS).
                  <button
                    type="button"
                    onClick={() => setForm("estimated_minutes", String(st.suggested_minutes))}
                    className="font-semibold text-brand-ink hover:underline"
                  >
                    Usar {formatMinutes(st.suggested_minutes)}
                  </button>
                </p>
              ) : null}
              <Field label="Título" required className="md:col-span-6">
                <Input
                  id={ERROR_FIELD.title}
                  value={f.title}
                  onChange={(e) => setForm("title", e.target.value)}
                  placeholder="Ex.: PDV 2 sem rede"
                  maxLength={200}
                  aria-invalid={shown.title ? true : undefined}
                  aria-describedby={shown.title ? "nova-titulo-erro" : undefined}
                />
                {shown.title ? <FieldError id="nova-titulo-erro">{shown.title}</FieldError> : null}
              </Field>
              <div className="flex flex-col gap-1 md:col-span-6">
                <Field label="Descrição do problema">
                  <Textarea
                    value={f.description}
                    onChange={(e) => setForm("description", e.target.value.slice(0, TEXT_LIMIT))}
                    onPaste={(e) => {
                      const text = e.clipboardData.getData("text");
                      setPasteCut(f.description.length + text.length > TEXT_LIMIT);
                      // Mensagem inteira colada na descrição vazia: oferece preencher o resto com ela.
                      if (!f.description.trim() && text.trim().length > 80) setPasteOffer(text);
                    }}
                    rows={4}
                    maxLength={TEXT_LIMIT}
                    placeholder="O que o cliente relatou: sintomas, mensagens de erro, desde quando, quem é afetado..."
                  />
                </Field>
                <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                  {pasteOffer ? (
                    <p className="flex flex-wrap items-center gap-1.5 text-xs text-ink-muted" role="status">
                      <Lightbulb aria-hidden className="size-3.5 text-ink-subtle" />
                      Parece a mensagem do cliente.
                      <button
                        type="button"
                        onClick={() => {
                          fillFromMessage(pasteOffer, true);
                          setPasteOffer(null);
                        }}
                        className="font-semibold text-brand-ink hover:underline"
                      >
                        Preencher os outros campos com ela
                      </button>
                      <button
                        type="button"
                        onClick={() => setPasteOffer(null)}
                        className="rounded p-0.5 text-ink-subtle hover:bg-surface-2 hover:text-ink"
                        aria-label="Dispensar a sugestão"
                      >
                        <X aria-hidden className="size-3.5" />
                      </button>
                    </p>
                  ) : pasteCut ? (
                    <p className="text-xs font-medium text-amber-700 dark:text-amber-300" role="status">
                      O texto colado passou de {TEXT_LIMIT.toLocaleString("pt-BR")} caracteres e foi cortado no fim.
                    </p>
                  ) : (
                    <span />
                  )}
                  <span className="text-[11px] text-ink-subtle tabular-nums">
                    {f.description.length.toLocaleString("pt-BR")} / {TEXT_LIMIT.toLocaleString("pt-BR")}
                  </span>
                </div>
              </div>
              <Field label="Categoria" className="md:col-span-2">
                <Select value={f.category_id} onChange={(e) => setForm("category_id", e.target.value)}>
                  <option value="">Sem categoria</option>
                  {sortedCategories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.full_name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Prioridade (prazo)" className="md:col-span-2">
                <Select value={f.priority} onChange={(e) => setForm("priority", e.target.value as NewTicketForm["priority"])}>
                  <option value="">
                    Padrão ({PRIORITY.medium.code} · {PRIORITY.medium.label})
                  </option>
                  {PRIORITY_ORDER.map((p) => (
                    <option key={p} value={p}>
                      {PRIORITY[p].code} · {PRIORITY[p].label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Tipo de atendimento" className="md:col-span-2">
                <Select value={f.type} onChange={(e) => setForm("type", e.target.value as TicketType)}>
                  {(Object.keys(TICKET_TYPE) as TicketType[]).map((type) => (
                    <option key={type} value={type}>
                      {TICKET_TYPE[type]}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="flex flex-col gap-1.5 md:col-span-6">
                <FieldLabel id={ids.tags}>Etiquetas</FieldLabel>
                <TagsInput value={d.tags} onChange={(tags) => setD((x) => ({ ...x, tags }))} labelledBy={ids.tags} />
                <span className="text-xs text-ink-subtle">Dizem como a OS é cobrada (avulso ou contrato) e o que mais vale lembrar.</span>
              </div>
            </div>
          </Section>

          <Section step={3} title="Pedido do cliente" description="Por onde chegou, o nº do chamado no sistema do cliente e quem pediu">
            <div className="grid gap-4 md:grid-cols-6">
              <div className="flex flex-col gap-1.5 md:col-span-6">
                <FieldLabel id={ids.origin}>Origem</FieldLabel>
                <SegmentedRadio options={ORIGINS} value={f.source} onChange={onOrigin} ariaLabel="Origem" labelledBy={ids.origin} className="max-w-md" />
              </div>
              <Field label="Nº do chamado do cliente" className="md:col-span-2">
                <Input
                  value={f.client_reference}
                  onChange={(e) => setForm("client_reference", e.target.value)}
                  maxLength={80}
                  placeholder="Ex.: INC0012345"
                />
              </Field>
              <Field label="Quem pediu" className="md:col-span-2">
                <Input
                  value={f.requester_name}
                  onChange={(e) => setForm("requester_name", e.target.value)}
                  maxLength={160}
                  placeholder="Nome de quem abriu o chamado"
                />
              </Field>
              <Field label="Contato" className="md:col-span-2">
                <Input
                  value={f.requester_contact}
                  onChange={(e) => setForm("requester_contact", e.target.value)}
                  maxLength={160}
                  inputMode="tel"
                  placeholder="(11) 90000-0000"
                />
              </Field>
              {f.client_reference.trim().length >= 4 ? (
                <div className="md:col-span-6">
                  <SameClientReference reference={f.client_reference} />
                </div>
              ) : null}
            </div>
          </Section>

          <Section step={4} title="Quando e quem" description="Agende a visita e escolha entre os técnicos mais indicados para a loja">
            <div className="flex flex-col gap-5">
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_9rem_minmax(0,1fr)]">
                <div className="flex flex-col gap-1.5">
                  {/* h-4: mesma altura do rótulo do Field ("Hora"); os botões Hoje/Amanhã não empurram o campo. */}
                  <span className="flex h-4 items-center justify-between text-xs font-semibold text-ink/80">
                    <label htmlFor={ERROR_FIELD.date}>Data da visita</label>
                    <span className="flex gap-1">
                      {([0, 1] as const).map((offset) => (
                        <button
                          key={offset}
                          type="button"
                          onClick={() => pickDay(offset)}
                          className="rounded-md border border-line px-1.5 py-px text-[11px] font-medium text-ink-muted hover:border-brand hover:text-brand-ink"
                        >
                          {offset === 0 ? "Hoje" : "Amanhã"}
                        </button>
                      ))}
                    </span>
                  </span>
                  <Input
                    id={ERROR_FIELD.date}
                    type="date"
                    value={f.date}
                    onChange={(e) => setForm("date", e.target.value)}
                    aria-invalid={shown.date ? true : undefined}
                    aria-describedby={shown.date ? "nova-data-erro" : undefined}
                  />
                  {shown.date ? <FieldError id="nova-data-erro">{shown.date}</FieldError> : null}
                </div>
                <Field label="Hora">
                  <Input
                    id={ERROR_FIELD.time}
                    type="time"
                    step={300}
                    value={f.time}
                    onChange={(e) => setForm("time", e.target.value)}
                    aria-invalid={shown.time ? true : undefined}
                    aria-describedby={shown.time ? "nova-hora-erro" : undefined}
                  />
                  {shown.time ? <FieldError id="nova-hora-erro">{shown.time}</FieldError> : null}
                </Field>
                <div className="flex flex-col justify-end gap-1 pb-2 text-xs text-ink-muted">
                  {startIso ? (
                    <>
                      <span>
                        Das <span className="font-medium text-ink">{f.time}</span> às <span className="font-medium text-ink">{endLabel}</span>
                        {minutes ? "" : " (1h reservada)"}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setConflicts(null);
                          setD((x) => ({ ...x, form: { ...x.form, date: "", time: "" } }));
                        }}
                        className="w-fit text-ink-muted underline-offset-2 hover:text-ink hover:underline"
                      >
                        Deixar sem agenda
                      </button>
                    </>
                  ) : (
                    <span>Sem data, a OS fica na fila para agendar depois.</span>
                  )}
                </div>
              </div>
              {startPassed ? (
                <p className="-mt-2 flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300" role="status">
                  <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
                  Esse horário já passou. Confira a data e a hora da visita.
                </p>
              ) : null}

              <div className="flex flex-col gap-2">
                <SectionTitle
                  wrap
                  aside={
                    <>
                      {suggestions.isFetching ? <span className="text-xs text-ink-subtle">atualizando...</span> : null}
                      {f.location_id ? (
                        <button type="button" onClick={() => void copyGroupInvite()} className="text-xs font-semibold text-brand-ink hover:underline">
                          Copiar convite para o grupo
                        </button>
                      ) : null}
                    </>
                  }
                >
                  Técnicos sugeridos para a loja
                </SectionTitle>
                <SuggestedTechnicians
                  items={suggestions.data}
                  loading={suggestions.isLoading}
                  hasPlace={Boolean(f.location_id)}
                  scheduled={Boolean(startIso)}
                  assigneeId={f.assignee_id}
                  helperIds={d.helperIds}
                  onAssign={(t) => {
                    setConflicts(null);
                    setD((x) => ({
                      ...x,
                      form: { ...x.form, assignee_id: t?.id ?? "" },
                      helperIds: t ? x.helperIds.filter((id) => id !== t.id) : x.helperIds,
                    }));
                  }}
                  onToggleHelper={(t) => {
                    setConflicts(null);
                    setD((x) => ({
                      ...x,
                      helperIds: x.helperIds.includes(t.id) ? x.helperIds.filter((id) => id !== t.id) : [...x.helperIds, t.id].slice(0, 6),
                    }));
                  }}
                  invite={(t) => invite(t.name)}
                  error={suggestions.error}
                  onRetry={() => void suggestions.refetch()}
                />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Técnico responsável" hint="Inicia, conclui e colhe a assinatura">
                  <Select
                    value={f.assignee_id}
                    onChange={(e) => {
                      const id = e.target.value;
                      setConflicts(null);
                      setD((x) => ({ ...x, form: { ...x.form, assignee_id: id }, helperIds: x.helperIds.filter((h) => h !== id) }));
                    }}
                  >
                    <option value="">Deixar sem técnico (na fila)</option>
                    {people.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name} · {u.role === "technician" ? (u.team_name ?? "técnico") : ROLE[u.role]} · {u.open_tickets} em aberto
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Projeto" hint="Se a OS faz parte de um projeto do cliente">
                  <Select value={f.project_id} onChange={(e) => setForm("project_id", e.target.value)}>
                    <option value="">Sem projeto</option>
                    {projectOptions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.code} · {p.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="md:col-span-2">
                  <HelpersField
                    options={people
                      .filter((u) => u.role === "technician")
                      .map((u) => ({ id: u.id, name: u.name, detail: u.team_name ?? undefined }))}
                    assigneeId={f.assignee_id}
                    helperIds={d.helperIds}
                    names={names}
                    onChange={(helperIds) => {
                      setConflicts(null);
                      setD((x) => ({ ...x, helperIds }));
                    }}
                  />
                </div>
              </div>

              {conflicts ? (
                <ConflictList
                  tone="error"
                  items={conflicts}
                  title="Há técnico ocupado neste horário. Envie de novo para abrir mesmo assim."
                  onOpenTicket={openPanel}
                />
              ) : startIso ? (
                <>
                  {f.assignee_id ? (
                    <ConflictHint
                      assigneeId={f.assignee_id}
                      assigneeName={names[f.assignee_id]}
                      start={startIso}
                      estimatedMinutes={minutes}
                      onOpenTicket={openPanel}
                    />
                  ) : null}
                  {d.helperIds.map((id) => (
                    <ConflictHint key={id} assigneeId={id} assigneeName={names[id]} start={startIso} estimatedMinutes={minutes} onOpenTicket={openPanel} />
                  ))}
                </>
              ) : null}

              <div className="flex flex-col gap-1">
                <Field label="Recado para o técnico">
                  <Textarea
                    rows={3}
                    value={f.visit_note}
                    onChange={(e) => setForm("visit_note", e.target.value.slice(0, NOTE_LIMIT))}
                    maxLength={NOTE_LIMIT}
                    placeholder="Com quem falar, acesso, o que levar. O técnico vê no app."
                  />
                </Field>
                <span className="text-right text-[11px] text-ink-subtle tabular-nums">
                  {f.visit_note.length.toLocaleString("pt-BR")} / {NOTE_LIMIT.toLocaleString("pt-BR")}
                </span>
              </div>
            </div>
          </Section>

          <Section step={5} title="Formulários" description="Checklists que o técnico preenche no app; os obrigatórios travam a conclusão da OS">
            <FormsPicker
              templates={templates.data}
              loading={templates.isLoading}
              serviceType={st}
              value={d.formIds}
              onToggle={toggleForm}
              required={d.formsRequired}
              onRequiredChange={(formsRequired) => setD((x) => ({ ...x, formsRequired }))}
            />
          </Section>
        </div>

        <aside className="flex flex-col gap-4 lg:sticky lg:top-[4.5rem] lg:max-h-[calc(100dvh-10.5rem)] lg:overflow-y-auto">
          <Card className="p-4">
            <SectionTitle className="mb-2.5">Analista responsável</SectionTitle>
            <SegmentedRadio
              options={OWNER_MODES}
              value={d.ownerMode}
              onChange={(ownerMode) => setD((x) => ({ ...x, ownerMode }))}
              ariaLabel="Analista responsável"
            />
            {d.ownerMode === "other" ? (
              <div className="mt-2 flex flex-col gap-1">
                <Select
                  id={ERROR_FIELD.owner}
                  value={d.ownerId}
                  onChange={(e) => {
                    const ownerId = e.target.value;
                    setD((x) => ({ ...x, ownerId }));
                  }}
                  aria-label="Analista"
                  aria-invalid={shown.owner ? true : undefined}
                  aria-describedby={shown.owner ? "nova-analista-erro" : undefined}
                >
                  <option value="">Escolher analista...</option>
                  {(queues.data?.queues ?? [])
                    .filter((q) => q.user.id !== userId)
                    .map((q) => (
                      <option key={q.user.id} value={q.user.id}>
                        {q.user.name} ({q.open} abertas)
                      </option>
                    ))}
                </Select>
                {shown.owner ? <FieldError id="nova-analista-erro">{shown.owner}</FieldError> : null}
              </div>
            ) : null}
            <p className="mt-2 text-xs text-ink-muted">
              {d.ownerMode === "me"
                ? "A OS vai para a sua fila."
                : d.ownerMode === "none"
                  ? "Fica em “Sem analista” até alguém assumir."
                  : "Vai para a fila do analista escolhido."}
            </p>
          </Card>

          <Card>
            <IntakePanel context={intake.data} loading={intake.isLoading} error={intake.error} onRetry={() => void intake.refetch()} />
          </Card>

          <Card className="p-4">
            <SectionTitle aside={<PriorityBadge priority={effectivePriority} />}>Prazos desta OS</SectionTitle>
            {policy && responseDue && resolutionDue ? (
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
                <dt className="text-ink-muted">1ª resposta</dt>
                <dd className="text-right font-medium text-ink tabular-nums">até {dayTimeLabel(iso(responseDue), now, true)}</dd>
                <dt className="text-ink-muted">Solução</dt>
                <dd className="text-right font-medium text-ink tabular-nums">até {dayTimeLabel(iso(resolutionDue), now, true)}</dd>
                {arrivalDue ? (
                  <>
                    <dt className="text-ink-muted">Chegada</dt>
                    <dd className="text-right font-medium text-ink tabular-nums">
                      até {dayTimeLabel(iso(arrivalDue), now, true)} ({arrivalHours}h)
                    </dd>
                  </>
                ) : null}
              </dl>
            ) : sla.isLoading ? (
              <div className="mt-3 flex flex-col gap-2">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            ) : (
              <p className="mt-2 text-xs text-ink-muted">Os prazos seguem a prioridade escolhida.</p>
            )}
            {lateFor && startIso ? (
              <p
                className="mt-3 rounded-lg border border-amber-200 bg-amber-50/70 px-2.5 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
                role="status"
              >
                {lateFor === "resolution" && resolutionDue
                  ? `A visita (${dayTimeLabel(startIso, now, true)}) fica depois do prazo de solução (${dayTimeLabel(iso(resolutionDue), now, true)}): a OS já vai abrir atrasada. Escolha uma prioridade com prazo maior ou combine outra data.`
                  : arrivalDue
                    ? `A visita (${dayTimeLabel(startIso, now, true)}) fica depois do prazo de chegada (${dayTimeLabel(iso(arrivalDue), now, true)}): a chegada já vai contar como atrasada.`
                    : null}
              </p>
            ) : null}
          </Card>
        </aside>

        {/* Barra fixa no rodapé: o botão fica à vista em qualquer tela, com o resumo da OS. */}
        <div className="sticky bottom-3 z-20 flex flex-col gap-2 rounded-xl border border-line bg-surface/95 px-4 py-3 shadow-elev-2 backdrop-blur lg:col-span-2">
          {/* O ErrorBox já é anunciado (role="alert") ao aparecer. */}
          {create.error && !conflicts ? <ErrorBox message={errorMessage(create.error)} /> : null}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {missing.length ? (
              <p className="min-w-0 flex-1 text-sm font-medium text-red-600 dark:text-red-400" role="alert">
                Falta preencher: {missing.map((k) => ERROR_NAME[k]).join(", ")}.
              </p>
            ) : (
              <p className="min-w-0 flex-1 truncate text-sm text-ink-muted" title={summary}>
                {summary}
              </p>
            )}
            <span className="hidden items-center gap-1 text-[11px] text-ink-subtle sm:inline-flex">
              <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd>
            </span>
            <Button type="submit" variant="primary" loading={create.isPending}>
              {create.isPending ? null : <Save aria-hidden className="size-4" />}
              {create.isPending ? "Abrindo..." : conflicts ? "Abrir OS mesmo assim" : "Abrir OS"}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

