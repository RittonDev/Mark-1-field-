// Ficha do técnico na central (/tecnicos/[id]) e lista de Técnicos: o grupo Gestão do menu, o link da ficha, os
// filtros da lista na URL e os rótulos de situação, e-mails e análises. Só `import type` (testável no Node, como
// lib/constants.ts): tests/technicians.test.mjs. Os três primeiros grupos do menu, a entrega no ar, os períodos de
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

/** Os filtros da lista de Técnicos como a tela guarda; na URL, as grafias em português (listQueryFrom/listQueryPatch). */
export interface TechListQuery {
  q: string;
  /** "SP". */
  uf: string;
  cidade: string;
  /** Id do grupo técnico. */
  grupo: string;
  /** Acesso ao app, como a API (`active`): "true" liberado, "false" sem acesso. */
  acesso: "" | "true" | "false";
  /** Id da ferramenta. */
  ferramenta: string;
  dia: Weekday | "";
  turno: DayPeriod | "";
  incompleto: GapKey | "";
  elo: LevelTier | "at_risk" | "";
  /** "name": a padrão (pela situação e pelo nome); "visit": última OS; "level": elo. */
  ordem: "name" | "visit" | "level";
}

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

/** Os filtros da URL da lista (grafias em português) para o estado da tela; valor desconhecido vira "". */
export function listQueryFrom(params: Pick<URLSearchParams, "get">): TechListQuery {
  const id = (name: string) => {
    const value = (params.get(name) ?? "").trim();
    return UUID_TEXT.test(value) ? value : "";
  };
  const uf = (params.get("uf") ?? "").trim().toUpperCase();
  return {
    q: params.get("q") ?? "",
    uf: /^[A-Z]{2}$/.test(uf) ? uf : "",
    cidade: (params.get("cidade") ?? "").trim(),
    grupo: id("grupo"),
    acesso: keyOf(ACESSO_PARAM, params.get("acesso")),
    ferramenta: id("ferramenta"),
    dia: keyOf(DIA_PARAM, params.get("dia")),
    turno: keyOf(TURNO_PARAM, params.get("turno")),
    incompleto: keyOf(INCOMPLETO_PARAM, params.get("incompleto")),
    elo: keyOf(ELO_PARAM, params.get("elo")),
    ordem: keyOf(ORDEM_PARAM, params.get("ordem")) || "name",
  };
}

/** O estado da tela para a URL (replaceSearch): cada filtro na grafia em português; vazio ou padrão: null (sai da URL). */
export function listQueryPatch(q: TechListQuery): Record<string, string | null> {
  return {
    q: q.q.trim() || null,
    uf: q.uf || null,
    cidade: q.cidade || null,
    grupo: q.grupo || null,
    acesso: q.acesso ? ACESSO_PARAM[q.acesso] : null,
    ferramenta: q.ferramenta || null,
    dia: q.dia ? DIA_PARAM[q.dia] : null,
    turno: q.turno ? TURNO_PARAM[q.turno] : null,
    incompleto: q.incompleto ? INCOMPLETO_PARAM[q.incompleto] : null,
    elo: q.elo ? ELO_PARAM[q.elo] : null,
    ordem: q.ordem === "name" ? null : ORDEM_PARAM[q.ordem],
  };
}

/**
 * A cidade que a lista filtra, a partir do `cidade` da URL (o mesmo parâmetro da aba Favoritos): só vale com a UF, e a
 * busca dos Favoritos chega como "Santos-SP" (o link "Favorito em"), que sem o "-UF" do fim é a cidade.
 */
export function listCityOf(cidade: string, uf: string): string {
  if (!uf) return "";
  const suffix = `-${uf}`;
  return cidade.toUpperCase().endsWith(suffix.toUpperCase()) ? cidade.slice(0, -suffix.length).trim() : cidade;
}
