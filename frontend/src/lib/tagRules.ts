"use client";

// Etiquetas automáticas das OS (como no Field Control): a OS nova já sai com as etiquetas de criação
// (as de projeto, quando é de um projeto), o custo extra lançado põe as dele e, quando os pagamentos
// ao técnico da OS ficam todos pagos, as de pagamento pendente saem. A gestão configura em
// Configurações (GET/PUT /ticket-tag-rules).

import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "./api";

/** Etiqueta com a cor do Field Control (null: sem cor). */
export type TagRule = { name: string; color: string | null };

export type TicketTagRules = {
  /** OS nova sem projeto (avulsa). */
  on_create: TagRule[];
  /** OS nova de projeto (no lugar das de criação). */
  on_project: TagRule[];
  /** Entram na OS quando um custo extra é lançado nela (só as que faltam). */
  on_extra_cost: TagRule[];
  /** Nomes que saem da OS quando os pagamentos ao técnico dela ficam todos pagos. */
  remove_on_payout_paid: string[];
};

/** As regras de quando a gestão ainda não configurou nada (as mesmas do servidor). */
export const DEFAULT_TAG_RULES: TicketTagRules = {
  on_create: [
    { name: "Pendente Envio PGTO", color: "field-pale" },
    { name: "Ticket Avulso", color: "green" },
  ],
  on_project: [{ name: "Projeto", color: "purple" }],
  on_extra_cost: [{ name: "Custo Extra", color: "yellow" }],
  remove_on_payout_paid: ["Pendente Envio PGTO"],
};

/** Cores aceitas nas etiquetas (nomes do Field Control); a API recusa outra. */
export const TAG_COLOR_NAMES: string[] = [
  "green",
  "pink",
  "yellow",
  "indigo",
  "purple",
  "field-pale",
  "light-blue",
  "brown",
  "red",
  "blue-grey",
  "blue",
  "teal",
  "orange",
  "grey",
];

/** Busca das regras: a mesma chave na Nova OS e nas Configurações (salvar atualiza as duas). */
export const tagRulesQuery = queryOptions({
  queryKey: ["ticket-tag-rules"],
  queryFn: ({ signal }) => api.get<TicketTagRules>("/ticket-tag-rules", undefined, { signal }),
  staleTime: 60_000,
});

/** Regras em vigor. Sem resposta da API (erro, sem permissão, servidor sem a rota), valem as padrão. */
export function useTagRules(): { rules: TicketTagRules; isLoading: boolean } {
  const query = useQuery(tagRulesQuery);
  return { rules: query.data ?? DEFAULT_TAG_RULES, isLoading: query.isLoading };
}
