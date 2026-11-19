// Custos extras da OS (reembolso ao técnico). A gestão lança; o técnico só vê.

import type { ExpenseKind, ExpenseStatus } from "./types";

export const EXPENSE_KIND: Record<ExpenseKind, string> = {
  material: "Material",
  km: "Km rodado",
  toll: "Pedágio",
  parking: "Estacionamento",
  transport: "Transporte",
  meal: "Alimentação",
  other: "Outro",
};

export const EXPENSE_STATUS: Record<ExpenseStatus, { label: string; tone: "muted" | "info" | "success" | "danger" }> = {
  pending: { label: "Lançado", tone: "muted" },
  approved: { label: "Aprovado", tone: "info" },
  paid: { label: "Reembolsado", tone: "success" },
  rejected: { label: "Recusado", tone: "danger" },
};

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const qty = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });

export const formatBRL = (value: number) => brl.format(value ?? 0);
export const formatQty = (value: number) => qty.format(value ?? 0);

/**
 * Valor em reais digitado ("1.234,56", "1234,56", "1234.56", "R$ 900") → número; vazio ou fora do formato → null. A
 * vírgula é sempre a dos centavos. O ponto separa milhares ("1.500" = 1500), a não ser que seja o único e venha com 1
 * ou 2 casas depois ("900.5", do teclado numérico de alguns Androids). Três casas depois da vírgula ("1,500") é ambíguo
 * e não passa.
 */
export function parseBRL(text: string): number | null {
  const raw = text
    .replace(/R\$/gi, "")
    .replace(/\s/g, "")
    .replace(/[.,]$/, "");
  if (!/^\d[\d.,]*$/.test(raw)) return null;
  let integer = raw;
  let cents = "";
  const comma = raw.indexOf(",");
  if (comma >= 0) {
    integer = raw.slice(0, comma);
    cents = raw.slice(comma + 1);
    if (!/^\d{1,2}$/.test(cents)) return null;
  } else {
    const dot = raw.lastIndexOf(".");
    if (dot >= 0 && raw.indexOf(".") === dot && /^\d{1,2}$/.test(raw.slice(dot + 1))) {
      integer = raw.slice(0, dot);
      cents = raw.slice(dot + 1);
    }
  }
  if (integer.includes(".") && !/^\d{1,3}(\.\d{3})+$/.test(integer)) return null;
  const value = Number(integer.replace(/\./g, "")) + Number(cents.padEnd(2, "0")) / 100;
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}
