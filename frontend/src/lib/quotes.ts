import { dayKey, formatMoney, OPERATION_TZ } from "./format";
import type { Quote, QuoteFollowUp, QuoteItem, QuoteItemKind, QuoteStatus } from "./types";

/**
 * Situação do orçamento. `color` vai no <Pill> (cinza no que não pede ação, vermelho só em recusado e
 * vencido); `className` segue para as telas que ainda pintam a etiqueta com classes.
 */
export const QUOTE_STATUS: Record<QuoteStatus, { label: string; className: string; color: string }> = {
  draft: { label: "Rascunho", className: "bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-300", color: "#64748b" },
  sent: { label: "Aguardando cliente", className: "bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300", color: "#2447ff" },
  approved: { label: "Aprovado", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300", color: "#10b981" },
  rejected: { label: "Recusado", className: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300", color: "#dc2626" },
  expired: { label: "Vencido", className: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300", color: "#dc2626" },
  cancelled: { label: "Cancelado", className: "bg-surface-2 text-ink-muted ring-1 ring-line ring-inset", color: "#64748b" },
};

// ---------------------------------------------------------------- números digitados (padrão brasileiro)

function normalizeDecimal(text: string): string {
  const raw = text.replace(/R\$/gi, "").replace(/\s/g, "");
  if (raw.includes(",")) return raw.replace(/\./g, "").replace(",", ".");
  // Sem vírgula, ponto em grupos de 3 é milhar ("1.000" = mil); fora disso, é decimal ("1.5", "0.500").
  if (/^-?[1-9]\d{0,2}(\.\d{3})+$/.test(raw)) return raw.replace(/\./g, "");
  return raw;
}

/**
 * Número digitado como se escreve no Brasil: "1.234,56", "0,5", ",5", "R$ 80", "1.000" (mil).
 * Vazio = null; inválido = NaN.
 */
export function parseDecimalBR(text: string): number | null {
  const normalized = normalizeDecimal(text);
  if (!normalized) return null;
  return /^-?(\d+(\.\d*)?|\.\d+)$/.test(normalized) ? Number(normalized) : Number.NaN;
}

/** Casas decimais do que foi digitado ("1.234,567" = 3; "1.000" = 0). */
export function decimalPlaces(text: string): number {
  const normalized = normalizeDecimal(text);
  const dot = normalized.indexOf(".");
  return dot < 0 ? 0 : normalized.length - dot - 1;
}

export interface DecimalRule {
  /** Casas aceitas pela API: 2 em dinheiro (centavos), 3 em quantidade. */
  decimals: 2 | 3;
  /** Zero vale (item de cortesia, desconto) ou não (quantidade). */
  allowZero?: boolean;
  /** Vazio conta como zero (desconto); sem isso, vazio pede `emptyMessage`. */
  emptyAsZero?: boolean;
  emptyMessage?: string;
}

/** Lê o campo e diz o que está errado, para mostrar embaixo dele (a API recusaria em inglês). */
export function readDecimal(text: string, rule: DecimalRule): { value: number | null; error: string | null } {
  const value = parseDecimalBR(text);
  if (value === null) {
    return rule.emptyAsZero ? { value: 0, error: null } : { value: null, error: rule.emptyMessage ?? "Preencha este campo" };
  }
  if (Number.isNaN(value) || value < 0) return { value: null, error: "Número inválido" };
  if (!rule.allowZero && value === 0) return { value: null, error: "Precisa ser maior que zero" };
  if (decimalPlaces(text) > rule.decimals) {
    return { value: null, error: rule.decimals === 2 ? "Use até 2 casas (centavos)" : "Use até 3 casas decimais" };
  }
  // NUMERIC(12, n) na API.
  if (value >= 10 ** (12 - rule.decimals)) return { value: null, error: "Valor alto demais" };
  return { value, error: null };
}

/** Quantidade no campo de edição ("1,5"; sem ponto de milhar para não confundir). */
export function quantityInput(value: number): string {
  return value.toLocaleString("pt-BR", { maximumFractionDigits: 3, useGrouping: false });
}

/**
 * Total da linha em centavos, como a API calcula: quantidade (3 casas) × valor (2 casas),
 * arredondado no centavo com metade para cima. Em inteiros, sem o erro do ponto flutuante.
 */
export function lineTotalCents(quantity: number, unitPrice: number): number {
  const milli = BigInt(Math.round(quantity * 1000));
  const cents = BigInt(Math.round(unitPrice * 100));
  return Number((milli * cents + BigInt(500)) / BigInt(1000));
}

/**
 * "AAAA-MM-DD" do dia no fuso da operação (São Paulo). A validade é um dia do calendário e a API a
 * confere nesse fuso: um computador em outro fuso, perto da meia-noite, veria outro dia.
 */
export function localDateISO(date: Date = new Date()): string {
  return dayKey(date);
}

/** Dia do calendário `days` dias depois de hoje na operação ("AAAA-MM-DD"). */
export function addDaysISO(days: number, from: Date = new Date()): string {
  const [year, month, day] = localDateISO(from).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Validade padrão de um orçamento novo ou renovado. */
export const QUOTE_VALID_DAYS = 7;

/** Link que o cliente abre (mesma origem do site; em produção, NEXT_PUBLIC_WEB_URL). */
export function quoteUrl(token: string): string {
  const base = (process.env.NEXT_PUBLIC_WEB_URL || window.location.origin).replace(/\/$/, "");
  return `${base}/orcamento/${token}`;
}

export const QUOTE_KIND: Record<QuoteItemKind, { label: string; plural: string }> = {
  product: { label: "Produto", plural: "Produtos" },
  service: { label: "Serviço", plural: "Serviços" },
  expense: { label: "Despesa", plural: "Despesas" },
};

/** Soma por tipo (usa o total da API quando vier; senão calcula pelos itens). */
export function totalsByKind(
  items: QuoteItem[],
  fromApi?: Record<QuoteItemKind, number> | null,
): Record<QuoteItemKind, number> {
  if (fromApi) return fromApi;
  const totals: Record<QuoteItemKind, number> = { product: 0, service: 0, expense: 0 };
  for (const item of items) totals[item.kind ?? "product"] += item.total;
  return totals;
}

// ---------------------------------------------------------------- datas curtas (fuso da operação)

const dayMonthFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: OPERATION_TZ, day: "2-digit", month: "2-digit" });
const dayTimeFmt = new Intl.DateTimeFormat("pt-BR", {
  timeZone: OPERATION_TZ,
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "24/11": a validade ("AAAA-MM-DD") sai como está; um horário, no dia da operação. */
export function dayMonth(value: string | null | undefined): string {
  if (!value) return "—";
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (day) return `${day[3]}/${day[2]}`;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : dayMonthFmt.format(d);
}

/** "18/11 14:05" (sem o ano e sem a vírgula). */
export function dayTime(value: string | null | undefined): string {
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return "—";
  const parts = dayTimeFmt.formatToParts(d);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("day")}/${part("month")} ${part("hour")}:${part("minute")}`;
}

/** Dias de `from` até `to` ("AAAA-MM-DD"); negativo quando `to` já passou. */
export function daysUntil(from: string, to: string): number {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

// ---------------------------------------------------------------- fila "Para cobrar" e acompanhamento

/** O cliente tem link para abrir (nasce no primeiro envio; cancelar derruba). */
export const hasClientLink = (q: Pick<Quote, "link" | "token">) => Boolean(q.link?.url || q.token);

/**
 * Motivo da fila "Para cobrar" (a regra é da API, a mesma do Início), em poucas palavras:
 * "Não aberto", "Aberto 2x, sem resposta", "Vence amanhã", "Em revisão: reenvie", "Venceu em 15/11: renove".
 */
export function followUpText(q: Quote, today: string): string | null {
  const reason: QuoteFollowUp | null | undefined = q.follow_up;
  switch (reason) {
    case "not_opened":
      return "Não aberto";
    case "no_answer": {
      // Sem link (enviado pelo Field Control) não há abertura para contar.
      const views = q.client_views ?? 0;
      return views > 0 ? `Aberto ${views}x, sem resposta` : "Sem resposta";
    }
    case "expiring":
      return q.valid_until && q.valid_until <= today ? "Vence hoje" : "Vence amanhã";
    case "in_review":
      return "Em revisão: reenvie";
    case "expired":
      return q.valid_until ? `Venceu em ${dayMonth(q.valid_until)}: renove` : "Venceu: renove";
    default:
      return null;
  }
}

/** Ação da linha na fila: cobrar o cliente, gerar o link, reenviar a revisão ou renovar a validade. */
export type FollowUpAction = "remind" | "link" | "send" | "renew";

/**
 * Espelha o que a API aceita: só se cobra o enviado, na validade e com link (POST /remind recusa os
 * demais). Sem motivo de cobrança, null: a linha fica com as ações de sempre.
 */
export function followUpAction(q: Quote, today: string): FollowUpAction | null {
  if (!q.follow_up) return null;
  const pastDue = Boolean(q.valid_until && q.valid_until < today);
  if (q.follow_up === "expired" || (q.follow_up === "in_review" && pastDue)) return "renew";
  if (q.follow_up === "in_review") return "send";
  if (q.status !== "sent") return null;
  if (!hasClientLink(q)) return "link";
  return pastDue ? "renew" : "remind";
}

/** Ainda espera o cliente: enviado, vencido sem resposta ou em revisão depois de enviado. */
const awaitingClient = (q: Quote) => q.status === "sent" || q.status === "expired" || (q.status === "draft" && Boolean(q.sent_at));

/**
 * Acompanhamento do link: "enviado 12/11 · aberto 2x · cobrado 1x" (com link e nenhuma abertura,
 * "não aberto"). `sent: false` tira o "enviado" quando a data já está ao lado.
 */
export function trackingText(q: Quote, { sent = true }: { sent?: boolean } = {}): string {
  const views = q.client_views ?? 0;
  const reminders = q.reminder_count ?? 0;
  return [
    sent && q.sent_at ? `enviado ${dayMonth(q.sent_at)}` : null,
    views > 0 ? `aberto ${views}x` : awaitingClient(q) && hasClientLink(q) ? "não aberto" : null,
    reminders > 0 ? `cobrado ${reminders}x` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Para o title: "1ª abertura 17/11 10:02 · última 18/11 14:40 · última cobrança 18/11 12:00 por Nome". */
export function trackingTitle(q: Quote): string | undefined {
  const first = q.client_first_viewed_at;
  const last = q.client_last_viewed_at;
  const parts = [
    first ? `1ª abertura ${dayTime(first)}` : null,
    last && last !== first ? `última ${dayTime(last)}` : null,
    q.last_reminded_at ? `última cobrança ${dayTime(q.last_reminded_at)}${q.last_reminded_by ? ` por ${q.last_reminded_by.name}` : ""}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

// ---------------------------------------------------------------- mensagens para o cliente (texto puro)

/** O que a mensagem precisa da OS: o código, o cliente e a loja. */
export interface QuoteMessageTicket {
  code: string;
  customer?: { name: string } | null;
  location?: { name: string } | null;
}

/** Sem acento e em minúsculas, para comparar nomes ("Loja São Paulo" = "loja sao paulo"). */
const plain = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** "Troca de fonte (Loja Centro)": a loja entra só quando o título ainda não a cita. */
export function titleWithStore(title: string, store: string | null | undefined): string {
  const name = store?.trim();
  if (!name || plain(title).includes(plain(name))) return title;
  return `${title} (${name})`;
}

/** Valor em texto corrido: o espaço depois do "R$" vira comum (o Intl usa o não separável). */
const moneyPlain = (value: number) => formatMoney(value).replace(/\s/g, " ");

/** Primeira linha, no formato dos textos de grupo: "*OS-001234* · Cliente". */
function messageHead(ticket: QuoteMessageTicket): string {
  const customer = ticket.customer?.name?.trim();
  return customer ? `*${ticket.code}* · ${customer}` : `*${ticket.code}*`;
}

/** "ORC-000123 · Troca de fonte (Loja Centro)". */
const quoteName = (q: Quote, ticket: QuoteMessageTicket) => `${q.code} · ${titleWithStore(q.title, ticket.location?.name)}`;

const validity = (q: Quote) => (q.valid_until ? ` · válido até ${dayMonth(q.valid_until)}` : "");

/** Assunto do e-mail: "Orçamento ORC-000123 · Troca de fonte (Loja Centro)". */
export function quoteSubject(q: Quote, ticket: QuoteMessageTicket): string {
  return `Orçamento ${quoteName(q, ticket)}`;
}

/** Envio do link: pede a aprovação; já respondido, só manda para consulta. */
export function quoteMessage(q: Quote, ticket: QuoteMessageTicket, url: string): string {
  const head = messageHead(ticket);
  if (q.status === "approved" || q.status === "rejected") {
    const verb = q.status === "approved" ? "aprovado" : "recusado";
    return `${head}\nOrçamento ${quoteName(q, ticket)}, ${verb}${q.decided_at ? ` em ${dayMonth(q.decided_at)}` : ""}.\nPara consultar: ${url}`;
  }
  return `${head}\nOrçamento ${quoteName(q, ticket)}\n${moneyPlain(q.total)}${validity(q)}\nPara aprovar com assinatura ou recusar: ${url}`;
}

/** Cobrança: lembrete com o valor e a validade ("(vence hoje)" ou "(vence amanhã)" no fim do prazo). */
export function reminderMessage(q: Quote, ticket: QuoteMessageTicket, url: string, today: string): string {
  const days = q.valid_until ? daysUntil(today, q.valid_until) : null;
  const due = days === 0 ? " (vence hoje)" : days === 1 ? " (vence amanhã)" : "";
  return (
    `${messageHead(ticket)}\nLembrete: o orçamento ${quoteName(q, ticket)} aguarda aprovação.\n` +
    `${moneyPlain(q.total)}${validity(q)}${due}\nPara aprovar ou recusar: ${url}`
  );
}

/** Endereço de "Ver como o cliente": a prévia (?preview=1) não conta como abertura do cliente. */
export function previewHref(pathOrUrl: string): string {
  return `${pathOrUrl}${pathOrUrl.includes("?") ? "&" : "?"}preview=1`;
}
