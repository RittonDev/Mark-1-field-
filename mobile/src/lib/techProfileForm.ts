// Perfil técnico (Configurações › Atendimento): as regras das telas sem React nem React Native, para a sonda
// (tests/tech-profile-form.test.mjs). Só importa valores de ./constants (que só tem `import type`).
//
// - Nomes: `foldName` compara como o servidor (services/tech_profile.fold) e `cleanText` limpa como ele grava. Os dois
//   tiram os caracteres de controle e de formatação (invisíveis, BOM, direção), como o servidor, para contarem igual.
// - Disponibilidade: `toggleSlot`, `sameSlots`, `copyToWorkdays` e `canCopyToWorkdays` (a lista "dia:turno" da API).
// - Transporte: `toggleMode`, `sameTransport`, `transportBody`, o nunca informado (`TRANSPORT_UNSET`, com
//   `sameSavedTransport`) e o item "Nenhum" (`noneMarked`, `markNone`). Ferramental e Áreas de atuação: `toggleId`,
//   `sameSet`, `sortTools`, `filterTools` e a busca dos catálogos (`searchCatalog`).
// - Aptidões, do catálogo da central (GET /technician-skills): a chave de cada uma (`skillKey`: o id ou, com o servidor
//   de antes da gestão, o nome), o que a folha oferece (`availableSkills`) e os corpos do PATCH, montados com a lista
//   gravada na hora em que a gravação sai da fila (`skillsAdd`, `skillsWith`, `skillsWithout`, `skillsBody`):
//   `{skill_id, level}` com o catálogo no servidor, `{name, level}` sem ele.
// - Formação: o erro da folha (`educationProblem`, com ponto final, como os do Meu cadastro; os do servidor vêm sem
//   ponto) e o corpo do PATCH (`educationBody`, `educationWith`, `educationWithout`). O que o leitor de tela fala de
//   cada item.
// - O carimbo da central nas telas do perfil profissional (`centralStampText`).
// - Folha do mês: `thisMonth` e `monthGrid`.
// - Salvar ao tocar: o redutor `autoSaveStep`, que decide o que lib/autoSave.ts faz.

import {
  competenceLabel,
  EDUCATION_LEVEL,
  MONTH_ABBR,
  periodsPhrase,
  sinceText,
  SKILL_LEVEL,
  slotPeriods,
  sortSlots,
  TECH_PROFILE_LIMITS,
  TRANSPORT_MODE_ORDER,
  WEEKDAY,
  WORKDAYS,
} from "./constants";
import type {
  AvailabilitySlot,
  DayPeriod,
  EducationItem,
  EducationItemIn,
  EducationLevel,
  SkillLevel,
  TechnicianSkill,
  TechnicianSkillIn,
  TransportInfo,
  TransportMode,
  Weekday,
} from "./types";

// --------------------------------------------------------------------------- textos

/** Tab, LF, VT, FF e CR: viram espaço (e se juntam aos outros). */
const CONTROL_SPACE = /[\t\n\v\f\r]/g;
/** Os outros caracteres de controle (Cc, como o NUL) e de formatação (Cf: invisíveis, BOM, direção): saem. */
const CONTROL = /[\p{Cc}\p{Cf}]/gu;

/** Sem caracteres de controle e de formatação, como o servidor (antes de juntar os espaços). */
function withoutControls(text: string): string {
  return text.replace(CONTROL_SPACE, " ").replace(CONTROL, "");
}

/**
 * Para comparar nomes como o servidor (services/tech_profile.fold): sem acento, sem maiúsculas, sem caracteres de
 * controle e de formatação e com os espaços juntados. "Impressoras  HP" e "impressoras hp" são a mesma aptidão.
 */
