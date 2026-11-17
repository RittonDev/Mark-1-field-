"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  ArrowLeft,
  ChevronDown,
  Hand,
  History,
  Inbox,
  Lightbulb,
  Mail,
  MapPin,
  MessageCircle,
  MoreHorizontal,
  Phone,
  Plus,
  UserRoundCog,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useId, useMemo, useRef, useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { LocationDialog } from "@/components/LocationDialog";
import { LocationPicker } from "@/components/LocationPicker";
import { Combobox, searchText, type ComboItem } from "@/components/new-ticket/Combobox";
import { CreatedTicket, type CreatedResult } from "@/components/new-ticket/CreatedTicket";
import { CustomerPicker } from "@/components/new-ticket/CustomerPicker";
import { dayTimeLabel } from "@/components/new-ticket/dayTime";
import {
  autoTitle,
  blankDraft,
  DRAFT_VERSION,
  draftKey,
  isFilled,
  locationLabel,
  ORIGIN_KEY,
  withCustomer,
  withLocation,
  withServiceType,
  type NewTicketDraft,
  type NewTicketForm,
  type Origin,
  type OwnerMode,
  type StoredDraft,
  type TagMode,
} from "@/components/new-ticket/draft";
import { OpenAtLocation, SameClientReference } from "@/components/new-ticket/Duplicates";
import { FormsPicker } from "@/components/new-ticket/FormsPicker";
import { IntakePanel } from "@/components/new-ticket/IntakePanel";
import { inviteText } from "@/components/new-ticket/invite";
import { MessageIntake, type IntakeSuggestion } from "@/components/new-ticket/MessageIntake";
import { customerIn, parseIntake } from "@/components/new-ticket/parseIntake";
import { SegmentedRadio } from "@/components/new-ticket/SegmentedRadio";
import { ServiceTypePicker } from "@/components/new-ticket/ServiceTypePicker";
import { Caution, FieldError, Step, stepHintId } from "@/components/new-ticket/Step";
import { readStored, writeStored } from "@/components/new-ticket/storage";
import { HelpersField, SuggestedTechnicians } from "@/components/new-ticket/SuggestedTechnicians";
import { ConflictHint, ConflictList, scheduleConflicts } from "@/components/ScheduleConflict";
import { TagsInput } from "@/components/TagChips";
import { useTicketPanel } from "@/components/ticket/TicketPanel";
import { useToast } from "@/components/Toaster";
import {
  Button,
  Card,
  CardHeader,
  ErrorBox,
  Field,
  Input,
  Kbd,
  LoadingBlock,
  PageHeader,
  SectionTitle,
  Select,
  Skeleton,
  Textarea,
} from "@/components/ui";
import { useNow } from "@/components/useNow";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { PRIORITY, PRIORITY_ORDER, ROLE, TICKET_TYPE } from "@/lib/constants";
import { dayKey, formatMinutes, formatMoney, formatTime, fromLocalInput, toLocalInput } from "@/lib/format";
import { useUnsavedChanges } from "@/lib/hooks";
import { useProjects } from "@/lib/projects";
import { useAssignable, useCategories, useCustomers } from "@/lib/queries";
import { tagRulesQuery } from "@/lib/tagRules";
import type {
  AssignableUser,
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
import { copyText } from "@/lib/whatsapp";

/** Limites da API (TicketCreate): escopo e recado para o técnico. */
const TEXT_LIMIT = 20_000;
const NOTE_LIMIT = 5_000;
const MAX_MINUTES = 60 * 24 * 7;
/** "Mais detalhes" aberto ou fechado: lembrado neste navegador. */
const MORE_KEY = "maxx.novaOs.maisOpcoes";

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

// Campos que barram a criação, na ordem da tela (o foco vai para o primeiro). Os três últimos ficam em
// "Mais detalhes", que abre sozinho quando o problema está lá.
type ErrorKey = "customer" | "location" | "type" | "scope" | "date" | "time" | "title" | "minutes" | "owner";
const ERROR_ORDER: ErrorKey[] = ["customer", "location", "type", "scope", "date", "time", "title", "minutes", "owner"];
const IN_MORE: ErrorKey[] = ["title", "minutes", "owner"];
const ERROR_FIELD: Record<ErrorKey, string> = {
  customer: "nova-cliente",
  location: "nova-localizacao",
  type: "nova-tipo",
  scope: "nova-escopo",
  date: "nova-data",
  time: "nova-hora",
  title: "nova-titulo",
  minutes: "nova-duracao",
  owner: "nova-analista",
};
const ERROR_NAME: Record<ErrorKey, string> = {
  customer: "cliente",
  location: "localização",
  type: "tipo de OS",
  scope: "escopo",
  date: "data",
  time: "hora",
  title: "título",
  minutes: "duração",
  owner: "analista",
};
const errorId = (key: ErrorKey) => `${ERROR_FIELD[key]}-erro`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFILL_KEYS = ["location_id", "customer_id", "service_type_id"] as const;

/** Pré-preenchimento pela URL (lista filtrada, ficha da loja ou do cliente, tipo de serviço). */
function readPrefill(params: { get(name: string): string | null }) {
  const id = (key: (typeof PREFILL_KEYS)[number]) => {
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

/** "“A”", "“A” e “B”", "“A”, “B” e “C”". */
function quoteList(names: string[]): string {
  const quoted = names.map((n) => `“${n}”`);
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} e ${quoted[quoted.length - 1]}` : (quoted[0] ?? "");
}

interface Filled {
  key: string;
  label: string;
  /** Desfaz só se o campo ainda tem o que veio da mensagem (o que foi editado depois fica). */
  undo: (d: NewTicketDraft) => NewTicketDraft;
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
  const router = useRouter();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { toast } = useToast();
  const panel = useTicketPanel();
  const now = useNow(60_000);
  const uid = useId();
  const ids = {
    customer: `${uid}-cliente`,
    location: `${uid}-localizacao`,
    type: `${uid}-tipo`,
    scope: `${uid}-escopo`,
    schedule: `${uid}-agenda`,
    assignee: `${uid}-colaborador`,
    tags: `${uid}-etiquetas`,
    origin: `${uid}-origem`,
    owner: `${uid}-analista`,
    priority: `${uid}-prioridade`,
    more: `${uid}-mais`,
  };

  // Começo da tela: o rascunho guardado nesta aba tem prioridade (o pré-preenchimento pela URL vira uma
  // oferta no aviso do rascunho); sem rascunho, a OS já começa com o que veio pela URL.
  const [prefill] = useState(() => readPrefill(params));
  const hasPrefill = Boolean(prefill.locationId || prefill.customerId || prefill.serviceTypeId);
  const [start] = useState(() => {
    const stored = readStored<Origin>("local", ORIGIN_KEY);
    const fresh = blankDraft(isOrigin(stored) ? stored : "whatsapp");
    const saved = userId ? readStored<StoredDraft>("session", draftKey(userId)) : null;
    if (saved?.v === DRAFT_VERSION && saved.draft?.form && isFilled(saved.draft)) return { draft: saved.draft, savedAt: saved.savedAt };
    return { draft: { ...fresh, form: { ...fresh.form, customer_id: prefill.customerId } }, savedAt: null };
  });
  const restored = start.savedAt !== null;
  const [d, setD] = useState<NewTicketDraft>(start.draft);
  // O analista mexeu na OS (o pré-preenchimento não conta): só então o rascunho é gravado e sair da
  // tela pede confirmação. Rascunho recuperado já é trabalho dele.
  const [touched, setTouched] = useState(restored);
  const [restoredAt, setRestoredAt] = useState<number | null>(start.savedAt);
  const [offerPrefill, setOfferPrefill] = useState(restored && hasPrefill);
  const [pendingLocationId, setPendingLocationId] = useState(restored ? "" : prefill.locationId);
  const [pendingTypeId, setPendingTypeId] = useState(restored ? "" : prefill.serviceTypeId);
  // Cliente recém-escolhido (ou vindo pela URL sem a loja): se tiver uma localização ativa só, ela entra.
  const [onlyFor, setOnlyFor] = useState(restored || prefill.locationId ? "" : prefill.customerId);
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
  const [moreOpen, setMoreOpen] = useState(() => readStored<boolean>("local", MORE_KEY) === true);
  const [creatingLocation, setCreatingLocation] = useState(false);
  // Localização escolhida sozinha por ser a única ativa do cliente (para dizer isso embaixo do campo).
  const [autoLocationId, setAutoLocationId] = useState<string | null>(null);
  const submitting = useRef(false);
  const f = d.form;

  // O pré-preenchimento sai da URL: recarregar a página traz o rascunho, e não a OS em branco de novo.
  useEffect(() => {
    if (!hasPrefill) return;
    const url = new URL(window.location.href);
    for (const key of PREFILL_KEYS) url.searchParams.delete(key);
    // Mantém a marca do painel da OS (?os=), se houver: o Fechar dele continua voltando o histórico.
    const panelMark = (window.history.state as { mfPanel?: string } | null)?.mfPanel;
    window.history.replaceState(panelMark ? { mfPanel: panelMark } : null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [hasPrefill]);

  const customers = useCustomers();
  const categories = useCategories();
  const assignable = useAssignable(null);
  const projects = useProjects({ enabled: true });
  // Regras das etiquetas padrão. Sem elas (carregando ou com erro), nada de padrão adivinhado: a OS vai
  // sem a lista e a API aplica as regras que a gestão configurou.
  const tagRulesState = useQuery(tagRulesQuery);
  const tagRules = tagRulesState.data ?? null;
  const tagRulesLoading = tagRulesState.isPending;
  const tagRulesFailed = !tagRules && tagRulesState.isError;
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
  // A localização da URL: aplicada sozinha (sem rascunho) ou mostrada na oferta do aviso do rascunho.
  const prefillLocation = useQuery({
    queryKey: ["location", prefill.locationId],
    queryFn: () => api.get<Location>(`/locations/${prefill.locationId}`),
    enabled: Boolean(prefill.locationId) && (Boolean(pendingLocationId) || offerPrefill),
  });

  // Pré-preenchimento: aplica a localização e o tipo de OS quando chegam (uma vez só).
  if (pendingLocationId && (prefillLocation.data || prefillLocation.error)) {
    setPendingLocationId("");
    const loc = prefillLocation.data;
    if (loc?.is_active) setD((x) => (x.form.location_id ? x : withLocation(x, loc, projects.data)));
  }
  if (pendingTypeId && serviceTypes.data && !serviceTypes.isPlaceholderData && (templates.data || templates.error)) {
    setPendingTypeId("");
    const type = serviceTypes.data.find((t) => t.id === pendingTypeId);
    if (type) setD((x) => (x.serviceType ? x : withServiceType(x, type, templates.data)));
  }

  // Cliente com uma localização ativa só: ela entra sozinha e o passo 2 já fica pronto.
  const onlyLocation = useQuery({
    queryKey: ["locations", "only", onlyFor],
    queryFn: () => api.get<Page<Location>>("/locations", { customer_id: onlyFor, active: true, page: 1, page_size: 2 }),
    enabled: Boolean(onlyFor),
    staleTime: 30_000,
  });
  // Espera a resposta de agora (a lista em cache pode ser de antes de uma loja nova ser cadastrada).
  if (onlyFor && !onlyLocation.isFetching && (onlyLocation.data || onlyLocation.error)) {
    setOnlyFor("");
    const only = onlyLocation.data?.total === 1 ? onlyLocation.data.items[0] : null;
    if (only && d.form.customer_id === only.customer_id && !d.form.location_id) {
      setD((x) => (x.form.customer_id === only.customer_id && !x.form.location_id ? withLocation(x, only, projects.data) : x));
      setAutoLocationId(only.id);
    }
  }

  // Cliente e localização: etiquetas, avaliação, histórico, contato e prazo de chegada.
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
  const serviceTypeId = d.serviceType?.id ?? "";
  // Técnicos mais indicados para a localização, o tipo de OS e o horário (o mesmo ranking da OS aberta).
  const suggestions = useQuery({
    queryKey: ["technician-suggest", f.location_id, serviceTypeId, f.category_id, f.project_id, startIso, minutes],
    queryFn: () =>
      api.get<TechnicianSuggestion[]>("/technicians/suggest", {
        location_id: f.location_id,
        service_type_id: serviceTypeId || undefined,
        category_id: f.category_id || undefined,
        project_id: f.project_id || undefined,
        start: startIso ?? undefined,
        estimated_minutes: minutes ?? undefined,
        limit: 5,
      }),
    enabled: Boolean(f.location_id),
    staleTime: 30_000,
    // Enquanto atualiza, a lista anterior fica (só se for a mesma localização).
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === f.location_id ? previous : undefined),
  });

  const sortedCategories = useMemo(
    () => [...(categories.data ?? [])].filter((c) => c.is_active).sort((a, b) => a.full_name.localeCompare(b.full_name, "pt-BR")),
    [categories.data],
  );
  // Técnicos primeiro, depois a equipe interna; por carga.
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
  const assigneeItems = useMemo<ComboItem<AssignableUser>[]>(
    () =>
      people.map((u) => ({
        key: u.id,
        item: u,
        label: u.name,
        haystack: searchText(`${u.name} ${u.team_name ?? ""} ${ROLE[u.role]}`),
      })),
    [people],
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

  // Etiquetas: o padrão (da abertura ou de projeto) até o analista mexer; a lista que aparece é a enviada.
  const tagMode: TagMode = f.project_id ? "project" : "create";
  const defaultTags = (mode: TagMode): Tag[] =>
    tagRules ? (mode === "project" ? tagRules.on_project : tagRules.on_create).map((t) => ({ name: t.name, color: t.color })) : [];
  const tags: Tag[] = d.tagsAuto ? defaultTags(tagMode) : d.tags;

  // Prazo de solução (SLA 24x7, conta da abertura): avisa quando o agendamento já nasce depois dele.
  const policy = sla.data?.find((p) => p.priority === (f.priority || "medium"));
  const resolutionDue = policy ? now + policy.resolution_minutes * 60_000 : null;
  const startMs = startIso ? new Date(startIso).getTime() : null;
  const startPassed = startMs !== null && startMs < now - 5 * 60_000;
  const lateResolution = startMs !== null && !startPassed && resolutionDue !== null && startMs > resolutionDue;
  const endLabel = startMs !== null ? formatTime(iso(startMs + (minutes ?? 60) * 60_000)) : null;
  const storeAddress = location
    ? [location.address_line, location.district, [location.city, location.state].filter(Boolean).join("-")].filter(Boolean).join(", ")
    : "";
  const automaticTitle = autoTitle(d);
  const titleText = f.title.trim();

  // Validação antes de criar (mensagem junto do campo; o foco vai para o primeiro problema).
  const errors: Partial<Record<ErrorKey, string>> = {};
  if (!f.customer_id) errors.customer = "Escolha o cliente.";
  if (!f.location_id) errors.location = "Escolha a localização do atendimento.";
  if (!st) errors.type = "Escolha o tipo de OS.";
  if (!f.description.trim()) errors.scope = "Descreva o que deve ser feito no atendimento.";
  if (f.time && !f.date) errors.date = "Informe a data do agendamento.";
  if (f.date && !f.time) errors.time = "Informe a hora do agendamento.";
  if (titleText && titleText.length < 3) errors.title = "Use pelo menos 3 letras ou deixe em branco para o título automático.";
  if (!minutesValid) errors.minutes = "Use de 1 a 10.080 minutos (7 dias).";
  if (d.ownerMode === "other" && !d.ownerId) errors.owner = "Escolha o analista.";
  const shown = showErrors ? errors : {};
  const missing = ERROR_ORDER.filter((k) => shown[k]);
  const dirty = touched && isFilled(d);

  // Rascunho nesta aba (sessionStorage some ao fechar a aba): volta ao recarregar ou ao voltar à tela.
  useEffect(() => {
    if (created || !userId || !touched) return;
    const timer = window.setTimeout(() => {
      const stored: StoredDraft = { v: DRAFT_VERSION, savedAt: Date.now(), draft: d };
      writeStored("session", draftKey(userId), isFilled(d) ? stored : null);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [d, created, userId, touched]);

  // Fechar ou recarregar a aba com a OS pela metade pede confirmação (e o Sair da central também).
  useUnsavedChanges(dirty && !created);

  const create = useMutation({
    mutationFn: async (input: {
      payload: TicketCreatePayload;
      forms: { id: UUID; name: string }[];
      formsRequired: boolean;
    }): Promise<CreatedResult> => {
      const ticket = await api.post<TicketDetail>("/tickets", input.payload);
      // A OS já existe: daqui em diante nada pode falhar a criação (o analista reenviaria e duplicaria).
      const problems: string[] = [];
      let current = ticket;
      const saved = ticket.tags ?? [];
      const lost = (input.payload.tags ?? []).filter((t) => !saved.some((s) => s.name.toLowerCase() === t.name.toLowerCase()));
      if (lost.length) problems.push(`Etiquetas que não entraram: ${lost.map((t) => t.name).join(", ")}`);
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
      for (const key of ["tickets", "dashboard", "intake", "assignable", "technician-suggest", "customers", "ticket-tags"]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
      window.scrollTo({ top: 0 });
    },
    onError: (error) => {
      const found = scheduleConflicts(error);
      setConflicts(found);
      // O conflito aparece no passo do agendamento: leva a tela até ele.
      if (found) window.requestAnimationFrame(() => document.getElementById("nova-conflitos")?.scrollIntoView({ block: "center" }));
    },
    onSettled: () => {
      submitting.current = false;
    },
  });

  /** Mudança feita pelo analista (o pré-preenchimento usa setD direto e não conta como mexer). */
  const update = (fn: (x: NewTicketDraft) => NewTicketDraft) => {
    setTouched(true);
    setD(fn);
  };
  const setForm = <K extends keyof NewTicketForm>(key: K, value: NewTicketForm[K]) => {
    if (key === "assignee_id" || key === "date" || key === "time" || key === "estimated_minutes") setConflicts(null);
    update((x) => ({
      ...x,
      form: { ...x.form, [key]: value },
      // Digitou: deixa de ser a duração que veio do tipo de OS.
      minutesFromType: key === "estimated_minutes" ? false : x.minutesFromType,
    }));
  };
  const setMore = (open: boolean) => {
    setMoreOpen(open);
    writeStored("local", MORE_KEY, open);
  };

  const onCustomer = (customerId: string) => {
    setConflicts(null);
    update((x) => withCustomer(x, customerId, projects.data));
    if (customerId) setOnlyFor(customerId);
  };
  const onLocation = (loc: Location | null) => {
    setConflicts(null);
    setAutoLocationId(null);
    update((x) => withLocation(x, loc, projects.data));
  };
  const onServiceType = (type: ServiceType | null) => {
    setConflicts(null);
    update((x) => withServiceType(x, type, templates.data));
  };
  const onAssignee = (id: string) => {
    setConflicts(null);
    update((x) => ({ ...x, form: { ...x.form, assignee_id: id }, helperIds: x.helperIds.filter((h) => h !== id) }));
  };
  const onTags = (next: Tag[]) => update((x) => ({ ...x, tags: next, tagsAuto: false, tagsMode: tagMode }));
  const resetTags = () => update((x) => ({ ...x, tags: [], tagsAuto: true }));
  const onOrigin = (source: Origin) => {
    setForm("source", source);
    writeStored("local", ORIGIN_KEY, source);
  };
  const toggleForm = (id: UUID) =>
    update((x) => ({
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
    update((x) => ({ ...x, form: { ...x.form, date, time } }));
  }

  /** Leva o foco a um campo; o que fica em "Mais detalhes" abre a seção antes. */
  function focusField(id: string, inMore: boolean) {
    const go = () => {
      const el = document.getElementById(id);
      el?.focus();
      el?.scrollIntoView({ block: "center" });
    };
    if (inMore && !moreOpen) {
      setMore(true);
      window.requestAnimationFrame(go);
    } else {
      go();
    }
  }

  /** Lê a mensagem colada e preenche só os campos vazios; cada campo vira um chip que desfaz. */
  function fillFromMessage(text: string, pastedInScope = false) {
    const parsed = parseIntake(text);
    const chips: Filled[] = [];
    let next = d;
    const put = (key: "description" | "requester_name" | "requester_contact" | "client_reference", value: string | null, label: string) => {
      if (!value) return;
      const current = next.form[key].trim();
      // O escopo colado cru vira o texto limpo da mesma mensagem.
      const replace = key === "description" && pastedInScope && current === text.trim();
      if (current && !replace) return;
      const previous = next.form[key];
      next = { ...next, form: { ...next.form, [key]: value } };
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
    put("description", parsed.description.slice(0, TEXT_LIMIT), "Escopo");
    put("requester_name", parsed.contactName, `Quem pediu: ${parsed.contactName}`);
    put("requester_contact", parsed.contact, `Contato: ${parsed.contact}`);
    put("client_reference", parsed.clientReference, `Chamado do cliente: ${parsed.clientReference}`);
    // Cliente citado pelo nome (sem CNPJ: o CNPJ já leva à loja, e ela ao cliente).
    const named = !next.form.customer_id && !parsed.cnpj ? customerIn(text, (customers.data ?? []).filter((c) => c.is_active)) : null;
    if (named) {
      next = withCustomer(next, named.id, projects.data);
      chips.push({
        key: "customer",
        label: `Cliente: ${named.name}`,
        undo: (x) => (x.form.customer_id === named.id ? withCustomer(x, "", projects.data) : x),
      });
    }
    update(() => next);
    setFilled((old) => [...old.filter((c) => !chips.some((n) => n.key === c.key)), ...chips]);
    setUrgentHint(parsed.urgent && !next.form.priority);
    if (!chips.length && !parsed.cnpj && !parsed.storeHint) {
      toast({ title: "Nada para preencher", description: "Os campos já estavam preenchidos ou a mensagem não trouxe cliente, loja, contato nem nº do chamado." });
    }
    if (next.form.location_id) return;
    if (parsed.cnpj) void findStore(parsed.cnpj, parsed.storeHint);
    else if (parsed.storeHint) setStoreHint((h) => ({ text: parsed.storeHint ?? "", n: (h?.n ?? 0) + 1 }));
    else if (named) setOnlyFor(named.id);
  }

  /** CNPJ da mensagem: uma loja só com ele já entra na OS; senão, a busca abre com a pista. */
  async function findStore(cnpj: string, hint: string | null) {
    try {
      const found = await api.get<Page<Location>>("/locations", { q: cnpj, active: true, page_size: 2 });
      if (found.total === 1) {
        const loc = found.items[0];
        update((x) => (x.form.location_id ? x : withLocation(x, loc, projects.data)));
        setFilled((old) => [
          ...old.filter((c) => c.key !== "location"),
          {
            key: "location",
            label: `Localização: ${locationLabel(loc)}`,
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
    if (chip) update((x) => chip.undo(x));
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

  /** Cria a OS. `tagsNow`: a lista de etiquetas que acabou de mudar (Ctrl+Enter no campo de etiquetas). */
  function submit(tagsNow?: Tag[]) {
    if (submitting.current || create.isPending || created) return;
    const first = ERROR_ORDER.find((k) => errors[k]);
    if (first) {
      setShowErrors(true);
      focusField(ERROR_FIELD[first], IN_MORE.includes(first));
      return;
    }
    submitting.current = true;
    const address = f.service_address.trim();
    const payload: TicketCreatePayload = {
      title: titleText || automaticTitle,
      description: f.description.trim(),
      type: f.type,
      priority: f.priority || null,
      source: f.source,
      category_id: f.category_id || null,
      customer_id: f.customer_id,
      location_id: f.location_id,
      service_address: d.otherAddress ? address || null : null,
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
      // A lista que o analista vê (o padrão ou o que ele ajustou), mesmo vazia. Com o padrão sem as
      // regras (carregando ou com erro), vai sem a lista: a API aplica as regras configuradas (as de
      // projeto, com projeto), e não um padrão fixo por cima delas.
      tags: tagsNow ?? (d.tagsAuto && !tagRules ? undefined : tags),
    };
    if (conflicts) payload.allow_conflict = true;
    // "Assumir" é o padrão: sem owner_id, quem cria leva a OS para a própria fila.
    if (d.ownerMode === "none") payload.owner_id = null;
    else if (d.ownerMode === "other") payload.owner_id = d.ownerId;
    const forms = d.formIds.map((id) => ({ id, name: templates.data?.find((t) => t.id === id)?.name ?? "formulário" }));
    create.mutate({ payload, forms, formsRequired: d.formsRequired });
  }

  /** Volta ao formulário limpo com `next` (sem contar como mexida: nada é gravado até o analista agir). */
  function reset(next: NewTicketDraft) {
    writeStored("session", draftKey(userId), null);
    setD(next);
    setTouched(false);
    setCreated(null);
    setConflicts(null);
    setShowErrors(false);
    setFilled([]);
    setUrgentHint(false);
    setStoreHint(null);
    setPasteOffer(null);
    setPasteCut(false);
    setRestoredAt(null);
    setOfferPrefill(false);
    setAutoLocationId(null);
    setPendingLocationId("");
    setPendingTypeId("");
    setOnlyFor("");
    create.reset();
    window.scrollTo({ top: 0 });
  }
  const startOver = (keep?: { location: Location | null; customerId: string }) => reset(blankDraft(f.source, keep));
  /** O rascunho sai e a OS começa com o que veio pela URL (a localização, o cliente ou o tipo). */
  function startWithPrefill() {
    reset(blankDraft(f.source, { location: null, customerId: prefill.customerId }));
    setPendingLocationId(prefill.locationId);
    setPendingTypeId(prefill.serviceTypeId);
    setOnlyFor(prefill.locationId ? "" : prefill.customerId);
  }

  async function cancel() {
    if (dirty) {
      const ok = await confirm({
        title: "Descartar esta OS?",
        description: "O que foi preenchido aqui será apagado.",
        confirmLabel: "Descartar",
        cancelLabel: "Continuar preenchendo",
        tone: "danger",
      });
      if (!ok) return;
    }
    writeStored("session", draftKey(userId), null);
    // Sem mexida pendente: o rascunho não volta a ser gravado no caminho para a lista.
    setTouched(false);
    router.push("/chamados");
  }

  const header = (
    <>
      <Link href="/chamados" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
        <ArrowLeft aria-hidden className="size-4" />
        Chamados
      </Link>
      <PageHeader title="Nova OS" />
    </>
  );

  if (created) {
    return (
      <div className="mx-auto max-w-5xl">
        {header}
        <CreatedTicket
          result={created}
          onNew={() => startOver()}
          onSameStore={() => startOver({ location: d.location, customerId: d.form.customer_id })}
        />
      </div>
    );
  }

  const prefillCustomerName = customers.data?.find((c) => c.id === prefill.customerId)?.name;
  const prefillAction = prefill.locationId
    ? prefillLocation.data
      ? `Começar nova OS em ${locationLabel(prefillLocation.data)}`
      : "Começar nova OS na localização escolhida"
    : prefill.customerId
      ? `Começar nova OS para ${prefillCustomerName ?? "o cliente escolhido"}`
      : "Começar nova OS com o tipo escolhido";

  const summary = [
    customerName,
    location ? locationLabel(location) : null,
    startIso ? dayTimeLabel(startIso, now) : "sem agendamento",
    f.assignee_id ? (names[f.assignee_id] ?? "colaborador escolhido") : "sem colaborador",
  ]
    .filter(Boolean)
    .join(" · ");

  // O que já foi mexido em "Mais detalhes" (aparece com a seção fechada).
  const ownerName = d.ownerMode === "other" ? queues.data?.queues.find((q) => q.user.id === d.ownerId)?.user.name : null;
  const project = projectOptions.find((p) => p.id === f.project_id);
  const category = sortedCategories.find((c) => c.id === f.category_id);
  const moreSummary =
    [
      titleText ? `Título: ${titleText}` : null,
      d.ownerMode === "none" ? "Sem analista" : d.ownerMode === "other" ? `Analista: ${ownerName ?? "a escolher"}` : null,
      project ? `Projeto ${project.code}` : null,
      d.formIds.length ? `${d.formIds.length} ${d.formIds.length === 1 ? "formulário" : "formulários"}` : null,
      f.priority ? `Prioridade ${PRIORITY[f.priority].code}` : null,
      minutes ? `Duração ${formatMinutes(minutes)}` : null,
      f.client_reference.trim() ? `Chamado ${f.client_reference.trim()}` : null,
      f.visit_note.trim() ? "Recado para o técnico" : null,
      d.helperIds.length ? `${d.helperIds.length} ${d.helperIds.length === 1 ? "técnico junto" : "técnicos juntos"}` : null,
      d.otherAddress && f.service_address.trim() ? "Outro endereço" : null,
      category ? category.full_name : null,
      f.type !== "incident" ? TICKET_TYPE[f.type] : null,
    ]
      .filter(Boolean)
      .join(" · ") || "Título, duração, analista, projeto, prioridade, recado, endereço, outros técnicos, pedido do cliente e formulários";

  // Só o que pede ação: as regras não carregaram, ou a lista foi mexida e dá para voltar ao padrão.
  const tagsHint =
    d.tagsAuto && tagRulesFailed ? (
      "Não deu para carregar agora o padrão de etiquetas."
    ) : !d.tagsAuto && d.tagsMode === tagMode ? (
      <button type="button" onClick={resetTags} className="font-semibold text-brand-ink hover:underline">
        Voltar ao padrão
      </button>
    ) : undefined;

  return (
    <div className="mx-auto max-w-7xl">
      {header}

      {restoredAt ? (
        <div role="status" className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface px-4 py-2.5 text-sm text-ink-muted shadow-elev-1">
          <History aria-hidden className="size-4 shrink-0 text-ink-subtle" />
          <span>
            {offerPrefill
              ? `Você tem uma OS pela metade (salva ${dayTimeLabel(iso(restoredAt), now, true)}).`
              : `Rascunho recuperado (salvo ${dayTimeLabel(iso(restoredAt), now, true)}): continue de onde parou.`}
          </span>
          {offerPrefill ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setOfferPrefill(false);
                  setRestoredAt(null);
                }}
                className="font-semibold text-brand-ink hover:underline"
              >
                Continuar o rascunho
              </button>
              <button type="button" onClick={startWithPrefill} className="font-semibold text-brand-ink hover:underline">
                {prefillAction}
              </button>
            </>
          ) : (
            <button type="button" onClick={() => startOver()} className="font-semibold text-brand-ink hover:underline">
              Descartar rascunho
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setRestoredAt(null);
              setOfferPrefill(false);
            }}
            className="ml-auto rounded-md p-1 text-ink-subtle hover:bg-surface-2 hover:text-ink"
            aria-label="Fechar o aviso do rascunho"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>
      ) : null}

      <form
        noValidate
        aria-label="Nova OS"
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
          // Enter puro num campo de uma linha não cria a OS pela metade (só Ctrl+Enter ou o botão).
          if ((e.target as HTMLElement).tagName === "INPUT") e.preventDefault();
        }}
        // Lateral a partir de 1280 px: técnicos sugeridos e histórico do cliente e da loja ao lado dos
        // passos. Abaixo disso, ela desce para depois do formulário.
        className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_22rem] 2xl:grid-cols-[minmax(0,1fr)_24rem]"
      >
        <div className="flex min-w-0 flex-col gap-4">
          <MessageIntake
            onFill={(text) => fillFromMessage(text)}
            filled={filled.map(({ key, label }) => ({ key, label }))}
            onUndo={undoFilled}
            suggestions={suggestionsForMessage}
          />

          {/* @container: os passos ficam em duas colunas quando o cartão tem largura para isso. */}
          <Card className="@container">
            <CardHeader title="Dados da OS" />
            <ol className="grid gap-x-8 gap-y-5 p-4 sm:p-5 @2xl:grid-cols-2">
              <Step
                n={1}
                title="Cliente"
                titleId={ids.customer}
                required
                done={Boolean(f.customer_id)}
                error={shown.customer}
                errorId={errorId("customer")}
              >
                <CustomerPicker
                  customers={customers.data}
                  loading={customers.isLoading}
                  value={f.customer_id}
                  onChange={(c) => onCustomer(c?.id ?? "")}
                  id={ERROR_FIELD.customer}
                  labelledBy={ids.customer}
                  required
                  invalid={Boolean(shown.customer)}
                  describedBy={shown.customer ? errorId("customer") : stepHintId(ids.customer)}
                />
              </Step>

              <Step
                n={2}
                title="Localização"
                titleId={ids.location}
                required
                done={Boolean(f.location_id)}
                hint={location && autoLocationId === location.id ? "Escolhida sozinha: é a única localização ativa deste cliente." : undefined}
                error={shown.location}
                errorId={errorId("location")}
                extra={
                  location ? (
                    <>
                      <p className="flex items-start gap-1.5 text-xs text-ink-muted">
                        <MapPin aria-hidden className="mt-px size-3.5 shrink-0 text-ink-subtle" />
                        {d.otherAddress && f.service_address.trim() ? (
                          <span>
                            Atendimento em outro endereço: <span className="text-ink">{f.service_address.trim()}</span> (em Mais detalhes)
                          </span>
                        ) : storeAddress ? (
                          <span className="text-ink">{storeAddress}</span>
                        ) : (
                          <span>Localização sem endereço no cadastro: informe o endereço do atendimento em Mais detalhes.</span>
                        )}
                      </p>
                      <OpenAtLocation locationId={location.id} />
                    </>
                  ) : null
                }
              >
                <LocationPicker
                  key={storeHint ? `pista-${storeHint.n}` : "localizacao"}
                  customerId={f.customer_id || null}
                  requireCustomer
                  customerName={customerName}
                  onCreate={() => setCreatingLocation(true)}
                  value={location}
                  onChange={onLocation}
                  initialQuery={storeHint?.text}
                  autoFocus={Boolean(storeHint)}
                  inputId={ERROR_FIELD.location}
                  labelledBy={ids.location}
                  required
                  invalid={Boolean(shown.location)}
                  describedBy={shown.location ? errorId("location") : stepHintId(ids.location)}
                  placeholder="Buscar loja por nome, código, CNPJ ou cidade"
                />
              </Step>

              <Step
                n={3}
                title="Tipo de OS"
                titleId={ids.type}
                required
                done={Boolean(st)}
                hint={
                  st
                    ? [
                        `Duração estimada ${formatMinutes(st.estimated_minutes)}`,
                        st.technician_fee != null ? `valor do técnico ${formatMoney(st.technician_fee)}` : null,
                        d.autoFormIds.length
                          ? `${d.autoFormIds.length} ${d.autoFormIds.length === 1 ? "formulário sugerido" : "formulários sugeridos"}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : undefined
                }
                error={shown.type}
                errorId={errorId("type")}
              >
                <ServiceTypePicker
                  types={serviceTypes.data}
                  loading={serviceTypes.isLoading}
                  value={st}
                  customerId={f.customer_id || null}
                  onChange={onServiceType}
                  id={ERROR_FIELD.type}
                  labelledBy={ids.type}
                  required
                  invalid={Boolean(shown.type)}
                  describedBy={shown.type ? errorId("type") : stepHintId(ids.type)}
                  placeholder="Buscar tipo de OS"
                />
              </Step>

              <Step
                n={4}
                title="Escopo"
                titleId={ids.scope}
                htmlFor={ERROR_FIELD.scope}
                required
                done={Boolean(f.description.trim())}
                className="@2xl:row-span-2"
                error={shown.scope}
                errorId={errorId("scope")}
                extra={
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
                          Preencher cliente, localização e contato com ela
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
                    ) : null}
                    {/* O contador só aparece perto do limite. */}
                    {f.description.length >= TEXT_LIMIT * 0.9 ? (
                      <span className="ml-auto text-[11px] text-ink-subtle tabular-nums">
                        {f.description.length.toLocaleString("pt-BR")} / {TEXT_LIMIT.toLocaleString("pt-BR")}
                      </span>
                    ) : null}
                  </div>
                }
              >
                <Textarea
                  id={ERROR_FIELD.scope}
                  value={f.description}
                  onChange={(e) => setForm("description", e.target.value.slice(0, TEXT_LIMIT))}
                  onPaste={(e) => {
                    const text = e.clipboardData.getData("text");
                    setPasteCut(f.description.length + text.length > TEXT_LIMIT);
                    // Mensagem inteira colada no escopo vazio: oferece preencher o resto com ela.
                    if (!f.description.trim() && text.trim().length > 80) setPasteOffer(text);
                  }}
                  rows={5}
                  // Na coluna da direita, ao lado do tipo de OS e do agendamento: cresce até o fim deles.
                  className="min-h-32 flex-1"
                  maxLength={TEXT_LIMIT}
                  required
                  aria-invalid={shown.scope ? true : undefined}
                  aria-describedby={shown.scope ? errorId("scope") : stepHintId(ids.scope)}
                />
              </Step>

              <Step
                n={5}
                title="Data e hora do agendamento"
                titleId={ids.schedule}
                done={Boolean(startIso)}
                aside={
                  <span className="flex gap-1">
                    {([0, 1] as const).map((offset) => (
                      <button
                        key={offset}
                        type="button"
                        onClick={() => pickDay(offset)}
                        aria-label={offset === 0 ? "Agendar para hoje" : "Agendar para amanhã"}
                        className="rounded-md border border-line px-2 py-0.5 text-xs font-medium text-ink-muted hover:border-brand hover:text-brand-ink focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
                      >
                        {offset === 0 ? "Hoje" : "Amanhã"}
                      </button>
                    ))}
                  </span>
                }
                hint={
                  startIso ? (
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span>
                        Das <span className="font-medium text-ink">{f.time}</span> às <span className="font-medium text-ink">{endLabel}</span> (
                        {minutes ? formatMinutes(minutes) : "1h reservada"})
                      </span>
                      <button
                        type="button"
                        onClick={() => focusField(ERROR_FIELD.minutes, true)}
                        className="font-semibold text-brand-ink hover:underline"
                      >
                        Mudar a duração
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setConflicts(null);
                          update((x) => ({ ...x, form: { ...x.form, date: "", time: "" } }));
                        }}
                        className="font-semibold text-brand-ink hover:underline"
                      >
                        Deixar sem agendamento
                      </button>
                    </span>
                  ) : undefined
                }
                error={shown.date ?? shown.time}
                errorId={shown.date ? errorId("date") : errorId("time")}
                extra={
                  <>
                    {startPassed ? <Caution>Esse horário já passou. Confira a data e a hora do agendamento.</Caution> : null}
                    {lateResolution && startIso && resolutionDue ? (
                      <Caution>
                        O agendamento ({dayTimeLabel(startIso, now, true)}) fica depois do prazo de solução ({dayTimeLabel(iso(resolutionDue), now, true)}):
                        a OS já nasce atrasada.{" "}
                        <button type="button" onClick={() => focusField(ids.priority, true)} className="font-semibold underline underline-offset-2 hover:no-underline">
                          Mudar a prioridade
                        </button>
                      </Caution>
                    ) : null}
                    {conflicts ? (
                      <div id="nova-conflitos">
                        <ConflictList
                          tone="error"
                          items={conflicts}
                          title="Há técnico ocupado neste horário. Clique em “Criar mesmo assim” para criar a OS assim mesmo."
                          onOpenTicket={openPanel}
                        />
                      </div>
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
                  </>
                }
              >
                <div role="group" aria-labelledby={ids.schedule} className="grid max-w-md grid-cols-[minmax(0,1fr)_8.5rem] gap-3">
                  <div className="flex flex-col gap-1">
                    <label htmlFor={ERROR_FIELD.date} className="text-xs font-semibold text-ink/80">
                      Data
                    </label>
                    <Input
                      id={ERROR_FIELD.date}
                      type="date"
                      value={f.date}
                      onChange={(e) => setForm("date", e.target.value)}
                      aria-invalid={shown.date ? true : undefined}
                      aria-describedby={shown.date ? errorId("date") : stepHintId(ids.schedule)}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label htmlFor={ERROR_FIELD.time} className="text-xs font-semibold text-ink/80">
                      Hora
                    </label>
                    <Input
                      id={ERROR_FIELD.time}
                      type="time"
                      step={300}
                      value={f.time}
                      onChange={(e) => setForm("time", e.target.value)}
                      aria-invalid={shown.time ? true : undefined}
                      aria-describedby={shown.time ? errorId("time") : stepHintId(ids.schedule)}
                    />
                  </div>
                </div>
              </Step>

              <Step
                n={6}
                title="Colaborador"
                titleId={ids.assignee}
                done={Boolean(f.assignee_id)}
              >
                <Combobox<AssignableUser>
                  items={assigneeItems}
                  value={f.assignee_id}
                  valueLabel={f.assignee_id ? (names[f.assignee_id] ?? "Colaborador escolhido") : undefined}
                  onChange={(u) => onAssignee(u?.id ?? "")}
                  loading={assignable.isLoading}
                  id="nova-colaborador"
                  labelledBy={ids.assignee}
                  describedBy={stepHintId(ids.assignee)}
                  placeholder="Buscar colaborador por nome ou equipe"
                  emptyText="Nenhum colaborador com esse nome"
                  clearLabel="Tirar o colaborador"
                  renderItem={(u) => (
                    <span className="flex flex-col">
                      <span className="font-medium">{u.name}</span>
                      <span className="text-xs text-ink-muted">
                        {u.role === "technician" ? (u.team_name ?? "Técnico") : ROLE[u.role]} · {u.open_tickets} em aberto
                      </span>
                    </span>
                  )}
                />
              </Step>

              <Step
                n={7}
                title="Etiquetas"
                titleId={ids.tags}
                done={tags.length > 0}
                hint={tagsHint}
                extra={
                  !d.tagsAuto && d.tagsMode !== tagMode ? (
                    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-ink-muted" role="status">
                      <Lightbulb aria-hidden className="size-3.5 shrink-0 text-ink-subtle" />
                      {tagMode === "project" ? "A OS agora é de projeto" : "A OS saiu do projeto"}
                      {tagRules
                        ? `: o padrão é ${defaultTags(tagMode).length ? quoteList(defaultTags(tagMode).map((t) => t.name)) : "sem etiquetas"}.`
                        : ": o padrão de etiquetas muda."}
                      <button type="button" onClick={resetTags} className="font-semibold text-brand-ink hover:underline">
                        Usar o padrão
                      </button>
                    </p>
                  ) : null
                }
              >
                {d.tagsAuto && tagRulesLoading ? (
                  <Skeleton className="h-10 w-full rounded-lg" />
                ) : d.tagsAuto && tagRulesFailed ? (
                  // Sem as regras não há como mostrar o padrão certo: a API aplica ao criar.
                  <div
                    role="status"
                    className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink-muted"
                  >
                    <span>As etiquetas padrão serão aplicadas ao criar.</span>
                    <button
                      type="button"
                      onClick={() => void tagRulesState.refetch()}
                      disabled={tagRulesState.isFetching}
                      className="font-semibold text-brand-ink hover:underline disabled:cursor-wait disabled:opacity-60"
                    >
                      {tagRulesState.isFetching ? "Carregando..." : "Mostrar o padrão"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        // A lista passa a ser a escolhida aqui (começa vazia); o foco vai para o campo.
                        onTags([]);
                        window.requestAnimationFrame(() => document.getElementById(`${ids.tags}-campo`)?.focus());
                      }}
                      className="font-semibold text-brand-ink hover:underline"
                    >
                      Escolher as etiquetas
                    </button>
                  </div>
                ) : (
                  <TagsInput
                    value={tags}
                    onChange={onTags}
                    onSubmitShortcut={(next) => submit(next)}
                    inputId={`${ids.tags}-campo`}
                    labelledBy={ids.tags}
                    describedBy={stepHintId(ids.tags)}
                  />
                )}
              </Step>
            </ol>
          </Card>

          <Card>
            <h2>
              <button
                type="button"
                aria-expanded={moreOpen}
                aria-controls={ids.more}
                aria-labelledby={`${ids.more}-titulo`}
                aria-describedby={`${ids.more}-resumo`}
                onClick={() => setMore(!moreOpen)}
                className="flex w-full items-center gap-3 rounded-xl px-4 py-3.5 text-left transition-colors hover:bg-surface-2/60 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none sm:px-5"
              >
                <span className="flex min-w-0 flex-1 gap-2.5">
                  {/* A mesma marca de seção do CardHeader (azul -> ciano), como em "Dados da OS". */}
                  <span aria-hidden className="mt-[3px] h-3.5 w-[3px] shrink-0 rounded-full bg-linear-to-b from-brand to-brand-cyan" />
                  <span className="min-w-0 flex-1">
                    <span id={`${ids.more}-titulo`} className="block text-[15px] leading-5 font-bold tracking-[-0.01em] text-ink">
                      Mais detalhes
                    </span>
                    <span id={`${ids.more}-resumo`} className="mt-0.5 block truncate text-xs font-normal text-ink-muted" title={moreSummary}>
                      {moreSummary}
                    </span>
                  </span>
                </span>
                <ChevronDown aria-hidden className={clsx("size-4 shrink-0 text-ink-subtle transition-transform duration-200", moreOpen && "rotate-180")} />
              </button>
            </h2>
            <div id={ids.more} hidden={!moreOpen} className="@container animate-enter border-t border-line px-4 py-4 sm:px-5">
              {/* Duas colunas quando cabe; o que é longo (outros técnicos, pedido do cliente, formulários) usa a linha toda. */}
              <div className="grid gap-x-6 gap-y-5 @2xl:grid-cols-2">
                <Field label="Título" error={shown.title}>
                  <Input
                    id={ERROR_FIELD.title}
                    value={f.title}
                    onChange={(e) => setForm("title", e.target.value)}
                    placeholder={automaticTitle || "Tipo de OS · Localização"}
                    maxLength={200}
                    aria-invalid={shown.title ? true : undefined}
                  />
                </Field>

                <div className="flex flex-col gap-1.5">
                  <Field label="Duração estimada (min)" error={shown.minutes} hint={minutes ? formatMinutes(minutes) : undefined}>
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
                      className="w-40"
                    />
                  </Field>
                  {st?.suggested_minutes && st.observed_median_minutes != null && minutes !== st.suggested_minutes ? (
                    // A estimativa aprende: a mediana das OS concluídas deste tipo, com um clique para usar.
                    <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-ink-muted">
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
                </div>

                <div className="flex flex-col gap-1.5">
                  <span id={ids.owner} className="text-xs font-semibold text-ink/80">
                    Analista responsável
                  </span>
                  <SegmentedRadio
                    options={OWNER_MODES}
                    value={d.ownerMode}
                    onChange={(ownerMode) => update((x) => ({ ...x, ownerMode }))}
                    ariaLabel="Analista responsável"
                    labelledBy={ids.owner}
                    className="max-w-sm"
                  />
                  {d.ownerMode === "other" ? (
                    <Select
                      id={ERROR_FIELD.owner}
                      value={d.ownerId}
                      onChange={(e) => {
                        const ownerId = e.target.value;
                        update((x) => ({ ...x, ownerId }));
                      }}
                      aria-label="Analista"
                      aria-invalid={shown.owner ? true : undefined}
                      aria-describedby={shown.owner ? errorId("owner") : undefined}
                      className="sm:max-w-sm"
                    >
                      <option value="">{queues.isLoading ? "Carregando analistas..." : "Escolher analista..."}</option>
                      {(queues.data?.queues ?? [])
                        .filter((q) => q.user.id !== userId)
                        .map((q) => (
                          <option key={q.user.id} value={q.user.id}>
                            {q.user.name} ({q.open} abertas)
                          </option>
                        ))}
                    </Select>
                  ) : null}
                  {shown.owner ? <FieldError id={errorId("owner")}>{shown.owner}</FieldError> : null}
                </div>

                <Field label="Projeto">
                  <Select value={f.project_id} onChange={(e) => setForm("project_id", e.target.value)}>
                    <option value="">Sem projeto</option>
                    {projectOptions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.code} · {p.name}
                      </option>
                    ))}
                  </Select>
                </Field>

                <div className="flex flex-col gap-1">
                  <Field label="Recado para o técnico">
                    <Textarea
                      rows={3}
                      value={f.visit_note}
                      onChange={(e) => setForm("visit_note", e.target.value.slice(0, NOTE_LIMIT))}
                      maxLength={NOTE_LIMIT}
                    />
                  </Field>
                  {f.visit_note.length >= NOTE_LIMIT * 0.9 ? (
                    <span className="text-right text-[11px] text-ink-subtle tabular-nums">
                      {f.visit_note.length.toLocaleString("pt-BR")} / {NOTE_LIMIT.toLocaleString("pt-BR")}
                    </span>
                  ) : null}
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-semibold text-ink/80">Endereço do atendimento</span>
                  {location ? (
                    <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2/60 px-3.5 py-3">
                      <p className="text-sm text-ink">{storeAddress || "Localização sem endereço no cadastro."}</p>
                      <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-ink-muted">
                        <input
                          type="checkbox"
                          checked={d.otherAddress}
                          onChange={(e) => {
                            const other = e.target.checked;
                            update((x) => ({ ...x, otherAddress: other, form: { ...x.form, service_address: other ? x.form.service_address : "" } }));
                          }}
                          className="size-3.5 accent-[var(--brand)]"
                        />
                        Atender em outro endereço ou ponto de referência
                      </label>
                      {d.otherAddress ? (
                        <Input
                          value={f.service_address}
                          onChange={(e) => setForm("service_address", e.target.value)}
                          maxLength={255}
                          autoFocus
                          aria-label="Outro endereço do atendimento"
                        />
                      ) : null}
                    </div>
                  ) : (
                    <span className="text-sm text-ink-subtle">—</span>
                  )}
                </div>

                {/* Três seletores curtos lado a lado, na linha toda. */}
                <div className="grid gap-x-6 gap-y-5 @2xl:col-span-2 @2xl:grid-cols-3">
                  <Field label="Prioridade">
                    <Select id={ids.priority} value={f.priority} onChange={(e) => setForm("priority", e.target.value as NewTicketForm["priority"])}>
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
                  <Field label="Categoria">
                    <Select value={f.category_id} onChange={(e) => setForm("category_id", e.target.value)}>
                      <option value="">Sem categoria</option>
                      {sortedCategories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.full_name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Tipo de atendimento">
                    <Select value={f.type} onChange={(e) => setForm("type", e.target.value as TicketType)}>
                      {(Object.keys(TICKET_TYPE) as TicketType[]).map((type) => (
                        <option key={type} value={type}>
                          {TICKET_TYPE[type]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>

                <div className="@2xl:col-span-2">
                  <HelpersField
                    options={people
                      .filter((u) => u.role === "technician")
                      .map((u) => ({ id: u.id, name: u.name, detail: u.team_name ?? undefined }))}
                    assigneeId={f.assignee_id}
                    helperIds={d.helperIds}
                    names={names}
                    onChange={(helperIds) => {
                      setConflicts(null);
                      update((x) => ({ ...x, helperIds }));
                    }}
                  />
                </div>

                <fieldset className="grid gap-3 rounded-lg border border-line p-3.5 @2xl:col-span-2 @2xl:grid-cols-2">
                  <legend className="px-1 text-xs font-semibold text-ink/80">Pedido do cliente</legend>
                  <div className="flex flex-col gap-1.5">
                    <span id={ids.origin} className="text-xs font-semibold text-ink/80">
                      Origem
                    </span>
                    <SegmentedRadio options={ORIGINS} value={f.source} onChange={onOrigin} ariaLabel="Origem" labelledBy={ids.origin} className="max-w-md" />
                  </div>
                  <Field label="Nº do chamado do cliente">
                    <Input value={f.client_reference} onChange={(e) => setForm("client_reference", e.target.value)} maxLength={80} />
                  </Field>
                  {f.client_reference.trim().length >= 4 ? (
                    <div className="@2xl:col-span-2">
                      <SameClientReference reference={f.client_reference} />
                    </div>
                  ) : null}
                  <Field label="Quem pediu">
                    <Input
                      value={f.requester_name}
                      onChange={(e) => setForm("requester_name", e.target.value)}
                      maxLength={160}
                    />
                  </Field>
                  <Field label="Contato">
                    <Input
                      value={f.requester_contact}
                      onChange={(e) => setForm("requester_contact", e.target.value)}
                      maxLength={160}
                      inputMode="tel"
                    />
                  </Field>
                </fieldset>

                <div className="flex flex-col gap-1.5 @2xl:col-span-2">
                  <span className="text-xs font-semibold text-ink/80">Formulários</span>
                  <FormsPicker
                    templates={templates.data}
                    loading={templates.isLoading}
                    serviceType={st}
                    value={d.formIds}
                    onToggle={toggleForm}
                    required={d.formsRequired}
                    onRequiredChange={(formsRequired) => update((x) => ({ ...x, formsRequired }))}
                  />
                </div>
              </div>
            </div>
          </Card>
        </div>

        {/* Lateral: técnicos sugeridos e histórico; no largo fica ao lado dos passos (e acompanha a rolagem). */}
        <aside
          className="grid gap-4 md:grid-cols-2 xl:sticky xl:top-[4.5rem] xl:flex xl:max-h-[calc(100dvh-10.5rem)] xl:flex-col xl:overflow-y-auto"
          aria-label="Contexto da OS"
        >
          <Card className="flex flex-col gap-3 p-4">
            <SectionTitle
              as="h2"
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
              Técnicos sugeridos
            </SectionTitle>
            <SuggestedTechnicians
              compact
              items={suggestions.data}
              loading={suggestions.isLoading}
              hasPlace={Boolean(f.location_id)}
              scheduled={Boolean(startIso)}
              assigneeId={f.assignee_id}
              helperIds={d.helperIds}
              onAssign={(t) => onAssignee(t?.id ?? "")}
              onToggleHelper={(t) => {
                setConflicts(null);
                update((x) => ({
                  ...x,
                  helperIds: x.helperIds.includes(t.id) ? x.helperIds.filter((id) => id !== t.id) : [...x.helperIds, t.id].slice(0, 6),
                }));
              }}
              invite={(t) => invite(t.name)}
              error={suggestions.error}
              onRetry={() => void suggestions.refetch()}
            />
          </Card>

          <Card>
            <IntakePanel context={intake.data} loading={intake.isLoading} error={intake.error} onRetry={() => void intake.refetch()} />
          </Card>
        </aside>

        {/* Barra fixa no rodapé: o Criar fica à vista em qualquer tela, com o resumo da OS. */}
        <div className="sticky bottom-3 z-20 flex flex-col gap-2 rounded-xl border border-line bg-surface/95 px-4 py-3 shadow-elev-2 backdrop-blur xl:col-span-2">
          {/* O ErrorBox já é anunciado (role="alert") ao aparecer. */}
          {create.error && !conflicts ? <ErrorBox message={errorMessage(create.error)} /> : null}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {missing.length ? (
              <p className="min-w-0 flex-1 text-sm font-medium text-red-600 dark:text-red-400" role="alert">
                Falta preencher: {missing.map((k) => ERROR_NAME[k]).join(", ")}.
              </p>
            ) : conflicts ? (
              <p className="min-w-0 flex-1 text-sm font-medium text-red-600 dark:text-red-400">
                Técnico ocupado no horário (veja no passo 5).
              </p>
            ) : (
              <p className="min-w-0 flex-1 truncate text-sm text-ink-muted" title={summary}>
                {summary}
              </p>
            )}
            <span className="hidden items-center gap-1 text-[11px] text-ink-subtle sm:inline-flex">
              <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd>
            </span>
            <Button variant="ghost" onClick={() => void cancel()} disabled={create.isPending}>
              Cancelar
            </Button>
            <Button type="submit" variant="primary" loading={create.isPending}>
              {create.isPending ? null : <Plus aria-hidden className="size-4" />}
              {create.isPending ? "Criando..." : conflicts ? "Criar mesmo assim" : "Criar"}
            </Button>
          </div>
        </div>
      </form>

      {/* Fora do formulário: as teclas do cadastro (Enter, Ctrl+Enter) não chegam à Nova OS. */}
      {creatingLocation ? (
        <LocationDialog
          location={null}
          customerId={f.customer_id || null}
          onClose={() => {
            setCreatingLocation(false);
            // Primeira localização do cliente cadastrada agora: já entra na OS (com várias, é só buscar).
            if (f.customer_id && !f.location_id) setOnlyFor(f.customer_id);
          }}
        />
      ) : null}
    </div>
  );
}
