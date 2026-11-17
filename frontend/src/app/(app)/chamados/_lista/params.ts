// Estado da lista de chamados (aba, filtros, busca, ordem, página e itens por página) guardado na URL:
// F5, Voltar e o link mandado para um colega abrem a lista como foi deixada, e um link de outra tela
// (dashboard, fila, clientes, locais) aplica o filtro mesmo com a lista já aberta. A URL é a fonte da
// verdade.

import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import type { Query } from "@/lib/api";
import { PRIORITY_ORDER, STATUS, STATUS_ORDER, TICKET_TYPE } from "@/lib/constants";
import type { TicketPriority, TicketSource, TicketStatus, TicketType, UUID } from "@/lib/types";

/** Itens por página (o rodapé da lista, como no Field Control). */
export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;

export type View = "abertos" | "minhas" | "sem_tecnico" | "sla" | "todas";

export const VIEWS: { key: View; label: string; /** Para o resumo: "312 OS em aberto". */ phrase: string }[] = [
  { key: "abertos", label: "Em aberto", phrase: "em aberto" },
  { key: "minhas", label: "Minhas", phrase: "em aberto com você" },
  { key: "sem_tecnico", label: "Sem técnico", phrase: "em aberto sem técnico" },
  { key: "sla", label: "SLA violado", phrase: "com SLA violado" },
  { key: "todas", label: "Todas", phrase: "no total" },
];

// Abas além de "Todas" só mostram OS em aberto (a API recebe open_only, ou sla_breached, que também é
// só de abertas): os status finais não entram nelas.
const VIEW_FLAGS: Record<View, Query> = {
  abertos: { open_only: true },
  minhas: { mine: true, open_only: true },
  sem_tecnico: { unassigned: true, open_only: true },
  sla: { sla_breached: true },
  todas: {},
};

/** Status que aparecem nas abas de OS em aberto. */
export const isOpenStatus = (s: TicketStatus) => ["open", "active", "pending"].includes(STATUS[s].group);

/** Parâmetros antigos que escolhiam a aba (links do dashboard, da Minha fila, de clientes e de locais). */
const LEGACY_VIEW_KEYS = ["open_only", "mine", "unassigned", "sla_breached"];

/** Um link com algum destes filtros (e sem aba) mostra todas as OS daquele filtro, inclusive as fechadas. */
const FILTER_KEYS = [
  "status",
  "priority",
  "type",
  "source",
  "assignee_id",
  "technician_id",
  "team_id",
  "customer_id",
  "location_id",
  "service_type_id",
  "category_id",
  "project_id",
  "violation_pending",
  "number",
  "tag",
  "created_from",
  "created_to",
  "scheduled_from",
  "scheduled_to",
];

/** Como no Field Control: a lista abre pelo identificador, do maior (a OS mais nova) para o menor. */
export const DEFAULT_ORDER = "-number";

/** Ordens aceitas (a coluna clicada no cabeçalho ou o link de outra tela) e como cada uma se lê. */
export const ORDERS: { value: string; label: string }[] = [
  { value: "-number", label: "Identificador, do maior para o menor" },
  { value: "number", label: "Identificador, do menor para o maior" },
  { value: "scheduled_start", label: "Agendamento, do mais antigo para o mais novo" },
  { value: "-scheduled_start", label: "Agendamento, do mais novo para o mais antigo" },
  { value: "customer", label: "Cliente, de A a Z" },
  { value: "-customer", label: "Cliente, de Z a A" },
  { value: "priority", label: "Maior prioridade primeiro" },
  { value: "-priority", label: "Menor prioridade primeiro" },
  { value: "resolution_due_at", label: "Prazo de solução mais próximo" },
  { value: "-resolution_due_at", label: "Prazo de solução mais distante" },
  { value: "-created_at", label: "Mais novas" },
  { value: "created_at", label: "Mais antigas" },
  { value: "-updated_at", label: "Atualizadas recentemente" },
  { value: "updated_at", label: "Atualizadas há mais tempo" },
];

