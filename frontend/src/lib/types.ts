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
  | "quote_reminded"
  | "times_corrected"
  | "payout_set"
  | "payout_removed"
  // Oferta de OS com preço (levam o valor: só com Pagamentos).
  | "offer_sent"
  | "offer_accepted"
  | "offer_declined"
  | "offer_cancelled";
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
  /** Perfil de acesso (só supervisor e analista; null nos demais papéis). */
  access_profile_id?: UUID | null;
  access_profile?: Ref | null;
  /** Ajustes deste usuário sobre o perfil. */
  access_overrides?: AccessOverrides | null;
  /**
   * Acesso efetivo calculado pela API (perfil + ajustes). null: técnico e cliente, que ficam fora dos
   * perfis. undefined: sessão aberta antes dos perfis existirem (a central relê o /auth/me).
   */
  access?: EffectiveAccess | null;
}

// ---- Perfis de acesso (por tela) e visibilidade das filas ----

/** Nível de acesso a uma tela: sem acesso, só ver, ou ver e alterar (criar, alterar e excluir). */
export type AccessLevel = "none" | "view" | "edit";

/** Filas que a pessoa vê: só a dela (mais as OS que executa) ou todas as da equipe. */
export type QueueScope = "own" | "all";

/** Os módulos do menu (o núcleo, com Início, Minha fila, Solicitações e Chamados, fica fora). */
export type AccessModuleKey = "operation" | "commercial" | "base" | "analysis" | "setup";

/** As telas com nível de acesso próprio (espelha backend/app/core/permissions.py). */
export type AccessItemKey =
  | "operation.calendar"
  | "operation.day"
  | "operation.map"
  | "operation.repairs"
  | "commercial.quotes"
  | "commercial.projects"
  | "commercial.expenses"
  | "commercial.payouts"
  | "base.customers"
  | "base.locations"
  | "base.technicians"
  | "base.onboarding"
  | "analysis.dashboard"
  | "analysis.reports"
  | "setup.forms"
  | "setup.messages"
  | "setup.service_types"
  | "setup.users"
  | "setup.settings";

/** Acesso efetivo de quem está na central (perfil + ajustes; o administrador é sempre total). */
export interface EffectiveAccess {
  full: boolean;
  profile: Ref | null;
  /** Algum ajuste por usuário muda o que o perfil daria. */
  customized: boolean;
  /** Todas as telas, com o nível de cada uma. */
  items: Record<AccessItemKey, AccessLevel>;
  /** unowned: vê também as OS sem analista (com scope "all" é sempre true). */
  queues: { scope: QueueScope; unowned: boolean };
}

/** Ajustes de um usuário sobre o perfil: o que falta (ou vem null) segue o perfil. */
export interface AccessOverrides {
  items?: Partial<Record<AccessItemKey, AccessLevel>>;
  queue_scope?: QueueScope | null;
  queue_unowned?: boolean | null;
}

export interface AccessProfile {
  id: UUID;
  name: string;
  description: string | null;
  /** Perfil padrão de um papel (nome fixo, não é excluído); null = criado na tela. */
  system_key: "supervisor" | "analyst" | null;
  /** Só os níveis gravados no perfil; o que falta segue o padrão. */
  items: Partial<Record<AccessItemKey, AccessLevel>>;
  /** O nível de cada tela, completo (gravado ou padrão). */
  effective_items: Record<AccessItemKey, AccessLevel>;
  queue_scope: QueueScope;
  queue_unowned: boolean;
  /** Usuários no perfil, ativos e inativos. */
  users_count: number;
  updated_at: ISODate;
}

/** POST /access/profiles: começa igual a `copy_from_id` (sem ele, igual ao Analista). */
export interface AccessProfileCreate {
  name: string;
  description?: string | null;
  copy_from_id?: UUID | null;
  items?: Partial<Record<AccessItemKey, AccessLevel>> | null;
  queue_scope?: QueueScope | null;
  queue_unowned?: boolean | null;
}

/** PATCH /access/profiles/{id}: só o que mudou; em `items`, null devolve a tela ao padrão. */
export interface AccessProfileUpdate {
  name?: string;
  description?: string | null;
  items?: Partial<Record<AccessItemKey, AccessLevel | null>>;
  queue_scope?: QueueScope;
  queue_unowned?: boolean;
}

export interface AccessCatalogItem {
  key: AccessItemKey;
  label: string;
  /** A tela do menu que o item protege. */
  href: string;
  /** Níveis que a tela aceita (as só de leitura não têm "edit"). */
  levels: AccessLevel[];
  /** O que o nível inclui, quando não é óbvio. */
  hint?: string | null;
}

export interface AccessCatalogModule {
  key: AccessModuleKey;
  label: string;
  items: AccessCatalogItem[];
}

