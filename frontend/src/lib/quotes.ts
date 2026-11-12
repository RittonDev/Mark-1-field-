import type { QuoteItem, QuoteItemKind, QuoteStatus } from "./types";

export const QUOTE_STATUS: Record<QuoteStatus, { label: string; className: string }> = {
  draft: { label: "Rascunho", className: "bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-300" },
  sent: { label: "Aguardando cliente", className: "bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300" },
  approved: { label: "Aprovado", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300" },
  rejected: { label: "Recusado", className: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300" },
  expired: { label: "Vencido", className: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300" },
  cancelled: { label: "Cancelado", className: "bg-slate-100 text-slate-500 dark:bg-slate-500/15 dark:text-slate-400" },
};

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
