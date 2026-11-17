// Colunas da lista de chamados. As padrão são as da lista de atividades do Field Control; as outras a
// pessoa liga em "Colunas" e a escolha fica guardada neste navegador.

import { useState } from "react";
import { readStored, writeStored } from "@/components/new-ticket/storage";

export type ColumnKey =
  | "tags"
  | "scheduled"
  | "customer"
  | "location"
  | "status"
  | "priority"
  | "title"
  | "technician"
  | "owner"
  | "sla"
  | "created"
  | "texts";

/** Ordem da API ao clicar no cabeçalho: o campo e a direção do primeiro clique. */
export interface ColumnSort {
  field: string;
  first: "asc" | "desc";
}

export interface ColumnDef {
  key: ColumnKey;
  label: string;
  /** Aparece sem a pessoa escolher (as colunas da lista do Field Control). */
  initial: boolean;
  sort?: ColumnSort;
  /** Só para quem gerencia as OS (a fila de cada analista). */
  managerOnly?: boolean;
}

/** O identificador fica sempre (é o que se fala da OS) e ordena a lista do maior para o menor. */
export const IDENTIFIER_SORT: ColumnSort = { field: "number", first: "desc" };

/** Todas as colunas, na ordem em que aparecem na tabela (depois do identificador). */
export const COLUMNS: ColumnDef[] = [
  { key: "tags", label: "Etiquetas", initial: true },
  { key: "scheduled", label: "Data do agendamento", initial: true, sort: { field: "scheduled_start", first: "asc" } },
  { key: "customer", label: "Cliente", initial: true, sort: { field: "customer", first: "asc" } },
  { key: "location", label: "Localização", initial: true },
  { key: "status", label: "Situação", initial: false },
  { key: "priority", label: "Prioridade", initial: false, sort: { field: "priority", first: "asc" } },
  { key: "title", label: "Título", initial: false },
  { key: "technician", label: "Técnico", initial: false },
  { key: "owner", label: "Analista", initial: false, managerOnly: true },
  { key: "sla", label: "Prazo (SLA)", initial: false, sort: { field: "resolution_due_at", first: "asc" } },
  { key: "created", label: "Criada em", initial: false, sort: { field: "created_at", first: "desc" } },
  { key: "texts", label: "Textos para o grupo", initial: false },
];

const STORAGE_KEY = "maxx.chamados.colunas";
const INITIAL: ColumnKey[] = COLUMNS.filter((c) => c.initial).map((c) => c.key);

const sameAsInitial = (keys: ColumnKey[]) => keys.length === INITIAL.length && INITIAL.every((k) => keys.includes(k));

/** O que está guardado, só com colunas que ainda existem (null: nada guardado ou guardado com defeito). */
function readColumns(): ColumnKey[] | null {
  const stored = readStored<unknown>("local", STORAGE_KEY);
  if (!Array.isArray(stored)) return null;
  return COLUMNS.filter((c) => stored.includes(c.key)).map((c) => c.key);
}

/** O campo e a direção de uma ordem da API ("-number" -> number, desc). */
export function splitOrder(order: string): { field: string; dir: "asc" | "desc" } {
  return order.startsWith("-") ? { field: order.slice(1), dir: "desc" } : { field: order, dir: "asc" };
}

/** Colunas à vista: a escolha guardada neste navegador ou as padrão. */
export function useColumns(manager: boolean) {
  const [stored, setStored] = useState<ColumnKey[] | null>(readColumns);
  const chosen = stored ?? INITIAL;
  const available = COLUMNS.filter((c) => manager || !c.managerOnly);
  const visible = available.filter((c) => chosen.includes(c.key));

  // Voltou a ser igual ao padrão: nada fica guardado (a lista acompanha o padrão se ele mudar).
  const save = (next: ColumnKey[] | null) => {
    const value = next && !sameAsInitial(next) ? next : null;
    setStored(value);
    writeStored("local", STORAGE_KEY, value);
  };

  return {
    /** Colunas que a pessoa pode ligar e desligar. */
    available,
    visible,
    isVisible: (key: ColumnKey) => visible.some((c) => c.key === key),
    isDefault: sameAsInitial(chosen),
    toggle: (key: ColumnKey) => save(chosen.includes(key) ? chosen.filter((k) => k !== key) : [...chosen, key]),
    reset: () => save(null),
  };
}
