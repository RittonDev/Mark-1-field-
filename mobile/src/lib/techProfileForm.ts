// Perfil técnico (Configurações › Atendimento): as regras das telas sem React nem React Native, para a sonda
// (tests/tech-profile-form.test.mjs). Só importa valores de ./constants (que só tem `import type`).
//
// - Nomes: `foldName` compara como o servidor (services/tech_profile.fold) e `cleanText` limpa como ele grava.
// - Disponibilidade: `toggleSlot`, `sameSlots` e `copyToWorkdays` (a lista "dia:turno" da API).
// - Transporte: `toggleMode`, `sameTransport` e `transportBody`. Ferramental: `sameSet`.
// - Aptidões e Formação: os erros das folhas (`skillProblem`, `educationProblem`, com ponto final, como os do Meu
//   cadastro; os do servidor vêm sem ponto) e os corpos do PATCH (`skillsBody`, `educationBody`).
// - Folha do mês: `thisMonth` e `monthGrid`.
// - Salvar ao tocar: o redutor `autoSaveStep`, que decide o que o hook useAutoSave (lib/autoSave.ts) faz.

import {
  competenceLabel,
  MONTH_ABBR,
  slotPeriods,
  sortSlots,
  TECH_PROFILE_LIMITS,
  TRANSPORT_MODE_ORDER,
  WORKDAYS,
} from "./constants";
import type {
  AvailabilitySlot,
  EducationItem,
  EducationItemIn,
  EducationLevel,
  SkillLevel,
  TechnicianSkillIn,
  TransportInfo,
  TransportMode,
  Weekday,
} from "./types";

// --------------------------------------------------------------------------- textos

/**
 * Para comparar nomes como o servidor (services/tech_profile.fold): sem acento, sem maiúsculas e com os espaços
 * juntados. "Impressoras  HP" e "impressoras hp" são a mesma aptidão.
 */
export function foldName(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim().replace(/\s+/g, " ");
}

/** O texto como o servidor grava (services/tech_profile.clean): NFC e espaços juntados. */
export function cleanText(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/g, " ");
}

/** Tamanho em caracteres, como o servidor conta (um emoji ocupa duas posições no texto do JavaScript). */
const chars = (text: string) => Array.from(text).length;

// --------------------------------------------------------------------------- disponibilidade

/** Marca ou desmarca um turno; a lista volta na ordem da grade, sem repetidos. */
export function toggleSlot(slots: readonly string[], slot: AvailabilitySlot): AvailabilitySlot[] {
  const list = sortSlots(slots);
  return list.includes(slot) ? list.filter((s) => s !== slot) : sortSlots([...list, slot]);
}

/** Os mesmos turnos (a ordem e os repetidos não contam). */
export function sameSlots(a: readonly string[], b: readonly string[]): boolean {
  return sortSlots(a).join() === sortSlots(b).join();
}

/**
 * "Copiar para os dias úteis": segunda a sexta ficam com os turnos de `from`; sábado e domingo não mudam.
 * `overwrites`: algum outro dia útil já tinha turnos diferentes (a tela pergunta antes de copiar).
 */
export function copyToWorkdays(slots: readonly string[], from: Weekday): { next: AvailabilitySlot[]; overwrites: boolean } {
  const periods = slotPeriods(slots, from);
  const overwrites = WORKDAYS.some((day) => {
    if (day === from) return false;
    const other = slotPeriods(slots, day);
    return other.length > 0 && other.join() !== periods.join();
  });
  const weekend = sortSlots(slots).filter((slot) => !WORKDAYS.some((day) => slot.startsWith(`${day}:`)));
  const copied = WORKDAYS.flatMap((day) => periods.map((period): AvailabilitySlot => `${day}:${period}`));
  return { next: sortSlots([...weekend, ...copied]), overwrites };
}

// --------------------------------------------------------------------------- transporte e ferramental

/** O mesmo conjunto (a ordem e os repetidos não contam): ids do ferramental, meios de transporte. */
export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((item) => right.has(item));
}

