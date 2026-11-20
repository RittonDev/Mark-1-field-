// Meu elo: a patente do técnico (Bronze, Prata, Ouro ou Diamante, desenhada como medalha em components/LevelBadge.tsx)
// pelos atendimentos dos últimos 12 meses (GET /me/level, docs/API.md "Elo dos técnicos"). Regras, faixas e textos vêm
// prontos do servidor: o app não repete números. Só o elo do próprio técnico: nada de outros técnicos, notas da central
// nem o que ela desconsiderou.
//
// - Fica no aparelho (kv `my_level`, com a hora em que chegou) para abrir sem internet. Quem busca é a rodada do sync
//   (sync.ts, refreshLevel: a cada 30 min com o app na tela e no "puxar para atualizar"), a tela Meu elo
//   (refreshLevelNow: ao abrir, se o guardado não é recente, e ao puxar) e a aba Perfil (uma vez por foco, enquanto
//   nada está guardado). Sai do aparelho com o resto dos dados na troca de técnico (resetLocalData).
// - As telas do elo releem a cada gravação (useMyLevel); o resto do app só acorda quando o elo mudou de fato (a hora
//   do cálculo muda a cada busca e não conta).
// - Subiu de faixa: a comemoração dentro do app, com a medalha da faixa nova ("Você chegou ao Ouro!"). A primeira carga
//   não comemora; sem push.

import { useEffect, useState, useSyncExternalStore } from "react";
import { LEVEL_TIER, LEVEL_TIER_ORDER } from "./constants";
import { getKv, setKv, type DB } from "./db";
import { formatDate, formatTime } from "./format";
import { haptic } from "./haptics";
import { session, useSession } from "./session";
import { showSuccess } from "./success";
import type { LevelCriterion, LevelCriterionKey, LevelTier, MyLevel, UUID } from "./types";

export const LEVEL_KEY = "my_level";

/** O elo guardado no aparelho. */
export interface StoredLevel {
  /** Quando chegou ao aparelho (relógio do aparelho): o "Atualizado em" da tela. */
  at: string;
  /** De quem é: o kv sai na troca de técnico, e isto garante que o elo de um nunca aparece para outro. */
  user: UUID;
  data: MyLevel;
}

/** Resultado da busca pedida pela tela Meu elo (abrir, puxar para atualizar, "Tentar de novo"). */
export type LevelRefreshResult = { ok: true } | { ok: false; offline: boolean; message: string };

export const isLevelTier = (value: unknown): value is LevelTier =>
  typeof value === "string" && (LEVEL_TIER_ORDER as string[]).includes(value);

/** Posição da faixa: Bronze 0 … Diamante 3. */
export const levelRank = (tier: LevelTier) => LEVEL_TIER_ORDER.indexOf(tier);

/** O mínimo para a tela abrir sem quebrar (faixa conhecida e as listas no lugar). */
function isMyLevel(value: unknown): value is MyLevel {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<MyLevel>;
  return (
    isLevelTier(data.tier) &&
    typeof data.since === "string" &&
    typeof data.computed_at === "string" &&
    typeof data.metrics === "object" &&
    data.metrics !== null &&
    Array.isArray(data.criteria) &&
    Array.isArray(data.tiers) &&
    Array.isArray(data.rules) &&
    Array.isArray(data.occurrences) &&
    typeof data.occurrences_total === "number"
  );
}

function parseStored(raw: string | null): StoredLevel | null {
  if (!raw) return null;
  try {
    const entry = JSON.parse(raw) as Partial<StoredLevel> | null;
    if (!entry || typeof entry.at !== "string" || typeof entry.user !== "string" || !isMyLevel(entry.data)) return null;
    return { at: entry.at, user: entry.user, data: entry.data };
  } catch {
    return null;
  }
}

/** O elo guardado, de quem for (dentro de uma transação, passe o `db` dela). */
export async function readStoredLevel(db?: DB): Promise<StoredLevel | null> {
  return parseStored(await getKv(LEVEL_KEY, db));
}

/** O elo guardado do técnico da sessão; null antes da primeira busca. */
export async function loadMyLevel(): Promise<StoredLevel | null> {
  const stored = await readStoredLevel();
  const user = session.get().user;
  return stored && user && stored.user === user.id ? stored : null;
}

