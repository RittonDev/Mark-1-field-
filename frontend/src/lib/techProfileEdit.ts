// Perfil profissional editado pela central (ficha › Dias e horários, Transporte, Formação, Áreas de atuação, Aptidões e
// Ferramental, com o PATCH /technicians/{id}): a API de antes da Gestão, a grade dos turnos, os períodos de
// indisponibilidade e a formação (as mesmas regras e mensagens do app: mobile/src/lib/unavailability.ts e
// techProfileForm.ts, que a sonda confere) e os corpos do PATCH já ordenados (o salvar da seção compara o corpo).
// Puro e só com `import type` (a sonda tests/tech-profile-edit.test.mjs roda direto no Node): a ordem da grade e os
// limites de lib/constants.ts ficam em cópias locais, conferidas pela sonda.

import type {
  AvailabilitySlot,
  DayPeriod,
  EducationItemIn,
  EducationLevel,
  SkillLevel,
  TechnicianSkillIn,
  TransportInfo,
  TransportMode,
  UnavailabilityIn,
  UnavailabilityPeriod,
  UUID,
  Weekday,
} from "./types";

/**
 * O detalhe veio da API de antes da Gestão (até a publicação): ela não manda `area_ids`. Com ela, o perfil profissional
 * fica só leitura como antes (ela ignoraria calada o que a central mandasse) e as seções novas ficam indisponíveis.
 */
export function isPreGestao(t: { area_ids?: readonly UUID[] | null }): boolean {
  return t.area_ids === undefined;
}

// --------------------------------------------------------------------------- textos

/** Tab, LF, VT, FF e CR viram espaço; os outros controles e os caracteres de formatação (invisíveis) saem. */
const CONTROL_SPACE = /[\t\n\v\f\r]/g;
const CONTROL = /[\p{Cc}\p{Cf}]/gu;

/** O texto como o servidor grava (core/text.clean, o cleanText do app): sem invisíveis, NFC e espaços juntados. */
export function cleanText(text: string): string {
  return text.replace(CONTROL_SPACE, " ").replace(CONTROL, "").normalize("NFC").trim().replace(/\s+/g, " ");
}

/** Tamanho em caracteres, como o servidor conta (um emoji é um só). */
const chars = (text: string) => Array.from(text).length;

/** = TECH_PROFILE_LIMITS e UNAVAILABILITY_LIMITS de constants (a sonda confere). */
export const PROFILE_EDIT_LIMITS = {
  textMin: 2,
  course: 120,
  institution: 120,
  education: 20,
  skills: 30,
  areas: 20,
  periods: 10,
  horizonDays: 365,
  firstMonth: "1950-01",
} as const;

// --------------------------------------------------------------------------- dias e horários

/** A ordem da grade (= WEEKDAY_ORDER e DAY_PERIOD_ORDER de constants): segunda a domingo; manhã a madrugada. */
const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_PERIODS: readonly DayPeriod[] = ["morning", "afternoon", "evening", "night"];
const GRID: readonly AvailabilitySlot[] = WEEKDAYS.flatMap((day) =>
  DAY_PERIODS.map((period): AvailabilitySlot => `${day}:${period}`),
);

/** Os 28 turnos, na ordem da grade ("Marcar todos"). */
export function allSlots(): AvailabilitySlot[] {
  return [...GRID];
}

/** Marca ou desmarca um turno; a lista volta na ordem da grade, sem repetidos nem códigos desconhecidos. */
export function toggleSlot(slots: readonly string[], slot: AvailabilitySlot): AvailabilitySlot[] {
  const marked = new Set(slots);
  if (marked.has(slot)) marked.delete(slot);
  else marked.add(slot);
  return GRID.filter((s) => marked.has(s));
}

/** Os erros do período (os mesmos do app, com ponto). */
export const PERIOD_MSG = {
  start: "Informe o início.",
  end: "Informe o fim.",
  order: "O fim não pode ser antes do início.",
  past: "O início não pode ser antes de hoje.",
  horizon: `Até ${PROFILE_EDIT_LIMITS.horizonDays} dias a partir de hoje.`,
  overlap: "Já há um período nessas datas.",
  limit: `Limite de ${PROFILE_EDIT_LIMITS.periods} períodos. Exclua um para incluir outro.`,
} as const;

const pad = (n: number) => String(n).padStart(2, "0");

/** "AAAA-MM-DD" mais `days` dias (no calendário). */
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Os limites dos campos "De" e "Até": de hoje a hoje + 365 dias. */
export function periodBounds(today: string): { min: string; max: string } {
  return { min: today, max: addDaysIso(today, PROFILE_EDIT_LIMITS.horizonDays) };
}

/** Um período a incluir: "AAAA-MM-DD" ou vazio. */
export interface PeriodDraft {
  start: string | null;
  end: string | null;
}

/**
 * Os erros do período a incluir ({} quando entra), como o app (mobile/src/lib/unavailability.periodProblem): `others`,
 * os períodos da lista (nenhum dia em comum, os dois dias inclusive). O início antes de hoje só vale se for o gravado
 * do período editado (`editing`; a central não edita, só tira e inclui).
 */
