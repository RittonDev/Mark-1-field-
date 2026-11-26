// Rótulos e regras espelhados de backend/app/services/workflow.py.
// A fonte da verdade é o backend (GET /meta e allowed_transitions de cada OS);
// estes valores servem para renderizar sem esperar a rede.

import type {
  AssetType,
  AvailabilitySlot,
  BankAccountType,
  BankPayoutMethod,
  CepAddress,
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
  OperationalStatus,
  PayoutMethod,
  PayoutMethodKind,
  PixKeyType,
  Responsibility,
  SkillLevel,
  SlaStatus,
  TechProfilePart,
  TechSectionKey,
  TicketEventType,
  TicketPriority,
  TicketSource,
  TicketStatus,
  TicketType,
  TransportInfo,
  TransportMode,
  UnavailabilityPeriod,
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

/** "Nova" em Pagamentos e na ficha do técnico: o destino do pagamento mudou há menos destes dias. */
export const PAYOUT_RECENT_DAYS = 7;

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

// --------------------------------------------------------------------------- cadastro V2 (Entrega 1)

export const OPERATIONAL_STATUS: Record<OperationalStatus, string> = { active: "Ativo", inactive: "Inativo", blocked: "Bloqueado" };
/** "Acesso ao app" (users.is_active). */
export const APP_ACCESS = { on: "Liberado", off: "Sem acesso" } as const;
export const PAYOUT_KIND: Record<PayoutMethodKind, string> = { pix: "Chave PIX", bank: "Conta bancária" };
export const BANK_ACCOUNT_TYPES: BankAccountType[] = ["checking", "savings", "payment"];
export const BANK_ACCOUNT_TYPE: Record<BankAccountType, string> = {
  checking: "Conta corrente",
  savings: "Conta poupança",
  payment: "Conta de pagamento",
};
export const PAYOUT_LIMITS = { methods: 10, holderName: 160, bankName: 80, accountNumber: 20 } as const;

/** "••••5678-9"; com até 4 números, os 2 últimos ("••34-4"). */
export function maskAccount(number: string, digit: string | null): string {
  const tail = number.length > 4 ? `••••${number.slice(-4)}` : `••${number.slice(-2)}`;
  return digit ? `${tail}-${digit}` : tail;
}

/** "PIX CPF •••.456.789-••" | "Banco Exemplo ••••5678-9" (= core/payout.describe com "•"). */
export function payoutMethodText(method: PayoutMethod): string {
  return method.kind === "pix"
    ? `PIX ${PIX_KEY_TYPE[method.pix_key_type]} ${maskPixKey(method.pix_key_type, method.pix_key)}`
    : `${method.bank_name} ${maskAccount(method.account_number, method.account_digit)}`;
}

/** Para quem paga: "Banco Exemplo (999) · Ag. 0001 · Conta 12345-6 · Conta corrente". */
export function bankAccountText(method: BankPayoutMethod): string {
  return `${method.bank_name} (${method.bank_code}) · Ag. ${method.branch} · Conta ${method.account_number}-${method.account_digit} · ${BANK_ACCOUNT_TYPE[method.account_type]}`;
}

export const PROFILE_LIMITS = {
  bio: 500,
  rgNumber: 20,
  rgIssuer: 20,
  addressNumber: 10,
  addressComplement: 60,
  companyName: 160,
  vehicleModel: 60,
} as const;
export const BIRTH_AGE = { min: 18, max: 90 } as const;

/** Idade completa em `today` (os dois "AAAA-MM-DD"); null com data inválida. */
export function ageAt(birth: string, today: string): number | null {
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birth);
  const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!b || !t) return null;
  const [by, bm, bd] = [Number(b[1]), Number(b[2]), Number(b[3])];
  const real = new Date(Date.UTC(by, bm - 1, bd));
  if (real.getUTCFullYear() !== by || real.getUTCMonth() !== bm - 1 || real.getUTCDate() !== bd) return null;
  const [ty, tm, td] = [Number(t[1]), Number(t[2]), Number(t[3])];
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

