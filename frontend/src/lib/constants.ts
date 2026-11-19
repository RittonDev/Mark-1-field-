// Rótulos e regras espelhados de backend/app/services/workflow.py.
// A fonte da verdade é o backend (GET /meta e allowed_transitions de cada OS);
// estes valores servem para renderizar sem esperar a rede.

import type {
  AssetType,
  AvailabilitySlot,
  DayPeriod,
  EarningsMonth,
  EarningsMonthState,
  EducationLevel,
  InvoiceFileKind,
  InvoiceStatus,
  Level,
  LevelMedalKind,
  LevelOccurrenceKind,
  LevelTier,
  OfferCancelReason,
  OfferState,
  PixKeyType,
  Responsibility,
  SkillLevel,
  SlaStatus,
  TechProfilePart,
  TicketEventType,
  TicketPriority,
  TicketSource,
  TicketStatus,
  TicketType,
  TransportInfo,
  TransportMode,
  UserChangeField,
  UserRole,
  ViolationScope,
  Weekday,
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
  technician: { label: "Técnico", color: "#be185d" },
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

/**
 * A chave só o bastante para reconhecer, igual a core/pix.mask com "•" no lugar de "*": CPF "•••.456.789-••", CNPJ
 * "12.345.678/••••-••", e-mail "t•••@exemplo.com", celular "+55 (11) •••••-7777", chave aleatória "…a1b2".
 */
export function maskPixKey(type: PixKeyType, key: string): string {
  if (type === "cpf" && key.length === 11) return `•••.${key.slice(3, 6)}.${key.slice(6, 9)}-••`;
  if (type === "cnpj" && key.length === 14) return `${key.slice(0, 2)}.${key.slice(2, 5)}.${key.slice(5, 8)}/••••-••`;
  if (type === "email" && key.includes("@")) return `${key.slice(0, 1)}•••@${key.slice(key.indexOf("@") + 1)}`;
  if (type === "phone") {
    let digits = key.replace(/\D/g, "");
    if (digits.length === 13 && digits.startsWith("55")) digits = digits.slice(2);
    if (digits.length === 11) return `+55 (${digits.slice(0, 2)}) •••••-${digits.slice(7)}`;
  }
  return `…${key.slice(-4)}`;
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
  tools: "Ferramental",
  availability: "Disponibilidade",
  transport: "Transporte",
  skills: "Aptidões",
  education: "Formação",
  avatar: "Foto",
  password: "Senha",
};

// --------------------------------------------------------------------------- perfil técnico (o técnico mantém no app; a central vê)

/** Os dias da grade, de segunda a domingo. */
export const WEEKDAY_ORDER: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** Segunda a sexta ("Copiar para os dias úteis"). */
export const WORKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri"];

export const WEEKDAY: Record<Weekday, { label: string; short: string }> = {
  mon: { label: "Segunda-feira", short: "seg" },
  tue: { label: "Terça-feira", short: "ter" },
  wed: { label: "Quarta-feira", short: "qua" },
  thu: { label: "Quinta-feira", short: "qui" },
  fri: { label: "Sexta-feira", short: "sex" },
  sat: { label: "Sábado", short: "sáb" },
  sun: { label: "Domingo", short: "dom" },
};

/**
 * Os turnos da disponibilidade, nesta ordem (a madrugada por último). `from`/`to`: horas locais (o fim não entra);
 * `spoken`: como o leitor de tela fala. Não é a jornada (o turno com GPS).
 */
export const DAY_PERIOD_ORDER: DayPeriod[] = ["morning", "afternoon", "evening", "night"];

export const DAY_PERIOD: Record<DayPeriod, { label: string; hours: string; spoken: string; from: number; to: number }> = {
  morning: { label: "Manhã", hours: "06h–12h", spoken: "das 6h ao meio-dia", from: 6, to: 12 },
  afternoon: { label: "Tarde", hours: "12h–18h", spoken: "do meio-dia às 18h", from: 12, to: 18 },
  evening: { label: "Noite", hours: "18h–24h", spoken: "das 18h à meia-noite", from: 18, to: 24 },
  night: { label: "Madrugada", hours: "00h–06h", spoken: "da meia-noite às 6h", from: 0, to: 6 },
};

/** Os 28 turnos da semana, na ordem da grade. */
export const ALL_SLOTS: AvailabilitySlot[] = WEEKDAY_ORDER.flatMap((day) =>
  DAY_PERIOD_ORDER.map((period): AvailabilitySlot => `${day}:${period}`),
);

/** Sem repetidos nem códigos desconhecidos, na ordem da grade. */
export function sortSlots(slots: readonly string[]): AvailabilitySlot[] {
  const wanted = new Set(slots);
  return ALL_SLOTS.filter((slot) => wanted.has(slot));
}

/** Os turnos marcados de um dia, na ordem. */
export function slotPeriods(slots: readonly string[], day: Weekday): DayPeriod[] {
  const wanted = new Set(slots);
  return DAY_PERIOD_ORDER.filter((period) => wanted.has(`${day}:${period}`));
}

/** "a", "a e b", "a, b e c". */
function joinWords(words: readonly string[]): string {
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} e ${words[words.length - 1]}` : (words[0] ?? "");
}

/** "manhã e tarde", "manhã, tarde, noite e madrugada" (na ordem; "" sem turno). */
export function periodsPhrase(periods: readonly DayPeriod[]): string {
  return joinWords(DAY_PERIOD_ORDER.filter((p) => periods.includes(p)).map((p) => DAY_PERIOD[p].label.toLowerCase()));
}

/** Os turnos de um dia no cartão: "Manhã · Tarde" ("" sem turno). */
export function dayPeriodsText(periods: readonly DayPeriod[]): string {
  return DAY_PERIOD_ORDER.filter((p) => periods.includes(p))
    .map((p) => DAY_PERIOD[p].label)
    .join(" · ");
}

/**
 * Turnos em texto curto, igual ao servidor (services/tech_profile.slots_text): "sáb · tarde", "sáb · tarde e noite",
 * "sex · noite; sáb · madrugada", "seg a sex · manhã e tarde; sáb · manhã", "sáb e dom · manhã". Dias seguidos com os
 * mesmos turnos se juntam. Vazio: "".
 */
export function slotsText(slots: readonly string[]): string {
  const days = WEEKDAY_ORDER.map((day) => ({ day, periods: slotPeriods(slots, day) }));
  const parts: string[] = [];
  let i = 0;
  while (i < days.length) {
    const periods = days[i].periods;
    if (!periods.length) {
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < days.length && days[j + 1].periods.join() === periods.join()) j += 1;
    const first = WEEKDAY[days[i].day].short;
    const last = WEEKDAY[days[j].day].short;
    const span = j === i ? first : j === i + 1 ? `${first} e ${last}` : `${first} a ${last}`;
    parts.push(`${span} · ${periodsPhrase(periods)}`);
    i = j + 1;
  }
  return parts.join("; ");
}

/**
 * Resumo da linha Disponibilidade (Configurações do app): "Seg a sex · manhã e tarde", "Sáb e dom · noite"; os 28:
 * "Todos os dias · todos os turnos"; dias com turnos diferentes: "6 dias · turnos variados"; nada: "Não informada".
 */
export function availabilitySummary(slots: readonly string[]): string {
  const list = sortSlots(slots);
  if (!list.length) return "Não informada";
  if (list.length === ALL_SLOTS.length) return "Todos os dias · todos os turnos";
  const text = slotsText(list);
  if (!text.includes(";")) return text.charAt(0).toUpperCase() + text.slice(1);
  const days = WEEKDAY_ORDER.filter((day) => slotPeriods(list, day).length > 0).length;
  return `${days} dias · turnos variados`;
}

export const TRANSPORT_MODE_ORDER: TransportMode[] = ["car", "motorcycle", "bicycle", "public_transport", "ride_app", "on_foot"];

export const TRANSPORT_MODE: Record<TransportMode, string> = {
  car: "Carro",
  motorcycle: "Moto",
  bicycle: "Bicicleta",
  public_transport: "Transporte público",
  ride_app: "Carro de aplicativo",
  on_foot: "A pé",
};

/** "Carro, Moto · com CNH", "Nenhum · sem CNH"; null sem a parte informada (o mesmo texto do histórico). */
export function transportText(transport: TransportInfo | null | undefined): string | null {
  if (!transport) return null;
  const modes = TRANSPORT_MODE_ORDER.filter((m) => transport.modes.includes(m)).map((m) => TRANSPORT_MODE[m]);
  return `${modes.length ? modes.join(", ") : "Nenhum"} · ${transport.driver_license ? "com CNH" : "sem CNH"}`;
}

export const SKILL_LEVEL_ORDER: SkillLevel[] = ["basico", "intermediario", "avancado"];

export const SKILL_LEVEL: Record<SkillLevel, string> = { basico: "Básico", intermediario: "Intermediário", avancado: "Avançado" };

export const EDUCATION_LEVEL_ORDER: EducationLevel[] = [
  "high_school",
  "technical",
  "undergraduate",
  "postgraduate",
  "certification",
  "free_course",
];

export const EDUCATION_LEVEL: Record<EducationLevel, string> = {
  high_school: "Ensino médio",
  technical: "Técnico",
  undergraduate: "Graduação",
  postgraduate: "Pós-graduação",
  certification: "Certificação",
  free_course: "Curso livre",
};

export const TECH_PROFILE_PART: Record<TechProfilePart, string> = {
  tools: "Ferramental",
  availability: "Disponibilidade",
  transport: "Transporte",
  skills: "Aptidões",
  education: "Formação",
};

/** Limites do perfil técnico (os mesmos de backend/app/services/tech_profile.py). */
export const TECH_PROFILE_LIMITS = {
  tools: 200,
  toolName: 80,
  slots: 28,
  modes: 6,
  skills: 30,
  skillName: 80,
  education: 20,
  course: 120,
  institution: 120,
  textMin: 2,
  /** Primeiro mês aceito na formação (o último é o mês atual). */
  firstMonth: "1950-01",
} as const;

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

// --------------------------------------------------------------------------- meses (gráficos, histórico, formação, faturamento)

/** Meses abreviados do eixo dos gráficos, sem ponto. */
export const MONTH_ABBR = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"] as const;

/** "2026-11" → "nov"; com o ano, "nov/26" (fora do formato, volta como veio). */
export function monthAbbr(month: string, withYear = false): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const name = match ? MONTH_ABBR[Number(match[2]) - 1] : undefined;
  if (!match || !name) return month;
  return withYear ? `${name}/${match[1].slice(2)}` : name;
}

/** "2026-11" → "Novembro de 2026" (seções do histórico e meses do faturamento): competenceLabel com a inicial maiúscula. */
export function monthTitle(month: string): string {
  const label = competenceLabel(month);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** "2024-02" ou "2024-02-19" → "02/2024" (fora do formato, volta como veio). */
export function monthText(value: string): string {
  const match = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(value);
  return match ? `${match[2]}/${match[1]}` : value;
}

/** Período da formação: "02/2022 a 12/2023"; sem fim, "desde 02/2024 (em andamento)". Igual ao servidor. */
export function educationPeriodText(start: string, end: string | null | undefined): string {
  return end ? `${monthText(start)} a ${monthText(end)}` : `desde ${monthText(start)} (em andamento)`;
}

/** O "desde" da aptidão: "2026-11-19" → "desde 11/2026". */
export function sinceText(since: string): string {
  return `desde ${monthText(since)}`;
}

// --------------------------------------------------------------------------- faturamento do técnico

/** Os valores por OS existem desde aqui (o Field Control não trazia valores): os meses antes vêm vazios. */
export const EARNINGS_HISTORY_SINCE = "2026-11-13";

/**
 * Situação do mês no Faturamento (GET /me/earnings/months): o selo e a cor do ícone redondo (o desenho do ícone fica
 * no app). Mesmas cores de Pagamentos e das notas: âmbar = esperando a central, verde-água = pago, vermelho = recusa,
 * azul = informativo (a nota nunca trava o pagamento), cinza = nada a fazer.
 */
export const EARNINGS_MONTH_STATE: Record<EarningsMonthState, { label: string; color: string }> = {
  empty: { label: "Sem valores", color: "#667085" },
  in_progress: { label: "Em andamento", color: "#667085" },
  no_invoice: { label: "Sem nota", color: "#0086C9" },
  in_review: { label: "Nota em conferência", color: "#DC6803" },
  rejected: { label: "Nota recusada", color: "#D92D20" },
  to_pay: { label: "A pagar", color: "#DC6803" },
  partial: { label: "Pago em parte", color: "#DC6803" },
  paid_no_invoice: { label: "Pago sem nota", color: "#0E9384" },
  paid: { label: "Pago", color: "#0E9384" },
};

/** "nenhuma OS", "1 OS", "12 OS". */
export function osCount(n: number): string {
  return n === 0 ? "nenhuma OS" : `${n} OS`;
}

/** Formatação vinda de quem mostra: `money` pode ocultar o valor (olho do app); `day` dá "18/11". */
export interface EarningsFormat {
  money: (value: number) => string;
  day: (iso: string) => string;
}

/** Linha curta do cartão do mês (só dados). */
export function earningsMonthLine(m: EarningsMonth, { money, day }: EarningsFormat): string | null {
  switch (m.state) {
    case "in_progress":
      return `${osCount(m.expected.count)} em andamento`;
    case "no_invoice":
      return `${osCount(m.due_without_invoice.count)} sem nota · ${money(m.due_without_invoice.amount)}`;
    case "in_review":
      return `${osCount(m.due_in_review.count)} com nota em conferência`;
    case "rejected":
      return `${m.rejection ? `Nota nº ${m.rejection.number}` : "Nota"} recusada · ver motivo`;
    case "to_pay":
      return `${money(m.to_pay.amount)} a receber`;
    case "partial":
      return [
        `${money(m.paid.amount)} pago`,
        m.to_pay.count ? `${money(m.to_pay.amount)} a receber` : null,
        m.expected.count ? `${money(m.expected.amount)} previsto` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "paid_no_invoice":
      return m.last_paid_at ? `Pago em ${day(m.last_paid_at)} · sem nota` : "Pago · sem nota";
    case "paid":
      return m.last_paid_at ? `Pago em ${day(m.last_paid_at)}` : null;
    default:
      return null;
  }
}

/** O texto da situação no topo do mês: o que aconteceu e o que o técnico pode fazer. */
export function earningsSituation(m: EarningsMonth, { money, day }: EarningsFormat): string | null {
  const paidOn = m.last_paid_at ? ` em ${day(m.last_paid_at)}` : "";
  switch (m.state) {
    case "in_progress":
      return "Nenhuma OS concluída ainda. O valor fica previsto até a conclusão.";
    case "no_invoice":
      return `${osCount(m.due_without_invoice.count)} sem nota fiscal (${money(m.due_without_invoice.amount)}). A central paga com ou sem nota; se quiser, envie a nota abaixo.`;
    case "in_review":
      return `A central está conferindo a nota de ${osCount(m.due_in_review.count)}. Nota errada? Apague e envie outra.`;
    case "rejected": {
      const reason = m.rejection?.reason?.trim();
      const head = m.rejection ? `A central recusou a nota nº ${m.rejection.number}.` : "A central recusou a nota.";
      const why = reason ? ` Motivo: ${/[.!?]$/.test(reason) ? reason : `${reason}.`}` : "";
      return `${head}${why} Apague a nota recusada e envie outra.`;
    }
    case "to_pay":
      return `Nota conferida. Falta a central pagar ${money(m.to_pay.amount)}.`;
    case "partial": {
      const parts = [
        `${money(m.paid.amount)} pago`,
        m.to_pay.count ? `${money(m.to_pay.amount)} a receber` : null,
        m.expected.count ? `${money(m.expected.amount)} previsto` : null,
      ].filter(Boolean);
      const missing = m.due_without_invoice.count + m.paid_without_invoice.count;
      return `${parts.join(", ")}.${missing ? ` ${osCount(missing)} sem nota.` : ""}`;
    }
    case "paid_no_invoice":
      return `Tudo pago${paidOn}. Se quiser, envie a nota fiscal destas OS.`;
    case "paid":
      return `Tudo pago${paidOn}.`;
    default:
      return null;
  }
}

// --------------------------------------------------------------------------- elo dos técnicos

/** As faixas do elo, da mais baixa à mais alta. */
export const LEVEL_TIER_ORDER: LevelTier[] = ["bronze", "silver", "gold", "diamond"];

export interface LevelTierInfo {
  label: string;
  /** "Para chegar à Prata", "Você chegou ao Ouro!". */
  to: string;
  /** "Para continuar no Diamante". */
  at: string;
  /** Cor do brasão no claro e no escuro (3:1 ou mais contra a superfície e contra as marcas). */
  color: { light: string; dark: string };
  /** Token da web (globals.css), com a mesma cor. */
  cssVar: string;
}

/** Faixa do elo do técnico: o nome vai sempre escrito junto do brasão (a cor fica só no escudo). */
export const LEVEL_TIER: Record<LevelTier, LevelTierInfo> = {
  bronze: { label: "Bronze", to: "ao Bronze", at: "no Bronze", color: { light: "#A9622B", dark: "#D08A52" }, cssVar: "--tier-bronze" },
  silver: { label: "Prata", to: "à Prata", at: "na Prata", color: { light: "#6E7B8C", dark: "#AEB8C6" }, cssVar: "--tier-silver" },
  gold: { label: "Ouro", to: "ao Ouro", at: "no Ouro", color: { light: "#A87A00", dark: "#E2B33C" }, cssVar: "--tier-gold" },
  diamond: { label: "Diamante", to: "ao Diamante", at: "no Diamante", color: { light: "#5B4BDB", dark: "#9D8CFF" }, cssVar: "--tier-diamond" },
};

/** O escudo do brasão (viewBox 24x24), preenchido com a cor da faixa. */
export const LEVEL_SHIELD_PATH = "M12 2.5 19.5 5.3v6.1c0 4.6-3.1 8.6-7.5 10.1-4.4-1.5-7.5-5.5-7.5-10.1V5.3z";

/**
 * As marcas do brasão, em traço (1,7, pontas redondas) na cor da superfície (LEVEL_MARK_COLOR): 1, 2 e 3 divisas e a
 * pedra do Diamante. A forma diferencia as faixas sem depender da cor.
 */
export const LEVEL_MARKS: Record<LevelTier, string[]> = {
  bronze: ["M8.5 11.5 12 13.6l3.5-2.1"],
  silver: ["M8.5 9.6 12 11.7l3.5-2.1", "M8.5 13.2 12 15.3l3.5-2.1"],
  gold: ["M8.5 8 12 10.1 15.5 8", "M8.5 11.3 12 13.4l3.5-2.1", "M8.5 14.6 12 16.7l3.5-2.1"],
  diamond: ["M9.2 10.2 10.6 8h2.8l1.4 2.2L12 15.5z", "M9.2 10.2h5.6"],
};

/** Cor das marcas do brasão: a superfície no claro e no escuro. */
export const LEVEL_MARK_COLOR = { light: "#FFFFFF", dark: "#141519" } as const;

/** O que pesou no elo, como a central e o app mostram. */
export const LEVEL_OCCURRENCE: Record<LevelOccurrenceKind, string> = {
  late: "Chegada fora do horário",
  rework: "Retorno",
  unproductive: "Visita perdida",
};

// --------------------------------------------------------------------------- aviso de privacidade (LGPD)

/**
 * Versão do aviso: a mesma de PRIVACY_VERSION em backend/app/schemas/onboarding.py (a ficha grava a do servidor no
 * aceite). Mudou o texto de PRIVACY_NOTICE? Mude a versão aqui e lá, no mesmo dia, e publique a web antes da API (ou
 * junto): com a API na frente, a ficha da web pede para recarregar e não envia até a web nova entrar.
 */
export const PRIVACY_VERSION = "2026-11-19";

/** O aviso de privacidade do técnico: a ficha da homologação mostra junto do aceite, e o app, para consulta. */
export const PRIVACY_NOTICE: { title: string; body: string }[] = [
  {
    title: "Quem trata seus dados",
    body: "A Maxx Field, como controladora, para avaliar seu cadastro como técnico parceiro e, se aprovado, para a gestão dos atendimentos.",
  },
  {
    title: "Quais dados",
    body: "Os do seu cadastro: identificação (nome, CPF, nascimento e foto), contato, endereço, CNPJ ou MEI (se tiver), região de atendimento, experiência, skills, veículo e CNH, disponibilidade, a senha do app (que ninguém da equipe consegue ver) e a chave PIX que você cadastrar no app para receber pelos chamados.",
  },
  {
    title: "Para quê",
    body: "Homologação técnica, cadastro na base de técnicos, distribuição de ordens de serviço, contato sobre os atendimentos e pagamento dos chamados por PIX. Não vendemos nem compartilhamos seus dados para marketing.",
  },
  {
    title: "Com quem compartilhamos",
    body: "O cliente atendido vê o seu nome e os horários da visita (saída, chegada e conclusão) no relatório e no portal do atendimento. Os demais dados ficam só com a equipe da Maxx Field.",
  },
  {
    title: "Localização (GPS)",
    body: "Se aprovado, o app coleta sua localização somente durante a jornada que você mesmo inicia e encerra, para acompanhar o deslocamento até o cliente. O app pede sua autorização antes da primeira jornada.",
  },
  {
    title: "Notas fiscais",
    body: "As que você envia pelo app: número, valor, datas e o arquivo, que pode trazer seu CPF ou CNPJ e endereço. Servem para conferir os pagamentos e ficam guardadas pelo prazo da legislação fiscal.",
  },
  {
    title: "Elo",
    body: "Classificação pelos seus atendimentos dos últimos 12 meses: quantidade, chegada no horário, retornos e visitas perdidas. Você acompanha em Meu elo, no app, e pode pedir à central a revisão de uma ocorrência.",
  },
  {
    title: "Por quanto tempo",
    body: "Enquanto você fizer parte da base técnica e pelo prazo exigido em lei. Fichas reprovadas são excluídas após a análise e o prazo legal aplicável.",
  },
  {
    title: "Seus direitos",
    body: "Você pode pedir acesso, correção, portabilidade ou exclusão dos seus dados e revogar consentimentos a qualquer momento, falando com a equipe da Maxx Field.",
  },
];
