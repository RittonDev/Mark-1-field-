// Lista de Técnicos (app/(app)/tecnicos/page.tsx): os filtros que correm na tela sobre a base carregada (só a busca vai
// ao servidor), combinados com E, e a contagem de cada opção, que é o número de linhas que a lista mostra ao escolhê-la
// (a opção conta quem passa por todos os outros filtros). Também a região de atuação (a da coluna), a disponibilidade, os
// favoritos de cada técnico, os cadastros incompletos e as colunas novas da planilha. Puro e só com `import type` (a
// sonda tests/tech-list.test.mjs roda direto no Node): as ordens de lib/constants.ts ficam em cópias locais, que a sonda
// confere.

import type { CityChoice, GapKey, TechListQuery } from "./technicians";
import type { CertificationDue, DayPeriod, FavoritesOut, LevelTier, OperationalStatus, Technician, UUID, Weekday } from "./types";

/** = WEEKDAY_ORDER, DAY_PERIOD_ORDER e LEVEL_TIER_ORDER de lib/constants.ts (a sonda confere). */
export const LIST_WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const LIST_PERIODS: readonly DayPeriod[] = ["morning", "afternoon", "evening", "night"];
export const LIST_TIERS: readonly LevelTier[] = ["bronze", "silver", "gold", "diamond"];
export const LIST_STATUSES: readonly OperationalStatus[] = ["active", "inactive", "blocked"];

/** Os favoritos de cada técnico ("Cidade-UF" em ordem alfabética); null: a consulta dos favoritos ainda não chegou. */
export interface ListContext {
  favorites: ReadonlyMap<UUID, readonly string[]> | null;
}

// --------------------------------------------------------------------------- região de atuação