export function normalizePlate(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 7);
}
/** Antiga (ABC1234) ou Mercosul (ABC1D23). */
export function isValidPlate(text: string): boolean {
  return /^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(normalizePlate(text));
}
/** "ABC-1234" (antiga) | "ABC1D23" (Mercosul). */
export function formatPlate(plate: string): string {
  const p = normalizePlate(plate);
  return /^[A-Z]{3}\d{4}$/.test(p) ? `${p.slice(0, 3)}-${p.slice(3)}` : p;
}
export function normalizeRg(text: string): string {
  return text.toUpperCase().replace(/[^0-9A-Z./ -]/g, "").replace(/\s+/g, " ").slice(0, PROFILE_LIMITS.rgNumber);
}
/** 5 a 20 caracteres com pelo menos 4 números. */
export function isValidRg(text: string): boolean {
  const rg = normalizeRg(text).trim();
  return rg.length >= 5 && (rg.match(/\d/g) ?? []).length >= 4;
}
/** O órgão emissor sem o corte: letras sem acento, espaço, "/" e "-", em maiúsculas. */
function issuerText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z /-]/g, "")
    .replace(/\s+/g, " ");
}

/** O campo do órgão emissor enquanto se digita, até 20 ("SSP/SP"); ao salvar, splitIssuer. */
export function normalizeIssuer(text: string): string {
  return issuerText(text).slice(0, PROFILE_LIMITS.rgIssuer);
}

/** As 27 UFs (= UFS de backend/app/schemas/onboarding.py). */
export const UFS: readonly string[] = [
  "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA", "PB",
  "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO",
];

/**
 * O órgão emissor ao salvar (o backend separa igual). Termina em "/" ou "-" e uma UF, com o órgão antes ("SSP/SP",
 * "ssp-sp", "SSP / SP"): órgão "SSP" e UF "SP"; a tela põe a UF no campo dela quando ele está vazio e, com outra UF lá,
 * fica a do campo. Sem UF válida no fim, "/" e "-" viram espaço ("SSP/XX" → "SSP XX"). Sem o corte de 20: o tamanho do
 * órgão a tela confere.
 */
export function splitIssuer(text: string): { issuer: string; state: string | null } {
  const value = issuerText(text).trim();
  const tidy = (part: string) => part.replace(/[/-]/g, " ").replace(/\s+/g, " ").trim();
  const match = /^(.*?)\s*[/-]\s*([A-Z]{2})$/.exec(value);
  const issuer = match ? tidy(match[1]) : "";
  if (match && issuer && UFS.includes(match[2])) return { issuer, state: match[2] };
  return { issuer: tidy(value), state: null };
}

/**
 * A mini biografia como se grava (= personal.bio): "\r\n" vira "\n", sem espaços no fim das linhas, três ou mais
 * quebras viram duas (uma linha em branco entre os parágrafos) e sem quebras nem espaços nas pontas. O limite de
 * PROFILE_LIMITS.bio conta depois disso.
 */
export function normalizeBio(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Recebe e-mail (= mail.sendable): "@", domínio com ponto, não termina em .invalid/.local (importados). */
export function isSendableEmail(email: string | null | undefined): boolean {
  const value = (email ?? "").trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) && !/\.(invalid|local)$/.test(value);
}

export const PASSWORD_RESET_HOURS = 2;

export const CEP_TEXT = {
  searching: "Buscando o CEP…",
  notFound: "CEP não encontrado.",
  unavailable: "Busca de CEP indisponível. Preencha o endereço.",
  invalid: "CEP inválido: use os 8 números.",
  use: "Usar este endereço",
} as const;

/** "Praça da Sé, Sé - São Paulo-SP"; CEP geral "Cidade Exemplo-SP" (linha "CEP de {resumo}."). */
export function cepSummary(address: CepAddress): string {
  const place = [address.street, address.district].filter(Boolean).join(", ");
  return `${place ? `${place} - ` : ""}${address.city}-${address.state}`;
}

export interface CepSlots { street: string; district: string; city: string; state: string }

const cepFold = (text: string) =>
  text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toUpperCase();

const NO_CEP_SLOTS: ReadonlySet<keyof CepSlots> = new Set();

/**
 * O CEP sobre o formulário (6 lugares): campo livre (vazio, igual ao aberto ou de busca anterior: `auto`) recebe o valor;
 * o digitado fica e, se difere, `differs` ("CEP de {cepSummary}." + "Usar este endereço"). O que o CEP não traz (CEP
 * geral: logradouro e bairro null) não mexe no digitado nem no gravado: só o campo de `stale` (ainda com o valor da
 * busca anterior) se esvazia e entra em `filled`. `stale` é sempre o da busca anterior, também no "Usar este
 * endereço", que passa todos em `auto` (o `auto` nunca esvazia). Logradouro trocado de fato (sameStreet): a tela
 * esvazia número e complemento livres.
 */