/** Nada marcado ainda (o transporte que nunca foi informado começa assim na tela). */
export const NO_TRANSPORT: TransportInfo = { modes: [], driver_license: false };

export function sameTransport(a: TransportInfo, b: TransportInfo): boolean {
  return a.driver_license === b.driver_license && sameSet(a.modes, b.modes);
}

/** Marca ou desmarca um meio de transporte. */
export function toggleMode(transport: TransportInfo, mode: TransportMode): TransportInfo {
  const modes = transport.modes.includes(mode) ? transport.modes.filter((m) => m !== mode) : [...transport.modes, mode];
  return { ...transport, modes };
}

/** O corpo do PATCH: os meios na ordem da lista, sem repetir, e a CNH, sempre juntos. */
export function transportBody(transport: TransportInfo): TransportInfo {
  return { modes: TRANSPORT_MODE_ORDER.filter((mode) => transport.modes.includes(mode)), driver_license: transport.driver_license };
}

// --------------------------------------------------------------------------- aptidões

export interface SkillDraft {
  name: string;
  level: SkillLevel | null;
}

export type SkillErrors = Partial<Record<"name" | "level", string>>;

export const SKILL_MSG = {
  name: "Informe a aptidão.",
  repeated: "Você já tem esta aptidão.",
  level: "Escolha o nível.",
} as const;

/**
 * Os erros da folha da aptidão ({} quando pode salvar). `others`: as outras aptidões do técnico (na edição, sem a
 * editada), para não repetir o nome sem diferença de maiúsculas e acentos, como o servidor confere.
 */
export function skillProblem(draft: SkillDraft, others: readonly { name: string }[]): SkillErrors {
  const errors: SkillErrors = {};
  const name = cleanText(draft.name);
  if (chars(name) < TECH_PROFILE_LIMITS.textMin) errors.name = SKILL_MSG.name;
  else if (others.some((other) => foldName(other.name) === foldName(name))) errors.name = SKILL_MSG.repeated;
  if (!draft.level) errors.level = SKILL_MSG.level;
  return errors;
}

/** O corpo do PATCH: a lista inteira, só nome e nível (o "desde" é do servidor, que o mantém pelo nome). */
export function skillsBody(list: readonly { name: string; level: SkillLevel }[]): TechnicianSkillIn[] {
  return list.map(({ name, level }) => ({ name: cleanText(name), level }));
}

/**
 * Sugestões da folha "Adicionar aptidão": as que contêm o texto digitado (sem acento e sem maiúsculas), fora as que o
 * técnico já tem; no máximo `max`.
 */
export function suggestionsFor(query: string, suggestions: readonly string[], taken: readonly string[], max = 12): string[] {
  const wanted = foldName(query);
  const have = new Set(taken.map(foldName));
  const out: string[] = [];
  for (const suggestion of suggestions) {
    if (out.length >= max) break;
    const key = foldName(suggestion);
    if (!key || have.has(key) || !key.includes(wanted)) continue;
    have.add(key);
    out.push(suggestion);
  }
  return out;
}

// --------------------------------------------------------------------------- formação

/** A folha da formação: meses "AAAA-MM"; `ongoing` ("Em andamento") quer dizer sem fim. */
export interface EducationDraft {
  course: string;
  level: EducationLevel | null;
  institution: string;
  start: string | null;
  end: string | null;
  ongoing: boolean;
}

export type EducationField = "course" | "level" | "institution" | "start" | "end";

/** A ordem da tela (o primeiro erro é o de cima). */
export const EDUCATION_FIELDS: EducationField[] = ["course", "level", "institution", "start", "end"];

export const EDUCATION_MSG = {
  course: "Informe o curso.",
  level: "Escolha o nível.",
  institution: "Informe a instituição.",
  start: "Informe o início.",
  end: "Informe o fim ou marque Em andamento.",
  endBeforeStart: "O fim não pode ser antes do início.",
} as const;