export function periodProblem(
  draft: PeriodDraft,
  others: readonly { start: string; end: string }[],
  today: string,
  editing: { start: string } | null = null,
): Partial<Record<"start" | "end", string>> {
  const errors: Partial<Record<"start" | "end", string>> = {};
  const { start, end } = draft;
  const max = addDaysIso(today, PROFILE_EDIT_LIMITS.horizonDays);
  if (!start) errors.start = PERIOD_MSG.start;
  else if (start < today && start !== editing?.start) errors.start = PERIOD_MSG.past;
  else if (start > max) errors.start = PERIOD_MSG.horizon;
  if (!end) errors.end = PERIOD_MSG.end;
  else if (start && end < start) errors.end = PERIOD_MSG.order;
  else if (end > max) errors.end = PERIOD_MSG.horizon;
  else if (start && others.some((other) => other.start <= end && start <= other.end)) errors.end = PERIOD_MSG.overlap;
  return errors;
}

/** O corpo da indisponibilidade: a lista inteira pelo início (e o fim); o gravado vai com o `id`, o novo sem. */
export function unavailabilityBody(list: readonly (UnavailabilityIn | UnavailabilityPeriod)[]): UnavailabilityIn[] {
  return [...list]
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : a.end > b.end ? 1 : 0))
    .map((item) => (item.id ? { id: item.id, start: item.start, end: item.end } : { start: item.start, end: item.end }));
}

// --------------------------------------------------------------------------- transporte

/** = TRANSPORT_MODE_ORDER de constants. */
const MODE_ORDER: readonly TransportMode[] = ["car", "motorcycle", "bicycle", "public_transport", "ride_app", "on_foot"];

/** Os meios na ordem da tela, sem repetir, e a CNH (o corpo compara assim). */
export function transportBody(modes: readonly string[], driverLicense: boolean): TransportInfo {
  const marked = new Set(modes);
  return { modes: MODE_ORDER.filter((m) => marked.has(m)), driver_license: driverLicense };
}

// --------------------------------------------------------------------------- formação

/** Um curso na tela: meses "AAAA-MM"; `ongoing` ("Em andamento") quer dizer sem fim. Como a folha do app. */
export interface EducationDraft {
  course: string;
  level: EducationLevel | null;
  institution: string;
  start: string | null;
  end: string | null;
  ongoing: boolean;
}

export type EducationField = "course" | "level" | "institution" | "start" | "end";

/** Os erros da formação (os mesmos do app, com ponto). */
export const EDUCATION_MSG = {
  course: "Informe o curso.",
  level: "Escolha o nível.",
  institution: "Informe a instituição.",
  start: "Informe o início.",
  end: "Informe o fim ou marque Em andamento.",
  endBeforeStart: "O fim não pode ser antes do início.",
} as const;

/** Os erros de um curso ({} quando pode salvar), como o app (mobile/src/lib/techProfileForm.educationProblem). */
export function educationProblem(draft: EducationDraft): Partial<Record<EducationField, string>> {
  const errors: Partial<Record<EducationField, string>> = {};
  if (chars(cleanText(draft.course)) < PROFILE_EDIT_LIMITS.textMin) errors.course = EDUCATION_MSG.course;
  if (!draft.level) errors.level = EDUCATION_MSG.level;
  if (chars(cleanText(draft.institution)) < PROFILE_EDIT_LIMITS.textMin) errors.institution = EDUCATION_MSG.institution;
  if (!draft.start) errors.start = EDUCATION_MSG.start;
  if (!draft.ongoing) {
    if (!draft.end) errors.end = EDUCATION_MSG.end;
    else if (draft.start && draft.end < draft.start) errors.end = EDUCATION_MSG.endBeforeStart;
  }
  return errors;
}

/** O corpo da formação: a lista inteira na ordem da tela; o gravado vai com o `id`, o novo sem. */
export function educationBody(list: readonly (EducationDraft & { id?: UUID | null })[]): EducationItemIn[] {
  return list.map((item) => ({
    ...(item.id ? { id: item.id } : {}),
    course: cleanText(item.course),
    level: item.level as EducationLevel,
    institution: cleanText(item.institution),
    start: item.start ?? "",
    end: item.ongoing ? null : (item.end ?? null),
  }));
}

/** O mês de hoje ("AAAA-MM"), o último aceito no início e no fim. */
export function thisMonth(today: string): string {
  return today.slice(0, 7);
}

// --------------------------------------------------------------------------- áreas, aptidões e ferramental

/** Ids sem repetir e em ordem (o corpo de `area_ids` e `tool_ids`: a mesma lista em outra ordem não é mudança). */
export function sortedIds(ids: readonly UUID[]): UUID[] {
  return [...new Set(ids)].sort();
}

/** O corpo das aptidões: `{skill_id, level}` sem repetir o id e pelo id (o servidor mantém o "desde" de cada uma). */
export function skillsBody(list: readonly { skill_id: UUID; level: SkillLevel }[]): TechnicianSkillIn[] {
  const seen = new Set<UUID>();
  const out: { skill_id: UUID; level: SkillLevel }[] = [];
  for (const { skill_id, level } of list) {
    if (seen.has(skill_id)) continue;
    seen.add(skill_id);
    out.push({ skill_id, level });
  }
  return out.sort((a, b) => (a.skill_id < b.skill_id ? -1 : a.skill_id > b.skill_id ? 1 : 0));
}