export function cepFill(
  current: CepSlots,
  opened: CepSlots,
  auto: ReadonlySet<keyof CepSlots>,
  found: CepAddress,
  stale: ReadonlySet<keyof CepSlots> = NO_CEP_SLOTS,
): { next: CepSlots; filled: (keyof CepSlots)[]; differs: boolean } {
  const values: CepSlots = { street: found.street ?? "", district: found.district ?? "", city: found.city, state: found.state };
  const next = { ...current };
  const filled: (keyof CepSlots)[] = [];
  let differs = false;
  for (const key of ["street", "district", "city", "state"] as const) {
    const value = values[key];
    if (!value) {
      if (stale.has(key) && current[key] !== "") {
        next[key] = "";
        filled.push(key);
      }
      continue;
    }
    const free = !current[key].trim() || current[key] === opened[key] || auto.has(key);
    if (free) {
      if (current[key] !== value) {
        next[key] = value;
        filled.push(key);
      }
    } else if (cepFold(current[key]) !== cepFold(value)) {
      differs = true;
    }
  }
  return { next, filled, differs };
}

/** A mesma rua sem contar acento, maiúsculas e espaços repetidos (a comparação de cepFill): "R. Exemplo" é outra. */
export function sameStreet(a: string | null | undefined, b: string | null | undefined): boolean {
  return cepFold(a ?? "") === cepFold(b ?? "");
}

export const UNAVAILABILITY_LIMITS = { periods: 10, horizonDays: 365 } as const;

const isoDayText = (iso: string) => iso.slice(0, 10).split("-").reverse().join("/");

/** "20/12/2026 a 05/01/2027"; um dia, "20/12/2026" (= unavailability.period_text). */
export function periodText(period: { start: string; end: string }): string {
  return period.start === period.end ? isoDayText(period.start) : `${isoDayText(period.start)} a ${isoDayText(period.end)}`;
}

/** Chips e avisos (= unavailability.period_short): "até 30/11" (já começou), "em 20/12", "de 20/12 a 05/01/2027". */
export function periodShort(period: { start: string; end: string }, today: string): string {
  const short = (iso: string) => {
    const [y, m, d] = iso.slice(0, 10).split("-");
    return y === today.slice(0, 4) ? `${d}/${m}` : `${d}/${m}/${y}`;
  };
  if (period.start <= today) return `até ${short(period.end)}`;
  return period.start === period.end ? `em ${short(period.start)}` : `de ${short(period.start)} a ${short(period.end)}`;
}

/**
 * O primeiro período (pelo início) com algum dia entre `first` e `last` ("AAAA-MM-DD"), as pontas inclusive, como
 * technician_status.unavailable_between: para a visita, do dia do início ao do fim. `last` antes de `first` vale
 * `first` (= unavailability.days_of).
 */
export function unavailableBetween(
  periods: readonly UnavailabilityPeriod[] | null | undefined,
  first: string,
  last: string,
): UnavailabilityPeriod | null {
  const end = last < first ? first : last;
  let found: UnavailabilityPeriod | null = null;
  for (const p of periods ?? []) {
    if (p.start <= end && p.end >= first && (!found || p.start < found.start)) found = p;
  }
  return found;
}

/** O período que contém `day`, os dois dias inclusive. */
export function unavailableOn(periods: readonly UnavailabilityPeriod[] | null | undefined, day: string): UnavailabilityPeriod | null {
  return unavailableBetween(periods, day, day);
}

