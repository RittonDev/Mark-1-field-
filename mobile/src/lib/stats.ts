// Estatísticas do técnico (GET /me/stats, docs/API.md "Perfil do técnico: estatísticas e histórico"): o total de
// atendimentos desde sempre (Perfil), os 12 meses corridos do elo e 12 meses de calendário (tela Estatísticas). Só
// leitura e só do próprio técnico, fora da rodada do sync e da fila de operações.
//
// - Fica no aparelho (kv `my_stats`, com a hora em que chegou e o técnico) para abrir sem internet. Quem busca: a tela
//   Estatísticas (ao abrir, se o guardado tem mais de 2 min, e ao puxar), o Perfil (no foco, se tem mais de 10 min) e o
//   "puxar para atualizar" da aba Perfil. Pedidos ao mesmo tempo dividem a mesma busca.
// - A gravação confere a sessão (o "Sair" ou a troca de técnico no meio da busca não grava para o outro) e o `user`
//   gravado impede mostrar o de outro técnico. Sai do aparelho com o resto do kv na troca de técnico (resetLocalData).
// - As telas releem a cada gravação (useMyStats); o resto do app não acorda (a escrita não avisa o banco local).

import { useEffect, useState, useSyncExternalStore } from "react";
import { api, ApiError, errorMessage } from "./api";
import { getKv, setKv, WriteCancelled, type DB } from "./db";
import { session, useSession } from "./session";
import type { MyStats, StatsMonth, UUID } from "./types";

export const STATS_KEY = "my_stats";

/** A tela Estatísticas busca de novo ao abrir quando o guardado passou disto (voltar de uma tela não refaz a busca). */
export const STATS_FRESH_MS = 2 * 60_000;

/** O Perfil busca no foco quando o guardado passou disto: o total muda pouco. */
export const STATS_PROFILE_MAX_AGE_MS = 10 * 60_000;

/** Servidor anterior às estatísticas (404). */
export const STATS_NOT_FOUND = "O servidor ainda não tem as estatísticas. Tente de novo mais tarde.";

const SESSION_ENDED = "Sessão encerrada";

/** As estatísticas guardadas no aparelho. */
export interface StoredStats {
  /** Quando chegaram ao aparelho (relógio do aparelho): o "Atualizado em" da tela. */
  at: string;
  /** De quem são: o de um técnico nunca aparece para outro. */
  user: UUID;
  data: MyStats;
}

/** Resultado de uma busca (Estatísticas: abrir, puxar e "Tentar de novo"; Perfil: em silêncio). */
export type StatsRefreshResult = { ok: true } | { ok: false; offline: boolean; message: string };

const isCount = (value: unknown) => typeof value === "number" && Number.isFinite(value);

function isStatsMonth(value: unknown): value is StatsMonth {
  if (!value || typeof value !== "object") return false;
  const m = value as Partial<StatsMonth>;
  return (
    typeof m.month === "string" &&
    typeof m.current === "boolean" &&
    typeof m.legacy_only === "boolean" &&
    [m.services, m.as_assignee, m.as_helper, m.legacy, m.measured, m.arrivals, m.late, m.reworks, m.lost].every(isCount)
  );
}

/** O mínimo para o Perfil e a tela abrirem sem quebrar: o total, os números do elo e os meses com as contagens. */
export function isMyStats(value: unknown): value is MyStats {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<MyStats>;
  return (
    typeof data.computed_at === "string" &&
    typeof data.lifetime === "object" &&
    data.lifetime !== null &&
    isCount(data.lifetime.services) &&
    typeof data.metrics === "object" &&
    data.metrics !== null &&
    Array.isArray(data.months) &&
    data.months.length > 0 &&
    data.months.every(isStatsMonth)
  );
}

function parseStored(raw: string | null): StoredStats | null {
  if (!raw) return null;
  try {
    const entry = JSON.parse(raw) as Partial<StoredStats> | null;
    if (!entry || typeof entry.at !== "string" || typeof entry.user !== "string" || !isMyStats(entry.data)) return null;
    return { at: entry.at, user: entry.user, data: entry.data };
  } catch {
    return null;
  }
}

