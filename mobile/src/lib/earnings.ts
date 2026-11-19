// Faturamento do técnico: a aba (totais e um cartão por mês) e o mês (as OS, os reembolsos e as notas). Só leitura e
// só com internet: nada entra na fila. Contrato em docs/API.md, "Valor por chamado".
//
// - Meses (GET /me/earnings/months?months=12): totais, os valores de cada mês e a situação dele, calculada no servidor
//   (o app não repete regra). Ficam no aparelho (kv `earnings:months`, com a hora e o técnico: o de um nunca aparece
//   para outro) e numa loja em memória que a aba e o mês leem (useEarningsMonths). Um pedido por vez.
// - Mês (GET /me/earnings?month=AAAA-MM): as OS do mês, guardadas por mês (kv `earnings:AAAA-MM`) para abrir sem
//   internet; a resposta do servidor substitui.
// - Quando busca: ao abrir a aba, ao voltar a ela e ao abrir o mês (a busca de até 30 s atrás ainda vale), no "puxar
//   para atualizar" e em "Tentar de novo", quando uma nota entra ou sai neste aparelho e, depois de uma sincronização,
//   se a última busca tem 2 min ou mais (pagar marca a OS como alterada e a rodada traz).
// - O kv sai na troca de técnico (resetLocalData); a loja em memória recomeça quando a sessão muda de técnico.

import { useEffect, useSyncExternalStore } from "react";
import { api, ApiError } from "./api";
import { getKv, setKv } from "./db";
import { formatDateTime } from "./format";
import { session, useSession } from "./session";
import type { EarningsMonths, MyEarnings, UUID } from "./types";

export const EARNINGS_OFFLINE_TEXT = "Sem internet: os valores aparecem quando a conexão voltar.";
export const EARNINGS_FAILED_TEXT = "Não foi possível carregar o faturamento.";
/** Depois de uma sincronização, os valores são conferidos de novo no máximo a cada 2 min. */
export const SYNC_REFRESH_MS = 2 * 60_000;
/** Ao abrir a aba, voltar a ela ou abrir o mês: a busca de até 30 s atrás ainda vale. */
export const EARNINGS_FRESH_MS = 30_000;
/** Meses da aba: o atual e os 11 anteriores. */
const WINDOW_MONTHS = 12;

/** Nenhuma tela lê estas chaves pelo aviso do banco: a escrita não recarrega as listas de OS à toa. */
const QUIET = { notify: false } as const;

/**
 * Por que a busca falhou: sem rede, o texto de sem internet; servidor sem a rota (versão antiga da API) ou resposta
 * que o app não entende, o texto da tela; senão, o do servidor.
 */
export function earningsFailureText(error: unknown): string {
  if (!(error instanceof ApiError)) return EARNINGS_FAILED_TEXT;
  if (error.status === 0) return EARNINGS_OFFLINE_TEXT;
  return error.status === 404 ? EARNINGS_FAILED_TEXT : error.message;
}

/** Valores guardados na tela enquanto a atualização falha: "Sem internet · valores de 19/11/2026 14:32". */
export function earningsStaleText(error: string, at: string): string {
  return `${error === EARNINGS_OFFLINE_TEXT ? "Sem internet" : "Não deu para atualizar"} · valores de ${formatDateTime(at)}`;
}

// ───────────────────────────── um mês ─────────────────────────────

/** As OS de um mês como vieram do servidor, e quando. */
export interface MonthEntry {
  at: string;
  data: MyEarnings;
}

const monthKey = (month: string) => `earnings:${month}`;

function isMonthEntry(value: unknown): value is MonthEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<MonthEntry>;
  return (
    typeof entry.at === "string" &&
    !!entry.data &&
    Array.isArray(entry.data.items) &&
    typeof entry.data.summary === "object" &&
    entry.data.summary !== null
  );
}

