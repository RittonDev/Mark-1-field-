// Planilha da lista de chamados com os filtros de agora (fechamento, cobrança por etiqueta).

import { api, type Query } from "@/lib/api";
import { PRIORITY, SLA_STATUS, STATUS, TICKET_TYPE } from "@/lib/constants";
import { downloadCsv } from "@/lib/download";
import { formatDateTime, todayISO } from "@/lib/format";
import type { Page, TicketListItem } from "@/lib/types";
import { SOURCES } from "./params";

/** Páginas grandes (o máximo da API) até completar o filtro. */
const EXPORT_PAGE = 500;
/** Acima disto, pergunta antes (a planilha fica grande e leva alguns segundos). */
export const EXPORT_CONFIRM_ABOVE = 5_000;

const when = (value: string | null | undefined) => (value ? formatDateTime(value) : "");

/**
 * Busca todas as OS do filtro, uma página por vez. `confirmLarge` decide, depois da 1ª página, se segue
 * com um total grande; devolve null quando a pessoa desiste.
 */
export async function fetchTicketsForExport(
  query: Query,
  onProgress: (done: number, total: number) => void,
  confirmLarge: (total: number) => Promise<boolean>,
): Promise<TicketListItem[] | null> {
  const first = await api.get<Page<TicketListItem>>("/tickets", { ...query, page: 1, page_size: EXPORT_PAGE });
  if (first.total > EXPORT_CONFIRM_ABOVE && !(await confirmLarge(first.total))) return null;
  // Por id: uma OS aberta durante a exportação empurra as páginas e não pode sair repetida.
  const rows = new Map(first.items.map((t) => [t.id, t]));
  onProgress(rows.size, first.total);
  const pages = Math.ceil(first.total / EXPORT_PAGE);
  for (let page = 2; page <= pages; page += 1) {
    const chunk = await api.get<Page<TicketListItem>>("/tickets", { ...query, page, page_size: EXPORT_PAGE });
    for (const t of chunk.items) rows.set(t.id, t);
    onProgress(Math.min(rows.size, first.total), first.total);
    if (chunk.items.length < EXPORT_PAGE) break;
  }
  return [...rows.values()];
}

export function downloadTicketsCsv(rows: TicketListItem[]): void {
  downloadCsv(`chamados-${todayISO()}.csv`, [
    [
      "OS",
      "Nº do chamado do cliente",
      "Título",
      "Status",
      "Prioridade",
      "Tipo de atendimento",
      "Origem",
      "Cliente",
      "Código da loja",
      "Loja",
      "Cidade",
      "UF",
      "Técnico",
      "Outros técnicos",
      "Grupo",
      "Analista",
      "Projeto",
      "Agendada para",
      "Fim previsto",
      "Prazo de solução",
      "SLA",
      "Etiquetas",
      "Aberta em",
      "Resolvida em",
      "Atualizada em",
    ],
    ...rows.map((t) => [
      t.code,
      t.client_reference ?? "",
      t.title,
      STATUS[t.status]?.label ?? t.status,
      `${PRIORITY[t.priority].code} · ${PRIORITY[t.priority].label}`,
      TICKET_TYPE[t.type] ?? t.type,
      SOURCES.find((s) => s.value === t.source)?.label ?? t.source,
      t.customer?.name ?? t.requester_name ?? "",
      t.location?.code ?? "",
      t.location?.name ?? "",
      t.location?.city ?? "",
      t.location?.state ?? "",
      t.assignee?.name ?? "",
      (t.helpers ?? []).map((h) => h.name).join(", "),
      t.team?.name ?? "",
      t.owner?.name ?? "",
      t.project ? `${t.project.code} · ${t.project.name}` : "",
      when(t.scheduled_start),
      when(t.scheduled_end),
      when(t.resolution_due_at),
      SLA_STATUS[t.sla_status]?.label ?? t.sla_status,
      (t.tags ?? []).map((tag) => tag.name).join(", "),
      when(t.created_at),
      when(t.resolved_at),
      when(t.updated_at),
    ]),
  ]);
}
