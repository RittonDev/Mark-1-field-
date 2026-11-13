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
export type TicketSource = "web" | "mobile" | "email" | "phone" | "whatsapp" | "monitoring" | "portal";
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
  | "attachment_updated"
  | "attachment_removed"
  | "helpers_changed"
  | "owner_changed"
  | "updated"
  | "status_changed"
  | "assigned"
  | "comment_added"
  | "worklog_added"
  | "attachment_added"
  | "form_added"
  | "form_completed"
  | "form_removed"
  | "signature_collected"
  | "expense_added"
  | "expense_updated"
  | "expense_removed"
  | "unproductive_visit"
  | "quote_sent"
  | "quote_approved"
  | "quote_rejected"
  | "times_corrected"
  | "payout_set"
  | "payout_removed";
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
  /** Desativado não entra no app (a OS dele precisa ser reatribuída). */
  is_active?: boolean;
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
  /** Usuário do cliente: a empresa (o portal mostra as solicitações de todas as lojas dela). */
  customer_id?: UUID | null;
  customer?: Ref | null;
  is_active: boolean;
  last_login_at: ISODate | null;
  // Aceite do termo de rastreamento (LGPD); sem ele o app não inicia a jornada.
  location_consent_at: ISODate | null;
  // Senha provisória: o app obriga a criar uma senha nova antes de seguir.
  must_change_password: boolean;
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
  tags?: Tag[];
  /** Todos os contatos (e-mails e telefones com nome e tipo), como vieram do Field Control. */
  contacts?: ContactEntry[];
  /** Endereço da matriz. */
  address_line?: string | null;
  district?: string | null;
  city?: string | null;
  state?: string | null;
  zip_code?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  logo_url?: string | null;
  legacy?: CustomerLegacy | null;
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
  contacts?: ContactEntry[];
  legacy?: RecordLegacy | null;
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
  /** Quanto o técnico parceiro recebe por uma OS deste tipo (padrão ao colocá-lo na OS). */
  technician_fee?: number | null;
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
  /** OS de projeto (valores e equipe seguem o projeto). */
  project: ProjectRef | null;
  /** Analista responsável (acompanha a OS); o técnico é o `assignee`. */
  owner?: UserRef | null;
  /** Outros técnicos da visita, além do responsável. */
  helpers?: UserRef[];
  /** Nº do chamado no sistema do cliente (entra na busca). */
  client_reference?: string | null;
  requester_name: string | null;
  scheduled_start: ISODate | null;
  scheduled_end: ISODate | null;
  response_due_at: ISODate | null;
  resolution_due_at: ISODate | null;
  first_response_at: ISODate | null;
  resolved_at: ISODate | null;
  sla_paused_at: ISODate | null;
  /** Visitas improdutivas (foi ao local e não atendeu). */
  unproductive_count: number;
  last_unproductive_at: ISODate | null;
  sla_paused_seconds: number;
  created_at: ISODate;
  updated_at: ISODate;
  version: number;
  sla_status: SlaStatus;
  /** Prazos de campo: chegada (4h nas capitais) e permanência na loja (4h contadas da chegada). */
  arrival_due_at?: ISODate | null;
  arrived_at?: ISODate | null;
  onsite_due_at?: ISODate | null;
  arrival_status?: ArrivalStatus | null;
  onsite_status?: OnsiteStatus | null;
  /** Tempo de técnico na loja já usado no chamado, somando as visitas (minutos). */
  onsite_used_minutes?: number | null;
  /** Outras OS na mesma loja nos últimos 30 dias. */
  recurrence_30d?: number;
  /** Etiquetas (ex.: "Avulso", "Faturamento Matriz"), vindas do Field Control. */
  tags?: Tag[];
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
  /** Observação da visita: o recado para o técnico (com quem falar, acesso, o que levar). */
  visit_note?: string | null;
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
  /** Formulários anexados pela gestão e assinatura do responsável no local. */
  forms: TicketForm[];
  signature_required: boolean;
  signer_name: string | null;
  signer_role: string | null;
  signed_at: ISODate | null;
  signature_attachment_id: UUID | null;
  /** Custos extras (a gestão lança; o técnico só vê; o solicitante recebe vazio). */
  expenses: Expense[];
  /** Link público do relatório para o cliente (gestão; e o técnico responsável com a OS concluída). */
  report_link?: ReportLink | null;
  /** Pedidos de peça do técnico (viram orçamento para o cliente aprovar). */
  part_requests?: PartRequest[];
  /** Valor de cada técnico na OS (só a gestão recebe). */
  payouts?: Payout[];
  /** O valor do próprio técnico (só no app dele). */
  my_payout?: MyPayout | null;
  recurrence?: { count_30d: number; previous: { id: UUID; code: string; title: string; status: TicketStatus; created_at: ISODate }[] } | null;
  /** Dados de origem da OS migrada do Field Control (valores, itens, solicitação, arquivos). */
  legacy?: LegacyOrder | null;
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
  /** Foto de um campo de formulário. */
  form_id: UUID | null;
  field_id: string | null;
  uploaded_by: UserRef | null;
  created_at: ISODate;
  download_url: string | null;
  /** Legenda (aparece no relatório do cliente). */
  description?: string | null;
  /** Arquivo migrado que continua no armazenamento do Field Control (sem tamanho conhecido). */
  external?: boolean;
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
  client_reference?: string | null;
  visit_note?: string | null;
  service_type_id?: UUID | null;
  estimated_minutes?: number | null;
  team_id?: UUID | null;
  assignee_id?: UUID | null;
  /** Outros técnicos da visita (só a gestão). */
  helper_ids?: UUID[];
  /** Analista responsável. Omitido: quem abre assume. null: fica sem analista. */
  owner_id?: UUID | null;
  scheduled_start?: ISODate | null;
  scheduled_end?: ISODate | null;
  allow_conflict?: boolean;
  project_id?: UUID | null;
  /** Etiquetas já na abertura (ex.: "Ticket Avulso"); a API que ainda não aceita ignora o campo. */
  tags?: Tag[];
}

