// Filtros da API (ListFilters) -> endereço da lista de Chamados. Todo o mapeamento fica aqui: se a lista
// mudar o nome de um parâmetro, só este arquivo muda. Os nomes seguem o que a lista lê em
// app/(app)/chamados/_lista/params.ts (readListState).

import type { ListFilters } from "./types";

/** Abas da lista (parâmetro "view"). */
type ListView = "abertos" | "minhas" | "sem_tecnico" | "sla" | "todas";

/** Técnico que atuou na OS (o atual, quem foi junto ou quem já foi o responsável): filtro da lista. */
const TECHNICIAN_PARAM = "technician_id";

/** Endereço de uma aba da lista, sem filtros (ex.: "Minhas OS"). */
export function ticketsViewHref(view: ListView): string {
  return view === "abertos" ? "/chamados" : `/chamados?view=${view}`;
}

/**
 * Aba que mostra o que os filtros pedem. A aba sempre vai escrita: sem ela, a lista escolheria sozinha
 * ("Em aberto" para uma busca só de texto), e o número de OS não bateria com o que a busca contou.
 */
function viewFor(f: ListFilters): ListView {
  if (f.sla_breached) return "sla";
  if (f.unassigned) return "sem_tecnico";
  if (f.open_only) return "abertos";
  // A fila sem analista é sempre das OS em aberto (como na Minha fila).
  if (f.no_owner) return "abertos";
  return "todas";
}

/** Endereço da lista de Chamados com os filtros da API. */
export function ticketsListHref(f: ListFilters): string {
  const params = new URLSearchParams();
  const view = viewFor(f);
  if (view !== "abertos") params.set("view", view);
  const list = (key: string, values: string[] | undefined) => values?.forEach((v) => v && params.append(key, v));
  const one = (key: string, value: string | number | undefined | null) => {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  };
  const flag = (key: string, value: boolean | undefined) => {
    if (value) params.set(key, "true");
  };

  list("status", f.status);
  list("priority", f.priority);
  one("number", f.number);
  one("customer_id", f.customer_id);
  one("location_id", f.location_id);
  one("assignee_id", f.assignee_id);
  // O técnico responsável escolhido vale mais que o "atuou na OS" quando os dois caem no mesmo parâmetro.
  if (!params.has(TECHNICIAN_PARAM)) one(TECHNICIAN_PARAM, f.technician_id);
  one("owner_id", f.owner_id);
  list("tag", f.tag);
  one("created_from", f.created_from);
  one("created_to", f.created_to);
  one("scheduled_from", f.scheduled_from);
  one("scheduled_to", f.scheduled_to);
  flag("no_owner", f.no_owner);
  flag("violation_pending", f.violation_pending);
  one("q", f.q?.trim());

  const query = params.toString();
  return query ? `/chamados?${query}` : "/chamados";
}

/** Endereço interno (nunca outro site, nem "//site"). */
const isInternal = (link: string) => link.startsWith("/") && !link.startsWith("//") && !link.startsWith("/\\");

/**
 * Destino de um ponto de atenção ou sugestão: a tela própria quando há (Custos, Pagamentos,
 * Solicitações, Orçamentos), senão a lista de Chamados com os filtros.
 */
export function targetHref(target: { filters: ListFilters | null; link: string | null }): string | null {
  if (target.link && isInternal(target.link)) return target.link;
  return target.filters ? ticketsListHref(target.filters) : null;
}