/** A cópia do mês guardada no aparelho; null sem cópia ou ilegível. */
export async function readCachedMonth(month: string): Promise<MonthEntry | null> {
  try {
    const raw = await getKv(monthKey(month));
    if (!raw) return null;
    const entry: unknown = JSON.parse(raw);
    return isMonthEntry(entry) ? entry : null;
  } catch {
    return null;
  }
}

/** GET /me/earnings?month=AAAA-MM: as OS do mês. A resposta fica no aparelho. */
export async function loadMonthEarnings(month: string): Promise<MonthEntry> {
  const userId = session.get().user?.id ?? null;
  const data = await api.get<MyEarnings>(`/me/earnings?month=${month}`);
  const entry: MonthEntry = { at: new Date().toISOString(), data };
  // Saiu da conta (ou entrou outro técnico) durante o pedido: nada fica no aparelho.
  if (session.get().user?.id === userId) {
    void setKv(monthKey(month), JSON.stringify(entry), undefined, QUIET).catch(() => undefined);
  }
  return entry;
}

// ───────────────────────────── os meses da aba ─────────────────────────────

export const EARNINGS_MONTHS_KEY = "earnings:months";

/** Os meses guardados no aparelho. */
export interface StoredEarningsMonths {
  /** Quando chegaram (relógio do aparelho): a linha de "valores de …" quando a atualização falha. */
  at: string;
  /** De quem são: os meses de um técnico nunca aparecem para outro. */
  user: UUID;
  data: EarningsMonths;
}

/** O mínimo para a aba abrir sem quebrar. */
export function isEarningsMonths(value: unknown): value is EarningsMonths {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<EarningsMonths>;
  return Array.isArray(data.months) && typeof data.totals === "object" && data.totals !== null && typeof data.until === "string";
}

function parseStored(raw: string | null): StoredEarningsMonths | null {
  if (!raw) return null;
  try {
    const entry = JSON.parse(raw) as Partial<StoredEarningsMonths> | null;
    if (!entry || typeof entry.at !== "string" || typeof entry.user !== "string" || !isEarningsMonths(entry.data)) return null;
    return { at: entry.at, user: entry.user, data: entry.data };
  } catch {
    return null;
  }
}

export interface EarningsMonthsState {
  /** O técnico da sessão a quem o estado pertence. */
  user: UUID | null;
  /** undefined: lendo o aparelho; null: nada guardado deste técnico. */
  stored: StoredEarningsMonths | null | undefined;
  /** Por que a última busca falhou (a entrada guardada continua); null depois de uma busca que deu certo. */
  error: string | null;
  /** Busca no ar. */
  refreshing: boolean;
}

const EMPTY_STATE: EarningsMonthsState = { user: null, stored: undefined, error: null, refreshing: false };

let state: EarningsMonthsState = EMPTY_STATE;
const listeners = new Set<() => void>();
/** Leitura do aparelho, busca no ar e a busca forçada que espera por ela: todas do técnico de `state.user`. */
let reading: Promise<void> | null = null;
let inflight: Promise<void> | null = null;
let queued: Promise<void> | null = null;
/** Fim da última busca que valeu: deu certo ou o servidor respondeu com erro (sem rede não conta: a próxima tenta). */
let fetchedAt = 0;
/** A versão das notas que já pediu busca: a aba e o mês não buscam duas vezes pela mesma nota. */
let invoicesSeen: number | null = null;