export type TicketUpdatePayload = Partial<
  Omit<TicketCreatePayload, "source" | "requester_id" | "assignee_id" | "tags">
> & {
  expected_version?: number;
  /** Só a gestão, a qualquer momento (inclusive OS fechada). */
  resolution_notes?: string | null;
  tags?: Tag[] | null;
  signature_required?: boolean | null;
  /** Troca o técnico no mesmo salvamento da agenda (null tira); o conflito confere o final. */
  assignee_id?: UUID | null;
};

/** Contexto para abrir a OS: o cliente e a loja escolhidos. */
export interface IntakeContext {
  upcoming_days: number;
  customer: {
    id: UUID;
    name: string;
    tags: Tag[];
    notes: string | null;
    rating_average: number | null;
    rating_last: number | null;
    total_tickets: number;
    open_tickets: number;
    upcoming: number;
  } | null;
  location: {
    id: UUID;
    name: string;
    code: string | null;
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
    total_tickets: number;
    open_tickets: number;
    tickets_30d: number;
    last_visit: { ticket_id: UUID; code: string; title: string; at: ISODate; technician: string | null } | null;
    is_capital: boolean;
    arrival_hours: number | null;
  } | null;
}

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
  /** Escopo da OS (o cartão mostra a primeira linha). */
  description?: string;
  /** Feito offline: a hora que o aparelho marcou no botão (o envio chegou depois). */
  started_declared_at?: ISODate | null;
  arrived_declared_at?: ISODate | null;
  /** Distância (metros) do GPS do técnico até a loja na saída e no início do atendimento. */
  start_distance_m?: number | null;
  arrival_distance_m?: number | null;
  /** Visita improdutiva registrada no dia: quando e o motivo. */
  unproductive_at?: ISODate | null;
  unproductive_reason?: string | null;
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
  /** Visitas improdutivas registradas no dia. */
  unproductive?: number;
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

/** Um ponto do mapa; `approximate` = medido pelo centro da cidade. */
export interface MapPoint {
  latitude: number;
  longitude: number;
  label: string;
  approximate: boolean;
}

/** Um trecho: linha reta, estimativa pelas ruas e minutos de carro. */
export interface DistanceLeg {
  km: number;
  road_km: number;
  minutes: number;
  approximate: boolean;
}

