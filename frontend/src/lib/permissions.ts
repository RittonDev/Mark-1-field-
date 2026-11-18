"use client";

// Perfis de acesso: o nível de cada tela (Sem acesso, Visualizar, Editar) e as filas que a pessoa vê.
// Espelha backend/app/core/permissions.py. A API é quem decide (403); aqui a central só esconde o que
// não pode e mostra a tela "Sem acesso" no lugar da página.

import { ApiError, apiErrorCode } from "./api";
import { useAuth } from "./auth";
import type {
  AccessItemKey,
  AccessLevel,
  AccessModuleKey,
  EffectiveAccess,
  QueueScope,
  User,
  UserRole,
} from "./types";

// ------------------------------------------------------------------ níveis

export const ACCESS_LEVELS: AccessLevel[] = ["none", "view", "edit"];

export const LEVEL_LABEL: Record<AccessLevel, string> = {
  none: "Sem acesso",
  view: "Visualizar",
  edit: "Editar",
};

/** O que cada nível deixa fazer (title das colunas da matriz). */
export const LEVEL_HINT: Record<AccessLevel, string> = {
  none: "A tela some do menu e da busca",
  view: "Abre a tela e consulta, sem alterar",
  edit: "Consulta, cria, altera e exclui",
};

export const LEVEL_RANK: Record<AccessLevel, number> = { none: 0, view: 1, edit: 2 };

const FULL: AccessLevel[] = ["none", "view", "edit"];
const VIEW_ONLY: AccessLevel[] = ["none", "view"];

// ------------------------------------------------------------------ catálogo (ordem do menu)

export const MODULE_LABEL: Record<AccessModuleKey, string> = {
  operation: "Operação",
  commercial: "Comercial",
  base: "Base",
  analysis: "Análise",
  setup: "Configuração",
};

export const ACCESS_MODULES: AccessModuleKey[] = ["operation", "commercial", "base", "analysis", "setup"];

export interface AccessItemDef {
  key: AccessItemKey;
  module: AccessModuleKey;
  label: string;
  href: string;
  levels: AccessLevel[];
  hint?: string;
}

/** Uma tela do catálogo: a chave diz o módulo ("commercial.payouts" é do Comercial). */
function catalogItem(key: AccessItemKey, label: string, href: string, levels: AccessLevel[], hint?: string): AccessItemDef {
  return { key, module: key.split(".")[0] as AccessModuleKey, label, href, levels, hint };
}

export const ACCESS_ITEMS: AccessItemDef[] = [
  catalogItem("operation.calendar", "Calendário", "/agenda", FULL, "Editar: remarcar arrastando"),
  catalogItem("operation.day", "Atividades do dia", "/dia", VIEW_ONLY),
  catalogItem("operation.map", "Mapa ao vivo", "/mapa", VIEW_ONLY),
  catalogItem("operation.repairs", "Assistência externa", "/assistencia", FULL),
  catalogItem("commercial.quotes", "Orçamentos", "/orcamentos", FULL, "Inclui a aba Orçamentos da OS"),
  catalogItem("commercial.projects", "Projetos", "/projetos", FULL),
  catalogItem("commercial.expenses", "Custos extras", "/custos", FULL, "Inclui os custos da OS"),
  catalogItem("commercial.payouts", "Pagamentos", "/pagamentos", FULL, "Inclui o valor do técnico na OS"),
  catalogItem("base.customers", "Clientes", "/clientes", FULL),
  catalogItem("base.locations", "Locais", "/locais", FULL),
  catalogItem("base.technicians", "Técnicos", "/tecnicos", FULL, "Editar inclui Liberar acesso"),
  catalogItem("base.onboarding", "Homologação", "/homologacao", FULL),
  catalogItem("analysis.dashboard", "Dashboard", "/dashboard", VIEW_ONLY),
  catalogItem("analysis.reports", "Relatórios", "/relatorios", VIEW_ONLY),
  catalogItem("setup.forms", "Formulários", "/formularios", FULL),
  catalogItem("setup.messages", "Textos do WhatsApp", "/textos", FULL),
  catalogItem("setup.service_types", "Tipos de serviço", "/tipos-servico", FULL),
  catalogItem("setup.users", "Usuários", "/usuarios", FULL, "Editar: grupos técnicos e os usuários do papel que você cuida"),
  catalogItem("setup.settings", "Configurações", "/configuracoes", FULL, "O SLA continua só com o administrador"),
];

export const ACCESS_ITEM = Object.fromEntries(ACCESS_ITEMS.map((def) => [def.key, def])) as Record<AccessItemKey, AccessItemDef>;

export const ACCESS_ITEM_KEYS: AccessItemKey[] = ACCESS_ITEMS.map((def) => def.key);

/** Tela do menu → item de acesso (a subtela segue o item de maior prefixo, ex.: /clientes/123). */
export const ROUTE_ITEMS: Record<string, AccessItemKey> = Object.fromEntries(ACCESS_ITEMS.map((def) => [def.href, def.key]));

/** Item de acesso da tela; null = núcleo (Início, Minha fila, Solicitações, Chamados e a OS). */
export function itemForPath(pathname: string): AccessItemKey | null {
  let best: string | null = null;
  for (const href of Object.keys(ROUTE_ITEMS)) {
    const match = pathname === href || pathname.startsWith(`${href}/`);
    if (match && (!best || href.length > best.length)) best = href;
  }
  return best ? ROUTE_ITEMS[best] : null;
}

/** Maior nível que a tela aceita (Editar, ou Visualizar nas só de leitura). */
export function maxLevel(item: AccessItemKey): AccessLevel {
  const levels = ACCESS_ITEM[item].levels;
  return levels[levels.length - 1];
}