function publish(patch: Partial<EarningsMonthsState>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

const sessionUser = () => session.get().user?.id ?? null;

/** O estado é do técnico da sessão: com outro técnico (ou ninguém), recomeça do zero. */
function own(): UUID | null {
  const user = sessionUser();
  if (state.user !== user) {
    reading = null;
    inflight = null;
    queued = null;
    fetchedAt = 0;
    publish({ ...EMPTY_STATE, user });
  }
  return user;
}

// Saiu da conta ou entrou outro técnico: os meses do anterior saem da memória na hora.
session.subscribe(() => {
  if (state.user !== sessionUser()) own();
});

/** Lê os meses guardados no aparelho, uma vez por técnico (a busca que chega antes vale mais). */
function ensureRead(): Promise<void> {
  const user = own();
  if (!user || state.stored !== undefined) return Promise.resolve();
  if (reading) return reading;
  const job = getKv(EARNINGS_MONTHS_KEY)
    .then(parseStored, () => null)
    .then((entry) => {
      if (state.user !== user || state.stored !== undefined) return;
      publish({ stored: entry && entry.user === user ? entry : null });
    });
  reading = job;
  return job;
}

/**
 * Busca os meses (GET /me/earnings/months?months=12). Um pedido por vez: quem chama durante um pedido espera o mesmo;
 * `force` com um pedido no ar (uma nota acabou de entrar) busca de novo quando ele terminar. Sem `force`, não busca se
 * a última busca tem menos de `maxAgeMs`. Grava no aparelho só se o técnico da sessão não mudou durante o pedido; o erro
 * fica em `error` e a entrada guardada continua. Nunca rejeita.
 */
export function refreshEarningsMonths({ force = false, maxAgeMs = 0 }: { force?: boolean; maxAgeMs?: number } = {}): Promise<void> {
  const user = own();
  if (!user) return Promise.resolve();
  void ensureRead();
  if (inflight) {
    if (!force) return inflight;
    queued ??= inflight.then(() => {
      queued = null;
      return state.user === user ? refreshEarningsMonths({ force: true }) : undefined;
    });
    return queued;
  }
  if (!force && fetchedAt > 0 && Date.now() - fetchedAt < maxAgeMs) return Promise.resolve();
  publish({ refreshing: true });
  const job = api
    .get<EarningsMonths>(`/me/earnings/months?months=${WINDOW_MONTHS}`)
    .then((data) => {
      if (!isEarningsMonths(data)) throw new Error("O servidor mandou o faturamento num formato que o app não conhece.");
      if (state.user !== user || sessionUser() !== user) return;
      const entry: StoredEarningsMonths = { at: new Date().toISOString(), user, data };
      fetchedAt = Date.now();
      publish({ stored: entry, error: null });
      void setKv(EARNINGS_MONTHS_KEY, JSON.stringify(entry), undefined, QUIET).catch(() => undefined);
    })
    .catch((error: unknown) => {
      if (state.user !== user) return;
      if (!(error instanceof ApiError && error.status === 0)) fetchedAt = Date.now();
      publish({ error: earningsFailureText(error) });
    })
    .finally(() => {
      if (state.user !== user) return;
      inflight = null;
      publish({ refreshing: false });
    });
  inflight = job;
  return job;
}

/**
 * Uma nota entrou ou saiu neste aparelho (`useInvoicesVersion` mudou): a situação dos meses muda. Busca uma vez por
 * versão, quem quer que chame primeiro (a aba e o mês ficam montados juntos).
 */
export function refreshAfterInvoices(version: number): Promise<void> {
  if (invoicesSeen === version) return inflight ?? Promise.resolve();
  invoicesSeen = version;
  return refreshEarningsMonths({ force: true });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getState = () => state;

/**
 * Os meses do técnico da sessão (`stored` undefined enquanto lê o aparelho, null sem nada guardado), o erro da última
 * busca e se há busca no ar. Lê o aparelho na primeira vez; quem busca é a tela (refreshEarningsMonths).
 */
export function useEarningsMonths(): EarningsMonthsState {
  const current = useSyncExternalStore(subscribe, getState, getState);
  const userId = useSession().user?.id ?? null;
  useEffect(() => {
    void ensureRead();
  }, [userId]);
  // Outro técnico na sessão: os meses do anterior não aparecem nem por um instante.
  return current.user === userId ? current : EMPTY_STATE;
}
