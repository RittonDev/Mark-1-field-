// Rótulos e regras espelhados de backend/app/services/workflow.py.
// A fonte da verdade é o backend (GET /meta e allowed_transitions de cada OS);
// estes valores servem para renderizar sem esperar a rede.

import type {
  AssetType,
  Level,
  Responsibility,
  SlaStatus,
  TicketEventType,
  TicketPriority,
  TicketSource,
  TicketStatus,
  TicketType,
  UserRole,
  ViolationScope,
} from "./types";

export type StatusGroup = "open" | "active" | "pending" | "done" | "final";

export interface StatusInfo {
  label: string;
  group: StatusGroup;
  color: string;
  slaPaused: boolean;
  final: boolean;
  requiresAssignee: boolean;
  description: string;
}

export const STATUS: Record<TicketStatus, StatusInfo> = {
  new: { label: "Novo", group: "open", color: "#64748b", slaPaused: false, final: false, requiresAssignee: false, description: "Aberto, aguardando triagem" },
  triage: { label: "Em triagem", group: "open", color: "#8b5cf6", slaPaused: false, final: false, requiresAssignee: false, description: "Sendo classificado" },
  assigned: { label: "Atribuído", group: "active", color: "#3b82f6", slaPaused: false, final: false, requiresAssignee: true, description: "Responsável definido, ainda não iniciado" },
  scheduled: { label: "Agendado", group: "active", color: "#06b6d4", slaPaused: false, final: false, requiresAssignee: true, description: "Visita técnica agendada" },
  en_route: { label: "Em deslocamento", group: "active", color: "#0ea5e9", slaPaused: false, final: false, requiresAssignee: true, description: "Técnico a caminho do local" },
  in_progress: { label: "Em atendimento", group: "active", color: "#f59e0b", slaPaused: false, final: false, requiresAssignee: true, description: "Atendimento em execução" },
  on_hold_customer: { label: "Aguardando cliente", group: "pending", color: "#a855f7", slaPaused: true, final: false, requiresAssignee: false, description: "Pendente de retorno/ação do solicitante (SLA pausado)" },
  on_hold_vendor: { label: "Aguardando fornecedor/peça", group: "pending", color: "#d946ef", slaPaused: true, final: false, requiresAssignee: false, description: "Pendente de terceiro ou peça (SLA pausado)" },
  resolved: { label: "Resolvido", group: "done", color: "#10b981", slaPaused: false, final: false, requiresAssignee: false, description: "Solução aplicada, aguardando aceite" },
  closed: { label: "Fechado", group: "final", color: "#334155", slaPaused: false, final: true, requiresAssignee: false, description: "Encerrado" },
  cancelled: { label: "Cancelado", group: "final", color: "#ef4444", slaPaused: false, final: true, requiresAssignee: false, description: "Cancelado" },
  reopened: { label: "Reaberto", group: "open", color: "#f97316", slaPaused: false, final: false, requiresAssignee: false, description: "Solução recusada, voltou para a fila" },
};

export const STATUS_ORDER: TicketStatus[] = [
  "new",
  "triage",
  "reopened",
  "assigned",
  "scheduled",
  "en_route",
  "in_progress",
  "on_hold_customer",
  "on_hold_vendor",
  "resolved",
  "closed",
  "cancelled",
];

export const FINAL_STATUSES: TicketStatus[] = ["closed", "cancelled"];

export const TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  new: ["triage", "assigned", "on_hold_customer", "cancelled"],
  triage: ["assigned", "on_hold_customer", "cancelled"],
  assigned: ["scheduled", "en_route", "in_progress", "on_hold_customer", "on_hold_vendor", "cancelled"],
  scheduled: ["en_route", "in_progress", "assigned", "on_hold_customer", "cancelled"],
  en_route: ["in_progress", "scheduled", "on_hold_customer"],
  in_progress: ["on_hold_customer", "on_hold_vendor", "scheduled", "resolved"],
  on_hold_customer: ["assigned", "scheduled", "in_progress", "resolved", "cancelled"],
  on_hold_vendor: ["scheduled", "in_progress", "resolved", "cancelled"],
  resolved: ["closed", "reopened"],
  closed: [],
  cancelled: [],
  reopened: ["assigned", "scheduled", "en_route", "in_progress", "on_hold_customer", "on_hold_vendor", "resolved"],
};

export const UNTOUCHED_STATUSES: TicketStatus[] = ["new", "triage"];

/** Verbo do botão de ação para cada status de destino. */
export const TRANSITION_ACTION: Record<TicketStatus, string> = {
  new: "Voltar para novo",
  triage: "Iniciar triagem",
  assigned: "Marcar como atribuído",
  scheduled: "Agendar visita",
  en_route: "Iniciar deslocamento",
  in_progress: "Iniciar atendimento",
  on_hold_customer: "Aguardar cliente",
  on_hold_vendor: "Aguardar fornecedor/peça",
  resolved: "Resolver",
  closed: "Fechar",
  cancelled: "Cancelar OS",
  reopened: "Reabrir",
};