/** O maior nível aceito pela tela que não passa do pedido. */
export function clampLevel(item: AccessItemKey, level: AccessLevel): AccessLevel {
  const allowed = ACCESS_ITEM[item].levels.filter((l) => LEVEL_RANK[l] <= LEVEL_RANK[level]);
  return allowed[allowed.length - 1] ?? "none";
}

// ------------------------------------------------------------------ padrões dos papéis (= acesso de antes dos perfis)

/** Cada tela no maior nível que aceita (o acesso total). */
function topLevels(): Record<AccessItemKey, AccessLevel> {
  return Object.fromEntries(ACCESS_ITEMS.map((def) => [def.key, maxLevel(def.key)])) as Record<AccessItemKey, AccessLevel>;
}

function defaultsFor(role: "supervisor" | "analyst"): Record<AccessItemKey, AccessLevel> {
  const items = topLevels();
  if (role === "analyst") {
    // O analista lia Usuários sem alterar, e Configurações não estava no menu dele.
    items["setup.users"] = "view";
    items["setup.settings"] = "none";
  }
  return items;
}

export const ROLE_DEFAULTS: Record<"supervisor" | "analyst", Record<AccessItemKey, AccessLevel>> = {
  supervisor: defaultsFor("supervisor"),
  analyst: defaultsFor("analyst"),
};

const ALL_QUEUES: EffectiveAccess["queues"] = { scope: "all", unowned: true };

const FULL_ACCESS: EffectiveAccess = {
  full: true,
  profile: null,
  customized: false,
  items: topLevels(),
  queues: ALL_QUEUES,
};

const ROLE_FALLBACK: Partial<Record<UserRole, EffectiveAccess>> = {
  admin: FULL_ACCESS,
  supervisor: { full: false, profile: null, customized: false, items: ROLE_DEFAULTS.supervisor, queues: ALL_QUEUES },
  analyst: { full: false, profile: null, customized: false, items: ROLE_DEFAULTS.analyst, queues: ALL_QUEUES },
};

/**
 * Acesso de quem está na central. A sessão aberta antes dos perfis (sem `access`) segue o padrão do
 * papel, que é o acesso de antes, até o /auth/me trazer o de verdade. Técnico e cliente: null.
 */
export function accessOf(user: User | null | undefined): EffectiveAccess | null {
  if (!user) return null;
  if (user.access !== undefined) return user.access;
  return ROLE_FALLBACK[user.role] ?? null;
}

/** O acesso permite o nível na tela? (o administrador pode tudo; sem acesso calculado, nada). */
export function can(access: EffectiveAccess | null | undefined, item: AccessItemKey, level: AccessLevel = "view"): boolean {
  if (!access) return false;
  if (access.full) return true;
  return LEVEL_RANK[access.items[item] ?? "none"] >= LEVEL_RANK[level];
}

export function canAccess(user: User | null | undefined, item: AccessItemKey, level: AccessLevel = "view"): boolean {
  return can(accessOf(user), item, level);
}

/** Vê as OS sem analista (todas as filas, ou a própria com a opção ligada). */
export function seesUnowned(access: EffectiveAccess | null | undefined): boolean {
  if (!access) return false;
  return access.full || access.queues.scope === "all" || access.queues.unowned;
}

// ------------------------------------------------------------------ hooks

export function useAccess(): EffectiveAccess | null {
  return accessOf(useAuth().user);
}

/** A pessoa pode o nível na tela? Ex.: `useCan("commercial.quotes", "edit")` para os botões de alterar. */
export function useCan(item: AccessItemKey, level: AccessLevel = "view"): boolean {
  return can(useAccess(), item, level);
}

/** Filas que a pessoa vê: só a dela (`own`) ou todas; `unowned`: também as sem analista. */
export function useQueueScope(): { scope: QueueScope; unowned: boolean } {
  const access = useAccess();
  if (!access) return ALL_QUEUES;
  return access.full ? ALL_QUEUES : access.queues;
}

// ------------------------------------------------------------------ 403 da API

export type ForbiddenCode = "MODULE_FORBIDDEN" | "QUEUE_FORBIDDEN";

/** O 403 é de tela sem acesso (MODULE_FORBIDDEN) ou de OS de outra fila (QUEUE_FORBIDDEN)? */
export function forbiddenCode(error: unknown): ForbiddenCode | null {
  if (!(error instanceof ApiError) || error.status !== 403) return null;
  const code = apiErrorCode(error);
  return code === "MODULE_FORBIDDEN" || code === "QUEUE_FORBIDDEN" ? code : null;
}

/** Tela citada no 403 de módulo (para a mensagem "Sem acesso a …"). */
export function forbiddenItem(error: unknown): AccessItemKey | null {
  if (forbiddenCode(error) !== "MODULE_FORBIDDEN") return null;
  const item = (error as ApiError).body as { item?: unknown } | null;
  const key = typeof item?.item === "string" ? item.item : null;
  return key && key in ACCESS_ITEM ? (key as AccessItemKey) : null;
}

// ------------------------------------------------------------------ rótulos da visibilidade de filas

export const QUEUE_SCOPE_LABEL: Record<QueueScope, string> = {
  all: "Todas as filas da equipe",
  own: "Somente a própria fila",
};

/** Resumo curto das filas (tabela de usuários, cadastro). */
export function queuesLabel(queues: { scope: QueueScope; unowned: boolean }): string {
  if (queues.scope === "all") return QUEUE_SCOPE_LABEL.all;
  return queues.unowned ? "Só a própria fila e as sem analista" : "Só a própria fila";
}
