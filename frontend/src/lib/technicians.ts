// Ficha do técnico na central (/tecnicos/[id]) e lista de Técnicos: o grupo Gestão do menu, o link da ficha, os
// filtros da lista na URL, os rótulos de situação, e-mails e análises, e as regras puras das seções da ficha (API de
// antes, endereço e RG). Só `import type` (testável no Node, como lib/constants.ts): tests/technicians.test.mjs e
// tests/ficha-mapa.test.mjs. Os três primeiros grupos do menu, a entrega no ar, os períodos de
// indisponibilidade e o e-mail que recebe ficam em lib/constants.ts (TECH_SECTION_GROUPS, CADASTRO_DELIVERY,
// periodShort, unavailableOn e isSendableEmail), iguais no app.

import type {
  ApplicationReview,
  DayPeriod,
  EmailLogStatus,
  EmailTemplate,
  LevelTier,
  OperationalStatus,
  TechSectionKey,
  UUID,
  Weekday,
} from "./types";

// --------------------------------------------------------------------------- ficha do técnico

/** Seções só da central, no grupo Gestão. */
export type GestaoSectionKey = "situacao" | "equipe" | "favoritos" | "avaliacoes" | "desempenho" | "elo" | "anexos" | "historico";

/** O `?secao=` da ficha: as seções de TECH_SECTION_GROUPS e as da Gestão. */
export type FichaSectionKey = TechSectionKey | GestaoSectionKey;

/** A seção que a ficha abre sem `?secao=` (ou com uma que não está no menu). */
export const FICHA_DEFAULT: FichaSectionKey = "dados-pessoais";

/** O grupo do menu que só a central tem, depois dos três de TECH_SECTION_GROUPS (no menu, só `delivery <= CADASTRO_DELIVERY`). */
export const GESTAO_GROUP: {
  key: "gestao";
  label: "Gestão";
  sections: readonly { key: GestaoSectionKey; label: string; delivery: 1 | 2 | 3 }[];
} = {
  key: "gestao",
  label: "Gestão",
  sections: [
    { key: "situacao", label: "Situação", delivery: 1 },
    { key: "equipe", label: "Equipe e jornada", delivery: 1 },
    { key: "favoritos", label: "Favoritos", delivery: 1 },
    { key: "avaliacoes", label: "Avaliações", delivery: 2 },
    { key: "desempenho", label: "Desempenho", delivery: 3 },
    { key: "elo", label: "Elo", delivery: 1 },
    { key: "anexos", label: "Anexos internos", delivery: 2 },
    { key: "historico", label: "Histórico", delivery: 1 },
  ],
};

/** A seção pedida na URL quando ela está no menu (`available`); senão, FICHA_DEFAULT (a URL não é reescrita). */
export function sectionFromParam(value: string | null, available: readonly FichaSectionKey[]): FichaSectionKey {
  const found = available.find((key) => key === value);
  return found ?? FICHA_DEFAULT;
}

/** "/tecnicos/{id}"; com uma seção que não é a padrão, "/tecnicos/{id}?secao={seção}". */
export function technicianHref(id: UUID, section?: FichaSectionKey | null): string {
  const base = `/tecnicos/${encodeURIComponent(id)}`;
  return section && section !== FICHA_DEFAULT ? `${base}?secao=${section}` : base;
}

// --------------------------------------------------------------------------- situação na operação

/** Cor do selo fora de Ativo (cor só para problema; Ativo é neutro). */
export const OPERATIONAL_STATUS_COLOR: Record<"inactive" | "blocked", string> = { inactive: "#d97706", blocked: "#dc2626" };

/**
 * Ordem padrão da lista: Ativo com acesso (0), Ativo sem acesso ao app (1), Inativo (2), Bloqueado (3); depois, o nome.
 * Sem `operational_status` (API antiga): Ativo.
 */
export function operationalRank(t: { operational_status?: OperationalStatus; is_active: boolean }): 0 | 1 | 2 | 3 {
  const status = t.operational_status ?? "active";
  if (status === "blocked") return 3;
  if (status === "inactive") return 2;
  return t.is_active ? 0 : 1;
}

