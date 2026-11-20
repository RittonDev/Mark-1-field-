// Histórico de atendimentos do técnico (GET /me/history, docs/API.md "Perfil do técnico: estatísticas e histórico"):
// as OS concluídas em que ele atuou (responsável ou junto), das mais recentes para as mais antigas, no recorte de campo
// (código, serviço, loja, cidade e data; nada de cliente, endereço, contato ou valores). Só do próprio técnico, só
// leitura, fora da rodada do sync e da fila de operações.
//
// - Páginas de 30 por cursor (o `next_cursor` da página anterior). A tela junta as páginas com lib/historySections.ts.
// - Só a primeira página fica no aparelho (kv `my_history`, com a hora em que chegou e o técnico), para abrir sem
//   internet. A gravação confere a sessão (o "Sair" ou a troca de técnico no meio da busca não grava para o outro) e o
//   `user` gravado impede mostrar a de outro técnico. Sai do aparelho com o resto do kv na troca de técnico
//   (resetLocalData).

import { api, ApiError, errorMessage } from "./api";
import { getKv, setKv, WriteCancelled } from "./db";
import { session } from "./session";
import type { HistoryItem, HistoryMonthCount, MyHistoryPage, UUID } from "./types";

export const HISTORY_KEY = "my_history";

/** A tela busca a primeira página de novo ao abrir quando a guardada passou disto (voltar de uma OS não refaz a busca). */
export const HISTORY_FRESH_MS = 2 * 60_000;

/** OS por página (a API aceita até 50). */
export const HISTORY_PAGE_SIZE = 30;

/** Servidor anterior ao histórico (404). */
export const HISTORY_NOT_FOUND = "O servidor ainda não tem o histórico. Tente de novo mais tarde.";

const SESSION_ENDED = "Sessão encerrada";

/** A primeira página guardada no aparelho. */
export interface StoredHistory {
  /** Quando chegou ao aparelho (relógio do aparelho): o "dados de…" da tela. */
  at: string;
  /** De quem é: o de um técnico nunca aparece para outro. */
  user: UUID;
  data: MyHistoryPage;
}

/** Por que uma busca não deu certo: sem rede (ou servidor fora do alcance) ou a mensagem do servidor. */
export interface HistoryFailure {
  offline: boolean;
  message: string;
}

/** Resultado da busca da primeira página (abrir, puxar, "Tentar de novo"); com sucesso, o que foi guardado. */
export type HistoryRefreshResult = { ok: true; stored: StoredHistory } | ({ ok: false } & HistoryFailure);

const isText = (value: unknown): value is string => typeof value === "string";
const isTextOrNull = (value: unknown) => value === null || typeof value === "string";
const isCount = (value: unknown) => typeof value === "number" && Number.isFinite(value);

function isHistoryItem(value: unknown): value is HistoryItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<HistoryItem>;
  return (
    isText(item.id) &&
    isText(item.code) &&
    isText(item.service) &&
    isTextOrNull(item.location_code) &&
    isTextOrNull(item.location_name) &&
    isTextOrNull(item.city) &&
    isTextOrNull(item.state) &&
    isText(item.resolved_at) &&
    isText(item.month) &&
    isText(item.role) &&
    typeof item.legacy === "boolean"
  );
}

function isMonthCount(value: unknown): value is HistoryMonthCount {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<HistoryMonthCount>;
  return isText(entry.month) && isCount(entry.count);
}

/** O mínimo para a tela abrir sem quebrar: as OS com o recorte de campo, o cursor, o total e os totais por mês. */
export function isHistoryPage(value: unknown): value is MyHistoryPage {
  if (!value || typeof value !== "object") return false;
  const page = value as Partial<MyHistoryPage>;
  return (
    Array.isArray(page.items) &&
    page.items.every(isHistoryItem) &&
    isTextOrNull(page.next_cursor) &&
    (page.total === null || isCount(page.total)) &&
    Array.isArray(page.months) &&
    page.months.every(isMonthCount)
  );
}

function parseStored(raw: string | null): StoredHistory | null {
  if (!raw) return null;
  try {
    const entry = JSON.parse(raw) as Partial<StoredHistory> | null;
    if (!entry || !isText(entry.at) || !isText(entry.user) || !isHistoryPage(entry.data)) return null;
    return { at: entry.at, user: entry.user, data: entry.data };
  } catch {
    return null;
  }
}

/** A primeira página guardada do técnico da sessão; null antes da primeira busca. */
export async function loadHistoryFirstPage(): Promise<StoredHistory | null> {
  const stored = parseStored(await getKv(HISTORY_KEY));
  const user = session.get().user;
  return stored && user && stored.user === user.id ? stored : null;
}

/** O que dizer de uma busca que falhou (404: o servidor ainda não tem o histórico). */
export function historyFailure(error: unknown): HistoryFailure {
  if (error instanceof WriteCancelled) return { offline: false, message: SESSION_ENDED };
  const offline = error instanceof ApiError && error.status === 0;
  if (error instanceof ApiError && error.status === 404) return { offline, message: HISTORY_NOT_FOUND };
  return { offline, message: errorMessage(error) };
}

/** Uma página do servidor: sem cursor, a primeira (com o total); com ele, a seguinte. Lança no erro. */
export async function fetchHistoryPage(cursor?: string): Promise<MyHistoryPage> {
  const after = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
  const page = await api.get<MyHistoryPage>(`/me/history?limit=${HISTORY_PAGE_SIZE}${after}`);
  if (!isHistoryPage(page)) throw new Error("O servidor mandou o histórico num formato que o app não conhece.");
  return page;
}

/**
 * Busca a primeira página e guarda. Nunca lança: o resultado diz se faltou internet ou o que o servidor disse. Se a
 * sessão mudou no meio (Sair, outro técnico), nada é gravado.
 */
export async function refreshHistoryFirstPage(): Promise<HistoryRefreshResult> {
  const user = session.get().user;
  if (!user) return { ok: false, offline: false, message: SESSION_ENDED };
  const mine = () => session.get().user?.id === user.id;
  try {
    const data = await fetchHistoryPage();
    if (!mine()) return { ok: false, offline: false, message: SESSION_ENDED };
    const stored: StoredHistory = { at: new Date().toISOString(), user: user.id, data };
    await setKv(HISTORY_KEY, JSON.stringify(stored), undefined, { notify: false, guard: mine });
    return { ok: true, stored };
  } catch (error) {
    return { ok: false, ...historyFailure(error) };
  }
}
