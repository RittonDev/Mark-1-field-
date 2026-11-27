// Configurações › Elo (elo por pontos, Etapa 1): o formulário como texto, as validações da tela (as mesmas mensagens do
// servidor, com ponto), as linhas De | Até das categorias, a abertura (início + bônus) e a categoria pela quantidade e
// pelo saldo. Puro e só com `import type` (a sonda tests/level-rules.test.mjs roda direto no Node): os limites são a
// cópia dos de backend/app/services/level_rules.py, que a sonda confere. Só a central vê pontos: nada daqui vai para o app.

import type {
  LevelArrivalTime,
  LevelCountBands,
  LevelLateMode,
  LevelMinBalance,
  LevelPointsBands,
  LevelRuleValues,
  LevelTier,
} from "./types";

/** Os limites das regras (= COUNT_MAX, POINTS_MAX, GAIN_MAX, LOSS_MAX, ABANDONMENT_MIN, REWORK_MIN e TOLERANCE_MAX). */
export const LEVEL_RULE_LIMITS = {
  countMax: 100000,
  pointsMax: 1000000,
  gainMax: 1000,
  lossMax: 10000,
  abandonmentMin: 80,
  reworkMin: 50,
  toleranceMax: 240,
};

/** As categorias com início próprio na contagem (o Bronze começa em 0). */
export type LevelCountTier = Exclude<LevelTier, "bronze">;

const TIERS: LevelTier[] = ["bronze", "silver", "gold", "diamond"];
export const LEVEL_COUNT_TIERS: LevelCountTier[] = ["silver", "gold", "diamond"];

/** O nome de cada categoria (= LEVEL_TIER[tier].label de lib/constants.ts, que a sonda confere). */
export const LEVEL_TIER_NAME: Record<LevelTier, string> = { bronze: "Bronze", silver: "Prata", gold: "Ouro", diamond: "Diamante" };

/** "do Bronze", "da Prata": nas mensagens ("O início do Ouro tem de ser maior que o da Prata."). */
export const LEVEL_TIER_OF: Record<LevelTier, string> = {
  bronze: "do Bronze",
  silver: "da Prata",
  gold: "do Ouro",
  diamond: "do Diamante",
};

/** O formulário como digitado: os números em texto; nas listas, "" é "Falta definir". */
export interface LevelRuleDraft {
  count_bands: Record<LevelCountTier, string>;
  points_bands: Record<LevelTier, string>;
  opening_bonus: string;
  completion_gain: string;
  on_time_gain: string;
  late: { mode: LevelLateMode | ""; points: string };
  abandonment_loss: string;
  rework_loss: string;
  min_balance: LevelMinBalance | "";
  arrival_tolerance: string;
  arrival_time: LevelArrivalTime | "";
  app_reasons: boolean;
}

/** Os campos que podem ter erro (a mensagem aparece abaixo de cada um). */
export type LevelRuleField =
  | `count_bands.${LevelCountTier}`
  | `points_bands.${LevelTier}`
  | "opening_bonus"
  | "completion_gain"
  | "on_time_gain"
  | "late.mode"
  | "late.points"
  | "abandonment_loss"
  | "rework_loss"
  | "arrival_tolerance";

export type LevelRuleProblems = Partial<Record<LevelRuleField, string>>;

/** Os campos na ordem da tela (Salvar com erro leva ao primeiro). */
export const LEVEL_RULE_FIELDS: LevelRuleField[] = [
  "count_bands.silver",
  "count_bands.gold",
  "count_bands.diamond",
  "points_bands.bronze",
  "points_bands.silver",
  "points_bands.gold",
  "points_bands.diamond",
  "opening_bonus",
  "completion_gain",
  "on_time_gain",
  "late.mode",
  "late.points",
  "abandonment_loss",
  "rework_loss",
  "arrival_tolerance",
];