/** Para comparar cidades: sem acento, sem maiúsculas e com os espaços juntados. */
export function cityKey(text: string | null | undefined): string {
  return (text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A região de atuação da coluna da lista: a base (pelo histórico de OS) quando há `base_city`; senão, a cidade de casa;
 * sem nenhuma, null. A UF em maiúsculas (null sem ela).
 */
export function regionOf(t: Pick<Technician, "base_city" | "base_state" | "home_city" | "home_state">): CityChoice | null {
  const [city, state] = t.base_city?.trim() ? [t.base_city, t.base_state] : [t.home_city, t.home_state];
  const name = (city ?? "").replace(/\s+/g, " ").trim();
  if (!name) return null;
  const uf = (state ?? "").trim().toUpperCase();
  return { city: name, state: uf || null };
}

/** A região bate com a cidade escolhida: o nome sem acento, maiúsculas e espaços extras; a UF só quando a escolha tem. */
export function sameCity(region: CityChoice | null, choice: CityChoice): boolean {
  if (!region || cityKey(region.city) !== cityKey(choice.city)) return false;
  return !choice.state || region.state === choice.state;
}

/** A chave de uma cidade nas opções do filtro ("sao paulo|SP"): a mesma para "São Paulo" e "SAO PAULO". */
export function cityOptionKey(choice: CityChoice): string {
  return `${cityKey(choice.city)}|${choice.state ?? ""}`;
}

// --------------------------------------------------------------------------- disponibilidade, elo e cadastro

/**
 * Disponível no dia e no turno (a disponibilidade informada no app ou pela central): os dois, aquele turno daquele dia;
 * só o dia, algum turno dele; só o turno, em algum dia (= availability_filter da API). Sem dia nem turno, todos; quem não
 * informou a disponibilidade não entra no filtro.
 */
export function availableIn(slots: readonly string[] | null | undefined, dia: Weekday | "", turno: DayPeriod | ""): boolean {
  if (!dia && !turno) return true;
  return (slots ?? []).some((slot) => {
    const [day, period] = slot.split(":");
    return (!dia || day === dia) && (!turno || period === turno);
  });
}

/** A faixa do elo ou "em risco" (sem o elo na resposta, ninguém). */
function levelMatches(t: Pick<Technician, "level">, elo: LevelTier | "at_risk"): boolean {
  return elo === "at_risk" ? !!t.level?.at_risk : t.level?.tier === elo;
}

/** A situação na operação; a API de antes não manda: Ativo. */
export function statusOf(t: Pick<Technician, "operational_status">): OperationalStatus {
  return t.operational_status ?? "active";
}

/** Cadastros incompletos que atrapalham a operação (filtro rápido da lista; ?incompleto=). */
export const GAPS: readonly { key: GapKey; label: string; hint: string; test: (t: Technician) => boolean }[] = [
  { key: "phone", label: "Sem celular", hint: "Sem celular, o WhatsApp não abre direto na conversa", test: (t) => !t.phone },
  {
    key: "region",
    label: "Sem região",
    hint: "Sem cidade de casa nem histórico de atendimento: fica fora das sugestões por cidade",
    test: (t) => !t.base_city && !t.home_city,
  },
  { key: "services", label: "Sem serviços", hint: "Sem os serviços que faz", test: (t) => !(t.services ?? []).length },
  {
    key: "gps",
    label: "Sem aceite do GPS",
    hint: "Com acesso ao app, mas ainda não autorizou o GPS: não consegue iniciar a jornada",
    test: (t) => t.is_active && !t.location_consent_at,
  },
  {
    key: "payout",
    label: "Sem forma de recebimento",
    hint: "Sem forma de recebimento, não há para onde pagar: ele cadastra no app",
    // Só quando a API diz que não tem (sem o campo, não conta ninguém).
    test: (t) => t.is_active && t.payout_methods_count === 0,
  },
];

// --------------------------------------------------------------------------- filtros e contagens

/** Os filtros que correm na tela (a busca vai ao servidor; a ordem não filtra). Dia e turno são um filtro só. */
export type ListDim =
  | "cidade"
  | "uf"
  | "situacao"
  | "acesso"
  | "area"
  | "aptidao"
  | "ferramenta"
  | "grupo"
  | "disponibilidade"
  | "favorito"
  | "certificacao"
  | "incompleto"
  | "elo";

/** Os filtros ligados que o técnico não cumpre. */
function failures(t: Technician, q: TechListQuery, ctx: ListContext): ListDim[] {
  const failed: ListDim[] = [];
  const region = q.cidade || q.uf ? regionOf(t) : null;
  if (q.cidade && !sameCity(region, q.cidade)) failed.push("cidade");
  if (q.uf && region?.state !== q.uf) failed.push("uf");
  if (q.situacao && statusOf(t) !== q.situacao) failed.push("situacao");
  if (q.acesso && String(t.is_active) !== q.acesso) failed.push("acesso");
  if (q.area && !(t.area_ids ?? []).includes(q.area)) failed.push("area");
  if (q.aptidao && !(t.skills ?? []).some((skill) => skill.skill_id === q.aptidao)) failed.push("aptidao");
  if (q.ferramenta && !(t.tool_ids ?? []).includes(q.ferramenta)) failed.push("ferramenta");
  if (q.grupo && t.team?.id !== q.grupo) failed.push("grupo");
  if ((q.dia || q.turno) && !availableIn(t.availability, q.dia, q.turno)) failed.push("disponibilidade");
  if (q.favorito && !ctx.favorites?.has(t.id)) failed.push("favorito");
  if (q.certificacao && !t.certification_due) failed.push("certificacao");
  if (q.incompleto && !GAPS.find((gap) => gap.key === q.incompleto)?.test(t)) failed.push("incompleto");
  if (q.elo && !levelMatches(t, q.elo)) failed.push("elo");
  return failed;
}

/**
 * O técnico passa pelos filtros da tela (a busca já veio do servidor). `skip`: um filtro (ou vários) que não conta, o
 * da opção que se quer contar. Com "Favoritos" e a consulta dos favoritos ainda sem dado, ninguém passa.
 */
export function matchesList(t: Technician, q: TechListQuery, ctx: ListContext, skip?: ListDim | readonly ListDim[]): boolean {
  const skipped: readonly ListDim[] = skip === undefined ? [] : typeof skip === "string" ? [skip] : skip;
  return failures(t, q, ctx).every((dim) => skipped.includes(dim));
}

/** Uma cidade do filtro: "Cidade-UF" com quantos técnicos a lista mostra ao escolhê-la. */
export interface CityOption {
  /** cityOptionKey. */
  key: string;
  city: string;
  state: string | null;
  /** "São Paulo-SP" (a grafia mais comum entre os técnicos). */
  label: string;
  count: number;
}

/** A contagem de cada opção de cada filtro: as linhas que a lista mostra ao escolhê-la. */
export interface ListFacets {
  /** Só as cidades com alguém, em ordem alfabética sem acento e depois a UF. */
  cities: CityOption[];
  /** Por UF ("SP"), só as que têm alguém. */
  uf: Record<string, number>;
  situacao: Record<OperationalStatus, number>;
  acesso: Record<"true" | "false", number>;
  /** Por id do catálogo (os ausentes: 0). */
  area: Record<string, number>;
  aptidao: Record<string, number>;
  ferramenta: Record<string, number>;
  grupo: Record<string, number>;
  /** Com o turno escolhido, só nele; com o dia escolhido, só nele. */
  dia: Record<Weekday, number>;
  turno: Record<DayPeriod, number>;
  favorito: number;
  certificacao: number;
  incompleto: Record<GapKey, number>;
  /** null: a API ainda não manda o elo (ninguém da lista tem). */
  elo: Record<LevelTier | "at_risk", number> | null;
}

const zeros = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
const bump = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

const collator = new Intl.Collator("pt-BR", { sensitivity: "base" });

/**
 * As contagens dos filtros sobre a base carregada. Cada opção conta quem passa por todos os outros filtros e tem a opção:
 * é exatamente o que a lista mostra ao escolhê-la. A UF trocada tira a cidade de outra UF (a tela faz o mesmo), então a
 * contagem da UF segue essa regra. Dia e turno contam juntos com o outro escolhido.
 */
export function listFacets(list: readonly Technician[], q: TechListQuery, ctx: ListContext): ListFacets {
  const facets: ListFacets = {
    cities: [],
    uf: {},
    situacao: zeros(LIST_STATUSES),
    acesso: { true: 0, false: 0 },
    area: {},
    aptidao: {},
    ferramenta: {},
    grupo: {},
    dia: zeros(LIST_WEEKDAYS),
    turno: zeros(LIST_PERIODS),
    favorito: 0,
    certificacao: 0,
    incompleto: zeros(GAPS.map((gap) => gap.key)),
    elo: null,
  };
  const elo = zeros<LevelTier | "at_risk">([...LIST_TIERS, "at_risk"]);
  let knownLevel = false;
  // Por cidade: quantos e as grafias (a mais comum vira o rótulo).
  const cities = new Map<string, { state: string | null; count: number; names: Map<string, number> }>();

  for (const t of list) {
    if (t.level) knownLevel = true;
    const failed = failures(t, q, ctx);
    if (failed.length > 2) continue;
    // Passa por todos os filtros menos estes.
    const only = (...dims: ListDim[]) => failed.every((dim) => dims.includes(dim));

    if (only("cidade")) {
      const region = regionOf(t);
      if (region) {
        const key = cityOptionKey(region);
        const entry = cities.get(key) ?? { state: region.state, count: 0, names: new Map<string, number>() };
        entry.count += 1;
        entry.names.set(region.city, (entry.names.get(region.city) ?? 0) + 1);
        cities.set(key, entry);
      }
    }
    if (only("uf", "cidade")) {
      const state = regionOf(t)?.state;
      // Escolher a UF da cidade (ou com a cidade sem UF) mantém a cidade; outra UF tira a cidade.
      const keepsCity = !!q.cidade && (!q.cidade.state || q.cidade.state === state);
      if (state && (!keepsCity || !failed.includes("cidade"))) bump(facets.uf, state);
    }
    if (only("situacao")) facets.situacao[statusOf(t)] += 1;
    if (only("acesso")) facets.acesso[t.is_active ? "true" : "false"] += 1;
    if (only("area")) for (const id of new Set(t.area_ids ?? [])) bump(facets.area, id);
    if (only("aptidao")) {
      for (const id of new Set((t.skills ?? []).map((skill) => skill.skill_id).filter(Boolean))) bump(facets.aptidao, id);
    }
    if (only("ferramenta")) for (const id of new Set(t.tool_ids ?? [])) bump(facets.ferramenta, id);
    if (only("grupo") && t.team) bump(facets.grupo, t.team.id);
    if (only("disponibilidade")) {
      for (const day of LIST_WEEKDAYS) if (availableIn(t.availability, day, q.turno)) facets.dia[day] += 1;
      for (const period of LIST_PERIODS) if (availableIn(t.availability, q.dia, period)) facets.turno[period] += 1;
    }
    if (only("favorito") && ctx.favorites?.has(t.id)) facets.favorito += 1;
    if (only("certificacao") && t.certification_due) facets.certificacao += 1;
    if (only("incompleto")) for (const gap of GAPS) if (gap.test(t)) facets.incompleto[gap.key] += 1;
    if (only("elo") && t.level) {
      elo[t.level.tier] += 1;
      if (t.level.at_risk) elo.at_risk += 1;
    }
  }

  facets.elo = knownLevel ? elo : null;
  facets.cities = [...cities.entries()]
    .map(([key, entry]): CityOption => {
      // A grafia mais comum; no empate, a que vem primeiro em ordem alfabética.
      const city = [...entry.names.entries()].sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0]))[0][0];
      return { key, city, state: entry.state, label: entry.state ? `${city}-${entry.state}` : city, count: entry.count };
    })
    .sort((a, b) => collator.compare(a.city, b.city) || (a.state ?? "").localeCompare(b.state ?? ""));
  return facets;
}

