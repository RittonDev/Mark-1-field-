// Meses dos seletores de período (Orçamentos e Relatórios): do atual até o começo do histórico, para dar
// para chegar a qualquer mês com dados (antes eram só os últimos 24, e a migração vai mais longe).

/** Primeiro mês com dados: a primeira OS migrada do Field Control. */
export const HISTORY_START = "2022-09";

/** "2026-11", "2026-10", ... até HISTORY_START (ou só o mês atual, se ele vier antes). */
export function historyMonths(current: string): string[] {
  const [y, m] = current.split("-").map(Number);
  const out: string[] = [];
  for (let i = 0; ; i++) {
    const value = new Date(Date.UTC(y, m - 1 - i, 15)).toISOString().slice(0, 7);
    if (i > 0 && value < HISTORY_START) break;
    out.push(value);
  }
  return out;
}

/** "Novembro de 2026". */
export function monthLabel(value: string): string {
  const [y, m] = value.split("-").map(Number);
  const label = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 15)));
  return label.charAt(0).toUpperCase() + label.slice(1);
}