export interface TechnicianHome extends MapPoint {
  /** home: endereço com coordenada; home_city: cidade de casa; base_city: onde mais atende. */
  kind: "home" | "home_city" | "base_city";
}

export interface TechnicianDistance {
  id: UUID;
  name: string;
  phone: string | null;
  live: MapPoint | null;
  live_at: ISODate | null;
  home: TechnicianHome | null;
  live_to_place: DistanceLeg | null;
  home_to_place: DistanceLeg | null;
  live_to_home: DistanceLeg | null;
}

export interface MapDistances {
  place: MapPoint | null;
  technicians: TechnicianDistance[];
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
  /** Quem está ocupado (o responsável ou outro técnico da visita). */
  who?: string | null;
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
  /** Outros técnicos da visita (a OS aparece também na agenda deles). */
  helpers?: Ref[];
  team: Ref | null;
  customer: Ref | null;
  location: { id: UUID; name: string; city: string | null } | null;
  service_type: string | null;
  conflict_with: UUID[];
}

// Homologação de técnicos
export type ApplicationStatus = "pending" | "approved" | "rejected";
export type InviteState = "active" | "used" | "expired" | "revoked";

export interface CatalogItem {
  key: string;
  label: string;
}

export interface OnboardingCatalog {
  service_areas: CatalogItem[];
  availability: CatalogItem[];
  skill_levels: CatalogItem[];
  vehicle_types: CatalogItem[];
  skill_suggestions: string[];
  privacy_version: string;
}

export interface OnboardingInvite {
  id: UUID;
  label: string | null;
  max_uses: number | null;
  use_count: number;
  expires_at: ISODate;
  revoked_at: ISODate | null;
  created_at: ISODate;
  created_by: Ref | null;
  state: InviteState;
  token?: string;
  /** Link para copiar de novo (só links ativos; os antigos, de antes desta versão, não têm). */
  url?: string | null;
}

export interface ApplicationSummary {
  id: UUID;
  status: ApplicationStatus;
  full_name: string;
  email: string;
  phone: string;
  city: string;
  state: string;
  service_areas: string[];
  years_experience: number | null;
  has_vehicle: boolean;
  created_at: ISODate;
  reviewed_at: ISODate | null;
  user_id: UUID | null;
}

export interface ApplicationDetail extends ApplicationSummary {
  document: string;
  birth_date: string | null;
  postal_code: string | null;
  address: string | null;
  company_document: string | null;
  skills: { name: string; level: string }[];
  certifications: string | null;
  tools: string | null;
  vehicle_type: string | null;
  has_driver_license: boolean;
  coverage_area: string;
  availability: string[];
  notes: string | null;
  privacy_consent_at: ISODate;
  privacy_version: string;
  reviewed_by: Ref | null;
  review_note: string | null;
  invite_label: string | null;
  photo_url: string | null;
}

// Base técnica (gestão de acesso dos técnicos)
export interface Technician {
  id: UUID;
  name: string;
  email: string;
  phone: string | null;
  job_title: string | null;
  team: Ref | null;
  /** Região de atuação: calculada pelo histórico de OS (onde ele atendeu) ou pelo endereço. */
  base_city?: string | null;
  base_state?: string | null;
  base_source?: "history" | "home" | null;
  base_visits?: number;
  last_visit_at?: ISODate | null;
  /** Ficha completa: endereço, jornada e serviços que faz. */
  address_line?: string | null;
  address_district?: string | null;
  address_zip?: string | null;
  work_schedule?: WorkSchedule | null;
  services?: { id: UUID; name: string }[];
  legacy?: RecordLegacy | null;
  home_city: string | null;
  home_state: string | null;
  coverage_area: string | null;
  is_active: boolean;
  last_login_at: ISODate | null;
  location_consent_at: ISODate | null;
  must_change_password: boolean;
  created_at: ISODate;
  avatar_url: string | null;
  on_shift: boolean;
  open_tickets: number;
  service_areas: string[];
  skills: { name: string; level: string }[];
  application_id: UUID | null;
}

export interface TemporaryPassword {
  technician: Technician;
  temporary_password: string;
}