/** A folha vazia (nova formação) ou com o curso gravado (edição). */
export function educationDraftOf(item: EducationItem | null): EducationDraft {
  if (!item) return { course: "", level: null, institution: "", start: null, end: null, ongoing: false };
  return {
    course: item.course,
    level: item.level,
    institution: item.institution,
    start: item.start,
    end: item.end,
    ongoing: item.end === null,
  };
}

/** Mudou alguma coisa na folha (para perguntar antes de descartar). */
export function educationChanged(draft: EducationDraft, base: EducationDraft): boolean {
  return (
    cleanText(draft.course) !== cleanText(base.course) ||
    draft.level !== base.level ||
    cleanText(draft.institution) !== cleanText(base.institution) ||
    draft.start !== base.start ||
    draft.ongoing !== base.ongoing ||
    (!draft.ongoing && draft.end !== base.end)
  );
}

/** Os erros da folha da formação, na ordem da tela ({} quando pode salvar). Início igual ao fim vale. */
export function educationProblem(draft: EducationDraft): Partial<Record<EducationField, string>> {
  const errors: Partial<Record<EducationField, string>> = {};
  if (chars(cleanText(draft.course)) < TECH_PROFILE_LIMITS.textMin) errors.course = EDUCATION_MSG.course;
  if (!draft.level) errors.level = EDUCATION_MSG.level;
  if (chars(cleanText(draft.institution)) < TECH_PROFILE_LIMITS.textMin) errors.institution = EDUCATION_MSG.institution;
  if (!draft.start) errors.start = EDUCATION_MSG.start;
  if (!draft.ongoing) {
    if (!draft.end) errors.end = EDUCATION_MSG.end;
    else if (draft.start && draft.end < draft.start) errors.end = EDUCATION_MSG.endBeforeStart;
  }
  return errors;
}

/** Um curso da lista: o gravado tem `id`; o novo vai sem (o servidor cria). */
export type EducationEntry = Omit<EducationItem, "id"> & { id?: string | null };

/** O curso da folha (já sem erros) para entrar na lista; null se faltar o nível ou o início. */
export function educationEntry(draft: EducationDraft, id?: string | null): EducationEntry | null {
  if (!draft.level || !draft.start) return null;
  return {
    ...(id ? { id } : {}),
    course: cleanText(draft.course),
    level: draft.level,
    institution: cleanText(draft.institution),
    start: draft.start,
    end: draft.ongoing ? null : draft.end,
  };
}

/** O corpo do PATCH: a lista inteira; o editado vai com o mesmo `id` e o novo, sem. */
export function educationBody(list: readonly EducationEntry[]): EducationItemIn[] {
  return list.map((item) => ({
    ...(item.id ? { id: item.id } : {}),
    course: cleanText(item.course),
    level: item.level,
    institution: cleanText(item.institution),
    start: item.start,
    end: item.end ?? null,
  }));
}

// --------------------------------------------------------------------------- folha do mês

const pad = (n: number) => String(n).padStart(2, "0");

/** O mês atual no fuso do aparelho, "AAAA-MM": o último que a formação aceita. */
export function thisMonth(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
}

/** O ano de um mês "AAAA-MM". */
export const yearOf = (month: string) => Number(month.slice(0, 4));

export interface MonthCell {
  /** "AAAA-MM". */
  month: string;
  /** "fev" (a grade). */
  label: string;
  /** "fevereiro de 2019" (o leitor de tela). */
  spoken: string;
  selected: boolean;
  /** Fora de [min, max]: não dá para escolher. */
  disabled: boolean;
}

/** Os 12 meses de um ano na folha do mês, de janeiro a dezembro. */
export function monthGrid(year: number, min: string, max: string, value: string | null): MonthCell[] {
  return MONTH_ABBR.map((label, index) => {
    const month = `${year}-${pad(index + 1)}`;
    return { month, label, spoken: competenceLabel(month), selected: month === value, disabled: month < min || month > max };
  });
}

// --------------------------------------------------------------------------- salvar ao tocar

export type AutoSaveStatus = "idle" | "saving" | "saved";