/** GET /access/catalog: as telas na ordem do menu e o acesso padrão de cada papel. */
export interface AccessCatalog {
  modules: AccessCatalogModule[];
  defaults: Record<"supervisor" | "analyst", Record<AccessItemKey, AccessLevel>>;
}

/** Acesso no cadastro do usuário (POST e PATCH /users). profile_id null = perfil padrão do papel. */
export interface UserAccessIn {
  profile_id: UUID | null;
  overrides: AccessOverrides | null;
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
  /**
   * Prazo de solução encerrado antes da conclusão: na OS migrada, a visita (mesmo improdutiva) com que o
   * Field Control deu o prazo como cumprido, no prazo ou fora dele. O relógio de solução para aí.
   */
  resolution_sla_met_at?: ISODate | null;
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
  /** Entrada na loja da visita em curso (só em atendimento): o tempo na loja conta daqui. */
  work_started_at?: ISODate | null;
  /** Outras OS na mesma loja nos últimos 30 dias. */
  recurrence_30d?: number;
  /** Etiquetas (ex.: "Avulso", "Faturamento Matriz"), vindas do Field Control. */
  tags?: Tag[];
  /** Tipo de OS (colunas opcionais da lista de chamados; a OS completa sempre traz). */
  service_type?: ServiceTypeRef | null;
  /** Escopo: o que deve ser feito no atendimento (coluna opcional da lista de chamados). */
  description?: string;
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
  /**
   * Ofertas da OS esperando o técnico responder (pendentes no prazo). Toda a gestão recebe o número; a lista com
   * os valores (GET /tickets/{id}/offers) é de Pagamentos. O técnico recebe 0; servidor antigo não manda.
   */
  open_offers?: number;
  /**
   * O prazo mais próximo entre essas ofertas (null se nenhuma tem prazo). Sem rotina de vencimento: reler a OS
   * nesse horário. O técnico recebe null; servidor antigo não manda.
   */
  next_offer_expires_at?: ISODate | null;
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
  /** Analista responsável pela OS (null: sem analista). */
  owner_id?: UUID | null;
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
  /** O ponto inteiro: sem eles, o mapa repetiria os dados do ponto anterior na posição nova. */
  accuracy_m?: number | null;
  speed_mps?: number | null;
  heading?: number | null;
  battery_pct?: number | null;
  is_mock?: boolean;
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
  /**
   * Formulários gravados junto com a OS, na ordem. Omitido ou null: entram os ligados ao tipo de OS e à categoria.
   * Uma lista, mesmo vazia, vale como está (até 20). Repetido, inexistente ou inativo: 422, sem gastar número.
   */
  forms?: { template_id: UUID; required: boolean }[] | null;
  /**
   * Só com `forms`: os ligados ao tipo de OS ou à categoria que o analista desmarcou (até 20). Ficam de fora e não entram
   * sozinhos depois; os ligados que não vieram em nenhuma das duas listas entram como automáticos. Omitido, com `forms`:
   * todos os ligados fora da lista ficam de fora (regra anterior).
   */
  forms_left_out?: UUID[];
}

export type TicketUpdatePayload = Partial<
  Omit<TicketCreatePayload, "source" | "requester_id" | "assignee_id" | "tags" | "forms" | "forms_left_out">
> & {
  expected_version?: number;
  /** Só a gestão, a qualquer momento (inclusive OS fechada). */
  resolution_notes?: string | null;
  tags?: Tag[] | null;
  /**
   * Nomes das etiquetas que o editor carregou: com eles, `tags` vale como diferença sobre as de agora
   * (não se perde o "Custo Extra" ou o lote que entrou nesse meio-tempo). Sem eles, `tags` substitui tudo.
   */
  tags_base?: string[] | null;
  signature_required?: boolean | null;
  /** Troca o técnico no mesmo salvamento da agenda (null tira); o conflito confere o final. */
  assignee_id?: UUID | null;
};

