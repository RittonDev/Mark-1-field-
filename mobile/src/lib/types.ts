// Espelho dos schemas Pydantic do backend (backend/app/schemas/*.py).
// Contrato documentado em docs/API.md.

export type UUID = string;
export type ISODate = string;

export type UserRole = "admin" | "supervisor" | "analyst" | "technician" | "requester";

export type TicketStatus =
  | "new"
  | "triage"
  | "assigned"
  | "scheduled"
  | "en_route"
  | "in_progress"
  | "on_hold_customer"
  | "on_hold_vendor"
  | "resolved"
  | "closed"
  | "cancelled"
  | "reopened";

export type TicketPriority = "critical" | "high" | "medium" | "low";
export type Level = "high" | "medium" | "low"; // impacto e urgência
export type TicketType = "incident" | "service_request" | "preventive" | "installation";
export type TicketSource = "web" | "mobile" | "email" | "phone" | "whatsapp" | "monitoring";
export type AssetType =
  | "printer"
  | "desktop"
  | "notebook"
  | "server"
  | "switch"
  | "router"
  | "access_point"
  | "firewall"
  | "camera"
  | "dvr_nvr"
  | "phone"
  | "other";
export type TicketEventType =
  | "created"
  | "updated"
  | "status_changed"
  | "assigned"
  | "comment_added"
  | "worklog_added"
  | "attachment_added";
export type SlaStatus = "ok" | "at_risk" | "breached" | "paused" | "met";
export type AttachmentKind = "file" | "photo" | "signature";

export interface Ref {
  id: UUID;
  name: string;
}

export interface UserRef {
  id: UUID;
  name: string;
  email: string;
  role: UserRole;
}

export interface User {
  id: UUID;
  name: string;
  email: string;
  phone: string | null;
  role: UserRole;
  job_title: string | null;
  team_id: UUID | null;
  team: Ref | null;
  is_active: boolean;
  last_login_at: ISODate | null;
  created_at: ISODate;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  user: User;
}

export interface AssignableUser {
  id: UUID;
  name: string;
  role: UserRole;
  team_id: UUID | null;
  team_name: string | null;
  open_tickets: number;
}

export interface Team {
  id: UUID;
  name: string;
  description: string | null;
  is_active: boolean;
}

/** Histórico resumido derivado das OS (calculado pela API, não digitado). */
export interface TicketStats {
  open_tickets: number;
  total_tickets: number;
  last_ticket_at: ISODate | null;
}

export interface Customer extends TicketStats {
  id: UUID;
  name: string;
  document: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: ISODate;
  locations_count: number;
}

/** Local de atendimento = filial (CNPJ próprio). É o eixo da operação, como no Field Control. */
export interface Location extends TicketStats {
  id: UUID;
  customer_id: UUID;
  customer: Ref;
  name: string;
  code: string | null;
  document: string | null;
  address_line: string | null;
  district: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  latitude: number | null;
  longitude: number | null;
  contact_name: string | null;
  contact_phone: string | null;
  notes: string | null;
  is_active: boolean;
}

export interface Asset {
  id: UUID;
  customer_id: UUID;
  customer: Ref;
  location_id: UUID | null;
  location: Ref | null;
  asset_type: AssetType;
  name: string;
  brand: string | null;
  model: string | null;
  serial_number: string | null;
  asset_tag: string | null;
  ip_address: string | null;
  mac_address: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: ISODate;
}

export interface Category {
  id: UUID;
  name: string;
  full_name: string;
  description: string | null;
  parent_id: UUID | null;
  default_team_id: UUID | null;
  default_team: Ref | null;
  is_active: boolean;
}

export interface SlaPolicy {
  priority: TicketPriority;
  response_minutes: number;
  resolution_minutes: number;
}

/** Tipo de serviço (o "Tipo de OS" do Field Control) com a duração estimada. */
export interface ServiceTypeRef {
  id: UUID;
  name: string;
  estimated_minutes: number;
}

export interface ServiceType extends ServiceTypeRef {
  description: string | null;
  customer_id: UUID | null;
  customer: Ref | null;
  category_id: UUID | null;
  is_active: boolean;
  /** Mediana do tempo em atendimento das OS concluídas deste tipo. */
  observed_median_minutes: number | null;
  observed_count: number;
  /** Sugestão de nova estimativa quando a observada se afasta muito (a estimativa aprende). */
  suggested_minutes: number | null;
}

export interface CategoryRef {
  id: UUID;
  name: string;
  full_name: string;
}

export interface LocationRef {
  id: UUID;
  name: string;
  code: string | null;
  document: string | null;
  address_line: string | null;
  city: string | null;
  state: string | null;
  latitude: number | null;
  longitude: number | null;
  contact_name: string | null;
  contact_phone: string | null;
}