/** O elo sem a hora do cálculo e da janela, que mudam a cada busca: igual a isto, nada mudou para as telas. */
function signature(data: MyLevel): string {
  return JSON.stringify({ ...data, computed_at: null, metrics: { ...data.metrics, window_start: null, window_end: null } });
}

export interface LevelSaved {
  /** Mudou desde o guardado (sem contar a hora do cálculo): o resto do app relê o banco local. */
  changed: boolean;
  /** A faixa nova, quando subiu desde o elo guardado (null na primeira carga, sem mudança ou descendo). */
  rise: LevelTier | null;
}

/** Guarda a resposta do servidor, na transação de quem chamou, e diz o que mudou. */
export async function saveLevel(db: DB, data: MyLevel, userId: UUID): Promise<LevelSaved> {
  if (!isMyLevel(data as unknown)) throw new Error("O servidor mandou o elo num formato que o app não conhece.");
  const previous = await readStoredLevel(db);
  const mine = previous && previous.user === userId ? previous : null;
  const entry: StoredLevel = { at: new Date().toISOString(), user: userId, data };
  await setKv(LEVEL_KEY, JSON.stringify(entry), db);
  return {
    changed: !mine || signature(mine.data) !== signature(data),
    rise: mine && levelRank(data.tier) > levelRank(mine.data.tier) ? data.tier : null,
  };
}

// ───────────────────────────── telas ─────────────────────────────

let version = 0;
const listeners = new Set<() => void>();

/** Avisa as telas do elo que a gravação terminou (também sem mudança: o "Atualizado em" anda). */
export function levelStored() {
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
 * O elo guardado do técnico da sessão: undefined enquanto lê, null sem elo guardado. Relê a cada gravação e na
 * troca de técnico; enquanto relê, fica o valor anterior (o chip de Hoje não pisca).
 */
export function useMyLevel(): StoredLevel | null | undefined {
  const stored = useSyncExternalStore(subscribe, getVersion, getVersion);
  const userId = useSession().user?.id ?? null;
  const [state, setState] = useState<{ user: string | null; entry: StoredLevel | null }>();
  useEffect(() => {
    let alive = true;
    loadMyLevel().then(
      (entry) => {
        if (alive) setState({ user: userId, entry });
      },
      (error: unknown) => console.warn("Falha ao ler o elo guardado", error),
    );
    return () => {
      alive = false;
    };
  }, [stored, userId]);
  // Outro técnico na sessão: o elo do anterior não aparece nem por um instante.
  return state && state.user === userId ? state.entry : undefined;
}

/** "Você chegou ao Ouro!": a subida de faixa, com o app na tela e a medalha da faixa nova. */
export function celebrateLevel(tier: LevelTier) {
  const highest = tier === LEVEL_TIER_ORDER[LEVEL_TIER_ORDER.length - 1];
  haptic.success();
  showSuccess(
    `Você chegou ${LEVEL_TIER[tier].to}!`,
    highest ? "É o elo mais alto." : "Veja em Meu elo o que conta para o próximo.",
    { medal: tier },
  );
}

const fullDate = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });

/** "12/11/2026". */
export const levelDate = (iso: string) => fullDate.format(new Date(iso));

/** "18/11 às 10:00". */
export const levelMoment = (iso: string) => `${formatDate(iso)} às ${formatTime(iso)}`;

/** O elo guardado chegou depois de `since` (ms): uma falha anterior da tela já não vale para ele. */
export const storedAfter = (stored: StoredLevel, since: number) => new Date(stored.at).getTime() > since;

/**
 * O texto pronto "Ainda sem dados suficientes (3 de 5 chegadas)" do critério da taxa, da próxima faixa ou da faixa
 * em vigor (no Diamante); null quando a taxa já tem dados.
 */
export function notEnoughText(data: MyLevel, key: LevelCriterionKey): string | null {
  const all: LevelCriterion[] = [...(data.next?.criteria ?? []), ...data.criteria];
  return all.find((criterion) => criterion.key === key && !criterion.enough_data)?.text ?? null;
}