/** Por onde o chamado chegou ("web": aberto na central sem dizer o canal). */
export const SOURCES: { value: TicketSource; label: string }[] = [
  { value: "whatsapp", label: "WhatsApp" },
  { value: "email", label: "E-mail" },
  { value: "phone", label: "Telefone" },
  { value: "portal", label: "Portal do cliente" },
  { value: "web", label: "Central (outro canal)" },
  { value: "monitoring", label: "Monitoramento" },
  { value: "mobile", label: "App" },
];

/** Limites das etiquetas no filtro (os mesmos da OS). */
export const TAG_FILTER_MAX = 20;
export const TAG_NAME_MAX = 60;

export interface Filters {
  status: TicketStatus[];
  priority: TicketPriority[];
  type: TicketType | "";
  source: TicketSource | "";
  assignee_id: UUID | "";
  /** Técnico que atuou na OS: o atual, quem foi junto ou quem já foi o responsável (OS antigas). */
  technician_id: UUID | "";
  team_id: UUID | "";
  customer_id: UUID | "";
  location_id: UUID | "";
  service_type_id: UUID | "";
  category_id: UUID | "";
  project_id: UUID | "";
  /** Fila de um analista (o responsável que acompanha a OS). */
  owner_id: UUID | "";
  no_owner: boolean;
  violation_pending: boolean;
  /** Identificador (nº) da OS: procura em todas as OS, em qualquer aba. */
  number: number | null;
  /** Etiquetas: OS com qualquer uma delas. */
  tag: string[];
  /** Dias "AAAA-MM-DD" (no fuso da operação), incluídos os dois extremos; vazio = sem limite. */
  created_from: string;
  created_to: string;
  scheduled_from: string;
  scheduled_to: string;
}

export type FilterKey = keyof Filters;

export interface ListState {
  view: View;
  filters: Filters;
  q: string;
  page: number;
  pageSize: number;
  order: string;
}

/** Valores que limpam cada filtro (para "Limpar filtros"). */
export const CLEAR_FILTERS: Record<FilterKey, null> = {
  status: null,
  priority: null,
  type: null,
  source: null,
  assignee_id: null,
  technician_id: null,
  team_id: null,
  customer_id: null,
  location_id: null,
  service_type_id: null,
  category_id: null,
  project_id: null,
  owner_id: null,
  no_owner: null,
  violation_pending: null,
  number: null,
  tag: null,
  created_from: null,
  created_to: null,
  scheduled_from: null,
  scheduled_to: null,
};

/** Os filtros que ficam em "Mais filtros" (os outros têm botão próprio na fileira de filtros). */
export const MORE_FILTER_KEYS: FilterKey[] = [
  "technician_id",
  "assignee_id",
  "owner_id",
  "no_owner",
  "service_type_id",
  "tag",
  "priority",
  "project_id",
  "scheduled_from",
  "scheduled_to",
  "type",
  "source",
  "team_id",
  "category_id",
  "violation_pending",
];

