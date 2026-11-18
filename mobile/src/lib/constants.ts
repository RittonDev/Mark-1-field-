// Rótulos e regras espelhados de backend/app/services/workflow.py.
// A fonte da verdade é o backend (GET /meta e allowed_transitions de cada OS);
// estes valores servem para renderizar sem esperar a rede.

import type {
  AssetType,
  InvoiceFileKind,
  InvoiceStatus,
  Level,
  OfferCancelReason,
  OfferState,
  PixKeyType,
  Responsibility,
  SlaStatus,
  TicketEventType,
  TicketPriority,
  TicketSource,
  TicketStatus,
  TicketType,
  UserChangeField,
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
  reopened: { label: "Reaberto", group: "open", color: "#f97316", slaPaused: false, final: false, requiresAssignee: false, description: "Reaberta, voltou para a fila" },
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
  // Fechada ou cancelada: só a central reabre, com motivo.
  closed: ["reopened"],
  cancelled: ["reopened"],
  reopened: ["assigned", "scheduled", "en_route", "in_progress", "on_hold_customer", "on_hold_vendor", "resolved"],
};

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
  requester: "Cliente (portal)",
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
  attachment_updated: "editou a descrição do anexo",
  attachment_removed: "excluiu o anexo",
  helpers_changed: "alterou os técnicos da visita",
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
  quote_reminded: "cobrou o cliente pelo orçamento",
  times_corrected: "corrigiu os horários",
  payout_set: "definiu o valor do técnico",
  payout_removed: "tirou o valor do técnico",
  offer_sent: "ofertou a OS",
  offer_accepted: "aceitou a oferta",
  offer_declined: "recusou a oferta",
  offer_cancelled: "cancelou a oferta",
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

/** Pagamento do técnico pela OS (parceiro pago por chamado). */
export const PAYOUT_STATUS: Record<"pending" | "paid", { label: string; color: string }> = {
  pending: { label: "A pagar", color: "#DC6803" },
  paid: { label: "Pago", color: "#0E9384" },
};

/** Estado da oferta de OS ("expired": pendente com o prazo para responder vencido, calculado pelo servidor). */
export const OFFER_STATE: Record<OfferState, { label: string; color: string }> = {
  pending: { label: "Aguardando resposta", color: "#DC6803" },
  expired: { label: "Prazo encerrado", color: "#667085" },
  accepted: { label: "Aceita", color: "#0E9384" },
  declined: { label: "Recusada", color: "#D92D20" },
  cancelled: { label: "Cancelada", color: "#667085" },
};

/** Por que a oferta foi cancelada (a central e o app mostram assim). */
export const OFFER_CANCEL_REASON: Record<OfferCancelReason, string> = {
  central: "Cancelada pela central",
  taken: "Outro técnico aceitou",
  assigned: "A central definiu o técnico",
  ticket_closed: "OS encerrada",
  replaced: "Trocada por uma oferta nova",
};

/** Tipo da chave PIX (os rótulos de backend/app/core/pix.py). */
export const PIX_KEY_TYPE: Record<PixKeyType, string> = {
  cpf: "CPF",
  cnpj: "CNPJ",
  email: "E-mail",
  phone: "Celular",
  random: "Chave aleatória",
};

/** Os tipos na ordem dos chips do app. */
export const PIX_KEY_TYPES: PixKeyType[] = ["cpf", "cnpj", "email", "phone", "random"];

/** "Chave nova" em Pagamentos e no cadastro do técnico: a chave mudou há menos destes dias. */
export const PIX_RECENT_DAYS = 7;

/**
 * A chave gravada (normalizada) como a pessoa confere, igual a core/pix.display: CPF "123.456.789-09", CNPJ
 * "12.345.678/0001-95", celular "+55 (11) 98888-7777"; e-mail e chave aleatória como estão.
 */
export function formatPixKey(type: PixKeyType, key: string): string {
  if (type === "cpf" && key.length === 11) {
    return `${key.slice(0, 3)}.${key.slice(3, 6)}.${key.slice(6, 9)}-${key.slice(9)}`;
  }
  if (type === "cnpj" && key.length === 14) {
    return `${key.slice(0, 2)}.${key.slice(2, 5)}.${key.slice(5, 8)}/${key.slice(8, 12)}-${key.slice(12)}`;
  }
  if (type === "phone") {
    let digits = key.replace(/\D/g, "");
    if (digits.length === 13 && digits.startsWith("55")) digits = digits.slice(2);
    if (digits.length === 11) return `+55 (${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  }
  return key;
}

/** Rótulo de cada campo do histórico do cadastro (GET /technicians/{id}/changes). */
export const USER_CHANGE_LABEL: Record<UserChangeField, string> = {
  name: "Nome",
  email: "E-mail",
  phone: "Celular",
  job_title: "Cargo",
  team: "Grupo",
  is_active: "Acesso ao app",
  role: "Papel",
  home_city: "Cidade",
  home_state: "UF",
  coverage_area: "Região que atende",
  address_line: "Endereço",
  address_district: "Bairro",
  address_zip: "CEP",
  work_schedule: "Jornada",
  services: "Serviços que faz",
  pix: "Chave PIX",
  pix_holder: "Titular da conta",
  avatar: "Foto",
  password: "Senha",
};

// --------------------------------------------------------------------------- notas fiscais dos técnicos

/** Situação da nota fiscal do técnico. */
export const INVOICE_STATUS: Record<InvoiceStatus, { label: string; color: string }> = {
  pending: { label: "Aguardando conferência", color: "#DC6803" },
  checked: { label: "Conferida", color: "#0E9384" },
  rejected: { label: "Recusada", color: "#D92D20" },
};

/** Limites da nota (os mesmos de backend/app/services/invoices.py e do motivo da recusa). */
export const INVOICE_LIMITS = { maxMb: 10, numberMax: 30, noteMax: 500, rejectMax: 300, perMonth: 20 } as const;

/** O tipo do arquivo da nota, como a tela mostra. */
export const INVOICE_FILE_KIND: Record<InvoiceFileKind, string> = {
  pdf: "PDF",
  xml: "XML",
  image: "Foto",
};

const COMPETENCE_MONTHS = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

/** A competência da nota por extenso: "2026-11" → "novembro de 2026" (fora do formato, volta como veio). */
export function competenceLabel(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const name = match ? COMPETENCE_MONTHS[Number(match[2]) - 1] : undefined;
  return match && name ? `${name} de ${match[1]}` : month;
}
