"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { AlertTriangle, ChevronDown, Hand, MapPin, Phone, Star, ThumbsUp, Users, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useConfirm } from "@/components/Confirm";
import { LocationPicker } from "@/components/LocationPicker";
import { ConflictHint, ConflictList, scheduleConflicts } from "@/components/ScheduleConflict";
import { TagChips, TagsInput } from "@/components/TagChips";
import { useToast } from "@/components/Toaster";
import { Combobox, searchText, type ComboItem } from "@/components/new-ticket/Combobox";
import { serviceTypeTiming } from "@/components/new-ticket/ServiceTypePicker";
import { readStored, writeStored } from "@/components/new-ticket/storage";
import { HelpersField, SuggestedTechnicians } from "@/components/new-ticket/SuggestedTechnicians";
import { PayoutLine } from "@/components/ticket/PayoutsCard";
import { busyTitle, isVersionConflict } from "@/components/ticket/useConflictHandler";
import { useNow } from "@/components/useNow";
import { Button, buttonClassName, Card, CardHeader, ErrorBox, Field, Input, SectionTitle, Select, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { PRIORITY, PRIORITY_ORDER, ROLE, STATUS, STATUS_ORDER, TICKET_SOURCE } from "@/lib/constants";
import { formatDateTime, formatDocument, formatMinutes, formatMoney, fromLocalInput, toLocalInput } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { useProjects } from "@/lib/projects";
import { useAssignable, useCategories, useCustomers, useServiceTypes } from "@/lib/queries";
import { type TicketTagRules, useTagRules } from "@/lib/tagRules";
import type {
  ConflictItem,
  Customer,
  IntakeContext,
  Location,
  ServiceType,
  Tag,
  TechnicianSuggestion,
  TicketDetail,
  TicketPriority,
  TicketStatus,
  TicketUpdatePayload,
  User,
  UUID,
} from "@/lib/types";
import { copyText } from "@/lib/whatsapp";
import { DISCARD_CONFIRM } from "./useUnsavedGuard";

/** Prefixo do id do formulário (o editor soma um id próprio: página e painel podem estar abertos juntos). */
export const GENERAL_FORM_ID = "ticket-general";

/** O que o rodapé do editor (fora do formulário) precisa para o botão Salvar. */
export interface SaveState {
  dirty: boolean;
  pending: boolean;
  /** A API barrou por conflito de agenda: o próximo Salvar confirma mesmo assim. */
  conflict: boolean;
}

const split = (iso: string | null | undefined) => {
  const local = toLocalInput(iso);
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
};
const join = (date: string, time: string) => (date && time ? fromLocalInput(`${date}T${time}`) : null);
const sameList = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** Situações com o técnico na OS: tirar ou trocar o técnico muda a situação. */
const FIELD_ACTIVE: TicketStatus[] = ["assigned", "scheduled", "en_route", "in_progress"];
/** Concluída, fechada ou cancelada: as sugestões de técnico ficam recolhidas. */
const FINISHED: TicketStatus[] = ["resolved", "closed", "cancelled"];
/** Limite de outros técnicos na visita (o mesmo da API). */
const MAX_HELPERS = 6;
/** Folga para o relógio do computador (a API aceita 1 minuto). */
const SKEW_MS = 60_000;
/** "Mais detalhes" recolhido ou aberto: preferência de quem usa, neste navegador. */
const MORE_KEY = "maxx.os.maisDetalhes";

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
  clientReference: string;
  requesterName: string;
  requesterContact: string;
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
    clientReference: t.client_reference ?? "",
    requesterName: t.requester_name ?? "",
    requesterContact: t.requester_contact ?? "",
    visitNote: t.visit_note ?? "",
    startDate: start.date,
    startTime: start.time,
    endDate: end.date,
    endTime: end.time,
    resolutionNotes: t.resolution_notes ?? "",
    timesReason: "",
  };
}

type Key = keyof FormState;

/** Textos comparados sem os espaços das pontas (a API grava aparado). */
const TEXT_KEYS: Key[] = [
  "title",
  "description",
  "serviceAddress",
  "clientReference",
  "requesterName",
  "requesterContact",
  "visitNote",
  "resolutionNotes",
];

/**
 * Campos que mudam juntos (a loja e o cliente dela, a agenda, os horários reais). Quando outra pessoa
 * muda a OS enquanto se edita, cada grupo entra inteiro ou fica como está aqui.
 */
const GROUPS: { keys: Key[]; label: string; schedule?: boolean }[] = [
  { keys: ["customerId", "locationId", "locationLabel"], label: "cliente e loja" },
  { keys: ["serviceTypeId"], label: "tipo de OS" },
  { keys: ["description"], label: "escopo" },
  { keys: ["estimated", "date", "time"], label: "agenda", schedule: true },
  { keys: ["assigneeId"], label: "técnico", schedule: true },
  { keys: ["helperIds"], label: "outros técnicos", schedule: true },
  { keys: ["tags"], label: "etiquetas" },
  { keys: ["title"], label: "título" },
  { keys: ["priority"], label: "prioridade" },
  { keys: ["categoryId"], label: "categoria" },
  { keys: ["ownerId"], label: "analista responsável" },
  { keys: ["projectId"], label: "projeto" },
  { keys: ["clientReference"], label: "nº do chamado do cliente" },
  { keys: ["requesterName"], label: "quem pediu" },
  { keys: ["requesterContact"], label: "contato de quem pediu" },
  { keys: ["visitNote"], label: "recado para o técnico" },
  { keys: ["serviceAddress"], label: "endereço do atendimento" },
  { keys: ["startDate", "startTime", "endDate", "endTime"], label: "horários reais" },
  { keys: ["resolutionNotes"], label: "descrição da conclusão" },
];

const SCHEDULE_KEYS: Key[] = ["date", "time", "estimated"];
const TIME_KEYS: Key[] = ["startDate", "startTime", "endDate", "endTime"];

/** Etiquetas iguais: os mesmos nomes com as mesmas cores, em qualquer ordem (tirar e pôr de volta não é mudança). */
const tagsKey = (tags: Tag[]) =>
  tags
    .map((t) => `${t.name.trim()}\u0000${t.color ?? ""}`)
    .sort()
    .join("\u0001");

function sameValue(key: Key, a: FormState, b: FormState): boolean {
  if (key === "helperIds") return sameList(a.helperIds, b.helperIds);
  if (key === "tags") return tagsKey(a.tags) === tagsKey(b.tags);
  if (TEXT_KEYS.includes(key)) return String(a[key]).trim() === String(b[key]).trim();
  return a[key] === b[key];
}

const sameGroup = (keys: Key[], a: FormState, b: FormState) => keys.every((k) => sameValue(k, a, b));

/** `target` com os campos `keys` copiados de `source`. */
function withKeys(target: FormState, source: FormState, keys: Key[]): FormState {
  const out = { ...target };
  for (const key of keys) Object.assign(out, { [key]: source[key] });
  return out;
}

/** Depois de salvar: o que não mudou desde o envio vira o que a API gravou; o que se digitou durante o envio fica. */
function adopt(current: FormState, sent: FormState, fresh: FormState): FormState {
  let out = current;
  for (const group of GROUPS) if (sameGroup(group.keys, current, sent)) out = withKeys(out, fresh, group.keys);
  return current.timesReason === sent.timesReason ? { ...out, timesReason: "" } : out;
}

/** A cópia `a` da OS é mais nova que `b`: a versão sobe a cada edição e a hora cobre o que não sobe a versão (outros técnicos). */
function isNewer(a: TicketDetail, b: TicketDetail) {
  return a.version > b.version || (a.version === b.version && Date.parse(a.updated_at) > Date.parse(b.updated_at));
}

function Counter({ value, max }: { value: string; max: number }) {
  return (
    <span className="self-end text-[11px] text-ink-subtle tabular-nums">
      {value.length.toLocaleString("pt-BR")} / {max.toLocaleString("pt-BR")}
    </span>
  );
}

