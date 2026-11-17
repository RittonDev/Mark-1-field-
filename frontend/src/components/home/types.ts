// Respostas de GET /home/overview e GET /search/smart (contrato combinado com a API).
// Ficam aqui, e não em lib/types.ts, até o contrato assentar.

import type { ISODate, TicketSource, TicketStatus, TicketType, UUID } from "@/lib/types";

/**
 * Filtros da lista de Chamados que a API devolve prontos (o que a busca entendeu, o "Ver todas" de
 * cada ponto de atenção). Dias em "AAAA-MM-DD" no fuso da operação. Quem vira parâmetro da URL é
 * ticketsListHref (components/home/links.ts).
 */
export interface ListFilters {
  status?: string[];
  priority?: string[];
  number?: number;
  customer_id?: UUID;
  location_id?: UUID;
  /** Técnico que atuou na OS (o atual, quem foi junto ou quem atendeu antes). */
  technician_id?: UUID;
  assignee_id?: UUID;
  owner_id?: UUID;
  tag?: string[];
  created_from?: string;
  created_to?: string;
  scheduled_from?: string;
  scheduled_to?: string;
  q?: string;
  open_only?: boolean;
  sla_breached?: boolean;
  unassigned?: boolean;
  no_owner?: boolean;
  violation_pending?: boolean;
  type?: TicketType;
  source?: TicketSource;
  /** Ordem da lista (uma das ORDERS da lista de chamados), ex.: "created_at" = mais antigas primeiro. */
  order_by?: string;
}

/** Nome que pode chegar como texto ou como referência ({ id, name }). */
export type NameLike = string | { name: string } | null | undefined;

export type Severity = "critical" | "high" | "medium" | "low";

/** "now": pede ação agora (entra no número do topo); "routine": o resto, recolhido. */
export type Tier = "now" | "routine";

export interface AttentionItem {
  ticket_id: UUID | null;
  number: number | null;
  title: string;
  customer: NameLike;
  location: NameLike;
  technician: NameLike;
  /** Momento que importa para o motivo (prazo, agendamento, última mudança). */
  when: ISODate | null;
  reason: string;
}

export interface AttentionGroup {
  key: string;
  title: string;
  severity: Severity;
  count: number;
  hint: string;
  filters: ListFilters | null;
  link: string | null;
  items: AttentionItem[];
  /** Ausente na API antiga: vale "routine". */
  tier?: Tier;
}

export interface Suggestion {
  key: string;
  title: string;
  detail: string;
  link: string | null;
  filters: ListFilters | null;
}

export interface HomeKpis {
  open: number;
  scheduled_today: number;
  in_field_now: number;
  resolved_today: number;
  late: number;
  unassigned: number;
}

export interface WeekDay {
  /** "AAAA-MM-DD" */
  day: string;
  created: number;
  resolved: number;
}

// ------------------------------------------------------------------ número do topo e sinais vitais

/** Parte de uma base: a tela mostra "count de base" e só põe % com base suficiente (rules.ts). */
export interface Ratio {
  count: number;
  base: number;
}

export interface HomeFocus {
  /** OS distintas em algum grupo "now" (uma OS com dois motivos conta uma vez). */
  total: number;
  /** Próxima visita de hoje ainda não iniciada. */
  next_visit_at: ISODate | null;
}

/** Visitas de hoje: planned = done + in_field + not_started + upcoming + on_hold. */
export interface HomeToday {
  planned: number;
  done: number;
  in_field: number;
  /** 30 min ou mais depois do horário, sem sair nem começar (a mesma regra do número do topo). */
  not_started: number;
  on_hold: number;
  /** Ainda no horário. */
  upcoming: number;
  unassigned: number;
  unassigned_filters: ListFilters;
  technicians: number;
  /** OS resolvidas hoje, de qualquer agenda. */
  resolved: number;
}

export interface HomeTomorrow {
  /** "AAAA-MM-DD" */
  day: string;
  planned: number;
  technicians: number;
  unassigned: number;
  unassigned_filters: ListFilters;
}

export type AgeKey = "d7" | "d30" | "d90" | "older";

export interface AgeBucket {
  key: AgeKey;
  count: number;
  /** Abertas criadas na faixa, mais antigas primeiro. */
  filters: ListFilters;
}

export type OldReasonKey = "no_owner" | "unassigned" | "overdue_visit" | "sla_breached" | "unproductive";

export interface OldReason {
  key: OldReasonKey;
  label: string;
  count: number;
  /** null quando a lista não reproduz o número (improdutivas). */
  filters: ListFilters | null;
}