/** Inativo ou Bloqueado: não recebe OS. Sem `operational_status` (API antiga): Ativo. */
export function isOutOfActive(t: { operational_status?: OperationalStatus }): boolean {
  return (t.operational_status ?? "active") !== "active";
}

/** O `title` do selo Inativo/Bloqueado: o motivo; só quando ele não vem, "Não recebe OS". */
export function operationalTitle(reason: string | null | undefined): string {
  return reason?.trim() || "Não recebe OS";
}

// --------------------------------------------------------------------------- ficha: API de antes e endereço

/**
 * O detalhe veio da API de antes do cadastro V2 (até a publicação): a nova sempre manda `address_number` (null quando
 * vazio). Com a antiga, as partes novas da ficha ficam só leitura ("Indisponível no momento."): ela ignora calada o que
 * não conhece, e salvar o Endereço trocaria a linha inteira gravada ("Rua Exemplo, 123 - Apto 4") só pelo logradouro.
 */
export function isLegacyDetail(t: { address_number?: string | null }): boolean {
  return t.address_number === undefined;
}

/** O número do endereço como a API grava (= personal.address_number): espaços juntos, maiúsculas; "SN" e "S / N", "S/N". */
export function addressNumberText(text: string): string {
  const value = text.replace(/\s+/g, " ").trim().toUpperCase();
  return /^(?:S\s*\/\s*N|SN)$/.test(value) ? "S/N" : value;
}

/** O endereço em partes da ficha (Endereço). */
export interface AddressParts {
  street: string;
  number: string;
  complement: string;
  district: string;
  city: string;
  state: string;
}

/**
 * O que o CEP muda no endereço da ficha: logradouro, bairro, cidade e UF de `next` (o cepFill) e, só com o logradouro
 * trocado de fato (`streetChanged`, pelo sameStreet de constants: acento, maiúsculas e espaços não contam), o número e o
 * complemento que ainda são os gravados saem (o digitado agora fica).
 */
export function addressAfterCep(
  value: AddressParts,
  base: AddressParts,
  next: Pick<AddressParts, "street" | "district" | "city" | "state">,
  streetChanged: boolean,
): Partial<AddressParts> {
  const changes: Partial<AddressParts> = { street: next.street, district: next.district, city: next.city, state: next.state };
  if (streetChanged) {
    if (value.number === base.number) changes.number = "";
    if (value.complement === base.complement) changes.complement = "";
  }
  return changes;
}

/**
 * O RG ao salvar: o órgão emissor sem a UF do fim (`split`, o splitIssuer de constants: "SSP/SP" → "SSP" e "SP") e a UF
 * do campo; com o campo vazio, a do fim do órgão (outra UF no campo: vale a do campo e o sufixo sai). Vazio vira null.
 */
export function rgIssuerFields(
  split: { issuer: string; state: string | null },
  fieldState: string,
): { rg_issuer: string | null; rg_state: string | null } {
  return { rg_issuer: split.issuer || null, rg_state: fieldState || split.state || null };
}

// --------------------------------------------------------------------------- e-mails e análises

/** O modelo na lista "E-mails enviados" (Credenciais). */
export const EMAIL_TEMPLATE_LABEL: Record<EmailTemplate, string> = {
  verify_email: "Validação de e-mail",
  welcome: "Boas-vindas",
  password_reset: "Redefinição de senha",
};

/** A situação do e-mail na fila; `expired`: venceu sem sair (envio desligado ou tentativas esgotadas). */
export const EMAIL_STATUS_LABEL: Record<EmailLogStatus, string> = {
  pending: "Na fila",
  sent: "Enviado",
  failed: "Falhou",
  expired: "Não enviado",
};

/** O rótulo da situação: com o envio desligado (`mailEnabled` false), o que está na fila não vai sair: "Não enviado". */
export function emailStatusLabel(status: EmailLogStatus, mailEnabled: boolean | undefined): string {
  return status === "pending" && mailEnabled === false ? EMAIL_STATUS_LABEL.expired : EMAIL_STATUS_LABEL[status];
}

/** As análises da ficha na Homologação. */
export const REVIEW_ACTION_LABEL: Record<ApplicationReview["action"], string> = {
  approved: "Aprovada",
  rejected: "Reprovada",
  reopened: "Reaberta",
  expired: "Expirada sem análise",
};