export interface ImportRow {
  line: number;
  name: string;
  email: string;
  phone: string | null;
  team: string | null;
  action: "create" | "update" | "error";
  errors: string[];
}

export interface ImportResult {
  dry_run: boolean;
  rows: ImportRow[];
  created: number;
  updated: number;
  errors: number;
  credentials: { name: string; email: string; temporary_password: string }[];
}

// Formulários (checklists) da OS
export type FormFieldType =
  | "section"
  | "text"
  | "textarea"
  | "number"
  | "yes_no"
  | "choice"
  | "multi_choice"
  | "date"
  | "confirm"
  | "photo";

export interface FormField {
  id: string;
  type: FormFieldType;
  label: string;
  help: string | null;
  required: boolean;
  options: string[];
  min_photos: number;
  max_photos: number;
}

export interface FormTemplate {
  id: UUID;
  name: string;
  description: string | null;
  fields: FormField[];
  service_type_ids: UUID[];
  requires_signature: boolean;
  is_active: boolean;
  version: number;
  created_at: ISODate;
  updated_at: ISODate;
  /** Só ao salvar com `apply_to_pending=true`: quantas OS (formulário ainda não começado) receberam a versão nova. */
  applied_to?: number | null;
}

export type FormStatus = "pending" | "in_progress" | "completed";
export type FormAnswer = string | number | boolean | string[];

export interface TicketForm {
  id: UUID;
  ticket_id: UUID;
  template_id: UUID | null;
  /** Versão do modelo que esta OS usa (o modelo pode ter sido corrigido depois de anexar). */
  template_version?: number;
  name: string;
  fields: FormField[];
  required: boolean;
  status: FormStatus;
  answers: Record<string, FormAnswer>;
  completed_at: ISODate | null;
  completed_by: Ref | null;
  created_at: ISODate;
  updated_at: ISODate;
}

// Custos extras da OS (reembolso ao técnico)
export type ExpenseKind = "material" | "km" | "toll" | "parking" | "transport" | "meal" | "other";
export type ExpenseStatus = "pending" | "approved" | "paid" | "rejected";

export interface Expense {
  id: UUID;
  ticket_id: UUID;
  kind: ExpenseKind;
  description: string;
  quantity: number;
  unit_value: number;
  total: number;
  technician: Ref | null;
  status: ExpenseStatus;
  paid_at: ISODate | null;
  receipt_attachment_id: UUID | null;
  notes: string | null;
  created_by: Ref | null;
  created_at: ISODate;
  updated_at: ISODate;
}

export interface ExpenseReport {
  items: (Expense & { ticket: { id: UUID; code: string; title: string; customer: Ref | null } })[];
  total: number;
  by_technician: { technician: Ref | null; count: number; total: number; to_pay: number }[];
  by_kind: Record<string, number>;
}

export interface UnproductiveReason {
  id: UUID;
  name: string;
  description: string | null;
  responsibility: Responsibility;
  is_active: boolean;
}

// Orçamentos (enviados ao cliente por link para aprovar)
export type QuoteStatus = "draft" | "sent" | "approved" | "rejected" | "expired" | "cancelled";

/** Produto (material), serviço (mão de obra) ou despesa (deslocamento, pedágio...). */
export type QuoteItemKind = "product" | "service" | "expense";

export interface QuoteItem {
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  total: number;
  catalog_item_id: UUID | null;
  kind?: QuoteItemKind;
}

/** Link do orçamento para o cliente (fica disponível para copiar e reenviar). */
export interface QuoteLink {
  token: string;
  path: string;
  url: string;
}

export interface CompanyProfile {
  name: string;
  document: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  website: string | null;
}

export interface Quote {
  id: UUID;
  number: number;
  code: string;
  ticket_id: UUID;
  status: QuoteStatus;
  title: string;
  items: QuoteItem[];
  subtotal: number;
  discount: number;
  total: number;
  valid_until: string | null;
  notes: string | null;
  sent_at: ISODate | null;
  decided_at: ISODate | null;
  approver_name: string | null;
  approver_document: string | null;
  approver_role: string | null;
  rejection_reason: string | null;
  created_by: Ref | null;
  created_at: ISODate;
  updated_at: ISODate;
  signature_url: string | null;
  token?: string;
  approver_registration?: string | null;
  client_comment?: string | null;
  link?: QuoteLink | null;
  totals_by_kind?: Record<QuoteItemKind, number>;
}

