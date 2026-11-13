import type { QuoteItem, QuoteItemKind, QuoteStatus } from "./types";

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
  // Sem vírgula, ponto em grupos de 3 é milhar ("1.000" = mil); fora disso, é decimal ("1.5").
  if (/^-?\d{1,3}(\.\d{3})+$/.test(raw)) return raw.replace(/\./g, "");
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

/** "AAAA-MM-DD" do dia no fuso de quem está usando (a validade é um dia do calendário). */
export function localDateISO(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Dia do calendário daqui a `days` dias ("AAAA-MM-DD"). */
export function addDaysISO(days: number, from: Date = new Date()): string {
  return localDateISO(new Date(from.getFullYear(), from.getMonth(), from.getDate() + days));
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