// --------------------------------------------------------------------------- favoritos

/**
 * Os favoritos efetivos por técnico (fixados e automáticos) de GET /technicians/favorites, a consulta da aba Favoritos:
 * id → "Cidade-UF" em ordem alfabética. Sem a consulta, null.
 */
export function favoriteCitiesMap(out: Pick<FavoritesOut, "cities"> | null | undefined): Map<UUID, string[]> | null {
  if (!out) return null;
  const map = new Map<UUID, string[]>();
  for (const city of out.cities) {
    const label = `${city.city}-${city.state}`;
    for (const favorite of city.favorites) {
      const list = map.get(favorite.id) ?? [];
      if (!list.includes(label)) list.push(label);
      map.set(favorite.id, list);
    }
  }
  for (const list of map.values()) list.sort((a, b) => collator.compare(a, b) || a.localeCompare(b));
  return map;
}

// --------------------------------------------------------------------------- planilha

/** O cabeçalho da planilha da lista (sem CPF, RG, nascimento nem dados de recebimento: ela circula fora do sistema). */
export const TECH_CSV_HEADER: readonly string[] = [
  "nome",
  "email",
  "celular",
  "grupo",
  "cidade",
  "uf",
  "regiao_atuacao",
  "situacao",
  "situacao_motivo",
  "acesso_app",
  "email_validado",
  "forma_recebimento",
  "ultimo_acesso",
  "ultima_os",
  "os_abertas",
  "elo",
  "elo_em_risco",
  "ferramental",
  "disponibilidade",
  "transporte",
  "cnh",
  "aptidoes",
  "areas_atuacao",
  "favorito_em",
  "certificacao_vencendo",
  "avaliacao_media",
  "avaliacoes",
  "perfil_tecnico_atualizado_em",
];

/** Os nomes dos ids pelo catálogo, em ordem alfabética, com "; " (o que não está no catálogo fica de fora). */
export function namesText(ids: readonly UUID[] | null | undefined, names: ReadonlyMap<UUID, string>): string {
  return (ids ?? [])
    .flatMap((id) => names.get(id) ?? [])
    .sort((a, b) => collator.compare(a, b) || a.localeCompare(b))
    .join("; ");
}

/** "AAAA-MM-DD" → "dd/mm/aaaa". */
function dayText(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** A certificação mais urgente na planilha: "NR10 vencida em 25/11/2026" ou "NR10 vence em 10/12/2026"; sem, "". */
export function certificationCsvText(due: Pick<CertificationDue, "title" | "expires_on"> | null | undefined, today: string): string {
  if (!due) return "";
  return `${due.title} ${due.expires_on < today ? "vencida" : "vence"} em ${dayText(due.expires_on)}`;
}