export interface QuoteListRow extends Quote {
  ticket_code: string;
  customer: string | null;
  /** Local (loja) da OS do orçamento. */
  location?: string | null;
}

export interface QuoteStatusTotal {
  count: number;
  total: number;
}

/** GET /quotes/summary: quantidade e valor por situação, somados no banco (não dependem do limite da lista). */
export interface QuoteSummary {
  by_status: Record<QuoteStatus, QuoteStatusTotal>;
}

export interface QuoteCatalogItem {
  id: UUID;
  name: string;
  unit: string;
  price: number;
  description: string | null;
  is_active: boolean;
  kind?: QuoteItemKind;
}

export interface PublicQuote {
  code: string;
  title: string;
  status: QuoteStatus;
  customer: string | null;
  location: string | null;
  ticket_code: string;
  ticket_title: string;
  items: QuoteItem[];
  subtotal: number;
  discount: number;
  total: number;
  valid_until: string | null;
  notes: string | null;
  sent_at: ISODate | null;
  decided_at: ISODate | null;
  approver_name: string | null;
  rejection_reason: string | null;
  ticket_number?: number;
  company?: CompanyProfile;
  customer_info?: { name: string; document: string | null; email: string | null; phone: string | null } | null;
  address?: {
    line: string | null;
    district: string | null;
    city: string | null;
    state: string | null;
    zip_code: string | null;
    full: string;
  } | null;
  issued_at?: ISODate;
  totals_by_kind?: Record<QuoteItemKind, number>;
  approver_registration?: string | null;
  client_comment?: string | null;
  signature_url?: string | null;
}

// Projetos
export type ProjectStatus = "planning" | "active" | "paused" | "done" | "cancelled";

export interface ProjectRef {
  id: UUID;
  number: number;
  name: string;
  code: string;
}

export interface Project {
  id: UUID;
  number: number;
  code: string;
  name: string;
  customer: Ref | null;
  description: string | null;
  status: ProjectStatus;
  start_date: string | null;
  end_date: string | null;
  contract_value: number | null;
  pricing_notes: string | null;
  manager: Ref | null;
  team: Ref | null;
  members: Ref[];
  margin: number | null;
  stats: {
    tickets_total: number;
    tickets_open: number;
    tickets_done: number;
    /** Canceladas: contam no total, não no progresso. */
    tickets_cancelled?: number;
    unproductive: number;
    expenses_total: number;
    /** Valores dos técnicos nas OS do projeto (entram na margem). */
    payouts_total?: number;
    quotes_approved_total: number;
    progress: number;
  };
  created_at: ISODate;
}

// Assistência externa
export type RepairStatus =
  | "withdrawn"
  | "received"
  | "sent_to_vendor"
  | "vendor_quote"
  | "in_repair"
  | "ready_at_vendor"
  | "back_in_stock"
  | "delivered"
  | "unrepairable"
  | "cancelled";

export interface Repair {
  id: UUID;
  number: number;
  code: string;
  status: RepairStatus;
  status_changed_at: ISODate;
  customer: Ref | null;
  location: Ref | null;
  ticket: Ref | null;
  equipment_type: string;
  brand: string | null;
  model: string | null;
  serial_number: string | null;
  asset_tag: string | null;
  problem: string;
  accessories: string | null;
  vendor_name: string | null;
  vendor_contact: string | null;
  vendor_protocol: string | null;
  vendor_quote_value: number | null;
  expected_return_date: string | null;
  notes: string | null;
  created_at: ISODate;
  events: { id: UUID; from_status: RepairStatus | null; to_status: RepairStatus; note: string | null; actor: Ref | null; created_at: ISODate }[];
  photos: { id: UUID; caption: string | null; created_at: ISODate; url: string }[];
  allowed_next: RepairStatus[];
  /** Para onde "Voltar etapa" leva (etapa clicada por engano; pede motivo). Só no detalhe. */
  previous_status?: RepairStatus | null;
  days_open: number;
  days_in_status: number;
  overdue: boolean;
}

