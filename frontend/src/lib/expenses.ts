// Custos extras: rótulos (espelha EXPENSE_KIND_LABEL em backend/app/schemas/expense.py).

import type { ExpenseKind, ExpenseStatus } from "./types";

export const EXPENSE_KIND: Record<ExpenseKind, { label: string; unit: string }> = {
  material: { label: "Material", unit: "un." },
  km: { label: "Km rodado", unit: "km" },
  toll: { label: "Pedágio", unit: "un." },
  parking: { label: "Estacionamento", unit: "un." },
  transport: { label: "Transporte", unit: "un." },
  meal: { label: "Alimentação", unit: "un." },
  other: { label: "Outro", unit: "un." },
};

/**
 * Situação do custo. `color` vai no <Pill> (cinza no lançado, que só espera a gestão; vermelho só no
 * recusado); `className` segue para as telas que ainda pintam a etiqueta com classes.
 */
export const EXPENSE_STATUS: Record<ExpenseStatus, { label: string; className: string; color: string }> = {
  pending: { label: "Lançado", className: "bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-300", color: "#64748b" },
  approved: { label: "Aprovado", className: "bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300", color: "#2447ff" },
  paid: { label: "Reembolsado", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300", color: "#10b981" },
  rejected: { label: "Recusado", className: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300", color: "#dc2626" },
};