export interface HomeBacklog {
  open: number;
  /** Abertas nos últimos 30 dias. */
  recent: number;
  /** Abertas antes disso (a "Fila antiga"). */
  old: number;
  median_age_days: number | null;
  /** Sempre as 4 faixas, nesta ordem; somam `open`. */
  ages: AgeBucket[];
  entered_30d: number;
  resolved_30d: number;
  cancelled_30d: number;
  /** Só os motivos com OS, do maior para o menor. */
  old_reasons: OldReason[];
  /** A fila antiga inteira, mais antigas primeiro. */
  old_filters: ListFilters;
}

export interface HomeQuality {
  on_time: Ratio;
  /** Só OS com prazo de solução. */
  resolution_sla: Ratio;
  /** Da base acima, quantas vieram do Field Control. */
  resolution_sla_imported: number;
  store_return: Ratio;
  return_days: number;
  unproductive: number;
  /** Idas à loja: chegadas + improdutivas. */
  visits: number;
}

export interface HomeTeam {
  worked: number;
  resolved: number;
  top3_resolved: number;
  in_app: number;
  onsite_median_minutes: number | null;
  onsite_over: Ratio;
  onsite_limit_hours: number;
}

export interface CustomerPulse {
  id: UUID;
  name: string;
  created: number;
  on_time: Ratio;
  breached: number;
  filters: ListFilters;
  /** null com breached 0. */
  breached_filters: ListFilters | null;
}

export interface HomeCustomers {
  active: number;
  /** Base da participação (= backlog.entered_30d). */
  entered: number;
  /** Até 5, os maiores por OS abertas no período. */
  top: CustomerPulse[];
}

/** Valores em R$ como número. Valor zero não diz nada: a tela decide pelos campos de contagem. */
export interface HomeFinance {
  payouts_to_pay: number;
  payouts_to_pay_count: number;
  payouts_technicians: number;
  payouts_late: number;
  payouts_expected: number;
  payout_tag: string | null;
  payout_tag_tickets: number;
  payout_tag_technicians: number;
  payout_tag_over_30d: number;
  payout_tag_filters: ListFilters | null;
  quotes_waiting: number;
  quotes_waiting_total: number;
  quotes_approved_month: number;
  quotes_approved_month_total: number;
  costs_pending: number;
  costs_pending_total: number;
}

export interface WeekFlow {
  /** Segunda-feira, "AAAA-MM-DD". */
  start: string;
  created: number;
  resolved: number;
}

export interface HomePulse {
  /** 1º dia dos "últimos 30 dias" (hoje − 29). */
  window_from: string;
  today: HomeToday;
  tomorrow: HomeTomorrow;
  backlog: HomeBacklog;
  quality: HomeQuality;
  team: HomeTeam;
  customers: HomeCustomers;
  /** null: sem permissão para ver valores. */
  finance: HomeFinance | null;
  /** 8 semanas, da mais antiga para a atual (em andamento). */
  weeks: WeekFlow[];
}

export interface HomeOverview {
  generated_at: ISODate;
  kpis: HomeKpis;
  attention: AttentionGroup[];
  suggestions: Suggestion[];
  week: WeekDay[];
  /** O número do topo (a API antiga não manda). */
  focus?: HomeFocus | null;
  /** Sinais vitais de hoje e dos últimos 30 dias (a API antiga não manda). */
  pulse?: HomePulse | null;
}

/** Grupo com a camada sempre preenchida. */
export type HomeGroup = AttentionGroup & { tier: Tier };

/** O resumo como a tela usa: focus e pulse sempre presentes (null com a API antiga) e tier preenchido. */
export interface HomeData {
  generated_at: ISODate;
  kpis: HomeKpis;
  attention: HomeGroup[];
  suggestions: Suggestion[];
  week: WeekDay[];
  focus: HomeFocus | null;
  pulse: HomePulse | null;
}

// ------------------------------------------------------------------ busca inteligente

export type ChipKind = "number" | "status" | "period" | "customer" | "location" | "technician" | "tag" | "city" | "priority" | "text";

export interface SearchChip {
  kind: ChipKind;
  label: string;
}

export interface SmartTicket {
  id: UUID;
  number: number;
  title: string;
  status: TicketStatus;
  customer: NameLike;
  location: NameLike;
  city: string | null;
  technician: NameLike;
  scheduled_start: ISODate | null;
  created_at: ISODate;
  tags: { name: string; color: string | null }[];
}

export interface SmartCustomer {
  id: UUID;
  name: string;
  document: string | null;
  open_count: number;
}

export interface SmartLocation {
  id: UUID;
  name: string;
  code: string | null;
  city: string | null;
  customer: NameLike;
}

export interface SmartTechnician {
  id: UUID;
  name: string;
  city: string | null;
  active: boolean;
}

export interface SmartSearchResult {
  query: string;
  chips: SearchChip[];
  filters: ListFilters | null;
  total: number;
  tickets: SmartTicket[];
  customers: SmartCustomer[];
  locations: SmartLocation[];
  technicians: SmartTechnician[];
}
