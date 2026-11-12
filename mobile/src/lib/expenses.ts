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