// --------------------------------------------------------------------------- filtros da lista na URL

/** Cadastro incompleto (filtro rápido da lista). */
export type GapKey = "phone" | "region" | "services" | "gps" | "payout";

/** A cidade escolhida na lista: o nome como veio e a UF (null: a cidade em qualquer UF). */
export interface CityChoice {
  city: string;
  /** "SP". */
  state: string | null;
}

/**
 * Os filtros da lista de Técnicos como a tela guarda; na URL, as grafias em português (listQueryFrom/listQueryPatch).
 * Só a busca vai ao servidor: o resto filtra a base carregada (lib/techListFilter.ts), combinado com E.
 */
export interface TechListQuery {
  q: string;
  /** "SP": a UF da região de atuação. */
  uf: string;
  /** A região de atuação ("Cidade-UF" na URL); sem UF, a cidade em qualquer UF. */
  cidade: CityChoice | null;
  situacao: OperationalStatus | "";
  /** Acesso ao app, como a API (`active`): "true" liberado, "false" sem acesso. */
  acesso: "" | "true" | "false";
  /** Ids dos catálogos de Configurações › Técnicos. */
  area: string;
  aptidao: string;
  ferramenta: string;
  /** Id do grupo técnico. */
  grupo: string;
  dia: Weekday | "";
  turno: DayPeriod | "";
  /** Favorito em alguma cidade. */
  favorito: boolean;
  /** Com certificação vencida ou vencendo em até 30 dias. */
  certificacao: "" | "vencendo";
  incompleto: GapKey | "";
  elo: LevelTier | "at_risk" | "";
  /** "name": a padrão (pela situação e pelo nome); "visit": última OS; "level": elo. */
  ordem: "name" | "visit" | "level";
}

/** As 27 UFs: "-SP" no fim do `cidade` é a UF; "-XX" que não é UF fica no nome. */
const STATES: ReadonlySet<string> = new Set([
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA",
  "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
]);

/**
 * O `cidade` da URL ("Cidade Exemplo-SP"; o "-sp" vale): a cidade e a UF do fim. Sem "-UF" (o link antigo mandava
 * `cidade` e `uf` separados), vale a `uf`; sem nenhuma, `state` null (a cidade em qualquer UF). Vazio: null.
 */