/** Grupos e seções com os mesmos nomes na central e no app; `app`: o nome no app quando difere. */
export const TECH_SECTION_GROUPS: readonly {
  key: "pessoais" | "financeiros" | "profissional";
  label: string;
  sections: readonly { key: TechSectionKey; label: string; app?: string; delivery: 1 | 2 }[];
}[] = [
  {
    key: "pessoais",
    label: "Dados pessoais e cadastrais",
    sections: [
      { key: "foto", label: "Foto do perfil", delivery: 1 },
      { key: "dados-pessoais", label: "Dados pessoais", delivery: 1 },
      { key: "endereco", label: "Endereço", delivery: 1 },
      { key: "contato", label: "Contato", delivery: 1 },
      { key: "credenciais", label: "Credenciais", app: "Senha", delivery: 1 },
      { key: "documentos", label: "Documentos", delivery: 2 },
      { key: "mini-biografia", label: "Mini biografia", delivery: 1 },
    ],
  },
  {
    key: "financeiros",
    label: "Dados financeiros e empresariais",
    sections: [
      { key: "dados-empresariais", label: "Dados empresariais", delivery: 1 },
      { key: "recebimento", label: "Formas de recebimento", delivery: 1 },
    ],
  },
  {
    key: "profissional",
    label: "Perfil profissional",
    sections: [
      { key: "dias-e-horarios", label: "Dias e horários", delivery: 1 },
      { key: "transporte", label: "Transporte", delivery: 1 },
      { key: "curriculo", label: "Currículo", delivery: 2 },
      { key: "formacao", label: "Formação", delivery: 1 },
      { key: "aptidoes", label: "Aptidões", delivery: 1 },
      { key: "ferramental", label: "Ferramental", delivery: 1 },
    ],
  },
];

/** A entrega no ar: seções com `delivery` maior ficam fora dos menus (a E2 sobe para 2). */
export const CADASTRO_DELIVERY = 1;

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
  address_line: "Logradouro",
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
  cpf: "CPF",
  rg: "RG",
  birth_date: "Nascimento",
  phone_secondary: "Telefone secundário",
  address_number: "Número",
  address_complement: "Complemento",
  bio: "Mini biografia",
  company_document: "CNPJ",
  company_name: "Razão social",
  company_trade_name: "Nome fantasia",
  vehicle: "Veículo",
  payout_methods: "Formas de recebimento",
  payout_preferred: "Forma preferencial",
  operational_status: "Situação",
  unavailability: "Indisponibilidade",
  email_pending: "E-mail novo",
  email_verified: "Validação do e-mail",
  password_link: "Link para nova senha",
  application: "Homologação",
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

/**
 * Os dias, na ordem: "seg a sex", "sáb e dom", "seg, qua e sex", "seg a qua e sex" (três ou mais seguidos: "a"); os
 * sete: "todos os dias".
 */