/** As estatísticas guardadas, de quem for (dentro de uma transação, passe o `db` dela). */
export async function readStoredStats(db?: DB): Promise<StoredStats | null> {
  return parseStored(await getKv(STATS_KEY, db));
}

/** As estatísticas guardadas do técnico da sessão; null antes da primeira busca. */
export async function loadMyStats(): Promise<StoredStats | null> {
  const stored = await readStoredStats();
  const user = session.get().user;
  return stored && user && stored.user === user.id ? stored : null;
}

/** As estatísticas chegaram depois de `since` (ms): uma falha anterior da tela já não vale para elas. */
export const statsStoredAfter = (stored: StoredStats, since: number) => new Date(stored.at).getTime() > since;

// ───────────────────────────── busca ─────────────────────────────

let inflight: { user: UUID; promise: Promise<StatsRefreshResult> } | null = null;

function failure(error: unknown): StatsRefreshResult {
  if (error instanceof WriteCancelled) return { ok: false, offline: false, message: SESSION_ENDED };
  const offline = error instanceof ApiError && error.status === 0;
  if (error instanceof ApiError && error.status === 404) return { ok: false, offline, message: STATS_NOT_FOUND };
  return { ok: false, offline, message: errorMessage(error) };
}

async function fetchStats(userId: UUID): Promise<StatsRefreshResult> {
  // Ainda é quem pediu? (Sair ou outro técnico no meio da busca: nada é gravado.)
  const mine = () => session.get().user?.id === userId;
  try {
    const data = await api.get<MyStats>("/me/stats");
    if (!isMyStats(data)) {
      return { ok: false, offline: false, message: "O servidor mandou as estatísticas num formato que o app não conhece." };
    }
    if (!mine()) return { ok: false, offline: false, message: SESSION_ENDED };
    const entry: StoredStats = { at: new Date().toISOString(), user: userId, data };
    await setKv(STATS_KEY, JSON.stringify(entry), undefined, { notify: false, guard: mine });
    statsStored();
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

/** Busca as estatísticas agora e guarda. Nunca lança: o resultado diz se faltou internet ou o que o servidor disse. */
export function refreshStatsNow(): Promise<StatsRefreshResult> {
  const user = session.get().user;
  if (!user) return Promise.resolve({ ok: false, offline: false, message: SESSION_ENDED });
  if (inflight && inflight.user === user.id) return inflight.promise;
  const promise = fetchStats(user.id);
  inflight = { user: user.id, promise };
  void promise.then(() => {
    if (inflight?.promise === promise) inflight = null;
  });
  return promise;
}

// ───────────────────────────── telas ─────────────────────────────

let version = 0;
const listeners = new Set<() => void>();

/** Avisa as telas que a gravação terminou (o "Atualizado em" anda mesmo sem número novo). */
export function statsStored() {
  version += 1;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getVersion = () => version;

/**
 * As estatísticas guardadas do técnico da sessão: undefined enquanto lê, null sem nada guardado. Relê a cada gravação e
 * na troca de técnico; enquanto relê, fica o valor anterior (o total do Perfil não pisca).
 */
export function useMyStats(): StoredStats | null | undefined {
  const stored = useSyncExternalStore(subscribe, getVersion, getVersion);
  const userId = useSession().user?.id ?? null;
  const [state, setState] = useState<{ user: string | null; entry: StoredStats | null }>();
  useEffect(() => {
    let alive = true;
    loadMyStats().then(
      (entry) => {
        if (alive) setState({ user: userId, entry });
      },
      (error: unknown) => console.warn("Falha ao ler as estatísticas guardadas", error),
    );
    return () => {
      alive = false;
    };
  }, [stored, userId]);
  // Outro técnico na sessão: as estatísticas do anterior não aparecem nem por um instante.
  return state && state.user === userId ? state.entry : undefined;
}