export function parseCityParam(cidade: string | null | undefined, uf?: string | null): CityChoice | null {
  const text = (cidade ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const end = /^(.*\S)\s*-\s*([A-Za-z]{2})$/.exec(text);
  if (end && STATES.has(end[2].toUpperCase())) return { city: end[1], state: end[2].toUpperCase() };
  const state = (uf ?? "").trim().toUpperCase();
  return { city: text, state: STATES.has(state) ? state : null };
}

/** A cidade para a URL e a tela: "Cidade Exemplo-SP"; sem UF, só a cidade. */
export function cityParam(city: string, state: string | null | undefined): string {
  return state ? `${city}-${state}` : city;
}

/** O texto termina numa UF ("Santos-SP"): a busca da aba Favoritos que vale como cidade na lista. */
export function hasStateSuffix(text: string | null | undefined): boolean {
  return parseCityParam(text, null)?.state != null;
}

const SITUACAO_PARAM: Record<OperationalStatus, string> = { active: "ativo", inactive: "inativo", blocked: "bloqueado" };
const ACESSO_PARAM: Record<"true" | "false", string> = { true: "liberado", false: "sem-acesso" };
const DIA_PARAM: Record<Weekday, string> = { mon: "seg", tue: "ter", wed: "qua", thu: "qui", fri: "sex", sat: "sab", sun: "dom" };
const TURNO_PARAM: Record<DayPeriod, string> = { morning: "manha", afternoon: "tarde", evening: "noite", night: "madrugada" };
const INCOMPLETO_PARAM: Record<GapKey, string> = {
  phone: "celular",
  region: "regiao",
  services: "servicos",
  gps: "gps",
  payout: "recebimento",
};
const ELO_PARAM: Record<LevelTier | "at_risk", string> = {
  bronze: "bronze",
  silver: "prata",
  gold: "ouro",
  diamond: "diamante",
  at_risk: "em-risco",
};
const ORDEM_PARAM: Record<"visit" | "level", string> = { visit: "ultima-os", level: "elo" };

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A chave do estado cuja grafia na URL é `value` (sem diferença de maiúsculas); desconhecida: "". */
function keyOf<K extends string>(params: Record<K, string>, value: string | null): K | "" {
  const text = (value ?? "").trim().toLowerCase();
  if (!text) return "";
  return (Object.keys(params) as K[]).find((key) => params[key] === text) ?? "";
}

/**
 * Os filtros da URL da lista (grafias em português) para o estado da tela; valor desconhecido e id que não é UUID viram
 * vazio. A cidade aceita "Cidade-UF" e o `cidade` + `uf` dos links antigos; a de outra UF que a `uf` escolhida sai (como
 * ao trocar a UF na tela).
 */
export function listQueryFrom(params: Pick<URLSearchParams, "get">): TechListQuery {
  const id = (name: string) => {
    const value = (params.get(name) ?? "").trim();
    return UUID_TEXT.test(value) ? value : "";
  };
  const state = (params.get("uf") ?? "").trim().toUpperCase();
  const uf = STATES.has(state) ? state : "";
  const city = parseCityParam(params.get("cidade"), uf);
  return {
    q: params.get("q") ?? "",
    uf,
    cidade: city && uf && city.state && city.state !== uf ? null : city,
    situacao: keyOf(SITUACAO_PARAM, params.get("situacao")),
    acesso: keyOf(ACESSO_PARAM, params.get("acesso")),
    area: id("area"),
    aptidao: id("aptidao"),
    ferramenta: id("ferramenta"),
    grupo: id("grupo"),
    dia: keyOf(DIA_PARAM, params.get("dia")),
    turno: keyOf(TURNO_PARAM, params.get("turno")),
    favorito: (params.get("favorito") ?? "").trim().toLowerCase() === "sim",
    certificacao: (params.get("certificacao") ?? "").trim().toLowerCase() === "vencendo" ? "vencendo" : "",
    incompleto: keyOf(INCOMPLETO_PARAM, params.get("incompleto")),
    elo: keyOf(ELO_PARAM, params.get("elo")),
    ordem: keyOf(ORDEM_PARAM, params.get("ordem")) || "name",
  };
}

/**
 * O estado da tela para a URL (replaceSearch): todos os parâmetros da lista, cada filtro na grafia em português; vazio
 * ou padrão: null (sai da URL). A cidade vai como "Cidade-UF".
 */
export function listQueryPatch(q: TechListQuery): Record<string, string | null> {
  return {
    q: q.q.trim() || null,
    uf: q.uf || null,
    cidade: q.cidade ? cityParam(q.cidade.city, q.cidade.state) : null,
    situacao: q.situacao ? SITUACAO_PARAM[q.situacao] : null,
    acesso: q.acesso ? ACESSO_PARAM[q.acesso] : null,
    area: q.area || null,
    aptidao: q.aptidao || null,
    ferramenta: q.ferramenta || null,
    grupo: q.grupo || null,
    dia: q.dia ? DIA_PARAM[q.dia] : null,
    turno: q.turno ? TURNO_PARAM[q.turno] : null,
    favorito: q.favorito ? "sim" : null,
    certificacao: q.certificacao || null,
    incompleto: q.incompleto ? INCOMPLETO_PARAM[q.incompleto] : null,
    elo: q.elo ? ELO_PARAM[q.elo] : null,
    ordem: q.ordem === "name" ? null : ORDEM_PARAM[q.ordem],
  };
}

/** Algum filtro ligado (a ordem não conta): "Limpar filtros" aparece. */
export function hasListFilter(q: TechListQuery): boolean {
  return Object.entries(listQueryPatch(q)).some(([key, value]) => key !== "ordem" && value !== null);
}

/** Os filtros vazios, com a ordem de agora ("Limpar filtros" apaga todos; a aba e a ordem ficam). */
export function clearedListQuery(ordem: TechListQuery["ordem"]): TechListQuery {
  return { ...listQueryFrom(new URLSearchParams()), ordem };
}