interface Params {
  get(name: string): string | null;
  getAll(name: string): string[];
  has(name: string): boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Maior nº de OS que a API aceita (coluna integer). */
const MAX_NUMBER = 2 ** 31 - 1;

/** Dia de calendário válido ("2026-02-30" não é). */
export function isDay(value: string): boolean {
  const match = DAY_RE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * Nº da OS como a pessoa digita ou cola: "16976", "OS-016976", "os 16976", "#16976". Devolve null
 * quando não é um nº de OS.
 */
export function parseTicketNumber(text: string): number | null {
  const match = /^(?:os|#)?[\s#-]*0*(\d{1,10})$/i.exec(text.trim());
  if (!match) return null;
  const n = Number(match[1]);
  return n > 0 && n <= MAX_NUMBER ? n : null;
}

/** Etiquetas sem repetição (maiúsculas não contam), sem espaços sobrando e dentro dos limites. */
export function cleanTags(names: string[]): string[] {
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.replace(/\s+/g, " ").trim().slice(0, TAG_NAME_MAX);
    if (name && !out.some((x) => x.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out.slice(0, TAG_FILTER_MAX);
}

function viewOf(params: Params): View {
  const explicit = params.get("view");
  const known = VIEWS.find((v) => v.key === explicit);
  if (known) return known.key;
  if (params.get("sla_breached") === "true") return "sla";
  if (params.get("unassigned") === "true") return "sem_tecnico";
  if (params.get("mine") === "true") return "minhas";
  if (params.get("open_only") === "true") return "abertos";
  // Fila de um analista (ou sem analista): as abertas dela.
  if (params.get("owner_id") || params.get("no_owner") === "true") return "abertos";
  // O painel da OS (?os=), a busca, a ordem e a página não contam: só filtro de verdade abre em "Todas".
  return FILTER_KEYS.some((k) => params.has(k)) ? "todas" : "abertos";
}

export function readListState(params: Params): ListState {
  const id = (key: string) => {
    const value = params.get(key) ?? "";
    return UUID_RE.test(value) ? value : "";
  };
  const day = (key: string) => {
    const value = params.get(key) ?? "";
    return isDay(value) ? value : "";
  };
  const type = params.get("type") ?? "";
  const source = SOURCES.find((s) => s.value === params.get("source"))?.value ?? "";
  const order = ORDERS.find((o) => o.value === params.get("order_by"))?.value ?? DEFAULT_ORDER;
  const size = Number(params.get("page_size"));
  return {
    view: viewOf(params),
    filters: {
      status: STATUS_ORDER.filter((s) => params.getAll("status").includes(s)),
      priority: PRIORITY_ORDER.filter((p) => params.getAll("priority").includes(p)),
      type: Object.keys(TICKET_TYPE).includes(type) ? (type as TicketType) : "",
      source,
      assignee_id: id("assignee_id"),
      technician_id: id("technician_id"),
      team_id: id("team_id"),
      customer_id: id("customer_id"),
      location_id: id("location_id"),
      service_type_id: id("service_type_id"),
      category_id: id("category_id"),
      project_id: id("project_id"),
      owner_id: id("owner_id"),
      no_owner: params.get("no_owner") === "true",
      violation_pending: params.get("violation_pending") === "true",
      number: /^\d{1,10}$/.test(params.get("number") ?? "") ? parseTicketNumber(params.get("number") ?? "") : null,
      tag: cleanTags(params.getAll("tag")),
      created_from: day("created_from"),
      created_to: day("created_to"),
      scheduled_from: day("scheduled_from"),
      scheduled_to: day("scheduled_to"),
    },
    q: (params.get("q") ?? "").trim(),
    page: Math.max(1, Math.floor(Number(params.get("page"))) || 1),
    pageSize: PAGE_SIZES.find((n) => n === size) ?? DEFAULT_PAGE_SIZE,
    order,
  };
}

/** A lista como está na URL agora (relê a cada mudança da URL, inclusive Voltar e links). */
export function useListState(): ListState {
  const params = useSearchParams();
  return useMemo(() => readListState(params), [params]);
}

// "OS-15829", "os 15829", "OS15829", "#15829": o nº de uma OS escrito como nº de OS. Um número solto
// ("041", "10234") é busca de texto e fica na aba: código de loja e nº do chamado do cliente também são
// números (a API ainda acha a OS com esse nº, se ela estiver na aba, e a põe primeiro).
const NUMBER_SEARCH = /^(?:os|#)[\s#-]*0*\d{1,9}$/i;

/** A busca é o nº de uma OS (com "OS" ou "#" na frente): procura em todas, qualquer que seja a aba. */
export const isNumberSearch = (q: string) => NUMBER_SEARCH.test(q.trim());

/** A lista procura em todas as OS, sem o limite da aba: identificador escolhido ou busca pelo nº da OS. */
export const ignoresView = (state: Pick<ListState, "filters" | "q">) => state.filters.number !== null || isNumberSearch(state.q);

/** Quantos filtros de "Mais filtros" estão em uso (o número no botão). */
export function moreFilterCount(f: Filters): number {
  return (
    f.priority.length +
    f.tag.length +
    [f.type, f.source, f.assignee_id, f.technician_id, f.team_id, f.service_type_id, f.category_id, f.project_id, f.owner_id].filter(Boolean).length +
    (f.no_owner ? 1 : 0) +
    (f.violation_pending ? 1 : 0) +
    (f.scheduled_from || f.scheduled_to ? 1 : 0)
  );
}

/** Algum filtro (de qualquer tipo) está em uso. */
export function hasAnyFilter(f: Filters): boolean {
  return (
    moreFilterCount(f) > 0 ||
    f.status.length > 0 ||
    Boolean(f.customer_id || f.location_id || f.created_from || f.created_to) ||
    f.number !== null
  );
}

/** Parâmetros de GET /tickets (e da exportação) para a lista como está na tela, sem a página. */
export function apiQuery(state: ListState): Query {
  const f = state.filters;
  return {
    status: f.status,
    priority: f.priority,
    type: f.type || undefined,
    source: f.source || undefined,
    assignee_id: f.assignee_id || undefined,
    technician_id: f.technician_id || undefined,
    team_id: f.team_id || undefined,
    customer_id: f.customer_id || undefined,
    location_id: f.location_id || undefined,
    service_type_id: f.service_type_id || undefined,
    category_id: f.category_id || undefined,
    project_id: f.project_id || undefined,
    owner_id: f.owner_id || undefined,
    no_owner: f.no_owner || undefined,
    violation_pending: f.violation_pending || undefined,
    number: f.number ?? undefined,
    tag: f.tag,
    created_from: f.created_from || undefined,
    created_to: f.created_to || undefined,
    scheduled_from: f.scheduled_from || undefined,
    scheduled_to: f.scheduled_to || undefined,
    // O identificador (ou a busca pelo nº da OS) vale para todas as OS: a aba não limita.
    ...(ignoresView(state) ? {} : VIEW_FLAGS[state.view]),
    q: state.q || undefined,
    order_by: state.order,
  };
}

type ParamValue = string | string[] | number | boolean | null | undefined;

/**
 * Grava na URL sem ir ao servidor e sem nova entrada no histórico (o Voltar sai da lista, não desfaz
 * filtro por filtro). Parte da URL de agora: o painel da OS (?os=) continua aberto. Vazio, false e
 * null tiram o parâmetro; a página volta para a 1 a menos que `keepPage`.
 */
export function writeListParams(patch: Record<string, ParamValue>, options: { keepPage?: boolean } = {}) {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(patch)) {
    params.delete(key);
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else if (value === true) {
      params.set(key, "true");
    } else if (typeof value === "number" || (typeof value === "string" && value !== "")) {
      params.set(key, String(value));
    }
  }
  // A aba escrita por extenso substitui as marcas antigas que a escolhiam.
  if ("view" in patch) for (const key of LEGACY_VIEW_KEYS) params.delete(key);
  if (!options.keepPage || params.get("page") === "1") params.delete("page");
  if (params.get("order_by") === DEFAULT_ORDER) params.delete("order_by");
  if (params.get("page_size") === String(DEFAULT_PAGE_SIZE)) params.delete("page_size");
  const query = params.toString();
  const href = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  if (href === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
  // O painel da OS marca a própria entrada do histórico (mfPanel) e a marca continua. O estado interno
  // do Next fica de fora: o próprio Next o copia e entrega a URL nova ao useSearchParams.
  const mfPanel = (window.history.state as { mfPanel?: string } | null)?.mfPanel;
  window.history.replaceState(mfPanel ? { mfPanel } : null, "", href);
}
