// Estado da lista de chamados (aba, filtros, busca, ordem e página) guardado na URL: F5, Voltar e o
// link mandado para um colega abrem a lista como foi deixada, e um link de outra tela (dashboard, fila,
// clientes, locais) aplica o filtro mesmo com a lista já aberta. A URL é a fonte da verdade.

import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import type { Query } from "@/lib/api";
import { PRIORITY_ORDER, STATUS, STATUS_ORDER, TICKET_TYPE } from "@/lib/constants";
import type { TicketPriority, TicketSource, TicketStatus, TicketType, UUID } from "@/lib/types";

export const PAGE_SIZE = 25;

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
  "team_id",
  "customer_id",
  "location_id",
  "service_type_id",
  "category_id",
  "project_id",
  "violation_pending",
];

export const DEFAULT_ORDER = "-created_at";
export const ORDERS: { value: string; label: string }[] = [
  { value: "-created_at", label: "Mais novas" },
  { value: "created_at", label: "Mais antigas" },
  { value: "-updated_at", label: "Atualizadas recentemente" },
  { value: "priority", label: "Maior prioridade" },
  { value: "resolution_due_at", label: "Prazo de solução mais próximo" },
  { value: "-number", label: "Nº da OS (maior primeiro)" },
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

export interface Filters {
  status: TicketStatus[];
  priority: TicketPriority[];
  type: TicketType | "";
  source: TicketSource | "";
  assignee_id: UUID | "";
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
}

export type FilterKey = keyof Filters;

export interface ListState {
  view: View;
  filters: Filters;
  q: string;
  page: number;
  order: string;
}

/** Valores que limpam cada filtro (para "Limpar filtros"). */
export const CLEAR_FILTERS: Record<FilterKey, null> = {
  status: null,
  priority: null,
  type: null,
  source: null,
  assignee_id: null,
  team_id: null,
  customer_id: null,
  location_id: null,
  service_type_id: null,
  category_id: null,
  project_id: null,
  owner_id: null,
  no_owner: null,
  violation_pending: null,
};

interface Params {
  get(name: string): string | null;
  getAll(name: string): string[];
  has(name: string): boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const type = params.get("type") ?? "";
  const source = SOURCES.find((s) => s.value === params.get("source"))?.value ?? "";
  const order = ORDERS.find((o) => o.value === params.get("order_by"))?.value ?? DEFAULT_ORDER;
  return {
    view: viewOf(params),
    filters: {
      status: STATUS_ORDER.filter((s) => params.getAll("status").includes(s)),
      priority: PRIORITY_ORDER.filter((p) => params.getAll("priority").includes(p)),
      type: Object.keys(TICKET_TYPE).includes(type) ? (type as TicketType) : "",
      source,
      assignee_id: id("assignee_id"),
      team_id: id("team_id"),
      customer_id: id("customer_id"),
      location_id: id("location_id"),
      service_type_id: id("service_type_id"),
      category_id: id("category_id"),
      project_id: id("project_id"),
      owner_id: id("owner_id"),
      no_owner: params.get("no_owner") === "true",
      violation_pending: params.get("violation_pending") === "true",
    },
    q: (params.get("q") ?? "").trim(),
    page: Math.max(1, Math.floor(Number(params.get("page"))) || 1),
    order,
  };
}

/** A lista como está na URL agora (relê a cada mudança da URL, inclusive Voltar e links). */
export function useListState(): ListState {
  const params = useSearchParams();
  return useMemo(() => readListState(params), [params]);
}

// "15829", "OS-015829", "os 15829", "#15829": o nº de uma OS (a API põe a própria OS em primeiro).
const NUMBER_SEARCH = /^(?:os[\s#-]*|#)?\s*0*\d{1,9}$/i;

/** A busca é o nº de uma OS: procura em todas, qualquer que seja a aba (a OS pode já estar fechada). */
export const isNumberSearch = (q: string) => NUMBER_SEARCH.test(q.trim());

/** Quantos filtros do cartão "Filtros" estão em uso (a fila e a justificativa de SLA ficam fora dele). */
export function filterCount(f: Filters): number {
  return (
    f.status.length +
    f.priority.length +
    [f.type, f.source, f.assignee_id, f.team_id, f.customer_id, f.location_id, f.service_type_id, f.category_id, f.project_id].filter(
      Boolean,
    ).length
  );
}

/** Algum filtro (de qualquer tipo) está em uso. */
export function hasAnyFilter(f: Filters): boolean {
  return filterCount(f) > 0 || Boolean(f.owner_id) || f.no_owner || f.violation_pending;
}

/** Parâmetros de GET /tickets para a lista (e a exportação) como está na tela. */
export function apiQuery(state: ListState): Query {
  const f = state.filters;
  return {
    status: f.status,
    priority: f.priority,
    type: f.type || undefined,
    source: f.source || undefined,
    assignee_id: f.assignee_id || undefined,
    team_id: f.team_id || undefined,
    customer_id: f.customer_id || undefined,
    location_id: f.location_id || undefined,
    service_type_id: f.service_type_id || undefined,
    category_id: f.category_id || undefined,
    project_id: f.project_id || undefined,
    owner_id: f.owner_id || undefined,
    no_owner: f.no_owner || undefined,
    violation_pending: f.violation_pending || undefined,
    // Busca pelo nº vale para todas as OS: a aba não limita.
    ...(isNumberSearch(state.q) ? {} : VIEW_FLAGS[state.view]),
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
  const query = params.toString();
  const href = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  if (href === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
  // O painel da OS marca a própria entrada do histórico (mfPanel) e a marca continua. O estado interno
  // do Next fica de fora: o próprio Next o copia e entrega a URL nova ao useSearchParams.
  const mfPanel = (window.history.state as { mfPanel?: string } | null)?.mfPanel;
  window.history.replaceState(mfPanel ? { mfPanel } : null, "", href);
}