export interface TechnicianSuggestion {
  id: UUID;
  name: string;
  phone: string | null;
  home_city: string | null;
  home_state: string | null;
  team: Ref | null;
  open_tickets: number;
  on_shift: boolean;
  distance_km: number | null;
  /** Visitas a esta mesma loja. */
  visits_at_location?: number;
  last_visit_at_location?: ISODate | null;
  /** Com horário informado: ocupado nele e quantas OS já tem no dia. */
  busy?: boolean | null;
  day_load?: number | null;
  score: number;
  reasons: string[];
}

// ---- Fila do analista ----

export type QueueSection = "attention" | "in_field" | "today" | "waiting" | "upcoming" | "unscheduled" | "done";

export interface QueueReason {
  code: "sla_violated" | "sla_at_risk" | "no_technician" | "late_start" | "unproductive" | "violation_pending" | string;
  label: string;
  tone: "danger" | "warning" | "info";
}

export interface QueueItem extends TicketListItem {
  section: QueueSection;
  reasons: QueueReason[];
}

export interface QueueCounts {
  open: number;
  attention: number;
  in_field: number;
  today: number;
  waiting: number;
  upcoming: number;
  unscheduled: number;
  done: number;
}

export interface MyQueue {
  user: UserRef;
  date: string;
  generated_at: ISODate;
  counts: QueueCounts;
  items: QueueItem[];
  /** Quantas OS a fila tem; acima do limite da lista, `truncated` avisa que ficaram de fora as menos urgentes. */
  total?: number;
  truncated?: boolean;
}

export interface QueueSummary {
  user: UserRef;
  role: UserRole;
  open: number;
  attention: number;
  today: number;
  in_field: number;
}

export interface QueuesOut {
  queues: QueueSummary[];
  unowned: { open: number; attention: number; today: number; in_field: number };
}

// ---- Relatório da OS para o cliente ----

export interface ReportLink {
  token: string;
  path: string;
  url: string;
  created_at: ISODate;
  views: number;
  last_viewed_at: ISODate | null;
}

export interface PublicReportPhoto {
  url: string;
  filename: string;
  taken_at?: ISODate | null;
  caption?: string | null;
}

export interface PublicReport {
  code: string;
  title: string;
  description: string;
  status: TicketStatus;
  status_label: string;
  company_name: string;
  company?: CompanyProfile;
  number?: number;
  customer: { name: string; document: string | null; email?: string | null; phone?: string | null } | null;
  location: {
    name: string;
    code: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    zip_code?: string | null;
    contact_name?: string | null;
    contact_phone?: string | null;
  } | null;
  service_address: string | null;
  requester_name: string | null;
  service_type: string | null;
  technician: { name: string } | null;
  /** Outros técnicos que foram à visita. */
  helpers?: { name: string }[];
  opened_at: ISODate;
  scheduled_start: ISODate | null;
  scheduled_end: ISODate | null;
  en_route_at: ISODate | null;
  arrived_at: ISODate | null;
  finished_at: ISODate | null;
  closed_at: ISODate | null;
  on_site_minutes: number | null;
  check_in_gps: boolean;
  /** Prazo de chegada: quanto o técnico levou desde o início do relógio e se foi no prazo. */
  arrival_due_at?: ISODate | null;
  arrival_minutes?: number | null;
  arrival_on_time?: boolean | null;
  resolution_notes: string | null;
  forms: {
    name: string;
    completed_at: ISODate | null;
    items: { label: string; type: string; value: string | null; photos: PublicReportPhoto[] }[];
  }[];
  photos: PublicReportPhoto[];
  signature: { name: string; role: string | null; signed_at: ISODate; image_url: string } | null;
  timeline: { at: ISODate; label: string }[];
  generated_at: ISODate;
}

// ---- Regras de campo e pedidos de peça ----

export type ArrivalStatus = "met" | "late" | "at_risk" | "pending";
export type OnsiteStatus = "ok" | "warning" | "over";

export interface FieldRules {
  arrival_hours_capital: number | null;
  arrival_hours_interior: number | null;
  onsite_hours: number;
  onsite_warning_minutes: number;
}