export function foldName(text: string): string {
  return withoutControls(text).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * O texto como o servidor grava (services/tech_profile.clean): NFC, sem caracteres de controle e de formatação e com os
 * espaços juntados. Um nome só de invisíveis fica vazio.
 */
export function cleanText(text: string): string {
  return withoutControls(text).normalize("NFC").trim().replace(/\s+/g, " ");
}

/** Tamanho em caracteres, como o servidor conta (um emoji ocupa duas posições no texto do JavaScript). */
const chars = (text: string) => Array.from(text).length;

const pad = (n: number) => String(n).padStart(2, "0");

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

/** O botão "Copiar para os dias úteis": só num dia útil com turno, quando outro dia útil está diferente dele. */
export function canCopyToWorkdays(slots: readonly string[], day: Weekday): boolean {
  if (!WORKDAYS.includes(day)) return false;
  const periods = slotPeriods(slots, day);
  return periods.length > 0 && WORKDAYS.some((other) => other !== day && slotPeriods(slots, other).join() !== periods.join());
}

/** O cabeçalho do dia para o leitor de tela: "Segunda-feira, manhã e tarde"; sem turno, "Segunda-feira, sem turnos". */
export function daySpoken(day: Weekday, periods: readonly DayPeriod[]): string {
  return `${WEEKDAY[day].label}, ${periods.length ? periodsPhrase(periods) : "sem turnos"}`;
}

// --------------------------------------------------------------------------- transporte e ferramental

/** O mesmo conjunto (a ordem e os repetidos não contam): ids do ferramental, meios de transporte. */
export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((item) => right.has(item));
}

/**
 * O transporte nunca informado (`transport` null no cadastro): a tela começa sem nada marcado. Vale pela identidade,
 * não pelo valor (sameSavedTransport): sem meio e sem CNH informado é outra coisa ("Nenhum · sem CNH") e grava, mesmo
 * quando o técnico marca e desmarca um meio antes do envio. Não é null porque o salvar ao tocar usa null para "sem
 * cadastro na memória".
 */
export const TRANSPORT_UNSET: TransportInfo = Object.freeze({ modes: [], driver_license: false });

export function sameTransport(a: TransportInfo, b: TransportInfo): boolean {
  return a.driver_license === b.driver_license && sameSet(a.modes, b.modes);
}

/** A comparação do salvar ao tocar do Transporte: o nunca informado (TRANSPORT_UNSET) só é igual a ele mesmo. */
export function sameSavedTransport(a: TransportInfo, b: TransportInfo): boolean {
  return a === TRANSPORT_UNSET || b === TRANSPORT_UNSET ? a === b : sameTransport(a, b);
}

/** O item "Nenhum" (no fim dos meios) fica marcado: o transporte foi informado, sem meio. */
export function noneMarked(transport: TransportInfo): boolean {
  return transport !== TRANSPORT_UNSET && transport.modes.length === 0;
}

/** Tocar em "Nenhum": sem meio, com a mesma CNH (um valor novo, nunca o TRANSPORT_UNSET). */
export function markNone(transport: TransportInfo): TransportInfo {
  return { modes: [], driver_license: transport.driver_license };
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

/** Marca ou desmarca uma ferramenta (pelo id), sem repetir. */
export function toggleId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id];
}

/** A busca do Ferramental e das Áreas de atuação aparece com mais itens do que isto no catálogo. */
export const TOOL_SEARCH_AFTER = 15;

/** O catálogo em ordem alfabética, sem diferença de acento e maiúsculas (o servidor já manda assim; é por garantia). */
export function sortTools<T extends { name: string }>(tools: readonly T[]): T[] {
  return [...tools].sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" }));
}

/** A busca do Ferramental: o texto em qualquer parte do nome, sem acento e sem maiúsculas. */
export function filterTools<T extends { name: string }>(tools: readonly T[], query: string): T[] {
  const wanted = foldName(query);
  return wanted ? tools.filter((tool) => foldName(tool.name).includes(wanted)) : [...tools];
}