export interface AutoSaveState<T> {
  /** O que o técnico marcou e ainda não voltou do servidor; null: a tela mostra o que está gravado. */
  desired: T | null;
  /** "waiting": o envio espera 0,6 s sem toque; "sending": um envio no ar. */
  phase: "idle" | "waiting" | "sending";
  /** Mexeu durante o envio: manda de novo assim que ele voltar. */
  again: boolean;
  /** O cabeçalho: "Salvando…", "Salvo" (2 s) ou nada. */
  status: AutoSaveStatus;
  /** Sobe a cada troca de sessão: a resposta de um envio de antes não muda mais nada. */
  epoch: number;
}

export const AUTO_SAVE_START: AutoSaveState<never> = { desired: null, phase: "idle", again: false, status: "idle", epoch: 0 };

export type AutoSaveEvent<T> =
  /** Um toque (com rede: sem rede o hook avisa e nem chega aqui). */
  | { type: "change"; value: T }
  /** A espera acabou (ou a tela saiu com o envio agendado); `saved`: o que está gravado agora. */
  | { type: "due"; saved: T }
  /** O servidor gravou o envio desta sessão. */
  | { type: "done"; epoch: number }
  /** O envio desta sessão falhou. */
  | { type: "failed"; epoch: number }
  /** Passaram os 2 s do "Salvo". */
  | { type: "settled" }
  /** Saiu da conta ou entrou outro técnico: descarta o que estava pendente. */
  | { type: "reset" };

export type AutoSaveEffect<T> =
  /** (Re)começa a espera de 0,6 s. */
  | { kind: "schedule" }
  /** Envia este valor agora (um envio por vez). */
  | { kind: "send"; value: T; epoch: number }
  /** Mostra "Salvo" por 2 s. */
  | { kind: "saved" }
  /** Para as esperas. */
  | { kind: "cancel" }
  | null;

/**
 * O passo do salvar ao tocar. Toques de perto vão juntos: cada um reinicia a espera e, quando ela acaba, sai um envio
 * com o último valor. Tocou durante o envio: manda de novo assim que ele voltar, com o valor final. Gravou: a tela volta
 * a seguir o servidor (que pode ter ignorado algo, como uma ferramenta desativada). Falhou: idem, sem o "Salvo". A
 * sessão mudou: descarta em silêncio, e a resposta de um envio de antes não conta.
 */
export function autoSaveStep<T>(
  state: AutoSaveState<T>,
  event: AutoSaveEvent<T>,
  equals: (a: T, b: T) => boolean,
): { state: AutoSaveState<T>; effect: AutoSaveEffect<T> } {
  switch (event.type) {
    case "change":
      if (state.phase === "sending") return { state: { ...state, desired: event.value, again: true, status: "saving" }, effect: null };
      return { state: { ...state, desired: event.value, phase: "waiting", status: "saving" }, effect: { kind: "schedule" } };
    case "due":
      if (state.phase !== "waiting") return { state, effect: null };
      // Voltou ao que já está gravado (marcou e desmarcou): nada a enviar.
      if (state.desired === null || equals(state.desired, event.saved)) {
        return { state: { ...state, desired: null, phase: "idle", again: false, status: "idle" }, effect: null };
      }
      return { state: { ...state, phase: "sending", again: false }, effect: { kind: "send", value: state.desired, epoch: state.epoch } };
    case "done":
      if (event.epoch !== state.epoch || state.phase !== "sending") return { state, effect: null };
      if (state.again && state.desired !== null) {
        return { state: { ...state, again: false }, effect: { kind: "send", value: state.desired, epoch: state.epoch } };
      }
      return { state: { ...state, desired: null, phase: "idle", again: false, status: "saved" }, effect: { kind: "saved" } };
    case "failed":
      if (event.epoch !== state.epoch || state.phase !== "sending") return { state, effect: null };
      return { state: { ...state, desired: null, phase: "idle", again: false, status: "idle" }, effect: null };
    case "settled":
      return state.status === "saved" ? { state: { ...state, status: "idle" }, effect: null } : { state, effect: null };
    case "reset":
      return { state: { ...AUTO_SAVE_START, epoch: state.epoch + 1 }, effect: { kind: "cancel" } };
  }
}