export type PartRequestStatus = "open" | "quoted" | "approved" | "rejected" | "cancelled";

export interface PartRequest {
  id: UUID;
  description: string;
  quantity: number;
  unit: string;
  note: string | null;
  status: PartRequestStatus;
  quote_id: UUID | null;
  quote_code: string | null;
  requested_by: Ref | null;
  attachments: { id: UUID; url: string }[];
  response_note: string | null;
  created_at: ISODate;
}

// ---- Migração do Field Control ----

export interface Tag {
  name: string;
  color: string | null;
}

export interface LegacyOrder {
  source: "fieldcontrol" | string;
  identifier: string | null;
  fc_status?: string | null;
  values?: { products: number; services: number; expenses: number; total: number } | null;
  items?: { type: string; name: string; quantity: number; value: number; total: number }[];
  request?: {
    subject: string | null;
    message: string | null;
    contact_email: string | null;
    contact_phone: string | null;
    created_at: ISODate | null;
  } | null;
  files?: { url: string; title: string | null; type: string | null }[];
  deadline?: { response_status: string | null; solution_status: string | null } | null;
  migration_note?: string | null;
}

// ---- Região dos técnicos e busca por proximidade ----

export interface TechnicianRegion {
  state: string;
  total: number;
  cities: { city: string; total: number }[];
}

export interface NearbyTechnician {
  id: UUID;
  name: string;
  email: string;
  phone: string | null;
  is_active: boolean;
  avatar_url: string | null;
  base_city: string | null;
  base_state: string | null;
  base_source: "history" | "home" | null;
  distance_km: number;
  nearest_kind: "store_history" | "home" | "live";
  visits_at_location: number;
  last_visit_at_location: ISODate | null;
  visits_in_city: number;
  total_visits: number;
  last_visit_at: ISODate | null;
  open_tickets: number;
  on_shift: boolean;
  reasons: string[];
}

export interface NearbyResult {
  point: { latitude: number; longitude: number; label: string };
  technicians: NearbyTechnician[];
}

// ---- Fichas completas (técnico, cliente e loja) ----

export interface ContactEntry {
  kind: "email" | "phone";
  value: string;
  name: string | null;
  /** work | personal | mobile | home */
  label: string | null;
  primary: boolean;
}

export interface WorkSchedule {
  start: string | null;
  end: string | null;
  break_start: string | null;
  break_end: string | null;
}

/** Origem do cadastro (Field Control): id, datas e dados que não têm campo próprio. */
export interface RecordLegacy {
  source: string;
  id: string | number | null;
  created_at?: ISODate | null;
  territories?: string[];
}

export interface CustomerLegacy extends RecordLegacy {
  rating?: { average: number; last_star: number; last_comment: string | null } | null;
  service?: { first_at: ISODate | null; last_at: ISODate | null; total: number } | null;
  attachments?: { url: string; title: string | null; type: string | null }[];
}

// --------------------------------------------------------------------------- valor por chamado

/** Os técnicos são parceiros e recebem por OS: a pagar ou pago. */
export type PayoutStatus = "pending" | "paid";

export interface Payout {
  id: UUID;
  ticket_id: UUID;
  technician: Ref;
  amount: number;
  status: PayoutStatus;
  note: string | null;
  paid_at: ISODate | null;
  created_at: ISODate;
}

export interface MyPayout {
  amount: number;
  status: PayoutStatus;
  paid_at: ISODate | null;
}

export interface PayoutLine {
  id: UUID;
  technician: Ref;
  amount: number;
  status: PayoutStatus;
  note: string | null;
  paid_at: ISODate | null;
  /** OS concluída entra no "a pagar"; aberta ainda é previsão. */
  concluded: boolean;
  /** OS cancelada: o valor pendente não é previsão (só sai se a central decidir pagar). */
  cancelled?: boolean;
  ticket: {
    id: UUID;
    code: string;
    title: string;
    status: TicketStatus;
    customer: string | null;
    location: string | null;
    city: string | null;
    resolved_at: ISODate | null;
  };
}

