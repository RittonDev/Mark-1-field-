// Respostas de GET /home/overview e GET /search/smart (contrato combinado com a API).
// Ficam aqui, e não em lib/types.ts, até o contrato assentar.

import type { ISODate, TicketStatus, UUID } from "@/lib/types";

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
}

/** Nome que pode chegar como texto ou como referência ({ id, name }). */
export type NameLike = string | { name: string } | null | undefined;

export type Severity = "critical" | "high" | "medium" | "low";

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

export interface HomeOverview {
  generated_at: ISODate;
  kpis: HomeKpis;
  attention: AttentionGroup[];
  suggestions: Suggestion[];
  week: WeekDay[];
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