/** Contexto para abrir a OS: o cliente e a loja escolhidos. */
export interface IntakeContext {
  upcoming_days: number;
  /** OS abertas da loja em filas que quem consulta não vê (só com "Somente a própria fila"). */
  other_queues_open?: number;
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
  /** Só hoje: OS a caminho ou em atendimento há mais de 12 h (dado parado). Ficam fora da lista e dos números acima. */
  stuck_in_field?: number;
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
/** "technician": motivo de responsabilidade do técnico (a improdutiva com ele pesa no elo do técnico). */
export type Responsibility = "internal" | "customer" | "third_party" | "technician";

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
  /** Em atendimento numa OS de outra fila: `current_ticket` vem null. */
  current_ticket_hidden?: boolean;
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
  /** null quando a OS é de outra fila (`hidden`): só o horário aparece. */
  id: UUID | null;
  code: string | null;
  title: string;
  /** OS de outra fila: vem sem número, cliente e local ("OS de outra fila"). */
  hidden?: boolean;
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
  /** Tem chave PIX (ele cadastra no app, em Conta › Meu cadastro). A chave fica em Pagamentos (PayoutBoard.pix). */
  has_pix?: boolean;
  /** Quando a chave mudou ("Chave nova" por PIX_RECENT_DAYS); null sem chave. */
  pix_updated_at?: ISODate | null;
  /** Elo (o selo da lista): a conta guardada, de até 6 h atrás. Sem conta ainda: bronze, since null. */
  level?: LevelSummary;
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

/**
 * Resposta automática: a pergunta já vem preenchida com um dado da OS que o técnico já vê (ele corrige). Texto e
 * texto longo aceitam todas as fontes; data, só `visit_date`. Nada de nº do chamado do cliente, CNPJ ou contato.
 */
export type FormPrefill =
  | "location_name"
  | "location_code"
  | "customer"
  | "address"
  | "city"
  | "ticket_code"
  | "technician"
  | "service_type"
  | "visit_date";

export interface FormField {
  id: string;
  type: FormFieldType;
  label: string;
  help: string | null;
  required: boolean;
  options: string[];
  min_photos: number;
  max_photos: number;
  /**
   * Resposta automática (null: a pergunta é do técnico). Combinação que o tipo não aceita volta null. No PUT do modelo,
   * sem a chave a pergunta mantém a fonte gravada (mesmo id, se o tipo aceitar); mande null para limpar.
   */
  prefill?: FormPrefill | null;
}

export interface FormTemplate {
  id: UUID;
  name: string;
  description: string | null;
  fields: FormField[];
  /** Tipos de OS em que o formulário entra sozinho. */
  service_type_ids: UUID[];
  /** Categorias em que o formulário entra sozinho (valem também as subcategorias). No PUT, omitido mantém. */
  category_ids: UUID[];
  /** Entra na OS como obrigatório (padrão) ou opcional. No PUT, omitido mantém. */
  default_required: boolean;
  requires_signature: boolean;
  is_active: boolean;
  version: number;
  created_at: ISODate;
  updated_at: ISODate;
  /** Só ao salvar com `apply_to_pending=true`: quantas OS (formulário ainda não começado) receberam a versão nova. */
  applied_to?: number | null;
  /**
   * Também só com `apply_to_pending=true` (no POST e no PUT): em quantas OS que ainda não começaram o formulário
   * entrou pelo tipo de OS ou pela categoria, e de quantas saiu (entrou sozinho, não casa mais, sem resposta).
   */
  attached_to?: number | null;
  detached_from?: number | null;
}

/** Tipo de OS em que o modelo foi usado nos últimos 12 meses (OS não canceladas): `used` de `total` OS do tipo. */
export interface ServiceTypeUsage {
  id: UUID;
  name: string;
  customer: Ref | null;
  used: number;
  total: number;
}

/** GET /form-templates/{id}/usage: tipos com o modelo em pelo menos 3 OS e na metade delas (os 10 mais usados). */
export interface FormTemplateUsage {
  service_types: ServiceTypeUsage[];
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
  /** Entrou sozinho, pelo tipo de OS ou pela categoria (servidor antigo não manda). */
  auto_attached?: boolean;
  /**
   * Resposta automática das perguntas ainda sem resposta: {campo: valor}, ao vivo até a conclusão, que grava o valor
   * nas respostas (concluído, vem vazio). Vale como resposta do servidor: `{...prefill, ...answers}`. Data da visita:
   * em atendimento, o dia do trecho atual; antes da chegada, o da agenda; fora de atendimento depois de uma chegada, não
   * vem (a conclusão grava o dia da última ida).
   */
  prefill?: Record<string, FormAnswer>;
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

/** Por que o orçamento está na fila "Para cobrar" (mesma regra do Início). */
export type QuoteFollowUp = "not_opened" | "no_answer" | "expiring" | "in_review" | "expired";

/** Anexo do orçamento no Field Control (cotação, nota): link externo. */
export interface QuoteLegacyAttachment {
  url: string;
  title: string | null;
  type: string | null;
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
  /** Aberturas do link pelo cliente (a equipe e a prévia não contam). */
  client_views?: number;
  client_first_viewed_at?: ISODate | null;
  client_last_viewed_at?: ISODate | null;
  /** Cobranças registradas pelo "Cobrar". */
  reminder_count?: number;
  last_reminded_at?: ISODate | null;
  last_reminded_by?: Ref | null;
  follow_up?: QuoteFollowUp | null;
  /** Orçamento migrado do Field Control. */
  legacy_code?: string | null;
  legacy_description?: string | null;
  legacy_attachments?: QuoteLegacyAttachment[];
}

export interface QuoteListRow extends Quote {
  ticket_code: string;
  customer: string | null;
  /** Local (loja) da OS do orçamento. */
  location?: string | null;
  customer_id?: UUID | null;
  /** Situação da OS: cancelada, o orçamento não muda mais. */
  ticket_status?: TicketStatus | null;
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
  /** Orçamentos não cancelados dos últimos 12 meses com o item. */
  uses_12m?: number;
  last_used_at?: ISODate | null;
}

/** GET /quote-items/last-prices: último preço aprovado do cliente, por item do catálogo. */
export interface QuoteLastPrice {
  catalog_item_id: UUID;
  unit_price: number;
  quote_id: UUID;
  quote_code: string;
  decided_at: ISODate | null;
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
  /** Favorito na cidade da loja: pela regra ("auto") ou fixado pela central ("manual"). */
  favorite?: "auto" | "manual" | null;
  favorite_note?: string | null;
  /** Elo do técnico: só o selo (não muda a pontuação nem a ordem). */
  level?: LevelSummary;
}

// ---- Fila do analista ----

export type QueueSection = "attention" | "in_field" | "today" | "waiting" | "upcoming" | "unscheduled" | "done";

export interface QueueReason {
  code:
    | "sla_violated"
    | "sla_at_risk"
    | "no_technician"
    | "late_start"
    | "unproductive"
    | "violation_pending"
    | "inactive_technician"
    | "field_stuck"
    | string;
  label: string;
  tone: "danger" | "warning" | "info";
}

export interface QueueItem extends TicketListItem {
  section: QueueSection;
  reasons: QueueReason[];
}

/**
 * Números da Minha fila: só as OS de que a pessoa é a analista responsável, sem o limite da lista (a mesma
 * conta da linha dela em "Filas da equipe"). `today`: em aberto agendadas para o dia; `in_field`: em campo
 * há até 12 h; `done`: resolvidas no dia; waiting, upcoming e unscheduled: o tamanho dessas seções.
 */
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
  /** Em aberto em que a pessoa só executa (o responsável é outro ou ninguém): estão na lista, fora de `counts`. */
  executing_only?: number;
}

export interface QueueSummary {
  user: UserRef;
  role: UserRole;
  open: number;
  attention: number;
  today: number;
  in_field: number;
}

/** Contagens de uma fila da equipe (painel "Filas da equipe"). */
export interface TeamQueueCounts {
  open: number;
  attention: number;
  today: number;
  in_field: number;
}

export interface QueuesOut {
  /** Com scope "own", só a linha de quem consulta. */
  queues: QueueSummary[];
  /** Sem analista; null quando quem consulta não vê essas OS. */
  unowned: TeamQueueCounts | null;
  scope: QueueScope;
  /** Soma das linhas devolvidas mais a "Sem analista". */
  total: TeamQueueCounts;
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
  /** Sem acesso a Orçamentos, a API manda os preços (value, total e `values`) como null. */
  items?: { type: string; name: string; quantity: number; value: number | null; total: number | null }[];
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

// ---- Técnicos favoritos por cidade ----

export interface FavoriteTechnician {
  id: UUID;
  name: string;
  email: string;
  phone: string | null;
  avatar_url: string | null;
  is_active: boolean;
  on_shift: boolean;
  open_tickets: number;
  base_city: string | null;
  base_state: string | null;
  /** OS dele nas lojas da cidade nos últimos 12 meses. */
  visits: number;
  last_visit_at: ISODate | null;
  /** Posição no ranking da cidade (null sem OS na janela). */
  rank: number | null;
  automatic: boolean;
  pinned: boolean;
  hidden: boolean;
  note: string | null;
  set_by: Ref | null;
  set_at: ISODate | null;
}

export interface FavoriteCity {
  state: string;
  city: string;
  key: string;
  /** Lojas ativas na cidade. */
  stores: number;
  /** OS distintas atendidas nas lojas da cidade nos últimos 12 meses. */
  visits: number;
  favorites: FavoriteTechnician[];
  hidden_count: number;
  others_count: number;
}

export interface FavoriteCityDetail extends FavoriteCity {
  hidden: FavoriteTechnician[];
  others: FavoriteTechnician[];
}

export interface FavoritesOut {
  window_days: number;
  min_visits: number;
  top: number;
  max_pinned: number;
  cities: FavoriteCity[];
}

export interface FavoriteSet {
  state: string;
  city: string;
  favorite: boolean;
  note?: string | null;
  /** Só no Desfazer de um tirado: grava tirado mesmo fora do top 3. */
  hide?: boolean;
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
  /** Nota fiscal do técnico que cobre este valor (GET /payouts e /me/earnings); a recusada solta o valor (null). */
  invoice?: PayoutInvoiceRef | null;
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

/**
 * GET /payouts da central. Com `with_pix=true`, `pix` traz a chave de cada técnico das linhas (e do filtro
 * `technician_id`) que tem chave; sem ele, `{}`. Relatórios não pede.
 */
export interface PayoutBoard extends PayoutList {
  pix: Record<UUID, PixInfo>;
}

// --------------------------------------------------------------------------- meu cadastro do técnico

/** Tipo da chave PIX: só o técnico cadastra (app, com a senha); a central vê em Pagamentos e só remove. */
export type PixKeyType = "cpf" | "cnpj" | "email" | "phone" | "random";

/**
 * A chave PIX como está gravada (normalizada; formatPixKey para mostrar; copiar leva a chave crua): CPF com 11
 * dígitos, CNPJ com 14 caracteres em maiúsculas, e-mail em minúsculas, celular "+55" e 11 dígitos, chave aleatória
 * 8-4-4-4-12.
 */
export interface PixInfo {
  key_type: PixKeyType;
  key: string;
  /** Titular da conta: quem paga compara com o nome que o banco mostra. */
  holder_name: string | null;
  /** Quando a chave mudou ("Chave nova" por PIX_RECENT_DAYS). */
  updated_at: ISODate | null;
}

/** GET /me/profile (só o técnico). Endereço e PIX não vão no /auth/me. */
export interface MyProfile {
  id: UUID;
  name: string;
  email: string;
  phone: string | null;
  job_title: string | null;
  team: Ref | null;
  home_city: string | null;
  home_state: string | null;
  coverage_area: string | null;
  address_line: string | null;
  address_district: string | null;
  address_zip: string | null;
  /** Link assinado de 12 h (ou a foto do Field Control). */
  avatar_url: string | null;
  pix: PixInfo | null;
}

/**
 * PATCH /me/profile: mande só o que mudou. E-mail e chave PIX (cadastrar, trocar tipo, chave ou titular, remover)
 * pedem `current_password`. Recusas, nesta ordem (422): com a senha provisória, "Crie sua senha no app antes de mudar o
 * e-mail ou a chave PIX"; e-mail da empresa, "Use um e-mail que não seja da empresa"; sem a senha, "Confirme com a sua
 * senha atual para mudar o e-mail ou a chave PIX"; errada, "Senha atual incorreta"; só então "E-mail já cadastrado".
 * 429 com Retry-After: 5 senhas erradas em 15 min (somando as da troca de senha) ou mais de 10 pedidos de troca de
 * e-mail na hora.
 */
export interface MyProfileUpdate {
  /** Só letras (com acento), espaço, apóstrofo, hífen e ponto; sem link (422 "Use só letras no nome"). */
  name?: string;
  /** 10 a 13 dígitos (aceita +55); volta "(11) 98888-7777". */
  phone?: string;
  /** Só quando mudou (há logins de teste sem "@"). */
  email?: string;
  home_city?: string;
  /** UF em maiúsculas. */
  home_state?: string;
  coverage_area?: string | null;
  address_line?: string | null;
  address_district?: string | null;
  /** 8 dígitos; volta "00000-000". Vazio ou null tira o CEP. */
  address_zip?: string | null;
  /** null tira a chave. */
  pix?: PixIn | null;
  current_password?: string;
}

export interface PixIn {
  key_type: PixKeyType;
  /** Como a pessoa digitou: o servidor normaliza (e valida CPF, CNPJ, e-mail, celular com o 9 e chave aleatória). */
  key: string;
  /** 3 a 160 caracteres. */
  holder_name: string;
}

/** Campos do histórico do cadastro (USER_CHANGE_LABEL). */
export type UserChangeField =
  | "name"
  | "email"
  | "phone"
  | "job_title"
  | "team"
  | "is_active"
  | "role"
  | "home_city"
  | "home_state"
  | "coverage_area"
  | "address_line"
  | "address_district"
  | "address_zip"
  | "work_schedule"
  | "services"
  /** A chave mascarada ("CPF ***.456.789-**"); null sem chave. Para quem não tem Pagamentos, "***" (null continua null). */
  | "pix"
  /** Titular da conta da chave PIX. Não vem para quem não tem Pagamentos. */
  | "pix_holder"
  /** to "nova" na troca, null na remoção. */
  | "avatar"
  /**
   * to "provisória" (redefinição em Técnicos), "definida pela central" (Usuários), "criada no app" (o técnico trocou
   * a provisória) ou "trocada no app".
   */
  | "password";

/** Uma mudança, com o texto pronto para a tela (team: o nome do grupo; is_active: "Liberado" ou "Bloqueado"). */
export interface UserChangeItem {
  field: UserChangeField;
  from: string | null;
  to: string | null;
}

/** GET /technicians/{id}/changes: o histórico do cadastro, do mais novo para o mais antigo. */
export interface UserChange {
  id: UUID;
  created_at: ISODate;
  /** "app": o próprio técnico, no Meu cadastro; "central": Técnicos, Usuários ou Pagamentos. */
  via: "app" | "central";
  actor: Ref | null;
  changes: UserChangeItem[];
}

/**
 * `data` do evento de tempo real `profile.changed` (vai para quem tem Técnicos ou Pagamentos; `user_id` e `name` do
 * técnico, `actor_id`/`actor_name` de quem mudou). `fields` usa os nomes da API ("pix" inclui o titular).
 */
export interface ProfileChangedData {
  fields: UserChangeField[];
  via: "app" | "central";
  /**
   * Só na troca de e-mail ou de chave PIX pelo app até 72 h depois de a central redefinir a senha (Técnicos ou
   * Usuários): quem redefiniu ("Sistema" sem autor) e quando. Ausente nos outros casos.
   */
  after_reset?: { by: string; at: ISODate } | null;
}

// --------------------------------------------------------------------------- ofertas de OS

/**
 * Estado da oferta de OS. "expired" não é gravado: é a pendente com o prazo para responder vencido (o servidor
 * calcula). Sem contraproposta: o técnico aceita pelo valor ou recusa.
 */
export type OfferState = "pending" | "expired" | "accepted" | "declined" | "cancelled";

/**
 * Por que a oferta foi cancelada: a central cancelou, outro técnico aceitou, a central definiu o técnico na mão,
 * a OS foi cancelada/resolvida/fechada, ou trocada por uma oferta nova da mesma OS.
 */
export type OfferCancelReason = "central" | "taken" | "assigned" | "ticket_closed" | "replaced";

/** A oferta para a central (GET /tickets/{id}/offers): leva o valor, só com Pagamentos. */
export interface TicketOffer {
  id: UUID;
  ticket_id: UUID;
  technician: Ref;
  /** Valor do técnico se aceitar (número, como os outros valores da API). */
  amount: number;
  state: OfferState;
  /** Prazo para responder (null: até alguém aceitar ou a central cancelar). */
  expires_at: ISODate | null;
  /** Recado da central para o técnico. */
  note: string | null;
  decline_reason: string | null;
  cancel_reason: OfferCancelReason | null;
  /** O técnico abriu a oferta (só então ele pode aceitar). */
  viewed_at: ISODate | null;
  /** Aceite ou recusa do técnico. */
  responded_at: ISODate | null;
  created_by: Ref | null;
  created_at: ISODate;
}

/** POST /tickets/{id}/offers: a OS (sem técnico, em aberto) para 1 a 10 técnicos ativos. */
export interface OfferCreate {
  technician_ids: UUID[];
  /** R$, ≥ 0, 2 casas (número ou texto "90.00"). */
  amount: number | string;
  /** No futuro; sem fuso, vale a hora de Brasília. */
  expires_at?: ISODate | null;
  /** Até 500 caracteres. */
  note?: string | null;
}

/** POST /me/offers/{id}/decline (corpo opcional). */
export interface OfferDecline {
  /** Até 300 caracteres. */
  reason?: string | null;
}

/**
 * O recorte da OS na oferta (o técnico ainda não está nela): serviço, escopo, formulários, bairro e cidade, data e
 * valor. Nunca cliente, loja, endereço ou contato. Na oferta que já fechou: sem escopo, formulários e bairro.
 */
export interface FieldOfferTicket {
  id: UUID;
  code: string;
  title: string;
  /** Escopo (o que deve ser feito). */
  description: string | null;
  service_type: Ref | null;
  forms: { name: string; required: boolean }[];
  district: string | null;
  city: string | null;
  state: string | null;
  /** Janela da visita; sem agenda, null ("data a combinar"). */
  scheduled_start: ISODate | null;
  scheduled_end: ISODate | null;
}

/** A oferta no app do técnico (GET /me/offers e /me/offers/{id}). */
export interface FieldOffer {
  id: UUID;
  state: OfferState;
  amount: number;
  expires_at: ISODate | null;
  note: string | null;
  /** Na cancelada, por quê ("taken": outro técnico aceitou). */
  cancel_reason: OfferCancelReason | null;
  viewed_at: ISODate | null;
  responded_at: ISODate | null;
  created_at: ISODate;
  ticket: FieldOfferTicket;
}

/** `code` do 409/422 do aceite e da recusa ({detail, code}). */
export type OfferErrorCode =
  | "OFFER_TAKEN"
  | "OFFER_EXPIRED"
  | "OFFER_CANCELLED"
  | "OFFER_UNAVAILABLE"
  | "OFFER_ANSWERED"
  | "OFFER_NOT_VIEWED";

/** O que aconteceu com a oferta, no tempo real (ticket.updated da gestão e ticket.offer do técnico). */
export type OfferAction = "sent" | "viewed" | "accepted" | "declined" | "cancelled";

/**
 * `data` do ticket.updated da gestão com `fields: ["offers"]` (sem valor). `reason`: o `cancel_reason` no
 * "cancelled"; o motivo do técnico no "declined". `sender_id`: quem mandou a oferta, no "accepted" e no "declined"
 * (null nas outras ações; servidor antigo não manda).
 */
export interface OfferRealtimeData {
  fields: ["offers"];
  offer: {
    action: OfferAction;
    technician_name: string | null;
    reason: string | null;
    sender_id?: UUID | null;
  };
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

/** GET /portal/requests: a página e quantas aguardam o cliente (com os mesmos filtros, em todas as páginas). */
export interface PortalRequestPage extends Page<PortalRequestItem> {
  waiting: number;
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
  /** null sem a tela de Custos extras (o total nem é calculado). */
  expenses_total: number | null;
  /** null sem a tela de Orçamentos. */
  quotes_approved_total: number | null;
}

// --------------------------------------------------------------------------- notas fiscais dos técnicos

/** Nota fiscal do técnico (INVOICE_STATUS). A recusa é final: o técnico apaga a nota e envia outra. */
export type InvoiceStatus = "pending" | "checked" | "rejected";

/** O tipo do arquivo, pelo conteúdo (INVOICE_FILE_KIND): PDF, XML ou foto. */
export type InvoiceFileKind = "pdf" | "xml" | "image";

/** A nota que cobre um valor (PayoutLine.invoice e InvoicePayoutCandidate.invoice). */
export interface PayoutInvoiceRef {
  id: UUID;
  number: string;
  status: InvoiceStatus;
}

/** Uma OS da nota: o valor do técnico nela. */
export interface InvoicePayoutRef {
  payout_id: UUID;
  ticket_id: UUID;
  code: string;
  title: string;
  amount: number;
  status: PayoutStatus;
  /** OS resolvida ou fechada. */
  concluded: boolean;
}

/** A nota para o próprio técnico (GET /me/invoices; POST /me/invoices devolve 201, ou 200 quando a client_upload_id repete). */
export interface MyInvoice {
  id: UUID;
  number: string;
  /** AAAA-MM-DD. */
  issue_date: string;
  amount: number;
  /** AAAA-MM: o mês do serviço (competenceLabel). */
  competence: string;
  note: string | null;
  status: InvoiceStatus;
  reject_reason: string | null;
  reviewed_at: ISODate | null;
  filename: string;
  content_type: string;
  size_bytes: number;
  file_kind: InvoiceFileKind;
  /** Link assinado de 30 min, relativo à API (absoluteApiUrl). */
  download_url: string;
  payouts: InvoicePayoutRef[];
  payouts_total: number;
  created_at: ISODate;
}

/** A nota para a central (Pagamentos): com o técnico e quem conferiu ou recusou. */
export interface TechnicianInvoice extends MyInvoice {
  technician: Ref;
  reviewed_by: Ref | null;
}

/** Quantas notas e quanto em cada situação, só com os filtros de técnico e mês (os contadores das abas). */
export interface TechnicianInvoiceSummary {
  pending: number;
  checked: number;
  rejected: number;
  pending_amount: number;
  checked_amount: number;
}

/** GET /technician-invoices?technician_id=&status=&month=: as mais novas primeiro (até 500); total_count com todos os filtros. */
export interface TechnicianInvoiceList {
  items: TechnicianInvoice[];
  summary: TechnicianInvoiceSummary;
  total_count: number;
}

/**
 * GET /me/invoices/payouts?month=: os valores que podem entrar numa nota da competência. Os do mês (OS concluída ou valor
 * pago, com qualquer situação de nota) vêm primeiro; depois os de meses anteriores ainda a receber e sem nota
 * (`in_month` false).
 */
export interface InvoicePayoutCandidate {
  payout_id: UUID;
  ticket_id: UUID;
  code: string;
  title: string;
  amount: number;
  status: PayoutStatus;
  resolved_at: ISODate | null;
  in_month: boolean;
  /** Já está numa nota ("Na nota nº 1200"). */
  invoice: PayoutInvoiceRef | null;
}

// --------------------------------------------------------------------------- elo dos técnicos

/** Faixa do elo do técnico (LEVEL_TIER), da mais baixa à mais alta (LEVEL_TIER_ORDER). */
export type LevelTier = "bronze" | "silver" | "gold" | "diamond";

/** O que pesou no elo (LEVEL_OCCURRENCE): chegada fora do horário, retorno ou visita perdida. */
export type LevelOccurrenceKind = "late" | "rework" | "unproductive";

export type LevelCriterionKey = "services" | "measured" | "on_time" | "rework" | "lost";

/** O selo nas listas (Technician.level, TechnicianSuggestion.level). Sem conta ainda: bronze, since null. */
export interface LevelSummary {
  tier: LevelTier;
  since: ISODate | null;
  /** Abaixo do critério da faixa: desce se não voltar a cumprir em 30 dias. */
  at_risk: boolean;
}

/** Um critério da faixa, com os textos prontos do servidor (as telas não repetem os números). */
export interface LevelCriterion {
  key: LevelCriterionKey;
  label: string;
  met: boolean;
  /** Taxas: false com menos de 5 casos ("Ainda sem dados suficientes"; o critério conta como cumprido). */
  enough_data: boolean;
  /** Contagem (atendimentos) ou os casos da taxa (chegadas no horário, retornos, visitas perdidas). */
  value: number;
  /** Base da taxa (chegadas, atendimentos medidos, visitas); null nas contagens. */
  base: number | null;
  /** Mínimo da contagem, meta (%) da chegada no horário ou limite (%) das taxas. */
  target: number;
  /** "38 de 50", "92% (23 de 25) · meta 90% ou mais", "3% (1 em 40) · limite 5%". */
  text: string;
  /** O que falta ("Faltam 12 atendimentos"); null quando cumprido. */
  missing: string | null;
}

/** Abaixo do critério da faixa em vigor: desce para `falls_to` em `until` se não voltar a cumprir. */
export interface LevelRisk {
  since: ISODate;
  until: ISODate;
  falls_to: LevelTier;
  /** Rótulos dos critérios não cumpridos. */
  failing: string[];
  text: string;
}

export interface LevelNext {
  tier: LevelTier;
  criteria: LevelCriterion[];
}

/** Uma faixa e o que ela pede (taxas em %; null no Bronze), com o resumo pronto. */
export interface LevelTierRule {
  tier: LevelTier;
  services: number;
  measured: number;
  on_time_pct: number | null;
  rework_pct: number | null;
  lost_pct: number | null;
  summary: string;
}

/** Os números dos últimos 12 meses. As taxas ficam null com menos de 5 casos. */
export interface LevelMetrics {
  window_start: ISODate;
  window_end: ISODate;
  services: number;
  as_assignee: number;
  as_helper: number;
  measured: number;
  arrivals: number;
  on_time: number;
  late: number;
  reworks: number;
  lost: number;
  visits: number;
  on_time_pct: number | null;
  rework_pct: number | null;
  lost_pct: number | null;
}

export interface LevelTicketRef {
  id: UUID;
  /** "OS-000123". */
  code: string;
  title: string;
}

/** O que pesou. `ref_id`: a OS no atraso; o evento do histórico no retorno e na visita perdida. */
export interface LevelOccurrence {
  kind: LevelOccurrenceKind;
  ref_id: UUID;
  ticket: LevelTicketRef;
  at: ISODate;
  detail: string;
}

/**
 * A OS da ocorrência na central. `hidden`: OS de outra fila (quem pede vê só a própria fila): vem sem id e sem código,
 * com o título "OS de outra fila"; sem link e sem desconsiderar (o servidor responde 403 QUEUE_FORBIDDEN).
 */
export interface CentralLevelTicketRef {
  id: UUID | null;
  /** "OS-000123"; null na OS de outra fila. */
  code: string | null;
  title: string;
  hidden: boolean;
}

/**
 * A ocorrência desconsiderada pela central (só a central vê). `note` vem null na OS de outra fila (ficam quem
 * desconsiderou e quando).
 */
export interface LevelWaiver {
  id: UUID;
  note: string | null;
  created_by: Ref | null;
  created_at: ISODate;
}

/** Na central, também as desconsideradas. Na OS de outra fila, `detail` vem sem a nota da reabertura. */
export interface CentralLevelOccurrence extends Omit<LevelOccurrence, "ticket"> {
  ticket: CentralLevelTicketRef;
  waiver: LevelWaiver | null;
}

/** GET /me/level: o elo do próprio técnico, recalculado na hora. */
export interface MyLevel {
  tier: LevelTier;
  since: ISODate;
  at_risk: LevelRisk | null;
  computed_at: ISODate;
  metrics: LevelMetrics;
  /** Os critérios da faixa em vigor (vazio no Bronze). */
  criteria: LevelCriterion[];
  /** A próxima faixa (null no Diamante). */
  next: LevelNext | null;
  tiers: LevelTierRule[];
  /** "Como funciona". */
  rules: string[];
  /** As que contam, as mais recentes primeiro, até 30 (o total em occurrences_total). */
  occurrences: LevelOccurrence[];
  occurrences_total: number;
}

/** GET /technicians/{id}/level e a resposta de desconsiderar e de voltar a contar. */
export interface TechnicianLevelDetail extends Omit<MyLevel, "occurrences"> {
  technician: Ref;
  computed_tier: LevelTier;
  waived: number;
  /** Motivos de improdutiva ativos com responsabilidade "Técnico" (0: visitas perdidas não contam). */
  technician_reasons: number;
  /** Também as desconsideradas, as mais recentes primeiro, até 200 (o total em occurrences_total). */
  occurrences: CentralLevelOccurrence[];
}

/** POST /technicians/{id}/level/waivers. `note`: o motivo, de 1 a 300 caracteres. */
export interface LevelWaiverCreate {
  kind: LevelOccurrenceKind;
  ref_id: UUID;
  note: string;
}

/** POST /technicians/levels/refresh: quantos técnicos ficaram em cada faixa. */
export interface LevelRefreshResult {
  technicians: number;
  bronze: number;
  silver: number;
  gold: number;
  diamond: number;
  at_risk: number;
}