export interface PayoutSummary {
  to_pay: number;
  expected: number;
  paid: number;
  /** Pendente de OS cancelada (fora do "a pagar" e do "previsto"). */
  cancelled?: number;
}

export interface PayoutList {
  items: PayoutLine[];
  summary: PayoutSummary;
  /** Quantos valores batem com o filtro (a lista vem até o limite; o resumo soma todos). */
  total_count?: number;
}

export interface MyEarnings extends PayoutList {
  reimbursement_to_receive: number;
  reimbursement_paid: number;
}

// --------------------------------------------------------------------------- portal do cliente

export interface PortalLocation {
  id: UUID;
  code: string | null;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
}

export interface PortalMe {
  customer: Ref;
  locations: number;
  /** Falso com a empresa desativada (sem contrato): o histórico continua visível, abrir solicitação não. */
  can_open_requests?: boolean;
}

export interface PortalRequestItem {
  id: UUID;
  code: string;
  title: string;
  status: TicketStatus;
  location: PortalLocation | null;
  requester_name: string | null;
  created_at: ISODate;
  updated_at: ISODate;
  scheduled_start: ISODate | null;
  scheduled_end: ISODate | null;
  technician: string | null;
  arrived_at: ISODate | null;
  resolved_at: ISODate | null;
  cancelled_at: ISODate | null;
}

/** Arquivo que a empresa do cliente mandou na solicitação (só nome e data). */
export interface PortalAttachment {
  id: UUID;
  filename: string;
  created_at: ISODate;
}

export interface PortalRequestDetail extends PortalRequestItem {
  description: string;
  client_reference: string | null;
  contact: string | null;
  resolution_notes: string | null;
  report_url: string | null;
  can_cancel: boolean;
  timeline: { status: TicketStatus | "created"; at: ISODate }[];
  /** Fotos do problema ou PDF que o cliente mandou (POST /portal/requests/{id}/attachments). */
  attachments?: PortalAttachment[];
  /** Ainda aceita arquivo (solicitação em aberto e abaixo do limite). */
  can_attach?: boolean;
}

// --------------------------------------------------------------------------- relatórios (fechamento do dia e do mês)

/** Item dos rankings dos relatórios (cliente, técnico ou motivo de improdutiva; o motivo vem sem id). */
export interface ReportCountRef {
  id: UUID | null;
  name: string;
  count: number;
}

/** Números de um período (dia ou mês), contados pela trilha de eventos das OS. */
export interface DayNumbers {
  opened: number;
  resolved: number;
  cancelled: number;
  /** Visitas improdutivas registradas no período. */
  unproductive: number;
  /** Agendadas e em aberto no fim do período (o estado de cada OS naquele instante). */
  scheduled_end: number;
  backlog_end: number;
  /** Resolvidas no período dentro do prazo (só as OS com prazo de solução). */
  resolved_in_sla: number;
  /** Chegadas do técnico no período e quantas dentro do prazo (4h nas capitais). */
  arrivals: number;
  arrivals_on_time: number;
  /** Percentual sobre as chegadas que tinham prazo. */
  arrival_on_time_pct: number | null;
  avg_arrival_minutes: number | null;
  /** Tempo em atendimento das OS resolvidas no período (soma das visitas de cada OS). */
  avg_onsite_minutes: number | null;
}

/** Fechamento do dia (o dia fecha à meia-noite, no fuso da operação). */
export interface DailyReport {
  date: string;
  /** Dia já fechado (passou da meia-noite) ou parcial (hoje). */
  closed: boolean;
  numbers: DayNumbers;
  /** Período anterior inteiro, para comparar. */
  previous: DayNumbers;
  top_customer: ReportCountRef | null;
  customers: ReportCountRef[];
  technicians: ReportCountRef[];
  unproductive_reasons: ReportCountRef[];
}

export interface ReportDayPoint {
  date: string;
  opened: number;
  resolved: number;
  cancelled: number;
  unproductive: number;
}

/** Relatório do mês (AAAA-MM): os números do mês, o mês anterior e um ponto por dia (até hoje). */
export interface MonthlyReport extends Omit<DailyReport, "date"> {
  month: string;
  days: ReportDayPoint[];
  expenses_total: number;
  quotes_approved_total: number;
}