export const PRIORITY: Record<TicketPriority, { label: string; code: string; color: string; rank: number }> = {
  critical: { label: "Crítica", code: "P1", color: "#dc2626", rank: 1 },
  high: { label: "Alta", code: "P2", color: "#ea580c", rank: 2 },
  medium: { label: "Média", code: "P3", color: "#ca8a04", rank: 3 },
  low: { label: "Baixa", code: "P4", color: "#16a34a", rank: 4 },
};

export const PRIORITY_ORDER: TicketPriority[] = ["critical", "high", "medium", "low"];

export const LEVEL: Record<Level, string> = { high: "Alta", medium: "Média", low: "Baixa" };
export const LEVEL_ORDER: Level[] = ["high", "medium", "low"];

/** Matriz ITIL impacto x urgência (mesma de workflow.PRIORITY_MATRIX). */
export const PRIORITY_MATRIX: Record<Level, Record<Level, TicketPriority>> = {
  high: { high: "critical", medium: "high", low: "medium" },
  medium: { high: "high", medium: "medium", low: "low" },
  low: { high: "medium", medium: "low", low: "low" },
};

export function computePriority(impact: Level, urgency: Level): TicketPriority {
  return PRIORITY_MATRIX[impact][urgency];
}

export const TICKET_TYPE: Record<TicketType, string> = {
  incident: "Incidente (corretiva)",
  service_request: "Requisição de serviço",
  preventive: "Manutenção preventiva",
  installation: "Instalação / implantação",
};

export const TICKET_SOURCE: Record<TicketSource, string> = {
  web: "Portal web",
  mobile: "App mobile",
  email: "E-mail",
  phone: "Telefone",
  whatsapp: "WhatsApp",
  monitoring: "Monitoramento",
  portal: "Portal do cliente",
};

export const ASSET_TYPE: Record<AssetType, string> = {
  printer: "Impressora",
  desktop: "Computador",
  notebook: "Notebook",
  server: "Servidor",
  switch: "Switch",
  router: "Roteador",
  access_point: "Access point",
  firewall: "Firewall",
  camera: "Câmera (CFTV)",
  dvr_nvr: "DVR / NVR",
  phone: "Telefone",
  other: "Outro",
};

export const ROLE: Record<UserRole, string> = {
  admin: "Administrador",
  supervisor: "Supervisor",
  analyst: "Analista",
  technician: "Técnico de campo",
  requester: "Solicitante",
};

export const EVENT_TYPE: Record<TicketEventType, string> = {
  created: "abriu a OS",
  updated: "editou a OS",
  status_changed: "alterou o status",
  assigned: "alterou o responsável",
  owner_changed: "alterou o analista responsável",
  comment_added: "adicionou um acompanhamento",
  worklog_added: "registrou um apontamento",
  attachment_added: "anexou um arquivo",
  attachment_updated: "descreveu o anexo",
  attachment_removed: "excluiu o anexo",
  form_added: "anexou o formulário",
  form_completed: "concluiu o formulário",
  form_removed: "removeu o formulário",
  signature_collected: "colheu a assinatura de",
  expense_added: "lançou um custo extra",
  expense_updated: "alterou um custo extra",
  expense_removed: "removeu um custo extra",
  unproductive_visit: "registrou visita improdutiva:",
  quote_sent: "enviou o orçamento",
  quote_approved: "Cliente aprovou o orçamento",
  quote_rejected: "Cliente recusou o orçamento",
};

export const SLA_STATUS: Record<SlaStatus, { label: string; color: string }> = {
  ok: { label: "No prazo", color: "#16a34a" },
  at_risk: { label: "Em risco", color: "#d97706" },
  breached: { label: "Violado", color: "#dc2626" },
  paused: { label: "Pausado", color: "#7c3aed" },
  met: { label: "Cumprido", color: "#0d9488" },
};

export const ATTACHMENT_KIND: Record<string, string> = {
  file: "Arquivo",
  photo: "Foto",
  signature: "Assinatura",
};

/** Equipe interna: vê notas internas e apontamentos. */
export const isStaff = (role: UserRole | undefined) =>
  role === "admin" || role === "supervisor" || role === "analyst" || role === "technician";
/** Gestão completa das OS na web (espelha User.can_manage_tickets). */
export const canManageTickets = (role: UserRole | undefined) =>
  role === "admin" || role === "supervisor" || role === "analyst";
/** Configuração: grupos e categorias (SLA e usuários só admin). */
export const isManager = (role: UserRole | undefined) => role === "admin" || role === "supervisor";
/** Quem assume sozinho uma OS sem responsável ao iniciar o atendimento (SELF_ASSIGN_ROLES). */
export const SELF_ASSIGN_ROLES: UserRole[] = ["analyst"];

export const RESPONSIBILITY: Record<Responsibility, { label: string; color: string }> = {
  internal: { label: "Interna", color: "#dc2626" },
  customer: { label: "Cliente", color: "#2563eb" },
  third_party: { label: "Terceiro / fornecedor", color: "#d97706" },
};

export const VIOLATION_SCOPE: Record<ViolationScope, string> = {
  response: "1ª resposta",
  resolution: "Solução",
  both: "Resposta e solução",
};
