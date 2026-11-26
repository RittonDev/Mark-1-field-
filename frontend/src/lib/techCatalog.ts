// Os três catálogos de Configurações › Técnicos (Áreas de atuação, Aptidões e Ferramental): os textos e a rota de cada
// um, o nome como o servidor grava e compara, quando dá para excluir e as linhas de uso do diálogo. Puro e só com
// `import type` (a sonda tests/tech-catalog.test.mjs roda direto no Node): o `max` de cada um é a cópia de
// CATALOG_LIMITS de lib/constants.ts, que a sonda confere.

import type { TechCatalogItem, TechCatalogKind } from "./types";

export interface TechCatalogConfig {
  /** O título do cartão. */
  title: string;
  /** A coluna do nome na tabela. */
  column: string;
  /** O botão de incluir e o título do diálogo. */
  newLabel: string;
  editTitle: string;
  /** O rótulo e o placeholder da busca. */
  search: string;
  /** O catálogo vazio. */
  empty: string;
  /** A busca sem resultado. */
  noMatch: string;
  /** O nome repetido (sem acento e sem maiúsculas, também entre os desativados). */
  duplicate: string;
  /** Nos avisos: "Área “Redes” cadastrada" (as três palavras são femininas). */
  noun: string;
  /** A rota da API. */
  path: string;
  /** A chave da consulta (useTechCatalog). */
  queryKey: string;
  /** O filtro da lista de Técnicos (/tecnicos?{listParam}={id}). */
  listParam: string;
  /** Quantos o catálogo aceita (ativos e desativados). */
  max: number;
}

export const TECH_CATALOGS: Record<TechCatalogKind, TechCatalogConfig> = {
  areas: {
    title: "Áreas de atuação",
    column: "Área",
    newLabel: "Nova área",
    editTitle: "Editar área",
    search: "Buscar área",
    empty: "Nenhuma área cadastrada",
    noMatch: "Nenhuma área com este nome.",
    duplicate: "Já existe uma área com este nome.",
    noun: "Área",
    path: "/technician-areas",
    queryKey: "technician-areas",
    listParam: "area",
    max: 100,
  },
  skills: {
    title: "Aptidões",
    column: "Aptidão",
    newLabel: "Nova aptidão",
    editTitle: "Editar aptidão",
    search: "Buscar aptidão",
    empty: "Nenhuma aptidão cadastrada",
    noMatch: "Nenhuma aptidão com este nome.",
    duplicate: "Já existe uma aptidão com este nome.",
    noun: "Aptidão",
    path: "/technician-skills",
    queryKey: "technician-skills",
    listParam: "aptidao",
    max: 300,
  },
  tools: {
    title: "Ferramental",
    column: "Ferramenta",
    newLabel: "Nova ferramenta",
    editTitle: "Editar ferramenta",
    search: "Buscar ferramenta",
    empty: "Nenhuma ferramenta cadastrada",
    noMatch: "Nenhuma ferramenta com este nome.",
    duplicate: "Já existe uma ferramenta com este nome.",
    noun: "Ferramenta",
    path: "/technician-tools",
    queryKey: "technician-tools",
    listParam: "ferramenta",
    max: 200,
  },
};

/** Os três na ordem da tela. */
export const TECH_CATALOG_ORDER: readonly TechCatalogKind[] = ["areas", "skills", "tools"];

/** Nome: de 2 a 80 caracteres, depois de limpo (= CATALOG_LIMITS.name). */
export const CATALOG_NAME = { min: 2, max: 80 } as const;

/** Tab, LF, VT, FF e CR viram espaço; os outros controles e os caracteres de formatação (invisíveis) saem. */
const CONTROL_SPACE = /[\t\n\v\f\r]/g;
const CONTROL = /[\p{Cc}\p{Cf}]/gu;

/** O nome como o servidor grava (core/text.clean): sem invisíveis, NFC e espaços juntados. */
export function cleanCatalogName(text: string): string {
  return text.replace(CONTROL_SPACE, " ").replace(CONTROL, "").normalize("NFC").trim().replace(/\s+/g, " ");
}

/** A chave do nome (core/text.fold, o `name_key` do banco): sem acento, sem maiúsculas e com os espaços juntados. */
export function catalogNameKey(text: string): string {
  return cleanCatalogName(text).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/** O mesmo nome para o catálogo: "Multímetro" e " multimetro " são o mesmo (409 no servidor). */
export function sameCatalogName(a: string, b: string): boolean {
  return catalogNameKey(a) === catalogNameKey(b);
}

/** Tamanho em caracteres, como o servidor conta. */
export function catalogNameLength(text: string): number {
  return Array.from(cleanCatalogName(text)).length;
}

/** "1 técnico", "3 técnicos", "1.006 técnicos". */
function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("pt-BR")} ${n === 1 ? one : many}`;
}

/** Excluir só o que nunca foi usado: `in_use` falso (null para o técnico; ausente na API de antes: não exclui). */
export function canDeleteCatalogItem(item: Pick<TechCatalogItem, "in_use">): boolean {
  return item.in_use === false;
}

/**
 * O uso no diálogo de editar: "Em uso: 3 técnicos e 1 ficha." · "Em uso: 1 técnico." · "Em uso: 2 fichas."; sem
 * ninguém agora mas já usado, "Já foi usada: desative para tirar das escolhas."; nunca usado (dá para excluir), null.
 */
export function catalogUsageText(item: Pick<TechCatalogItem, "technicians" | "applications" | "in_use">): string | null {
  const technicians = item.technicians ?? 0;
  const applications = item.applications ?? 0;
  const parts = [
    technicians > 0 ? plural(technicians, "técnico", "técnicos") : null,
    applications > 0 ? plural(applications, "ficha", "fichas") : null,
  ].filter(Boolean);
  if (parts.length) return `Em uso: ${parts.join(" e ")}.`;
  return item.in_use ? "Já foi usada: desative para tirar das escolhas." : null;
}

/** Renomear: "Muda também para 3 técnicos."; sem ninguém, null. */
export function renameHint(technicians: number | null | undefined): string | null {
  const n = technicians ?? 0;
  return n > 0 ? `Muda também para ${plural(n, "técnico", "técnicos")}.` : null;
}

/**
 * Desativar: "Sai das escolhas e fica guardada em 3 técnicos."; reativar: "Volta para 3 técnicos."; sem mudança ou sem
 * ninguém, null.
 */
export function activeHint(wasActive: boolean, nowActive: boolean, technicians: number | null | undefined): string | null {
  const n = technicians ?? 0;
  if (wasActive === nowActive || n <= 0) return null;
  const who = plural(n, "técnico", "técnicos");
  return nowActive ? `Volta para ${who}.` : `Sai das escolhas e fica guardada em ${who}.`;
}

/** A contagem de técnicos da tabela vira o link da lista filtrada: só do item ativo, com alguém (a lista só filtra pelos ativos). */
export function catalogListHref(kind: TechCatalogKind, item: Pick<TechCatalogItem, "id" | "is_active" | "technicians">): string | null {
  if (!item.is_active || !item.technicians) return null;
  return `/tecnicos?${TECH_CATALOGS[kind].listParam}=${encodeURIComponent(item.id)}`;
}
