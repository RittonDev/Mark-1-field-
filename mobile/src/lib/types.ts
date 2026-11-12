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
  team_id?: UUID | null;
  assignee_id?: UUID | null;
  scheduled_start?: ISODate | null;
  scheduled_end?: ISODate | null;
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
}