/** Número com ponto de milhar ("1.001", "100.000"); o negativo com o sinal de menos ("−50"). */
export function formatPoints(n: number): string {
  const grouped = String(Math.abs(Math.trunc(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return n < 0 ? `−${grouped}` : grouped;
}

/**
 * O inteiro digitado: "1401", "1.401" (ponto de milhar, como se escreve no Brasil) ou "-50". Vazio: null. O resto
 * (vírgula, letra, "1.40"): NaN.
 */
export function readInt(text: string): number | null {
  const raw = text.trim();
  if (!raw) return null;
  const match = /^([-−]?)(\d+|\d{1,3}(?:\.\d{3})+)$/.exec(raw);
  if (!match) return Number.NaN;
  const n = Number(match[2].replace(/\./g, ""));
  return match[1] ? -n : n;
}

/** O inteiro digitado, ou null (vazio ou inválido): as contas da tela enquanto a pessoa digita. */
export function knownInt(text: string): number | null {
  const n = readInt(text);
  return n === null || Number.isNaN(n) ? null : n;
}

const rangeText = (min: number, max: number) => `Use um número inteiro de ${formatPoints(min)} a ${formatPoints(max)}.`;

/** Inteiro de `min` a `max`, ou a mensagem do campo (vazio também é erro: só nos obrigatórios ou com texto). */
function intProblem(text: string, min: number, max: number): string | null {
  const n = readInt(text);
  return n === null || Number.isNaN(n) || n < min || n > max ? rangeText(min, max) : null;
}

/** Perda com mínimo: abaixo dele, "No mínimo 80 pontos."; o resto (vazio, não inteiro, acima do teto), a faixa. */
function lossProblem(text: string, min: number): string | null {
  const n = readInt(text);
  if (n !== null && !Number.isNaN(n) && n < min) return `No mínimo ${formatPoints(min)} pontos.`;
  return intProblem(text, min, LEVEL_RULE_LIMITS.lossMax);
}

/** Os inícios de uma tabela de categorias: cada um na faixa e maior que o de baixo (o erro da ordem fica no de cima). */
function bandProblems<T extends LevelTier>(
  texts: Record<T, string>,
  tiers: T[],
  min: number,
  max: number,
  field: (tier: T) => LevelRuleField,
  out: LevelRuleProblems,
): Map<T, number> {
  const valid = new Map<T, number>();
  for (const tier of tiers) {
    const problem = intProblem(texts[tier], min, max);
    if (problem) out[field(tier)] = problem;
    else valid.set(tier, readInt(texts[tier]) as number);
  }
  for (let i = 1; i < tiers.length; i++) {
    const lower = valid.get(tiers[i - 1]);
    const upper = valid.get(tiers[i]);
    if (lower !== undefined && upper !== undefined && upper <= lower) {
      out[field(tiers[i])] = `O início ${LEVEL_TIER_OF[tiers[i]]} tem de ser maior que o ${LEVEL_TIER_OF[tiers[i - 1]]}.`;
      valid.delete(tiers[i]);
    }
  }
  return valid;
}

/**
 * Os erros do formulário, um por campo, com as mensagens do servidor (aqui com ponto). Obrigatórias: as faixas, o bônus e
 * as duas perdas; os ganhos, o atraso e a tolerância podem ficar em branco (falta definir).
 */
export function levelRuleProblems(draft: LevelRuleDraft): LevelRuleProblems {
  const limits = LEVEL_RULE_LIMITS;
  const out: LevelRuleProblems = {};

  bandProblems(draft.count_bands, LEVEL_COUNT_TIERS, 1, limits.countMax, (tier) => `count_bands.${tier}`, out);
  const points = bandProblems(draft.points_bands, TIERS, 0, limits.pointsMax, (tier) => `points_bands.${tier}`, out);

  // A abertura (início + bônus) fica dentro da faixa: o erro é o da primeira categoria que passa do fim.
  const bonusProblem = intProblem(draft.opening_bonus, 0, limits.pointsMax);
  if (bonusProblem) out.opening_bonus = bonusProblem;
  else if (points.size === TIERS.length) {
    const bonus = readInt(draft.opening_bonus) as number;
    for (let i = 0; i < TIERS.length - 1; i++) {
      const open = (points.get(TIERS[i]) as number) + bonus;
      const end = (points.get(TIERS[i + 1]) as number) - 1;
      if (open > end) {
        out.opening_bonus = `Com este bônus, a abertura ${LEVEL_TIER_OF[TIERS[i]]} (${formatPoints(open)}) passa do fim da faixa (${formatPoints(end)}).`;
        break;
      }
    }
  }

  for (const key of ["completion_gain", "on_time_gain"] as const) {
    const problem = draft[key].trim() ? intProblem(draft[key], 0, limits.gainMax) : null;
    if (problem) out[key] = problem;
  }

  if (draft.late.mode === "deduct") {
    if (!draft.late.points.trim()) out["late.points"] = "Informe quantos pontos o atraso desconta.";
    else {
      const problem = intProblem(draft.late.points, 1, limits.gainMax);
      if (problem) out["late.points"] = problem;
    }
  } else if (draft.late.mode !== "" && draft.late.mode !== "no_gain") {
    out["late.mode"] = "Escolha se o atraso desconta pontos ou só deixa de ganhar.";
  }

  const abandonment = lossProblem(draft.abandonment_loss, limits.abandonmentMin);
  if (abandonment) out.abandonment_loss = abandonment;
  const rework = lossProblem(draft.rework_loss, limits.reworkMin);
  if (rework) out.rework_loss = rework;

  if (draft.arrival_tolerance.trim()) {
    const n = readInt(draft.arrival_tolerance);
    if (n === null || Number.isNaN(n) || n < 0 || n > limits.toleranceMax) {
      out.arrival_tolerance = `Use minutos inteiros de 0 a ${formatPoints(limits.toleranceMax)}.`;
    }
  }
  return out;
}

const text = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));

/** O formulário com os valores salvos. */
export function draftOf(values: LevelRuleValues): LevelRuleDraft {
  return {
    count_bands: {
      silver: text(values.count_bands.silver),
      gold: text(values.count_bands.gold),
      diamond: text(values.count_bands.diamond),
    },
    points_bands: {
      bronze: text(values.points_bands.bronze),
      silver: text(values.points_bands.silver),
      gold: text(values.points_bands.gold),
      diamond: text(values.points_bands.diamond),
    },
    opening_bonus: text(values.opening_bonus),
    completion_gain: text(values.completion_gain),
    on_time_gain: text(values.on_time_gain),
    late: { mode: values.late?.mode ?? "", points: values.late?.mode === "deduct" ? text(values.late.points) : "" },
    abandonment_loss: text(values.abandonment_loss),
    rework_loss: text(values.rework_loss),
    min_balance: values.min_balance ?? "",
    arrival_tolerance: text(values.arrival_tolerance),
    arrival_time: values.arrival_time ?? "",
    app_reasons: values.app_reasons,
  };
}

/** Os valores do PUT (sem a versão); null enquanto houver erro. "Só deixa de ganhar" vai sem pontos. */
export function valuesOf(draft: LevelRuleDraft): LevelRuleValues | null {
  if (Object.keys(levelRuleProblems(draft)).length > 0) return null;
  const whole = (value: string) => readInt(value) as number;
  const optional = (value: string) => readInt(value);
  const { late } = draft;
  return {
    count_bands: { silver: whole(draft.count_bands.silver), gold: whole(draft.count_bands.gold), diamond: whole(draft.count_bands.diamond) },
    points_bands: {
      bronze: whole(draft.points_bands.bronze),
      silver: whole(draft.points_bands.silver),
      gold: whole(draft.points_bands.gold),
      diamond: whole(draft.points_bands.diamond),
    },
    opening_bonus: whole(draft.opening_bonus),
    completion_gain: optional(draft.completion_gain),
    on_time_gain: optional(draft.on_time_gain),
    late: late.mode === "deduct" ? { mode: "deduct", points: whole(late.points) } : late.mode === "no_gain" ? { mode: "no_gain", points: null } : null,
    abandonment_loss: whole(draft.abandonment_loss),
    rework_loss: whole(draft.rework_loss),
    min_balance: draft.min_balance === "negative" || draft.min_balance === "zero" ? draft.min_balance : null,
    arrival_tolerance: optional(draft.arrival_tolerance),
    arrival_time: draft.arrival_time === "server" || draft.arrival_time === "device" ? draft.arrival_time : null,
    app_reasons: draft.app_reasons,
  };
}

const flat = (v: LevelRuleValues) => [
  v.count_bands.silver,
  v.count_bands.gold,
  v.count_bands.diamond,
  v.points_bands.bronze,
  v.points_bands.silver,
  v.points_bands.gold,
  v.points_bands.diamond,
  v.opening_bonus,
  v.completion_gain,
  v.on_time_gain,
  v.late?.mode ?? null,
  v.late?.mode === "deduct" ? v.late.points : null,
  v.abandonment_loss,
  v.rework_loss,
  v.min_balance,
  v.arrival_tolerance,
  v.arrival_time,
  v.app_reasons,
];

/** Os mesmos valores (o formulário com "051" no lugar de "51" não tem alteração). null (com erro): diferente. */
export function sameLevelValues(a: LevelRuleValues | null, b: LevelRuleValues): boolean {
  return a !== null && JSON.stringify(flat(a)) === JSON.stringify(flat(b));
}

/** A categoria pela quantidade de atendimentos concluídos (só na abertura): cada início vale para a categoria. */
export function tierForCount(count: number, bands: LevelCountBands): LevelTier {
  if (count >= bands.diamond) return "diamond";
  if (count >= bands.gold) return "gold";
  if (count >= bands.silver) return "silver";
  return "bronze";
}

/** A categoria pelo saldo: abaixo da Prata é Bronze (mesmo negativo); o Diamante não tem teto. */
export function tierForBalance(balance: number, bands: LevelPointsBands): LevelTier {
  if (balance >= bands.diamond) return "diamond";
  if (balance >= bands.gold) return "gold";
  if (balance >= bands.silver) return "silver";
  return "bronze";
}

/** O saldo de abertura da categoria: o início da faixa de pontos mais o bônus. */
export function openingBalance(tier: LevelTier, bands: LevelPointsBands, bonus: number): number {
  return bands[tier] + bonus;
}

/** Uma linha De | Até. `to` null: o Diamante (sem fim) ou falta um número válido para a conta. */
export interface LevelBandRow {
  tier: LevelTier;
  from: number | null;
  to: number | null;
}

/** As linhas De | Até: o fim é o início da seguinte menos 1 (sem a conta quando ela sai antes do início). */
function rowsOf(starts: (number | null)[]): LevelBandRow[] {
  return TIERS.map((tier, i) => {
    const from = starts[i];
    const next = i < TIERS.length - 1 ? starts[i + 1] : null;
    const to = from !== null && next !== null && next - 1 >= from ? next - 1 : null;
    return { tier, from, to };
  });
}

/** Abertura por atendimentos: o Bronze de 0 até o início da Prata menos 1, e assim por diante. */
export function countBandRows(bands: LevelRuleDraft["count_bands"]): LevelBandRow[] {
  return rowsOf([0, ...LEVEL_COUNT_TIERS.map((tier) => knownInt(bands[tier]))]);
}

/** Faixas de pontos. */
export function pointsBandRows(bands: LevelRuleDraft["points_bands"]): LevelBandRow[] {
  return rowsOf(TIERS.map((tier) => knownInt(bands[tier])));
}

/** "Bronze 200 · Prata 1.001 · Ouro 1.501 · Diamante 1.950" (início + bônus); null enquanto falta um número. */
export function openingLine(draft: Pick<LevelRuleDraft, "points_bands" | "opening_bonus">): string | null {
  const bonus = knownInt(draft.opening_bonus);
  const starts = TIERS.map((tier) => knownInt(draft.points_bands[tier]));
  if (bonus === null || starts.some((start) => start === null)) return null;
  return TIERS.map((tier, i) => `${LEVEL_TIER_NAME[tier]} ${formatPoints((starts[i] as number) + bonus)}`).join(" · ");
}

/** As faixas da tela para a Prévia; null quando a contagem, os pontos ou o bônus têm erro ("Corrija as faixas."). */
export function previewBands(
  draft: LevelRuleDraft,
  problems: LevelRuleProblems = levelRuleProblems(draft),
): { count: LevelCountBands; points: LevelPointsBands; bonus: number } | null {
  const broken = Object.keys(problems).some(
    (field) => field.startsWith("count_bands.") || field.startsWith("points_bands.") || field === "opening_bonus",
  );
  if (broken) return null;
  const whole = (value: string) => readInt(value) as number;
  return {
    count: { silver: whole(draft.count_bands.silver), gold: whole(draft.count_bands.gold), diamond: whole(draft.count_bands.diamond) },
    points: {
      bronze: whole(draft.points_bands.bronze),
      silver: whole(draft.points_bands.silver),
      gold: whole(draft.points_bands.gold),
      diamond: whole(draft.points_bands.diamond),
    },
    bonus: whole(draft.opening_bonus),
  };
}
