// Seções do Histórico de atendimentos (app/historico.tsx): junta as páginas de GET /me/history (por cursor) sem repetir e
// agrupa as OS pelo mês da conclusão, com o total do mês que o servidor mandou. Puro e sem import: as sondas em Node
// importam direto (mobile/tests/history-sections.test.mjs).

/** O total de um mês ("2026-11"), como vem em MyHistoryPage.months. */
export interface MonthCount {
  month: string;
  count: number;
}

/** Uma seção da lista: o mês, o número que aparece no cabeçalho e as OS carregadas dele. */
export interface HistorySection<T> {
  month: string;
  count: number;
  data: T[];
}

/** A lista com os itens da página nova que ainda não estavam nela (pelo id), na ordem em que chegaram. */
export function mergeItems<T extends { id: string }>(current: T[], next: T[]): T[] {
  const seen = new Set(current.map((item) => item.id));
  const added: T[] = [];
  for (const item of next) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    added.push(item);
  }
  return added.length ? [...current, ...added] : current;
}

/** Os totais por mês: o da página mais nova vale; os meses que ainda não estavam entram no fim. */
export function mergeCounts(current: MonthCount[], next: MonthCount[]): MonthCount[] {
  const fresh = new Map(next.map((entry) => [entry.month, entry.count]));
  const merged = current.map((entry) => {
    const count = fresh.get(entry.month);
    return count === undefined ? entry : { month: entry.month, count };
  });
  const known = new Set(current.map((entry) => entry.month));
  for (const entry of next) {
    if (known.has(entry.month)) continue;
    known.add(entry.month);
    merged.push({ month: entry.month, count: entry.count });
  }
  return merged;
}

/**
 * As seções na ordem da lista: uma por sequência de itens do mesmo mês. O número de cada uma é o total do mês que o
 * servidor mandou, ou o de itens já carregados quando o total é menor ou não veio.
 */
export function historySections<T extends { month: string }>(items: T[], counts: MonthCount[]): HistorySection<T>[] {
  const totals = new Map(counts.map((entry) => [entry.month, entry.count]));
  const sections: HistorySection<T>[] = [];
  for (const item of items) {
    const last = sections[sections.length - 1];
    if (last && last.month === item.month) last.data.push(item);
    else sections.push({ month: item.month, count: 0, data: [item] });
  }
  for (const section of sections) section.count = Math.max(totals.get(section.month) ?? 0, section.data.length);
  return sections;
}