function weekdaysText(days: readonly Weekday[]): string {
  if (WEEKDAY_ORDER.every((day) => days.includes(day))) return "todos os dias";
  const runs: number[][] = [];
  WEEKDAY_ORDER.forEach((day, i) => {
    if (!days.includes(day)) return;
    const run = runs[runs.length - 1];
    if (run && run[run.length - 1] === i - 1) run.push(i);
    else runs.push([i]);
  });
  const short = (i: number) => WEEKDAY[WEEKDAY_ORDER[i]].short;
  const parts = runs.flatMap((run) =>
    run.length >= 3 ? [`${short(run[0])} a ${short(run[run.length - 1])}`] : run.map(short),
  );
  return joinWords(parts);
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
 * Resumo da linha Disponibilidade (Configurações do app). Dias com os mesmos turnos, seguidos ou não:
 * "Seg a sex · manhã e tarde", "Sáb e dom · noite", "Seg, qua e sex · manhã", "Seg a qua e sex · manhã"; os 28:
 * "Todos os dias · todos os turnos"; dias com turnos diferentes: "6 dias · turnos variados"; nada: "Não informada".
 */
export function availabilitySummary(slots: readonly string[]): string {
  const list = sortSlots(slots);
  if (!list.length) return "Não informada";
  if (list.length === ALL_SLOTS.length) return "Todos os dias · todos os turnos";
  const days = WEEKDAY_ORDER.filter((day) => slotPeriods(list, day).length > 0);
  const periods = slotPeriods(list, days[0]);
  const same = days.every((day) => slotPeriods(list, day).join() === periods.join());
  if (!same) return `${days.length} dias · turnos variados`;
  const text = `${weekdaysText(days)} · ${periodsPhrase(periods)}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
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
    case "empty": {
      // Mês sem valores, mas com nota da competência ("1 nota fiscal"); a API antiga não manda invoices.
      const invoices = m.invoices ?? 0;
      if (invoices <= 0) return null;
      return invoices === 1 ? "1 nota fiscal" : `${invoices} notas fiscais`;
    }
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
  /** Cor da faixa (barra de progresso do Meu elo). */
  color: { light: string; dark: string };
}

/** Faixa do elo do técnico: o nome vai sempre escrito junto da medalha. */
export const LEVEL_TIER: Record<LevelTier, LevelTierInfo> = {
  bronze: { label: "Bronze", to: "ao Bronze", at: "no Bronze", color: { light: "#A9622B", dark: "#D08A52" } },
  silver: { label: "Prata", to: "à Prata", at: "na Prata", color: { light: "#6E7B8C", dark: "#AEB8C6" } },
  gold: { label: "Ouro", to: "ao Ouro", at: "no Ouro", color: { light: "#A87A00", dark: "#E2B33C" } },
  diamond: { label: "Diamante", to: "ao Diamante", at: "no Diamante", color: { light: "#5B4BDB", dark: "#9D8CFF" } },
};

// --------------------------------------------------------------------------- patente: a medalha do elo

/**
 * A patente do técnico (o elo como medalha), desenhada no Maxx Field: hexágono de ponta para cima, aro em relevo, face e o
 * emblema da faixa (viewBox 48x48, centro 24,24). A mesma arte na central e no app: os dois leem daqui. A forma e o
 * emblema diferenciam a faixa sem depender da cor, e o nome vai sempre escrito junto.
 */
export const LEVEL_MEDAL_VIEWBOX = "0 0 48 48";

/** O aro (contorno de fora), com cantos arredondados. */
export const LEVEL_MEDAL_RIM_PATH =
  "M21.4 3.5Q24 2 26.6 3.5L40.5 11.5Q43.1 13 43.1 16V32Q43.1 35 40.5 36.5L26.6 44.5Q24 46 21.4 44.5L7.5 36.5Q4.9 35 4.9 32V16Q4.9 13 7.5 11.5Z";

/** A face (o miolo, um pouco para dentro do aro). */
export const LEVEL_MEDAL_FACE_PATH =
  "M21.9 8.2Q24 7 26.1 8.2L36.6 14.3Q38.7 15.5 38.7 17.9V30.1Q38.7 32.5 36.6 33.7L26.1 39.8Q24 41 21.9 39.8L11.4 33.7Q9.3 32.5 9.3 30.1V17.9Q9.3 15.5 11.4 14.3Z";

/** O relevo do aro: o brilho na faceta de cima, à esquerda (branco), e a sombra na de baixo, à direita (preto). */
export const LEVEL_MEDAL_SHEEN_PATH = "M7.5 11.5L21.4 3.5L21.9 8.2L11.4 14.3Z";
export const LEVEL_MEDAL_SHADE_PATH = "M40.5 36.5L26.6 44.5L26.1 39.8L36.6 33.7Z";

/** Opacidade do brilho e da sombra do aro, por tema. */
export const LEVEL_MEDAL_RELIEF = {
  light: { sheen: 0.45, shade: 0.12 },
  dark: { sheen: 0.3, shade: 0.25 },
} as const;

/**
 * Relevo com degradê (aro em diagonal, face de cima para baixo) a partir de LEVEL_MEDAL_FLAT_BELOW. false: aro e face
 * chapados (rim[0] e face[0]), com o brilho, a sombra, a linha da face e as facetas. O dono escolheu o relevo
 * (24/11/2026).
 */
export const LEVEL_MEDAL_GRADIENT: boolean = true;

/** Traço das divisas e das facetas da pedra (unidades do viewBox). */
export const LEVEL_MEDAL_STROKE = 3.4;
export const LEVEL_MEDAL_FACET_STROKE = 1.2;

/** Abaixo deste tamanho (pt no app, px na web), a medalha sai lisa: sem degradê, brilho, sombra nem facetas. */
export const LEVEL_MEDAL_FLAT_BELOW = 28;

/** Tamanhos: chip de Hoje e selos (18), listas (24), Perfil (64), comemoração (72) e Meu elo (96). */
export const LEVEL_MEDAL_SIZE = { chip: 18, list: 24, profile: 64, celebrate: 72, hero: 96 } as const;

export interface LevelMedalEmblem {
  /** Divisas: traço LEVEL_MEDAL_STROKE, pontas e cantos redondos, na cor `emblem`. */
  strokes: string[];
  /** Formas cheias na cor `emblem` (a pedra do Diamante). */
  fills: string[];
  /** Facetas da pedra, em traço fino na cor de cima da face (só a partir de LEVEL_MEDAL_FLAT_BELOW). */
  facets: string[];
}

/** O emblema cresce com a faixa: 1, 2 e 3 divisas para cima e a pedra do Diamante; sem elo, um traço. */
export const LEVEL_MEDAL_EMBLEM: Record<LevelMedalKind, LevelMedalEmblem> = {
  none: { strokes: ["M19 24H29"], fills: [], facets: [] },
  bronze: { strokes: ["M17 27L24 21L31 27"], fills: [], facets: [] },
  silver: { strokes: ["M17 24L24 18L31 24", "M17 30L24 24L31 30"], fills: [], facets: [] },
  gold: { strokes: ["M17 21L24 15L31 21", "M17 27L24 21L31 27", "M17 33L24 27L31 33"], fills: [], facets: [] },
  diamond: {
    strokes: [],
    fills: ["M19 16.5H29L33 21.5L24 31.5L15 21.5Z"],
    facets: ["M15 21.5H33", "M21.5 16.5L20.5 21.5L24 31.5L27.5 21.5L26.5 16.5"],
  },
};

export interface LevelMedalColors {
  /** Aro: da luz (em cima, à esquerda) para a sombra (embaixo, à direita). */
  rim: readonly [string, string];
  /** Face: de cima para baixo. */
  face: readonly [string, string];
  /** Divisas e pedra: 4:1 ou mais contra a face. */
  emblem: string;
  /** Silhueta (e o aro cheio da medalha lisa): 4:1 ou mais contra a superfície, o canvas e o fundo dos selos. */
  outline: string;
  /** A linha entre o aro e a face. */
  edge: string;
}

/** Cores da medalha por faixa e tema. "none" (sem elo ainda) é apagada de propósito: o "SEM ELO" escrito diz o que é. */
export const LEVEL_MEDAL_COLOR: Record<LevelMedalKind, { light: LevelMedalColors; dark: LevelMedalColors }> = {
  none: {
    light: { rim: ["#E3E6EA", "#A3AAB5"], face: ["#F4F5F7", "#E6E8EC"], emblem: "#8B93A1", outline: "#A3AAB5", edge: "#A3AAB5" },
    dark: { rim: ["#3A3E46", "#2A2D33"], face: ["#2A2D33", "#24272C"], emblem: "#6C727D", outline: "#4A4F58", edge: "#2A2D33" },
  },
  bronze: {
    light: { rim: ["#D9935A", "#8C4B1F"], face: ["#F2B98A", "#CF8547"], emblem: "#4A230A", outline: "#7E4219", edge: "#7E4219" },
    dark: { rim: ["#D9935A", "#8C4B1F"], face: ["#E8AD7C", "#C27A3F"], emblem: "#3F1D07", outline: "#C27A3F", edge: "#8C4B1F" },
  },
  silver: {
    light: { rim: ["#E3E7ED", "#7A8594"], face: ["#F7F8FA", "#CDD3DC"], emblem: "#3F4856", outline: "#6E7987", edge: "#6E7987" },
    dark: { rim: ["#DCE1E8", "#6E7987"], face: ["#E9ECF1", "#B9C1CC"], emblem: "#3B4451", outline: "#AEB8C6", edge: "#6E7987" },
  },
  gold: {
    light: { rim: ["#F4CD5C", "#9A6F00"], face: ["#FCE49A", "#E5B634"], emblem: "#5C4000", outline: "#8A6400", edge: "#8A6400" },
    dark: { rim: ["#EFC453", "#8F6700"], face: ["#F6DC8C", "#D9A92B"], emblem: "#573C00", outline: "#E2B33C", edge: "#8F6700" },
  },
  diamond: {
    light: { rim: ["#BDB3FF", "#4B3CC6"], face: ["#E3DEFF", "#A598FF"], emblem: "#2D2191", outline: "#4234B8", edge: "#4234B8" },
    dark: { rim: ["#B3A8FF", "#4536B8"], face: ["#D6CFFF", "#9C8CFF"], emblem: "#251A80", outline: "#9D8CFF", edge: "#4536B8" },
  },
};

/** O nome da medalha sem elo (a tela mostra em maiúsculas: "SEM ELO"). */
export const LEVEL_NONE_LABEL = "Sem elo";

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
 * junto): com a API na frente, a ficha da web pede para recarregar e não envia até a web nova entrar. Formato
 * "AAAA-MM-DD"; uma segunda versão no mesmo dia ganha ".2" (as versões se comparam como texto). 2026-11-26 (a
 * publicação da Entrega 1): RG, nascimento e CPF no cadastro, veículo, dados da empresa, formas de recebimento,
 * biografia, e-mail validado, indisponibilidade, situação na operação, e-mails do cadastro e a reabertura da ficha
 * reprovada.
 */
export const PRIVACY_VERSION = "2026-11-26";

/** A data da versão para mostrar ("26/11/2026"): os 10 primeiros caracteres, sem um ".2". */
export const PRIVACY_DATE = PRIVACY_VERSION.slice(0, 10).split("-").reverse().join("/");

/** O aviso de privacidade do técnico: a ficha da homologação mostra junto do aceite, e o app, para consulta. */
export const PRIVACY_NOTICE: { title: string; body: string }[] = [
  {
    title: "Quem trata seus dados",
    body: "A Maxx Field, como controladora, para avaliar seu cadastro como técnico parceiro e, se aprovado, para a gestão dos atendimentos.",
  },
  {
    title: "Quais dados",
    body: "Os do seu cadastro: identificação (nome, CPF, RG com órgão emissor e UF, nascimento e foto), contato (celular, telefone secundário e e-mail, com a validação de que o e-mail é seu), endereço, região de atendimento, mini biografia (se escrever), experiência, veículo (modelo e placa, se informar), dados da sua empresa (CNPJ, razão social e nome fantasia, se tiver), as formas de recebimento que você cadastrar no app (chaves PIX e contas bancárias, com o nome e o CPF ou CNPJ do titular) e a senha do app (que ninguém da equipe consegue ver). O seu perfil técnico, informado na ficha ou no app: áreas de atuação, aptidões, formação (curso, nível, instituição e período), ferramental, meios de transporte e CNH, os dias e turnos em que você atende e os períodos em que avisar que está indisponível. E os registros das ofertas de OS no app: quando você vê a oferta, abre o escopo e aceita ou recusa.",
  },
  {
    title: "Para quê",
    body: "Homologação técnica, conferência da sua identidade, cadastro na base de técnicos, distribuição de ordens de serviço (o perfil técnico, a disponibilidade e a indisponibilidade ajudam a central a escolher quem convidar para cada OS), contato sobre os atendimentos e pagamento dos chamados na forma de recebimento que você marcar como preferencial. Não vendemos nem compartilhamos seus dados para marketing.",
  },
  {
    title: "Situação na operação",
    body: "A equipe registra a sua situação na operação (ativo, inativo ou bloqueado), com o motivo, quem mudou e quando. Só quem está ativo recebe novas OS. A situação, sozinha, não tira o seu acesso ao app. Você pode pedir à central a revisão.",
  },
  {
    title: "Com quem compartilhamos",
    body: "O cliente atendido vê o seu nome e os horários da visita (saída, chegada e conclusão) no relatório e no portal do atendimento. Prestadores que operam o sistema para a Maxx Field tratam os dados só para isso: hospedagem, envio dos e-mails do cadastro e consulta de CEP (vai só o CEP). No pagamento, a instituição financeira recebe os dados da forma de recebimento. Os demais dados ficam só com a equipe da Maxx Field.",
  },
  {
    title: "E-mails",
    body: "Usamos o seu e-mail só para mensagens do cadastro: confirmar o endereço, avisar a aprovação e criar uma nova senha. São automáticas e não recebem resposta; a conversa sobre o trabalho continua pelo WhatsApp.",
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
    body: "Enquanto você fizer parte da base técnica e pelo prazo exigido em lei (os dados de pagamento, pelo prazo da legislação fiscal). A ficha reprovada fica guardada por 180 dias contados da última análise: nesse prazo, a equipe pode reabri-la para uma nova análise; depois, ela é excluída com a foto. O registro dos e-mails enviados fica 180 dias.",
  },
  {
    title: "Seus direitos",
    body: "Você pode pedir acesso, correção, portabilidade ou exclusão dos seus dados e revogar consentimentos a qualquer momento, falando com a equipe da Maxx Field. Se aprovado, você mesmo atualiza no app, em Configurações, os seus dados, o perfil técnico e as formas de recebimento (o CPF, depois de informado, só a central corrige).",
  },
];