/**
 * Erro de uma linha com dois campos (data e hora), embaixo dos dois: o `error` do Field cobre um campo
 * só. Mesmo tom e anúncio do Field; aparece depois da primeira tentativa de salvar.
 */
function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <span id={id} role="alert" className="block text-xs font-medium text-red-600 dark:text-red-400">
      {message}
    </span>
  ) : null;
}

/** Aviso do que vai acontecer ao salvar (ex.: a OS volta para Novo). */
function Caution({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p
      className={clsx(
        "flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200",
        className,
      )}
    >
      <AlertTriangle className="mt-px size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** Rótulo de um campo que fica fora de <label> (busca com lista, grupo de chips): o campo aponta para o id. */
function FieldLabel({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <span id={id} className="text-xs font-semibold text-ink/80">
      {children}
    </span>
  );
}

/** Endereço da loja numa linha (rua, bairro, cidade - UF, CEP). */
function storeAddressOf(loc: IntakeContext["location"]): string {
  if (!loc) return "";
  return [loc.address_line, loc.district, [loc.city, loc.state].filter(Boolean).join(" - "), loc.zip_code].filter(Boolean).join(", ");
}

/** “A”; “A” e “B”; “A”, “B” e “C”. */
function quoted(names: string[]): string {
  const list = names.map((n) => `“${n}”`);
  return list.length > 1 ? `${list.slice(0, -1).join(", ")} e ${list[list.length - 1]}` : (list[0] ?? "");
}

/** O que o sistema faz sozinho com as etiquetas de uma OS já aberta, numa frase (vazio sem regra). */
function autoTagsHint(rules: TicketTagRules): string {
  const parts: string[] = [];
  const extra = rules.on_extra_cost.map((t) => t.name);
  const paid = rules.remove_on_payout_paid;
  if (extra.length) parts.push(`${quoted(extra)} ${extra.length > 1 ? "entram" : "entra"} ao lançar um custo extra`);
  // A API tira a etiqueta só quando todos os pagamentos da OS (responsável e quem foi junto) estão pagos.
  if (paid.length) parts.push(`${quoted(paid)} ${paid.length > 1 ? "saem" : "sai"} quando todos os técnicos da OS estão pagos`);
  return parts.length ? `Automático: ${parts.join("; ")}.` : "";
}

/** Corpo da correção de horários (PUT /times): o motivo e só o que mudou. */
interface TimesBody {
  reason: string;
  arrived_at?: string | null;
  resolved_at?: string | null;
}

/** O que o Salvar envia, em até três chamadas (dados da OS, técnico, horários reais). */
interface SavePlan {
  version: number;
  patch: TicketUpdatePayload | null;
  assign: { assignee_id: UUID | null } | null;
  /**
   * Troca o técnico antes dos dados: o técnico que sai continua na visita como "outro técnico", e a
   * API só aceita como outro técnico quem já não é o responsável.
   */
  assignFirst: boolean;
  times: TimesBody | null;
  /** Os conflitos de agenda já foram mostrados: o Salvar confirma mesmo assim. */
  confirmed: boolean;
  /** O formulário como foi enviado (o que mudar depois disso continua não salvo). */
  sent: FormState;
}

/**
 * Aba "Geral" da OS, no formato do "Editar atividade" do Field Control e na mesma ordem da abertura
 * (Nova OS): cliente, localização, tipo de OS, escopo, agendamento, colaborador (com os técnicos mais
 * indicados para a loja) e etiquetas; o resto fica em "Mais detalhes". Tudo editável pela central a
 * qualquer momento, inclusive com a OS fechada.
 *
 * A edição se apoia numa cópia da OS (a `base`). Quando a OS muda por fora (o técnico conclui no app,
 * outro analista salva), os campos não mexidos passam a mostrar a versão nova e os mexidos ficam como
 * estão, com um aviso; nada do que foi digitado se perde.
 */
export function GeneralTab({
  ticket,
  formId = GENERAL_FORM_ID,
  onSaveState,
  onTransition,
}: {
  ticket: TicketDetail;
  /** Id do formulário (o botão Salvar do rodapé fica fora dele e aponta para este id). */
  formId?: string;
  /** Para o botão Salvar do rodapé (fora do formulário). */
  onSaveState: (state: SaveState) => void;
  /** Mudar a situação: o editor abre a confirmação com o que o destino pede. */
  onTransition: (to: TicketStatus) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const now = useNow(30_000);
  const formRef = useRef<HTMLFormElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const conflictRef = useRef<HTMLDivElement>(null);

  // `server`: a cópia mais nova da OS que se conhece (a da lista em cache ou a resposta do último
  // Salvar, que pode chegar antes do cache). `snap.base` é o que ela dizia quando a edição se apoiou nela.
  const [snap, setSnap] = useState(() => ({ server: ticket, base: initial(ticket) }));
  const [saved, setSaved] = useState<TicketDetail | null>(null);
  const [form, setForm] = useState<FormState>(() => initial(ticket));
  // A OS mudou por fora durante a edição: os grupos que as duas pessoas mexeram.
  const [notice, setNotice] = useState<string[] | null>(null);
  const [conflicts, setConflicts] = useState<ConflictItem[] | null>(null);
  const [tried, setTried] = useState(false);
  // Um passo do Salvar gravou e outro falhou: o aviso diz que o resto já foi salvo.
  const [partial, setPartial] = useState(false);
  const [changingLocation, setChangingLocation] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  // "Mais detalhes" começa aberto; quem recolhe uma vez encontra recolhido nas próximas OS.
  const [moreOpen, setMoreOpen] = useState(() => readStored<boolean>("local", MORE_KEY) !== false);
  const base = snap.base;
  const server = saved && isNewer(saved, ticket) ? saved : ticket;

  const set = <K extends Key>(key: K, value: FormState[K]) => {
    if (key === "date" || key === "time" || key === "estimated" || key === "helperIds") setConflicts(null);
    setForm((f) => ({ ...f, [key]: value }));
  };
  // Quem passa a ser o técnico responsável deixa de ser "outro técnico" da visita.
  const setAssignee = (id: string) => {
    setConflicts(null);
    setForm((f) => ({ ...f, assigneeId: id, helperIds: f.helperIds.filter((h) => h !== id) }));
    // Técnico escolhido (no campo ou nas sugestões): a lista de sugeridos fecha.
    if (id) setSuggestOpen(false);
  };
  // Outro cliente: a loja era do anterior e sai; a busca de loja abre já filtrada pelo cliente novo.
  const setCustomer = (id: string) => {
    if (id === form.customerId) return;
    setForm((f) => ({ ...f, customerId: id, locationId: "", locationLabel: "" }));
    setChangingLocation(Boolean(id));
  };
  const toggleMore = () => {
    const next = !moreOpen;
    setMoreOpen(next);
    writeStored("local", MORE_KEY, next ? null : false);
  };

  const customers = useCustomers();
  const categories = useCategories();
  const { rules: tagRules } = useTagRules();
  const serviceTypes = useServiceTypes({ customerId: form.customerId || null, active: true });
  const assignable = useAssignable(null);
  const projects = useProjects({ enabled: true });
  // Analistas e gestores (quem pode ser o analista responsável): lista estável, fora das chaves que o
  // tempo real recarrega a cada evento.
  const staff = useQuery({
    queryKey: ["users", "managers"],
    queryFn: () => api.get<User[]>("/users", { active: true }),
    staleTime: 5 * 60_000,
  });
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

  const estimatedNumber = form.estimated ? Number(form.estimated) : null;
  const estimatedValid =
    estimatedNumber === null || (Number.isInteger(estimatedNumber) && estimatedNumber >= 1 && estimatedNumber <= 10080);
  const minutes = estimatedValid ? estimatedNumber : null;
  const startIso = join(form.date, form.time);
  // Os técnicos indicados e o aviso de agenda esperam a digitação parar (uma consulta, não uma por tecla).
  const lazyStart = useDebounced(startIso, 400);
  const lazyMinutes = useDebounced(minutes, 400);
  const lazyTitle = useDebounced(form.title.trim(), 400);
  // Com técnico na OS, ou com ela concluída, as sugestões ficam recolhidas (a consulta só roda se abrir).
  const suggestionsShown = suggestOpen || (!form.assigneeId && !FINISHED.includes(server.status));
  // Os 5 técnicos mais indicados para a loja, o serviço e o horário (o mesmo ranking da abertura). A
  // própria OS não conta como "ocupado" para o técnico dela (exclude_ticket_id).
  const suggestions = useQuery({
    queryKey: ["technician-suggest", form.locationId, form.serviceTypeId, form.categoryId, form.projectId, lazyStart, lazyMinutes, lazyTitle, ticket.id],
    queryFn: () =>
      api.get<TechnicianSuggestion[]>("/technicians/suggest", {
        location_id: form.locationId,
        service_type_id: form.serviceTypeId || undefined,
        category_id: form.categoryId || undefined,
        project_id: form.projectId || undefined,
        title: lazyTitle || undefined,
        start: lazyStart ?? undefined,
        estimated_minutes: lazyMinutes ?? undefined,
        exclude_ticket_id: ticket.id,
        limit: 5,
      }),
    enabled: Boolean(form.locationId) && suggestionsShown,
    staleTime: 30_000,
    // Mudou só o horário ou o serviço: a lista anterior fica à vista até a nova chegar (sem piscar).
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === form.locationId ? previous : undefined),
  });

  const people = useMemo(
    () =>
      [...(assignable.data ?? [])].sort(
        (a, b) => (a.role === "technician" ? 0 : 1) - (b.role === "technician" ? 0 : 1) || a.name.localeCompare(b.name),
      ),
    [assignable.data],
  );
  const technicians = people.filter((p) => p.role === "technician");
  const internal = people.filter((p) => p.role !== "technician");
  const names = useMemo(() => {
    const map: Record<UUID, string> = {};
    for (const p of people) map[p.id] = p.name;
    for (const h of server.helpers ?? []) map[h.id] ??= h.name;
    if (server.assignee) map[server.assignee.id] ??= server.assignee.name;
    return map;
  }, [people, server.helpers, server.assignee]);
  const analysts = useMemo(() => {
    const list = (staff.data ?? [])
      .filter((u) => u.role === "admin" || u.role === "supervisor" || u.role === "analyst")
      .map((u) => ({ id: u.id, name: u.name }));
    // O analista atual (mesmo desativado) e quem está logado (o "Assumir") sempre aparecem.
    for (const person of [server.owner, user]) {
      if (person && !list.some((u) => u.id === person.id)) list.push({ id: person.id, name: person.name });
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }, [staff.data, server.owner, user]);
  // Cliente e tipo de OS com busca, como na Nova OS (centenas de tipos, mais de cem clientes).
  const customerItems = useMemo<ComboItem<Customer>[]>(
    () =>
      (customers.data ?? [])
        // O cliente da OS continua na lista, mesmo inativo.
        .filter((c) => c.is_active || c.id === form.customerId)
        .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
        .map((c) => ({
          key: c.id,
          item: c,
          label: c.is_active ? c.name : `${c.name} (inativo)`,
          haystack: `${searchText(c.name)} ${c.document ?? ""}`,
        })),
    [customers.data, form.customerId],
  );
  const typeItems = useMemo<ComboItem<ServiceType>[]>(() => {
    // Os tipos do catálogo do cliente da OS primeiro, depois os gerais.
    const rank = (t: ServiceType) => (t.customer_id && t.customer_id === form.customerId ? 0 : t.customer_id ? 2 : 1);
    return [...(serviceTypes.data ?? [])]
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "pt-BR"))
      .map((t) => ({ key: t.id, item: t, label: t.name, haystack: searchText(`${t.name} ${t.customer?.name ?? ""}`) }));
  }, [serviceTypes.data, form.customerId]);

  // ── o que mudou ──
  const schedChanged = !sameGroup(SCHEDULE_KEYS, form, base);
  const timesChanged = !sameGroup(TIME_KEYS, form, base);
  const assigneeChanged = form.assigneeId !== base.assigneeId;
  const helpersChanged = !sameList(form.helperIds, base.helperIds);
  const dirty = GROUPS.some((group) => !sameGroup(group.keys, form, base));

  // Tirar ou trocar o técnico muda a situação da OS na API: avisa antes.
  const currentTech = server.assignee;
  const assigneeWarning =
    assigneeChanged && currentTech
      ? !form.assigneeId && FIELD_ACTIVE.includes(server.status)
        ? { title: "Tirar o técnico da OS?", text: `Sem técnico, a OS volta para Novo e sai do app de ${currentTech.name}.` }
        : form.assigneeId && (server.status === "en_route" || server.status === "in_progress")
          ? { title: "Trocar o técnico em campo?", text: `A OS volta para Atribuído e o atendimento de ${currentTech.name} é interrompido.` }
          : null
      : null;

  // ── validação (as mesmas regras da API, com a mensagem ao lado do campo) ──
  const startAt = join(form.startDate, form.startTime);
  const endAt = join(form.endDate, form.endTime);
  const errors: Partial<Record<"title" | "estimated" | "schedule" | "start" | "end" | "reason", string>> = {};
  if (form.title.trim().length < 3) errors.title = "O título precisa de pelo menos 3 letras";
  if (!estimatedValid) errors.estimated = "Use minutos inteiros, de 1 a 10080";
  if (Boolean(form.date) !== Boolean(form.time)) errors.schedule = "Informe a data e a hora do agendamento";
  if (timesChanged) {
    const created = Date.parse(server.created_at);
    const problem = (at: string) => {
      const t = Date.parse(at);
      if (t > now + SKEW_MS) return "O horário não pode ficar no futuro";
      if (t < created - SKEW_MS) return `Não pode ser antes da abertura da OS (${formatDateTime(server.created_at)})`;
      return undefined;
    };
    if (server.arrived_at && !startAt) errors.start = "Informe a data e a hora do início";
    else if (startAt) errors.start = problem(startAt);
    if (server.resolved_at && !endAt) errors.end = "Informe a data e a hora da conclusão";
    else if (endAt) errors.end = problem(endAt);
    if (!errors.end && startAt && endAt && Date.parse(startAt) > Date.parse(endAt)) errors.end = "A conclusão deve ser depois do início";
    if (!errors.end && endAt && server.closed_at && Date.parse(endAt) > Date.parse(server.closed_at) + SKEW_MS) {
      errors.end = `A conclusão não pode ser depois do fechamento (${formatDateTime(server.closed_at)})`;
    }
    if (form.timesReason.trim().length < 3) errors.reason = "Explique o motivo da correção (pelo menos 3 letras)";
  }
  const invalid = Object.values(errors).some(Boolean);
  // A mensagem aparece depois da primeira tentativa de salvar; o aria-invalid vale sempre.
  const shown = (key: keyof typeof errors) => (tried ? errors[key] : undefined);
  const fieldId = (key: string) => `${formId}-${key}`;
  const today = toLocalInput(new Date(now).toISOString()).slice(0, 10);

  function buildPatch(): TicketUpdatePayload {
    const p: TicketUpdatePayload = {};
    if (!sameValue("title", form, base)) p.title = form.title.trim();
    if (!sameValue("description", form, base)) p.description = form.description.trim();
    if (form.categoryId !== base.categoryId) p.category_id = form.categoryId || null;
    if (form.priority !== base.priority) p.priority = form.priority;
    if (form.serviceTypeId !== base.serviceTypeId) p.service_type_id = form.serviceTypeId || null;
    if (form.estimated !== base.estimated) p.estimated_minutes = minutes;
    if (form.customerId !== base.customerId) p.customer_id = form.customerId || null;
    if (form.locationId !== base.locationId) p.location_id = form.locationId || null;
    if (!sameValue("serviceAddress", form, base)) p.service_address = form.serviceAddress.trim() || null;
    if (!sameValue("visitNote", form, base)) p.visit_note = form.visitNote.trim() || null;
    if (!sameValue("clientReference", form, base)) p.client_reference = form.clientReference.trim() || null;
    if (!sameValue("requesterName", form, base)) p.requester_name = form.requesterName.trim() || null;
    if (!sameValue("requesterContact", form, base)) p.requester_contact = form.requesterContact.trim() || null;
    if (helpersChanged) p.helper_ids = form.helperIds;
    if (form.ownerId !== base.ownerId) p.owner_id = form.ownerId || null;
    if (form.projectId !== base.projectId) p.project_id = form.projectId || null;
    if (!sameValue("resolutionNotes", form, base)) p.resolution_notes = form.resolutionNotes.trim() || null;
    if (!sameValue("tags", form, base)) {
      // Com os nomes carregados, a API aplica só o que mudou aqui: o "Custo Extra" (ou o lote) que
      // entrou com o editor aberto fica, e o "Pendente Envio PGTO" que saiu com o pagamento não volta.
      p.tags = form.tags;
      p.tags_base = base.tags.map((t) => t.name);
    }
    if (schedChanged && startIso) {
      // Fim = início + duração (estimada ou a da agenda atual), para não sobrar um fim antigo.
      const current =
        server.scheduled_start && server.scheduled_end
          ? Math.round((Date.parse(server.scheduled_end) - Date.parse(server.scheduled_start)) / 60000)
          : null;
      const duration = minutes ?? current ?? 60;
      p.scheduled_start = startIso;
      p.scheduled_end = new Date(Date.parse(startIso) + duration * 60000).toISOString();
    } else if (schedChanged && !form.date && !form.time && (base.date || base.time)) {
      // Data e hora apagadas: a OS fica sem agenda.
      p.scheduled_start = null;
      p.scheduled_end = null;
    }
    return p;
  }

  function buildTimes(): TimesBody {
    const body: TimesBody = { reason: form.timesReason.trim() };
    if (form.startDate !== base.startDate || form.startTime !== base.startTime) body.arrived_at = startAt;
    if (form.endDate !== base.endDate || form.endTime !== base.endTime) body.resolved_at = endAt;
    return body;
  }

  const save = useMutation({
    mutationFn: async (plan: SavePlan) => {
      let current = server;
      let version = plan.version;
      // Cada chamada grava sozinha: a edição passa a se apoiar no que já foi gravado, e se a seguinte
      // falhar, só ela fica pendente (o próximo Salvar não repete o que já foi).
      const step = (next: TicketDetail) => {
        current = next;
        version = next.version;
        queryClient.setQueryData(["ticket", ticket.id], next);
        setSaved(next);
        setSnap({ server: next, base: initial(next) });
        setPartial(true);
      };
      const sendPatch = async (patch: TicketUpdatePayload, allow: boolean) =>
        step(await api.patch<TicketDetail>(`/tickets/${ticket.id}`, { ...patch, expected_version: version, allow_conflict: allow }));
      const sendAssign = async (assign: { assignee_id: UUID | null }, allow: boolean) =>
        step(await api.post<TicketDetail>(`/tickets/${ticket.id}/assign`, { ...assign, expected_version: version, allow_conflict: allow }));
      // A agenda muda no PATCH: lá a API confere o conflito com a agenda nova, o técnico e os outros técnicos finais.
      const agendaInPatch = Boolean(
        plan.patch && ("scheduled_start" in plan.patch || "scheduled_end" in plan.patch || "estimated_minutes" in plan.patch),
      );
      if (plan.assign && plan.assignFirst) {
        // O conflito do técnico novo é conferido aqui, a menos que a agenda ainda vá mudar no PATCH.
        await sendAssign(plan.assign, agendaInPatch || plan.confirmed);
        if (plan.patch) await sendPatch(plan.patch, plan.confirmed);
      } else {
        // Trocando o técnico depois, o conflito é conferido na troca (com o técnico novo, a agenda e
        // os outros técnicos já gravados): no PATCH a API olharia o técnico que está saindo.
        if (plan.patch) await sendPatch(plan.patch, plan.assign ? true : plan.confirmed);
        if (plan.assign) await sendAssign(plan.assign, plan.confirmed);
      }
      if (plan.times) step(await api.put<TicketDetail>(`/tickets/${ticket.id}/times`, { ...plan.times, expected_version: version }));
      return current;
    },
    onMutate: () => setPartial(false),
    onSuccess: (updated, plan) => {
      const fresh = initial(updated);
      setSaved(updated);
      setSnap({ server: updated, base: fresh });
      setForm((f) => adopt(f, plan.sent, fresh));
      setPartial(false);
      setConflicts(null);
      setNotice(null);
      setTried(false);
      void queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id] });
      void queryClient.invalidateQueries({ queryKey: ["tickets"] });
      void queryClient.invalidateQueries({ queryKey: ["assignable"] });
      toast({ title: `${updated.code} salva`, tone: "success" });
    },
    onError: (error) => {
      const found = scheduleConflicts(error);
      if (found) {
        setConflicts(found);
        requestAnimationFrame(() => conflictRef.current?.scrollIntoView({ block: "nearest" }));
        return;
      }
      // A OS mudou enquanto se salvava: recarrega (as alterações daqui ficam no formulário).
      if (isVersionConflict(error)) void queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id] });
      toast({ title: "Não foi possível salvar a OS", description: errorMessage(error), tone: "error" });
      requestAnimationFrame(() => errorRef.current?.scrollIntoView({ block: "nearest" }));
    },
  });

  // A OS mudou por fora (tempo real, outro analista, a volta do Salvar): os grupos que ninguém mexeu
  // aqui passam a mostrar a versão nova; os mexidos ficam, e o aviso diz quais mudaram dos dois lados.
  if (!save.isPending && server !== snap.server && isNewer(server, snap.server)) {
    const fresh = initial(server);
    let next = form;
    let touched = false;
    let remote = false;
    let schedule = false;
    const overlap: string[] = [];
    for (const group of GROUPS) {
      const mine = !sameGroup(group.keys, form, base);
      touched ||= mine;
      if (sameGroup(group.keys, fresh, base)) continue;
      remote = true;
      schedule ||= Boolean(group.schedule);
      if (!mine) next = withKeys(next, fresh, group.keys);
      else if (!sameGroup(group.keys, form, fresh)) overlap.push(group.label);
    }
    setSnap({ server, base: fresh });
    if (remote) {
      setForm(next);
      if (touched) setNotice((current) => [...new Set([...(current ?? []), ...overlap])]);
      if (schedule) setConflicts(null);
    }
  }

  useEffect(() => {
    onSaveState({ dirty, pending: save.isPending, conflict: Boolean(conflicts) });
  }, [dirty, save.isPending, conflicts, onSaveState]);

  const discard = () => {
    const fresh = initial(server);
    setSnap({ server, base: fresh });
    setForm(fresh);
    setNotice(null);
    setConflicts(null);
    setTried(false);
    setPartial(false);
    setChangingLocation(false);
    // O erro do último Salvar era sobre as alterações descartadas.
    save.reset();
  };

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    // O envio de um diálogo aberto daqui (portal no <body>) também "sobe" pela árvore do React: não é o Salvar da OS.
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    if (!dirty || save.isPending) return;
    if (invalid) {
      setTried(true);
      // Leva ao primeiro campo com problema. Título e horários ficam em "Mais detalhes": recolhido, abre antes.
      if (!moreOpen && (errors.title || errors.start || errors.end || errors.reason)) flushSync(() => setMoreOpen(true));
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      return;
    }
    if (
      notice?.length &&
      !(await confirm({
        title: "Gravar por cima?",
        description: `Também mudaram por fora: ${notice.join(", ")}. Ao salvar, fica o que está aqui.`,
        confirmLabel: "Gravar por cima",
      }))
    ) {
      return;
    }
    if (assigneeWarning && !(await confirm({ title: assigneeWarning.title, description: assigneeWarning.text, confirmLabel: "Salvar assim", tone: "danger" }))) {
      return;
    }
    const patch = buildPatch();
    save.mutate({
      version: server.version,
      patch: Object.keys(patch).length ? patch : null,
      assign: assigneeChanged ? { assignee_id: form.assigneeId || null } : null,
      assignFirst: assigneeChanged && Boolean(base.assigneeId) && form.helperIds.includes(base.assigneeId),
      times: timesChanged ? buildTimes() : null,
      confirmed: Boolean(conflicts),
      sent: form,
    });
  }

  const intakeCustomer = intake.data?.customer ?? null;
  const intakeLocation = intake.data?.location ?? null;
  // Convite pelo WhatsApp: só o básico (o técnico é parceiro), o bastante para ele topar ou não.
  const chosenType = serviceTypes.data?.find((s) => s.id === form.serviceTypeId) ?? null;
  // Valor do convite: o que o técnico já tem na OS; senão o do responsável atual (o valor não pago
  // acompanha quem assume); senão o padrão do tipo de serviço.
  const payoutOf = (id: UUID | undefined) => (id ? (server.payouts ?? []).find((p) => p.technician.id === id) : undefined);
  const feeFor = (technicianId?: UUID) => {
    const own = payoutOf(technicianId);
    if (own) return own.amount;
    const moving = payoutOf(server.assignee?.id);
    return moving && moving.status === "pending" ? moving.amount : (chosenType?.technician_fee ?? null);
  };
  const invite = (name?: string, technicianId?: UUID) => {
    const city = [intakeLocation?.city, intakeLocation?.state].filter(Boolean).join(" - ");
    const place = [intakeLocation?.district, city].filter(Boolean).join(", ");
    const fee = feeFor(technicianId);
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
  const copyInvite = async () => {
    const ok = await copyText(invite());
    toast(
      ok
        ? { title: "Convite copiado: cole no grupo de técnicos do WhatsApp", tone: "success" }
        : { title: "Não deu para copiar o convite", description: "O navegador não liberou a área de transferência. Tente de novo.", tone: "error" },
    );
  };
  const toggleHelper = (t: TechnicianSuggestion) => {
    if (form.helperIds.includes(t.id)) return set("helperIds", form.helperIds.filter((h) => h !== t.id));
    if (form.helperIds.length >= MAX_HELPERS) return toast({ title: `No máximo ${MAX_HELPERS} técnicos junto na visita`, tone: "error" });
    set("helperIds", [...form.helperIds, t.id]);
  };
  const storeAddress = storeAddressOf(intakeLocation);
  // Onde o técnico vai: o endereço do atendimento, quando informado; senão, o da loja.
  const address = form.serviceAddress.trim() || storeAddress;
  const statusOptions = [server.status, ...[...server.allowed_transitions].sort((a, b) => STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b))];
  // O nome do cliente escolhido, também enquanto a lista de clientes carrega.
  const customerName =
    customers.data?.find((c) => c.id === form.customerId)?.name ?? (form.customerId === server.customer?.id ? server.customer.name : null);
  // Tipo de serviço gravado que não está na lista (desativado, ou do catálogo de outro cliente): o nome continua no campo.
  const typeListed = Boolean(serviceTypes.data?.some((t) => t.id === form.serviceTypeId));
  const typeName = form.serviceTypeId === server.service_type?.id ? server.service_type.name : null;
  const typeLabel =
    form.serviceTypeId && !typeListed ? `${typeName ?? "Tipo escolhido"}${serviceTypes.data ? " (inativo ou de outro cliente)" : ""}` : undefined;
  const autoTags = autoTagsHint(tagRules);
  const assigneeListed = people.some((p) => p.id === form.assigneeId);
  const assigneeName = form.assigneeId ? (names[form.assigneeId] ?? null) : null;
  const unscheduledWarning = schedChanged && !form.date && !form.time && (base.date || base.time) && server.status === "scheduled";
  const conflictsTitle = conflicts
    ? `${busyTitle(conflicts, assigneeName ?? "O técnico")}.${partial ? " O restante das alterações já foi salvo." : ""} Para agendar assim mesmo, use "Salvar mesmo assim".`
    : "";
  const saveError = save.error
    ? `${isVersionConflict(save.error) ? "Esta OS mudou enquanto você salvava. Atualizamos os dados e suas alterações continuam aqui: confira e salve de novo." : errorMessage(save.error)}${partial ? " O restante das alterações já foi salvo." : ""}`
    : null;

  return (
    <form ref={formRef} id={formId} onSubmit={onSubmit} noValidate className="@container flex flex-col gap-4">
      {notice && dirty ? (
        <div
          role="status"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <p className="flex items-center gap-1.5 font-semibold">
            <AlertTriangle className="size-4 shrink-0" />
            Esta OS foi atualizada enquanto você editava.
          </p>
          <p className="mt-0.5">
            Suas alterações continuam aqui; o resto já mostra a versão nova.
            {notice.length ? ` Também mudaram por fora: ${notice.join(", ")}.` : ""}
          </p>
          <button
            type="button"
            onClick={async () => {
              if (await confirm(DISCARD_CONFIRM)) discard();
            }}
            disabled={save.isPending}
            className="mt-1.5 text-xs font-semibold underline underline-offset-2 hover:no-underline disabled:opacity-50"
          >
            Descartar minhas alterações
          </button>
        </div>
      ) : null}
      {saveError && !conflicts ? (
        <div ref={errorRef}>
          <ErrorBox message={saveError} />
        </div>
      ) : null}

      {/* Na ordem da abertura da OS (Nova OS): cliente, localização, tipo de OS, escopo, agendamento,
          colaborador e etiquetas. O resto fica em "Mais detalhes". */}
      <Card>
        <CardHeader title="Dados da OS" />
        <div className="grid grid-cols-12 gap-4 p-5">
          <div className="col-span-12 flex flex-col gap-1.5 @xl:col-span-5">
            <FieldLabel id={fieldId("customer")}>Cliente</FieldLabel>
            <Combobox
              items={customerItems}
              value={form.customerId}
              valueLabel={customerName ?? undefined}
              onChange={(c) => setCustomer(c?.id ?? "")}
              loading={customers.isLoading}
              labelledBy={fieldId("customer")}
              placeholder="Buscar cliente por nome ou CNPJ"
              emptyText="Nenhum cliente com esse nome ou CNPJ"
              clearLabel="Tirar o cliente"
              renderItem={(c) => (
                <span className="flex flex-col">
                  <span className="font-medium">
                    {c.name}
                    {c.is_active ? null : <span className="ml-1.5 text-[11px] font-medium text-ink-muted">(inativo)</span>}
                  </span>
                  {c.document ? <span className="text-xs text-ink-muted tabular-nums">{formatDocument(c.document)}</span> : null}
                </span>
              )}
            />
            {intakeCustomer ? (
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
                <span>
                  Total de OS: <b className="text-ink">{intakeCustomer.total_tickets}</b>
                </span>
                {intakeCustomer.rating_average != null ? (
                  <span className="inline-flex items-center gap-1">
                    <Star className="size-3" /> Média de avaliação: <b className="text-ink">{intakeCustomer.rating_average}</b>
                  </span>
                ) : null}
                {intakeCustomer.rating_last != null ? (
                  <span className="inline-flex items-center gap-1">
                    <ThumbsUp className="size-3" /> Última avaliação: <b className="text-ink">{intakeCustomer.rating_last}</b>
                  </span>
                ) : null}
                <Link href={`/clientes/${intakeCustomer.id}`} className="font-medium text-brand hover:underline">
                  Ver cliente
                </Link>
              </p>
            ) : null}
          </div>

          {/* Rótulo fora de <label>: dentro dele, o clique no texto acionaria o "Trocar". A busca já
              trata Enter (escolhe a loja, não salva a OS) e Esc (fecha só a lista). */}
          <div className="col-span-12 flex flex-col gap-1.5 @xl:col-span-7">
            <FieldLabel id={fieldId("location")}>Localização</FieldLabel>
            {changingLocation || !form.locationId ? (
              <>
                <LocationPicker
                  labelledBy={fieldId("location")}
                  customerId={form.customerId || null}
                  // Como na Nova OS: só as lojas do cliente escolhido (para outra rede, troque o cliente antes).
                  requireCustomer
                  customerName={customerName}
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
                {form.locationId ? (
                  <button type="button" onClick={() => setChangingLocation(false)} className={buttonClassName("ghost", "sm", "self-start")}>
                    Manter {form.locationLabel}
                  </button>
                ) : null}
              </>
            ) : (
              <div className="flex h-9 items-center gap-2 rounded-lg border border-line bg-surface pr-1 pl-3 text-sm shadow-elev-1">
                <MapPin className="size-4 shrink-0 text-ink-subtle" />
                <span className="min-w-0 flex-1 truncate text-ink">{form.locationLabel}</span>
                <button
                  type="button"
                  onClick={() => setChangingLocation(true)}
                  className={buttonClassName("ghost", "sm", "h-7 px-2")}
                  aria-label={`Trocar a loja (${form.locationLabel})`}
                >
                  Trocar
                </button>
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, locationId: "", locationLabel: "" }))}
                  className="inline-flex size-7 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
                  aria-label="Tirar a localização"
                >
                  <X className="size-4" />
                </button>
              </div>
            )}
            {/* Onde o técnico vai e com quem falar na loja (o endereço do atendimento muda em "Mais detalhes"). */}
            {!changingLocation && (address || intakeLocation?.contact_phone) ? (
              <div className="flex flex-col gap-1 text-xs text-ink-muted">
                {address ? (
                  <p className="flex items-start gap-1.5">
                    <MapPin aria-hidden className="mt-px size-3.5 shrink-0 text-ink-subtle" />
                    <span className="min-w-0 break-words">
                      {form.serviceAddress.trim() ? (
                        <>
                          Atendimento em: <span className="font-medium text-ink">{address}</span>
                        </>
                      ) : (
                        address
                      )}
                    </span>
                  </p>
                ) : null}
                {intakeLocation?.contact_phone ? (
                  <p className="flex items-start gap-1.5">
                    <Phone aria-hidden className="mt-px size-3.5 shrink-0 text-ink-subtle" />
                    <span className="min-w-0 break-words">
                      {intakeLocation.contact_phone}
                      {intakeLocation.contact_name ? ` · ${intakeLocation.contact_name}` : ""}
                    </span>
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="col-span-12 flex flex-col gap-1.5">
            <FieldLabel id={fieldId("type")}>Tipo de OS</FieldLabel>
            <Combobox
              items={typeItems}
              value={form.serviceTypeId}
              valueLabel={typeLabel}
              onChange={(t) => {
                if ((t?.id ?? "") === form.serviceTypeId) return;
                set("serviceTypeId", t?.id ?? "");
                // O tipo traz a duração dele (ajustável no agendamento).
                if (t) set("estimated", String(t.estimated_minutes));
              }}
              loading={serviceTypes.isLoading}
              labelledBy={fieldId("type")}
              placeholder="Buscar tipo de OS"
              emptyText="Nenhum tipo de OS com esse nome"
              clearLabel="Tirar o tipo de OS"
              renderItem={(t) => (
                <span className="flex flex-col">
                  <span className="flex flex-wrap items-center gap-x-1.5 font-medium">
                    {t.name}
                    {t.customer ? (
                      <span className="rounded bg-surface-3 px-1.5 text-[11px] font-medium text-ink-muted">{t.customer.name}</span>
                    ) : null}
                  </span>
                  <span className="text-xs text-ink-muted">{serviceTypeTiming(t)}</span>
                </span>
              )}
            />
          </div>

          <div className="col-span-12 flex flex-col gap-1">
            <Field label="Escopo">
              <Textarea
                rows={4}
                value={form.description}
                onChange={(e) => set("description", e.target.value)}
                maxLength={20000}
                placeholder="O que deve ser feito no atendimento, de forma clara."
              />
            </Field>
            <Counter value={form.description} max={20000} />
          </div>

          <Field label="Data do agendamento" className="col-span-6 @xl:col-span-4">
            <Input
              type="date"
              value={form.date}
              onChange={(e) => set("date", e.target.value)}
              aria-invalid={errors.schedule && !form.date ? true : undefined}
              aria-describedby={shown("schedule") ? fieldId("schedule") : undefined}
            />
          </Field>
          <Field label="Hora do agendamento" className="col-span-6 @xl:col-span-4">
            <Input
              type="time"
              value={form.time}
              onChange={(e) => set("time", e.target.value)}
              aria-invalid={errors.schedule && !form.time ? true : undefined}
              aria-describedby={shown("schedule") ? fieldId("schedule") : undefined}
            />
          </Field>
          <Field
            label="Duração estimada (min)"
            className="col-span-12 @xl:col-span-4"
            hint={minutes ? formatMinutes(minutes) : undefined}
            error={shown("estimated")}
          >
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={10080}
              step={1}
              value={form.estimated}
              onChange={(e) => set("estimated", e.target.value)}
              aria-invalid={errors.estimated ? true : undefined}
            />
          </Field>
          {shown("schedule") ? (
            <div className="col-span-12 -mt-2">
              <FieldError id={fieldId("schedule")} message={errors.schedule} />
            </div>
          ) : null}
          {unscheduledWarning ? (
            <Caution className="col-span-12">Sem data e hora, a OS sai de Agendado e volta para Atribuído (fora da agenda do técnico).</Caution>
          ) : null}

          <Field label="Colaborador" className="col-span-12 @xl:col-span-6">
            <Select value={form.assigneeId} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Sem colaborador</option>
              {technicians.length ? (
                <optgroup label="Técnicos">
                  {technicians.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.open_tickets} em aberto
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {internal.length ? (
                <optgroup label="Equipe interna">
                  {internal.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({ROLE[p.role]}) · {p.open_tickets} em aberto
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {form.assigneeId && !assigneeListed ? <option value={form.assigneeId}>{assigneeName ?? "Técnico atual"}</option> : null}
            </Select>
          </Field>
          <div className="col-span-12 flex flex-col gap-1.5 @xl:col-span-6">
            <span className="text-xs font-semibold text-ink/80">Outros colaboradores</span>
            <HelpersField
              hideLabel
              options={technicians.map((p) => ({ id: p.id, name: p.name }))}
              assigneeId={form.assigneeId as UUID | ""}
              helperIds={form.helperIds}
              names={names}
              onChange={(ids) => set("helperIds", ids)}
            />
          </div>
          {assigneeWarning ? <Caution className="col-span-12">{assigneeWarning.text}</Caution> : null}
          {server.assignee ? (
            <div className="col-span-12">
              <PayoutLine ticket={server} />
            </div>
          ) : null}

          <div className="col-span-12">
            {suggestionsShown ? (
              <div className="rounded-xl border border-line bg-surface-2/40 p-3">
                <SectionTitle
                  wrap
                  className="mb-2"
                  aside={
                    <>
                      {form.locationId ? (
                        <button type="button" onClick={() => void copyInvite()} className={buttonClassName("ghost", "sm", "h-7 px-2")}>
                          Copiar convite para o grupo
                        </button>
                      ) : null}
                      {suggestOpen ? (
                        <button type="button" onClick={() => setSuggestOpen(false)} className={buttonClassName("ghost", "sm", "h-7 px-2")}>
                          Recolher
                        </button>
                      ) : null}
                    </>
                  }
                >
                  Técnicos mais indicados para esta loja
                </SectionTitle>
                <SuggestedTechnicians
                  items={suggestions.data}
                  loading={suggestions.isLoading}
                  hasPlace={Boolean(form.locationId)}
                  scheduled={Boolean(lazyStart)}
                  assigneeId={form.assigneeId as UUID | ""}
                  helperIds={form.helperIds}
                  onAssign={(t) => setAssignee(t?.id ?? "")}
                  onToggleHelper={toggleHelper}
                  invite={(t) => invite(t.name, t.id)}
                  error={suggestions.error}
                  onRetry={() => void suggestions.refetch()}
                />
              </div>
            ) : (
              <button type="button" onClick={() => setSuggestOpen(true)} className={buttonClassName("secondary", "sm")}>
                <Users className="size-3.5" />
                Ver técnicos indicados para esta loja
              </button>
            )}
          </div>

          {conflicts ? (
            <div ref={conflictRef} className="col-span-12">
              <ConflictList tone="error" items={conflicts} title={conflictsTitle} />
            </div>
          ) : lazyStart && (form.assigneeId || form.helperIds.length) && (assigneeChanged || schedChanged || helpersChanged) ? (
            <div className="col-span-12 flex flex-col gap-2">
              {form.assigneeId ? (
                <ConflictHint
                  assigneeId={form.assigneeId}
                  assigneeName={names[form.assigneeId]}
                  start={lazyStart}
                  estimatedMinutes={lazyMinutes}
                  excludeId={ticket.id}
                />
              ) : null}
              {form.helperIds.map((id) => (
                <ConflictHint key={id} assigneeId={id} assigneeName={names[id]} start={lazyStart} estimatedMinutes={lazyMinutes} excludeId={ticket.id} />
              ))}
            </div>
          ) : null}

          <div className="col-span-12 flex flex-col gap-1.5">
            <FieldLabel id={fieldId("tags")}>Etiquetas</FieldLabel>
            <TagsInput
              value={form.tags}
              onChange={(tags) => set("tags", tags)}
              labelledBy={fieldId("tags")}
              describedBy={autoTags ? fieldId("tags-hint") : undefined}
            />
            {autoTags ? (
              <span id={fieldId("tags-hint")} className="text-xs text-ink-subtle">
                {autoTags}
              </span>
            ) : null}
          </div>
        </div>
      </Card>

      {/* Recolhido, o cartão é só o cabeçalho: sem a linha de baixo dele, que dobraria com a borda do cartão. */}
      <Card className={moreOpen ? undefined : "[&>div:first-child]:border-b-0"}>
        <CardHeader
          title="Mais detalhes"
          description={moreOpen ? undefined : "Título, prazo, analista, projeto, pedido do cliente, recado, endereço, situação, horários e conclusão."}
          actions={
            <button
              type="button"
              onClick={toggleMore}
              aria-expanded={moreOpen}
              aria-controls={fieldId("more")}
              aria-label={moreOpen ? "Recolher mais detalhes" : "Mostrar mais detalhes"}
              className={buttonClassName("ghost", "sm")}
            >
              {moreOpen ? "Recolher" : "Mostrar"}
              <ChevronDown aria-hidden className={clsx("size-3.5 transition-transform duration-150", moreOpen && "rotate-180")} />
            </button>
          }
        />
        <div id={fieldId("more")} hidden={!moreOpen} className="divide-y divide-line">
          <div className="p-5">
            <SectionTitle className="mb-3">Identificação</SectionTitle>
            <div className="grid grid-cols-12 gap-4">
              <Field label="Identificador" className="col-span-12 @xl:col-span-3">
                <Input value={ticket.code} readOnly className="bg-surface-2 font-mono text-ink-muted" />
              </Field>
              <Field label="Título" required error={shown("title")} className="col-span-12 @xl:col-span-9">
                <Input
                  value={form.title}
                  onChange={(e) => set("title", e.target.value)}
                  maxLength={200}
                  aria-required="true"
                  aria-invalid={errors.title ? true : undefined}
                />
              </Field>
              <Field label="Contrato de prazo (prioridade)" className="col-span-12 @xl:col-span-6">
                <Select value={form.priority} onChange={(e) => set("priority", e.target.value as TicketPriority)}>
                  {PRIORITY_ORDER.map((p) => (
                    <option key={p} value={p}>
                      {PRIORITY[p].code} - {PRIORITY[p].label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Categoria" className="col-span-12 @xl:col-span-6">
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
            </div>
          </div>

          <div className="p-5">
            <SectionTitle className="mb-3">Central</SectionTitle>
            <div className="grid grid-cols-12 gap-4">
              <div className="col-span-12 flex flex-col gap-1.5 @xl:col-span-6">
                <FieldLabel id={fieldId("owner")}>Analista responsável</FieldLabel>
                <div className="flex items-center gap-2">
                  <Select value={form.ownerId} onChange={(e) => set("ownerId", e.target.value)} className="flex-1" aria-labelledby={fieldId("owner")}>
                    <option value="">Sem analista (fila geral)</option>
                    {analysts.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </Select>
                  {user && form.ownerId !== user.id ? (
                    <Button onClick={() => set("ownerId", user.id)}>
                      <Hand className="size-3.5" />
                      Assumir
                    </Button>
                  ) : null}
                </div>
              </div>
              <Field label="Projeto" className="col-span-12 @xl:col-span-6">
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
            </div>
          </div>

          <div className="p-5">
            <SectionTitle wrap className="mb-3" aside={<span className="text-xs text-ink-muted">Origem: {TICKET_SOURCE[server.source]}</span>}>
              Pedido do cliente
            </SectionTitle>
            <div className="grid grid-cols-12 gap-4">
              <Field label="Nº do chamado do cliente" className="col-span-12 @xl:col-span-4">
                <Input
                  value={form.clientReference}
                  onChange={(e) => set("clientReference", e.target.value)}
                  maxLength={80}
                  placeholder="Ex.: INC0012345"
                />
              </Field>
              <Field label="Quem pediu" className="col-span-12 @xl:col-span-4">
                <Input
                  value={form.requesterName}
                  onChange={(e) => set("requesterName", e.target.value)}
                  maxLength={160}
                  placeholder="Nome de quem abriu o chamado"
                />
              </Field>
              <Field label="Contato" className="col-span-12 @xl:col-span-4">
                <Input
                  value={form.requesterContact}
                  onChange={(e) => set("requesterContact", e.target.value)}
                  maxLength={160}
                  inputMode="tel"
                  placeholder="(11) 90000-0000"
                />
              </Field>
            </div>
          </div>

          <div className="p-5">
            <SectionTitle className="mb-3">Visita</SectionTitle>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <Field label="Recado para o técnico" hint="Aparece em destaque no app do técnico">
                  <Textarea
                    rows={2}
                    value={form.visitNote}
                    onChange={(e) => set("visitNote", e.target.value)}
                    maxLength={5000}
                    placeholder="Com quem falar, acesso, o que levar."
                  />
                </Field>
                <Counter value={form.visitNote} max={5000} />
              </div>
              <Field
                label="Endereço do atendimento"
                hint={storeAddress ? `Vazio, vale o endereço da loja: ${storeAddress}` : "Vazio, vale o endereço da loja."}
              >
                <Input
                  value={form.serviceAddress}
                  onChange={(e) => set("serviceAddress", e.target.value)}
                  placeholder="Outro lugar para este atendimento (ex.: doca 3, entrada pelos fundos)"
                  maxLength={255}
                />
              </Field>
            </div>
          </div>

          <div className="p-5">
            <SectionTitle className="mb-1">Situação e horários</SectionTitle>
            <p className="mb-3 text-xs text-ink-muted">Os horários reais vêm do app do técnico; aqui a central corrige, com o motivo.</p>
            <div className="grid grid-cols-12 gap-4">
              <Field
                label="Situação"
                className="col-span-12 @xl:col-span-4"
                hint={dirty && statusOptions.length > 1 ? "Salve as alterações para mudar a situação" : undefined}
              >
                <Select
                  value={server.status}
                  onChange={(e) => e.target.value !== server.status && onTransition(e.target.value as TicketStatus)}
                  disabled={statusOptions.length <= 1 || dirty}
                >
                  {statusOptions.map((s) => (
                    <option key={s} value={s}>
                      {STATUS[s].label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Data de início" className="col-span-6 @xl:col-span-2">
                <Input
                  type="date"
                  value={form.startDate}
                  max={today}
                  disabled={!server.arrived_at}
                  onChange={(e) => set("startDate", e.target.value)}
                  aria-invalid={errors.start ? true : undefined}
                  aria-describedby={shown("start") ? fieldId("start") : undefined}
                />
              </Field>
              <Field label="Hora de início" className="col-span-6 @xl:col-span-2">
                <Input
                  type="time"
                  value={form.startTime}
                  disabled={!server.arrived_at}
                  onChange={(e) => set("startTime", e.target.value)}
                  aria-invalid={errors.start ? true : undefined}
                  aria-describedby={shown("start") ? fieldId("start") : undefined}
                />
              </Field>
              <Field label="Data de conclusão" className="col-span-6 @xl:col-span-2">
                <Input
                  type="date"
                  value={form.endDate}
                  max={today}
                  disabled={!server.resolved_at}
                  onChange={(e) => set("endDate", e.target.value)}
                  aria-invalid={errors.end ? true : undefined}
                  aria-describedby={shown("end") ? fieldId("end") : undefined}
                />
              </Field>
              <Field label="Hora de conclusão" className="col-span-6 @xl:col-span-2">
                <Input
                  type="time"
                  value={form.endTime}
                  disabled={!server.resolved_at}
                  onChange={(e) => set("endTime", e.target.value)}
                  aria-invalid={errors.end ? true : undefined}
                  aria-describedby={shown("end") ? fieldId("end") : undefined}
                />
              </Field>
              {shown("start") || shown("end") ? (
                <div className="col-span-12 -mt-2 flex flex-col gap-0.5">
                  <FieldError id={fieldId("start")} message={shown("start") ? `Início: ${errors.start}` : undefined} />
                  <FieldError id={fieldId("end")} message={shown("end") ? `Conclusão: ${errors.end}` : undefined} />
                </div>
              ) : null}
              {timesChanged ? (
                <Field
                  label="Motivo da correção do horário"
                  required
                  className="col-span-12"
                  hint="Fica no histórico da OS (o técnico não vê)"
                  error={shown("reason")}
                >
                  <Input
                    value={form.timesReason}
                    onChange={(e) => set("timesReason", e.target.value)}
                    placeholder="Ex.: técnico esqueceu de concluir no app; confirmado com a loja"
                    maxLength={500}
                    aria-required="true"
                    aria-invalid={errors.reason ? true : undefined}
                  />
                </Field>
              ) : null}
            </div>
          </div>

          <div className="flex flex-col gap-1 p-5">
            <SectionTitle className="mb-2">Conclusão</SectionTitle>
            <Field label="Descrição da conclusão" hint="O que foi feito. Aparece no relatório do cliente.">
              <Textarea rows={5} value={form.resolutionNotes} onChange={(e) => set("resolutionNotes", e.target.value)} maxLength={20000} />
            </Field>
            <Counter value={form.resolutionNotes} max={20000} />
          </div>
        </div>
      </Card>
    </form>
  );
}

/** Um dado da OS para quem só vê (sem editar): o rótulo em cima, o valor embaixo. */
function ViewItem({ label, children, wide = false }: { label: string; children: React.ReactNode; wide?: boolean }) {
  const empty = children === null || children === undefined || children === "";
  return (
    <div className={clsx("col-span-12 flex min-w-0 flex-col gap-1", !wide && "@xl:col-span-6")}>
      <dt className="text-xs font-semibold text-ink/80">{label}</dt>
      <dd className="text-sm break-words text-ink">{empty ? <span className="text-ink-muted">—</span> : children}</dd>
    </div>
  );
}

/** Texto longo da OS (escopo, recado, conclusão) com as quebras de linha de quem escreveu. */
const longText = (text: string | null | undefined) => (text?.trim() ? <span className="whitespace-pre-wrap">{text.trim()}</span> : null);

/**
 * A aba Geral para quem pode ver a OS mas não editar: os mesmos dados, na mesma ordem da abertura
 * (cliente, localização, tipo de OS, escopo, agendamento, colaborador, etiquetas) e depois o resto.
 */
export function GeneralView({ ticket }: { ticket: TicketDetail }) {
  const loc = ticket.location;
  const storeAddress = loc ? [loc.address_line, [loc.city, loc.state].filter(Boolean).join(" - ")].filter(Boolean).join(", ") : "";
  const helpers = (ticket.helpers ?? []).map((h) => h.name).join(", ");
  const requester = ticket.requester?.name ?? ticket.requester_name;
  return (
    <div className="@container flex flex-col gap-4">
      <Card>
        <CardHeader title="Dados da OS" />
        <dl className="grid grid-cols-12 gap-4 p-5">
          <ViewItem label="Cliente">{ticket.customer?.name}</ViewItem>
          <ViewItem label="Localização">
            {loc ? (
              <>
                {[loc.name, loc.code].filter(Boolean).join(" - ")}
                {storeAddress ? <span className="block text-xs text-ink-muted">{storeAddress}</span> : null}
              </>
            ) : null}
          </ViewItem>
          <ViewItem label="Tipo de OS" wide>
            {ticket.service_type?.name}
          </ViewItem>
          <ViewItem label="Escopo" wide>
            {longText(ticket.description)}
          </ViewItem>
          <ViewItem label="Data e hora do agendamento">
            {ticket.scheduled_start
              ? `${formatDateTime(ticket.scheduled_start)}${ticket.estimated_minutes ? ` · ${formatMinutes(ticket.estimated_minutes)}` : ""}`
              : null}
          </ViewItem>
          <ViewItem label="Colaborador">
            {ticket.assignee ? (
              <>
                {ticket.assignee.name}
                {helpers ? <span className="block text-xs text-ink-muted">Com {helpers}</span> : null}
              </>
            ) : null}
          </ViewItem>
          <ViewItem label="Etiquetas" wide>
            {ticket.tags?.length ? <TagChips tags={ticket.tags} max={20} /> : null}
          </ViewItem>
        </dl>
      </Card>
      <Card>
        <CardHeader title="Mais detalhes" />
        <dl className="grid grid-cols-12 gap-4 p-5">
          <ViewItem label="Identificador">
            <span className="font-mono">{ticket.code}</span>
          </ViewItem>
          <ViewItem label="Título">{ticket.title}</ViewItem>
          <ViewItem label="Contrato de prazo (prioridade)">{`${PRIORITY[ticket.priority].code} - ${PRIORITY[ticket.priority].label}`}</ViewItem>
          <ViewItem label="Categoria">{ticket.category?.full_name}</ViewItem>
          <ViewItem label="Analista responsável">{ticket.owner?.name ?? "Sem analista (fila geral)"}</ViewItem>
          <ViewItem label="Projeto">{ticket.project ? `${ticket.project.code} · ${ticket.project.name}` : "Não é de projeto (OS avulsa)"}</ViewItem>
          <ViewItem label="Nº do chamado do cliente">{ticket.client_reference}</ViewItem>
          <ViewItem label="Quem pediu">
            {requester || ticket.requester_contact ? (
              <>
                {requester}
                {ticket.requester_contact ? <span className="block text-xs text-ink-muted">{ticket.requester_contact}</span> : null}
              </>
            ) : null}
          </ViewItem>
          <ViewItem label="Origem">{TICKET_SOURCE[ticket.source]}</ViewItem>
          <ViewItem label="Recado para o técnico" wide>
            {longText(ticket.visit_note)}
          </ViewItem>
          <ViewItem label="Endereço do atendimento" wide>
            {ticket.service_address?.trim() || (storeAddress ? `O da loja: ${storeAddress}` : null)}
          </ViewItem>
          <ViewItem label="Situação">{STATUS[ticket.status].label}</ViewItem>
          <ViewItem label="Início e conclusão do atendimento">
            {ticket.arrived_at || ticket.resolved_at ? `${formatDateTime(ticket.arrived_at)} até ${formatDateTime(ticket.resolved_at)}` : null}
          </ViewItem>
          <ViewItem label="Descrição da conclusão" wide>
            {longText(ticket.resolution_notes)}
          </ViewItem>
        </dl>
      </Card>
    </div>
  );
}