/** As palavras de um texto, sem acento e maiúsculas (o que não é letra nem número separa). */
const words = (text: string) => foldName(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Ordem alfabética sem diferença de acento e maiúsculas (a do servidor e a de sortTools). */
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" });

/**
 * A busca dos catálogos (folha das Aptidões e Áreas de atuação): cada palavra da busca em alguma parte do nome, sem
 * acento e maiúsculas. Primeiro os nomes que começam com a 1ª palavra, depois os que têm uma palavra começando com ela,
 * depois o resto; dentro de cada grupo, em ordem alfabética. Busca vazia: todos, em ordem alfabética.
 */
export function searchCatalog<T extends { name: string }>(items: readonly T[], query: string): T[] {
  const wanted = words(query);
  if (!wanted.length) return [...items].sort(byName);
  const [first] = wanted;
  const rank = (name: string) => (foldName(name).startsWith(first) ? 0 : words(name).some((word) => word.startsWith(first)) ? 1 : 2);
  return items
    .filter((item) => {
      const name = foldName(item.name);
      return wanted.every((word) => name.includes(word));
    })
    .map((item) => ({ item, rank: rank(item.name) }))
    .sort((a, b) => a.rank - b.rank || byName(a.item, b.item))
    .map(({ item }) => item);
}

// --------------------------------------------------------------------------- aptidões

export const SKILL_MSG = {
  /** A folha "Adicionar aptidão" sem nenhuma marcada. */
  pick: "Escolha ao menos uma aptidão.",
  level: "Escolha o nível.",
  /** Mudou o nível de uma aptidão que uma gravação anterior excluiu (ou que a central desativou). */
  gone: "Esta aptidão foi excluída.",
} as const;

/**
 * Uma aptidão da lista do técnico: com o catálogo no servidor (hasCadastroE2), ela vem com `skill_id`; o servidor de
 * antes da gestão manda só o nome.
 */
export type SkillRef = { skill_id?: string | null; name: string };

/** A chave da aptidão na tela (lista, lixeira e edição): "id:{uuid}" pelo catálogo; sem o id, "nome:{foldName}". */
export function skillKey(skill: SkillRef): string {
  return skill.skill_id ? `id:${skill.skill_id}` : `nome:${foldName(skill.name)}`;
}

/** A aptidão tem a chave? Uma chave pelo nome (de antes de o servidor ganhar o catálogo) vale também com o id. */
function hasKey(skill: SkillRef, key: string): boolean {
  return key.startsWith("nome:") ? `nome:${foldName(skill.name)}` === key : skillKey(skill) === key;
}

/**
 * Um item do PATCH. `byId` (o servidor tem o catálogo): `{skill_id, level}`. Sem ele, ou na aptidão sem id, `{name,
 * level}` com o nome limpo (o servidor casa o nome sem acento e maiúsculas). Nunca o `since`: o servidor o mantém.
 */
export function skillItemIn(skill: SkillRef & { level: SkillLevel }, byId: boolean): TechnicianSkillIn {
  return byId && skill.skill_id ? { skill_id: skill.skill_id, level: skill.level } : { name: cleanText(skill.name), level: skill.level };
}

/** A chave de um item do PATCH (o servidor recusa a aptidão repetida, pelo id ou pelo nome). */
const itemKey = (item: TechnicianSkillIn) => ("skill_id" in item ? `id:${item.skill_id}` : `nome:${foldName(item.name)}`);

/** O corpo do PATCH: a lista inteira, sem repetir (fica a primeira). */
export function skillsBody(list: readonly (SkillRef & { level: SkillLevel })[], byId: boolean): TechnicianSkillIn[] {
  const seen = new Set<string>();
  const body: TechnicianSkillIn[] = [];
  for (const skill of list) {
    const item = skillItemIn(skill, byId);
    const key = itemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    body.push(item);
  }
  return body;
}

/**
 * O que a folha "Adicionar aptidão" oferece: as ativas do catálogo, fora as que o técnico já tem (pelo id e, na dele sem
 * id, pelo nome sem acento e maiúsculas), na ordem do catálogo.
 */
export function availableSkills<T extends { id: string; name: string; is_active?: boolean | null }>(
  catalog: readonly T[],
  mine: readonly SkillRef[],
): T[] {
  const ids = new Set(mine.flatMap((skill) => (skill.skill_id ? [skill.skill_id] : [])));
  const names = new Set(mine.filter((skill) => !skill.skill_id).map((skill) => foldName(skill.name)));
  return catalog.filter((item) => item.is_active !== false && !ids.has(item.id) && !names.has(foldName(item.name)));
}

/**
 * Incluir as escolhidas na folha, todas com o mesmo nível: o corpo com a lista gravada agora e elas no fim, sem as que o
 * técnico já tem.
 */
export function skillsAdd(
  list: readonly (SkillRef & { level: SkillLevel })[],
  picked: readonly { id: string; name: string }[],
  level: SkillLevel,
  byId: boolean,
): TechnicianSkillIn[] {
  const fresh = availableSkills(picked, list).map((item) => ({ skill_id: item.id, name: item.name, level }));
  return skillsBody([...list, ...fresh], byId);
}

/**
 * Mudar o nível da aptidão `key` (skillKey): o corpo com a lista gravada agora. null: ela já saiu da lista (uma gravação
 * anterior a excluiu ou a central a desativou).
 */
export function skillsWith(
  list: readonly (SkillRef & { level: SkillLevel })[],
  key: string,
  level: SkillLevel,
  byId: boolean,
): TechnicianSkillIn[] | null {
  if (!list.some((item) => hasKey(item, key))) return null;
  return skillsBody(list.map((item) => (hasKey(item, key) ? { ...item, level } : item)), byId);
}

/** Excluir a aptidão `key` (skillKey): o corpo com a lista gravada agora, sem ela (a que já saiu não muda nada). */
export function skillsWithout(list: readonly (SkillRef & { level: SkillLevel })[], key: string, byId: boolean): TechnicianSkillIn[] {
  return skillsBody(list.filter((item) => !hasKey(item, key)), byId);
}

/** A linha de baixo da aptidão: "Avançado · desde 11/2026". */
export function skillLine(skill: Pick<TechnicianSkill, "level" | "since">): string {
  return `${SKILL_LEVEL[skill.level] ?? skill.level} · ${sinceText(skill.since)}`;
}

/** A aptidão para o leitor de tela: "Impressoras HP, Avançado, desde novembro de 2026". */
export function skillSpoken(skill: TechnicianSkill): string {
  return `${skill.name}, ${SKILL_LEVEL[skill.level] ?? skill.level}, desde ${competenceLabel(skill.since.slice(0, 7))}`;
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
  /** Salvou a edição de uma formação que uma gravação anterior excluiu. */
  gone: "Esta formação foi excluída.",
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

/** Mudou alguma coisa na folha (para perguntar antes de descartar e para liberar o "Salvar" da edição). */
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

/** Excluir: o corpo com a lista gravada agora, sem a formação `id`. */
export function educationWithout(list: readonly EducationItem[], id: string): EducationItemIn[] {
  return educationBody(list.filter((item) => item.id !== id));
}

/**
 * Incluir (sem `id`, no fim) ou salvar a editada (com o `id`, no lugar dela): o corpo com a lista gravada agora. null: a
 * editada já saiu da lista (uma gravação anterior a excluiu).
 */
export function educationWith(list: readonly EducationItem[], entry: EducationEntry): EducationItemIn[] | null {
  if (!entry.id) return educationBody([...list, entry]);
  if (!list.some((item) => item.id === entry.id)) return null;
  return educationBody(list.map((item) => (item.id === entry.id ? entry : item)));
}

/** O curso para o leitor de tela: "Técnico em redes, Técnico, Escola Exemplo, de fevereiro de 2022 a dezembro de 2023". */
export function educationSpoken(item: EducationItem): string {
  const period = item.end
    ? `de ${competenceLabel(item.start)} a ${competenceLabel(item.end)}`
    : `desde ${competenceLabel(item.start)}, em andamento`;
  return `${item.course}, ${EDUCATION_LEVEL[item.level] ?? item.level}, ${item.institution}, ${period}`;
}

// --------------------------------------------------------------------------- carimbo da central

/**
 * O carimbo de uma parte do perfil profissional (tech_profile_updated): "Atualizado pela central em 20/11/2026" (o dia
 * no fuso do aparelho) quando quem mudou a parte por último foi a central. Pelo app ou pela ficha da homologação, o
 * próprio técnico: null (a tela não mostra nada).
 */
export function centralStampText(stamp: { at: string; via: string } | null | undefined): string | null {
  if (stamp?.via !== "central") return null;
  const at = new Date(stamp.at);
  if (Number.isNaN(at.getTime())) return null;
  return `Atualizado pela central em ${pad(at.getDate())}/${pad(at.getMonth() + 1)}/${at.getFullYear()}`;
}

// --------------------------------------------------------------------------- folha do mês

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
  /** O servidor gravou o envio desta sessão; `saved`: o que ele guardou (pode ter ignorado algo). */
  | { type: "done"; epoch: number; saved: T }
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
 * com o último valor. Tocou durante o envio: quando ele volta, manda de novo na hora com o valor final (se ainda for
 * diferente do que o servidor gravou). Gravou: a tela volta a seguir o servidor (que pode ter ignorado algo, como uma
 * ferramenta desativada). Falhou: idem, sem o "Salvo". A sessão mudou: descarta em silêncio, e a resposta de um envio
 * de antes não conta.
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
      if (state.again && state.desired !== null && !equals(state.desired, event.saved)) {
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