export interface AssetRef {
  id: UUID;
  name: string;
  asset_type: AssetType;
  brand: string | null;
  model: string | null;
  serial_number: string | null;
  asset_tag: string | null;
  ip_address: string | null;
}

export interface TicketListItem {
  id: UUID;
  number: number;
  code: string;
  title: string;
  status: TicketStatus;
  priority: TicketPriority;
  type: TicketType;
  source: TicketSource;
  category: CategoryRef | null;
  customer: Ref | null;
  location: LocationRef | null;
  assignee: UserRef | null;
  team: Ref | null;
  requester_name: string | null;
  scheduled_start: ISODate | null;
  scheduled_end: ISODate | null;
  response_due_at: ISODate | null;
  resolution_due_at: ISODate | null;
  first_response_at: ISODate | null;
  resolved_at: ISODate | null;
  sla_paused_at: ISODate | null;
  sla_paused_seconds: number;
  created_at: ISODate;
  updated_at: ISODate;
  version: number;
  sla_status: SlaStatus;
}

export interface TicketDetail extends TicketListItem {
  description: string;
  impact: Level;
  urgency: Level;
  asset: AssetRef | null;
  requester: UserRef | null;
  requester_contact: string | null;
  /** Endereço do atendimento quando diferente do cadastrado no local. */
  service_address: string | null;
  created_by: UserRef | null;
  closed_at: ISODate | null;
  cancelled_at: ISODate | null;
  reopen_count: number;
  resolution_notes: string | null;
  service_type: ServiceTypeRef | null;
  /** Estimada: copiada do tipo na abertura. Real: tempo somado em "Em atendimento". */
  estimated_minutes: number | null;
  work_seconds: number;
  work_started_at: ISODate | null;
  actual_minutes: number;
  /** Motivo da violação de SLA, um por relógio (como no Field Control). */
  response_violation_reason: ViolationReasonRef | null;
  resolution_violation_reason: ViolationReasonRef | null;
  violation_note: string | null;
  response_breached: boolean;
  resolution_breached: boolean;
  /** Resolvida com prazo violado e sem motivo informado. */
  violation_reason_pending: boolean;
  allowed_transitions: TicketStatus[];
  can_edit: boolean;
  can_assign: boolean;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface Comment {
  id: UUID;
  ticket_id: UUID;
  author: UserRef | null;
  body: string;
  is_internal: boolean;
  created_at: ISODate;
}

export interface TicketEvent {
  id: UUID;
  ticket_id: UUID;
  actor: UserRef | null;
  event_type: TicketEventType;
  from_value: string | null;
  to_value: string | null;
  note: string | null;
  data: Record<string, unknown> | null;
  created_at: ISODate;
}

export interface Worklog {
  id: UUID;
  ticket_id: UUID;
  user: UserRef | null;
  description: string;
  started_at: ISODate;
  ended_at: ISODate | null;
  minutes: number;
  latitude: number | null;
  longitude: number | null;
  created_at: ISODate;
}

export interface Attachment {
  id: UUID;
  ticket_id: UUID;
  filename: string;
  content_type: string;
  size_bytes: number;
  kind: AttachmentKind | string;
  uploaded_by: UserRef | null;
  created_at: ISODate;
  download_url: string | null;
}

export interface AssigneeLoad {
  user_id: UUID;
  name: string;
  open: number;
  in_progress: number;
  breached: number;
}

export interface DashboardSummary {
  by_status: Record<string, number>;
  by_priority: Record<string, number>;
  open_total: number;
  unassigned: number;
  sla_breached: number;
  sla_at_risk: number;
  created_today: number;
  resolved_today: number;
  avg_resolution_minutes_30d: number | null;
  sla_compliance_30d: number | null;
  by_assignee: AssigneeLoad[];
}

export interface RealtimeEvent {
  type: string;
  ticket_id?: UUID;
  ticket_code?: string;
  status?: TicketStatus;
  priority?: TicketPriority;
  assignee_id?: UUID | null;
  team_id?: UUID | null;
  actor_id?: UUID | null;
  actor_name?: string | null;
  version?: number;
  occurred_at?: ISODate;
  data?: Record<string, unknown> | null;
  // Eventos do rastreamento (technician.location, technician.shift), só para a gestão.
  user_id?: UUID;
  name?: string;
  latitude?: number;
  longitude?: number;
  recorded_at?: ISODate;
  on_shift?: boolean;
}

export interface TicketCreatePayload {
  title: string;
  description?: string;
  type?: TicketType;
  impact?: Level;
  urgency?: Level;
  priority?: TicketPriority | null;
  source?: TicketSource;
  category_id?: UUID | null;
  customer_id?: UUID | null;
  location_id?: UUID | null;
  asset_id?: UUID | null;
  requester_id?: UUID | null;
  requester_name?: string | null;
  requester_contact?: string | null;
  service_address?: string | null;
  service_type_id?: UUID | null;
  estimated_minutes?: number | null;
  team_id?: UUID | null;
  assignee_id?: UUID | null;
  scheduled_start?: ISODate | null;
  scheduled_end?: ISODate | null;
  allow_conflict?: boolean;
}

export type TicketUpdatePayload = Partial<
  Omit<TicketCreatePayload, "source" | "requester_id" | "assignee_id">
> & { expected_version?: number };

export interface TicketTransitionPayload {
  to_status: TicketStatus;
  note?: string | null;
  resolution_notes?: string | null;
  scheduled_start?: ISODate | null;
  scheduled_end?: ISODate | null;
  latitude?: number | null;
  longitude?: number | null;
  expected_version?: number;
  response_violation_reason_id?: UUID | null;
  resolution_violation_reason_id?: UUID | null;
  violation_note?: string | null;
  allow_conflict?: boolean;
}

/** Atividades do dia (GET /activities/day): o previsto e o realizado na mesma linha. */
export type ActivityState =
  | "scheduled"
  | "late"
  | "en_route"
  | "in_progress"
  | "on_hold"
  | "rescheduled"
  | "done"
  | "pending";

export interface Activity {
  ticket: TicketListItem;
  state: ActivityState;
  scheduled_start: ISODate | null;
  scheduled_end: ISODate | null;
  started_at: ISODate | null;
  arrived_at: ISODate | null;
  finished_at: ISODate | null;
  start_delay_minutes: number | null;
  start_has_gps: boolean;
  service_type_name: string | null;
  estimated_minutes: number | null;
  actual_minutes: number;
}

export interface DaySummary {
  total: number;
  scheduled: number;
  late: number;
  en_route: number;
  in_progress: number;
  on_hold: number;
  rescheduled: number;
  done: number;
  pending: number;
  unassigned: number;
}

export interface DayActivities {
  date: string;
  timezone: string;
  is_today: boolean;
  summary: DaySummary;
  activities: Activity[];
}

/** Motivos de violação de SLA (cadastro) e o relatório que os transforma em estatística. */
export type ViolationScope = "response" | "resolution" | "both";
export type Responsibility = "internal" | "customer" | "third_party";

export interface ViolationReasonRef {
  id: UUID;
  name: string;
  responsibility: Responsibility;
}

export interface ViolationReason extends ViolationReasonRef {
  description: string | null;
  applies_to: ViolationScope;
  is_active: boolean;
}

export interface ViolationReasonCount {
  reason_id: UUID;
  name: string;
  responsibility: Responsibility;
  count: number;
}

export interface ClockViolations {
  breached: number;
  justified: number;
  by_reason: ViolationReasonCount[];
}

export interface SlaViolationReport {
  period_days: number;
  tickets_total: number;
  response: ClockViolations;
  resolution: ClockViolations;
  by_responsibility: Record<Responsibility, number>;
  pending_justification: number;
}

// Rastreamento dos técnicos (mapa ao vivo)
export type LiveState = "offline" | "no_signal" | "available" | "en_route" | "in_progress";

export interface LivePosition {
  latitude: number;
  longitude: number;
  accuracy_m: number | null;
  speed_mps: number | null;
  heading: number | null;
  battery_pct: number | null;
  is_mock: boolean;
  recorded_at: ISODate;
}

export interface LiveTicket {
  id: UUID;
  code: string;
  title: string;
  status: TicketStatus;
  location: { name: string; city: string | null; latitude: number | null; longitude: number | null } | null;
  service_address: string | null;
}

export interface LiveTechnician {
  id: UUID;
  name: string;
  phone: string | null;
  team: Ref | null;
  on_shift: boolean;
  shift_started_at: ISODate | null;
  state: LiveState;
  last_position: LivePosition | null;
  current_ticket: LiveTicket | null;
  open_tickets: number;
}

export interface TrackingHistory {
  user_id: UUID;
  date: string;
  points: { latitude: number; longitude: number; recorded_at: ISODate; speed_mps: number | null }[];
  status_events: {
    ticket_id: UUID;
    ticket_code: string;
    to_status: TicketStatus;
    at: ISODate;
    latitude: number | null;
    longitude: number | null;
  }[];
}

// Calendário e conflito de horário
export interface ConflictItem {
  id: UUID;
  code: string;
  title: string;
  customer: string | null;
  location: string | null;
  start: ISODate;
  end: ISODate;
}

export interface CalendarEvent {
  id: UUID;
  code: string;
  title: string;
  status: TicketStatus;
  priority: TicketPriority;
  start: ISODate;
  end: ISODate;
  end_is_estimated: boolean;
  assignee: Ref | null;
  team: Ref | null;
  customer: Ref | null;
  location: { id: UUID; name: string; city: string | null } | null;
  service_type: string | null;
  conflict_with: UUID[];
}
