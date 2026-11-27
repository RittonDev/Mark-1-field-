"use client";

import clsx from "clsx";
import {
  Camera,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  History,
  ImageIcon,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  WifiOff,
  XCircle,
} from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CepField } from "@/components/CepField";
import { useConfirm } from "@/components/Confirm";
import { apiText, isOffline, PublicPanel, PublicShell } from "@/components/PublicPage";
import { Button, buttonClassName, Card, Checkbox, ErrorBox, Field, Input, LoadingBlock, Select, Textarea } from "@/components/ui";
import { type AddressSlots, NO_ADDRESS, normalizeAddressNumber } from "@/lib/address";
import { ApiError, apiErrorCode, errorMessage, request } from "@/lib/api";
import { useIsClient } from "@/lib/auth";
import {
  ageAt,
  BIRTH_AGE,
  CEP_TEXT,
  DOCUMENT_ACCEPT,
  DOCUMENT_KIND,
  DOCUMENT_LIMITS,
  DOCUMENT_TITLE_SUGGESTIONS,
  formatPlate,
  isValidPlate,
  isValidRg,
  normalizeBio,
  normalizeIssuer,
  normalizePlate,
  normalizeRg,
  PROFILE_LIMITS,
  splitIssuer,
  TECH_PROFILE_LIMITS,
} from "@/lib/constants";
import {
  cleanDocumentTitle,
  documentExpiryProblem,
  documentFileProblem,
  documentTitleProblem,
  EXPIRY_FIRST_DAY,
  expiryLastDay,
  newUploadId,
} from "@/lib/documents";
import { formatBytes, formatDate, formatDateTime, todayISO } from "@/lib/format";
import {
  isValidCnpj,
  isValidCpf,
  maskCnpj,
  maskCpf,
  maskPhone,
  PRIVACY_NOTICE,
  PRIVACY_VERSION,
  resizePhoto,
  UFS,
  useOnboardingCatalog,
} from "@/lib/onboarding";
import type { CatalogItem, EmailQueued, FichaDocument, OnboardingCatalog } from "@/lib/types";

const STEPS = ["Seus dados", "Endereço", "Atuação", "Disponibilidade e transporte", "Acesso e privacidade"];

/** Nome de cada campo para o técnico (a API devolve o nome técnico) e a etapa em que ele está. */
const FIELDS: Record<string, { label: string; step: number }> = {
  full_name: { label: "Nome completo", step: 0 },
  email: { label: "E-mail", step: 0 },
  phone: { label: "Celular", step: 0 },
  phone_secondary: { label: "Telefone secundário", step: 0 },
  document: { label: "CPF", step: 0 },
  birth_date: { label: "Data de nascimento", step: 0 },
  rg_number: { label: "RG", step: 0 },
  rg_issuer: { label: "Órgão emissor", step: 0 },
  rg_state: { label: "UF do RG", step: 0 },
  photo: { label: "Foto", step: 0 },
  postal_code: { label: "CEP", step: 1 },
  address: { label: "Logradouro", step: 1 },
  address_number: { label: "Número", step: 1 },
  address_complement: { label: "Complemento", step: 1 },
  address_district: { label: "Bairro", step: 1 },
  city: { label: "Cidade", step: 1 },
  state: { label: "UF", step: 1 },
  coverage_area: { label: "Região que você atende", step: 1 },
  service_areas: { label: "Áreas de atuação", step: 2 },
  years_experience: { label: "Anos de experiência", step: 2 },
  skills: { label: "Aptidões", step: 2 },
  certifications: { label: "Certificações e cursos", step: 2 },
  tools: { label: "Ferramentas próprias", step: 2 },
  bio: { label: "Mini biografia", step: 2 },
  company_document: { label: "CNPJ / MEI", step: 2 },
  company_name: { label: "Razão social", step: 2 },
  company_trade_name: { label: "Nome fantasia", step: 2 },
  availability: { label: "Disponibilidade", step: 3 },
  has_vehicle: { label: "Veículo", step: 3 },
  vehicle_type: { label: "Tipo de veículo", step: 3 },
  vehicle_model: { label: "Modelo do veículo", step: 3 },
  vehicle_plate: { label: "Placa", step: 3 },
  has_driver_license: { label: "CNH", step: 3 },
  notes: { label: "Observações", step: 3 },
  password: { label: "Senha", step: 4 },
  password2: { label: "Confirme a senha", step: 4 },
  privacy_consent: { label: "Aviso de privacidade", step: 4 },
};

/** Campos que mostram o problema logo abaixo deles (o RG, abaixo da linha dos três); nos demais, ele vai no fim da etapa. */
const INLINE_FIELDS = new Set([
  "full_name",
  "email",
  "phone",
  "phone_secondary",
  "document",
  "birth_date",
  "rg_number",
  "rg_issuer",
  "rg_state",
  "postal_code",
  "address",
  "address_number",
  "address_complement",
  "address_district",
  "city",
  "state",
  "coverage_area",
  "service_areas",
  "years_experience",
  "skills",
  "certifications",
  "tools",
  "bio",
  "company_document",
  "company_name",
  "company_trade_name",
  "availability",
  "vehicle_model",
  "vehicle_plate",
  "notes",
  "password",
  "password2",
  "privacy_consent",
]);

/** O que está errado e em qual campo (para marcar, levar até ele e anunciar). */
interface Problem {
  field: string | null;
  message: string;
  /** A mensagem fala só deste campo: aparece logo abaixo dele (senão, no fim da etapa). */
  inline?: boolean;
  /** `name` do campo que recebe o foco, quando não é o próprio (o nome de uma das aptidões). */
  target?: string;
}

/** Primeira letra maiúscula e ponto final ("mínimo de 3 caracteres" -> "Mínimo de 3 caracteres."). */
function sentence(text: string): string {
  const trimmed = text.trim();
  const capitalized = `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

interface ValidationIssue {
  loc?: (string | number)[];
  msg?: string;
  type?: string;
  ctx?: Record<string, unknown>;
}

/** Mensagem do Pydantic em português simples (sem nomes técnicos nem inglês). */
function translateIssue(issue: ValidationIssue): { text: string; withLabel: boolean } {
  const ctx = issue.ctx ?? {};
  const msg = (issue.msg ?? "").replace(/^Value error, /, "");
  switch (issue.type) {
    case "missing":
      return { text: "obrigatório", withLabel: true };
    case "string_too_short":
      return { text: `mínimo de ${ctx.min_length} caracteres`, withLabel: true };
    case "string_too_long":
      return { text: `máximo de ${ctx.max_length} caracteres`, withLabel: true };
    case "too_short":
      return { text: `escolha pelo menos ${ctx.min_length}`, withLabel: true };
    case "too_long":
      return { text: `no máximo ${ctx.max_length}`, withLabel: true };
    case "less_than_equal":
      return { text: `no máximo ${ctx.le}`, withLabel: true };
    case "greater_than_equal":
      return { text: `no mínimo ${ctx.ge}`, withLabel: true };
    case "int_parsing":
    case "int_type":
    case "int_from_float":
      return { text: "use um número inteiro", withLabel: true };
    case "date_parsing":
    case "date_from_datetime_parsing":
    case "date_type":
      return { text: "data inválida", withLabel: true };
    case "literal_error":
      return { text: "opção inválida", withLabel: true };
    case "value_error":
      // E-mail recusado pelo validador vem em inglês; os nossos ("CPF inválido") já vêm em português.
      return /valid email/i.test(msg) ? { text: "e-mail inválido", withLabel: true } : { text: msg || "inválido", withLabel: false };
    default:
      return { text: "inválido", withLabel: true };
  }
}

/**
 * Recusas do envio pelas áreas e aptidões (pelo `code`), na etapa Atuação. `refetch`: a lista do servidor mudou depois
 * de a ficha abrir (área ou aptidão desativada ou excluída, a primeira área cadastrada), então ela é relida; `message`: o
 * recado da tela no lugar do texto do servidor.
 */
const CATALOG_ERRORS: Record<string, { field: "service_areas" | "skills"; refetch: boolean; message?: string }> = {
  AREA_NOT_FOUND: { field: "service_areas", refetch: true, message: "A lista de áreas mudou: confira as áreas e envie de novo." },
  AREA_REQUIRED: { field: "service_areas", refetch: true },
  AREAS_LIMIT: { field: "service_areas", refetch: false },
  SKILL_NOT_FOUND: { field: "skills", refetch: true, message: "A lista de aptidões mudou: confira as aptidões e envie de novo." },
  SKILL_UNKNOWN_NAME: { field: "skills", refetch: true, message: "A lista de aptidões mudou: confira as aptidões e envie de novo." },
  SKILL_REPEATED: { field: "skills", refetch: false },
};

/** Erro da API para a pessoa: o primeiro campo recusado (para levar até ele) e a mensagem em português. */
function apiProblem(error: unknown): Problem {
  if (error instanceof ApiError) {
    if (error.status === 0) {
      return { field: null, message: "Sem internet. Confira o sinal e toque em “Enviar ficha” de novo." };
    }
    if (Array.isArray(error.detail)) {
      const issues = (error.detail as ValidationIssue[]).map((issue) => {
        const field = (issue.loc ?? []).find((p): p is string => typeof p === "string" && p in FIELDS) ?? null;
        const { text, withLabel } = translateIssue(issue);
        return { field, text, labelled: field && withLabel ? `${FIELDS[field].label}: ${text}` : text };
      });
      // Um problema só, num campo que mostra o recado: aparece abaixo dele, sem repetir o nome do campo.
      if (issues.length === 1 && issues[0].field && INLINE_FIELDS.has(issues[0].field)) {
        return { field: issues[0].field, message: sentence(issues[0].text), inline: true };
      }
      return {
        field: issues.find((issue) => issue.field)?.field ?? null,
        message: issues.map((issue) => issue.labelled).join(" · "),
      };
    }
    if (typeof error.detail === "string" && error.detail) {
      // E-mail ou CPF de um cadastro que já existe: o recado vai junto do campo.
      const field = /e-mail/i.test(error.detail) ? "email" : /\bCPF\b/.test(error.detail) ? "document" : null;
      return { field, message: field ? sentence(error.detail) : error.detail, inline: !!field };
    }
    if (error.status >= 500) {
      return { field: null, message: "O servidor não respondeu agora. Espere um pouco e toque em “Enviar ficha” de novo." };
    }
  }
  return { field: null, message: errorMessage(error) };
}

/** Uma aptidão escolhida: a chave dela no catálogo da ficha (o id; na API de antes, o nome da sugestão) e o nível. */
interface Skill {
  key: string;
  level: string;
}

/** Até 30 aptidões e 20 áreas de atuação (a API recusa mais). */
const MAX_SKILLS = TECH_PROFILE_LIMITS.skills;
const MAX_AREAS = TECH_PROFILE_LIMITS.areas;
const SKILL_LEVELS = ["basico", "intermediario", "avancado"];
const DEFAULT_SKILL_LEVEL = "intermediario";
/** Quantas aptidões a busca mostra de uma vez. */
const SKILL_MATCHES = 20;

/** Sem acento, maiúsculas e espaços extras: "câmeras  ip" acha "Câmeras IP". */
function foldName(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/**
 * As áreas de atuação e as aptidões que a ficha oferece. API da Entrega 2: os catálogos de Configurações › Técnicos (as
 * ativas; `key` = id, e a aptidão vai pelo id). API de antes: as áreas fixas (`key` = código) e as sugestões de aptidão
 * (a aptidão vai pelo nome).
 */
interface Choices {
  areas: CatalogItem[];
  skills: CatalogItem[];
  skillsById: boolean;
}

function choicesOf(cat: OnboardingCatalog | undefined): Choices {
  const skillsById = Array.isArray(cat?.skills);
  const suggestions = cat?.skill_suggestions;
  const skills = skillsById
    ? (cat?.skills ?? [])
    : (Array.isArray(suggestions) ? suggestions : []).map((name) => ({ key: name, label: name }));
  return {
    areas: cat?.service_areas ?? [],
    skills: [...skills].sort((a, b) => a.label.localeCompare(b.label, "pt-BR", { sensitivity: "base" })),
    skillsById,
  };
}

interface FormState {
  full_name: string;
  email: string;
  phone: string;
  phone_secondary: string;
  document: string;
  birth_date: string;
  rg_number: string;
  rg_issuer: string;
  rg_state: string;
  postal_code: string;
  /** O logradouro. */
  address: string;
  address_number: string;
  address_complement: string;
  address_district: string;
  city: string;
  state: string;
  photo: string | null;
  service_areas: string[];
  years_experience: string;
  skills: Skill[];
  certifications: string;
  tools: string;
  bio: string;
  company_document: string;
  company_name: string;
  company_trade_name: string;
  coverage_area: string;
  availability: string[];
  has_vehicle: boolean;
  vehicle_type: string;
  vehicle_model: string;
  vehicle_plate: string;
  has_driver_license: boolean;
  notes: string;
  password: string;
  password2: string;
  privacy_consent: boolean;
}

const EMPTY: FormState = {
  full_name: "",
  email: "",
  phone: "",
  phone_secondary: "",
  document: "",
  birth_date: "",
  rg_number: "",
  rg_issuer: "",
  rg_state: "",
  postal_code: "",
  address: "",
  address_number: "",
  address_complement: "",
  address_district: "",
  city: "",
  state: "",
  photo: null,
  service_areas: [],
  years_experience: "",
  skills: [],
  certifications: "",
  tools: "",
  bio: "",
  company_document: "",
  company_name: "",
  company_trade_name: "",
  coverage_area: "",
  availability: [],
  has_vehicle: false,
  vehicle_type: "carro",
  vehicle_model: "",
  vehicle_plate: "",
  has_driver_license: false,
  notes: "",
  password: "",
  password2: "",
  privacy_consent: false,
};

/**
 * O RG como vai para a API: o órgão emissor sem a UF do fim ("SSP/SP" → órgão "SSP" e UF "SP"); a UF escolhida no campo
 * vale mais que a do fim (que então sai).
 */
function rgOf(form: Pick<FormState, "rg_number" | "rg_issuer" | "rg_state">) {
  const split = splitIssuer(form.rg_issuer);
  return { rg_number: form.rg_number.trim(), rg_issuer: split.issuer, rg_state: form.rg_state || split.state || "" };
}

/*
 * Rascunho neste aparelho: o navegador do celular descarta a aba quando a pessoa vai ao WhatsApp ou à
 * câmera, e a ficha voltava em branco. Fica 24 h, sem senha e sem foto, e some ao enviar. Volta sozinho
 * só no mesmo link; com outro link (o anterior expirou no meio, ou é outra pessoa no mesmo aparelho), a
 * ficha começa vazia e pergunta antes de usar o que ficou, sem mostrar os dados dele.
 */
const DRAFT_KEY = "mf-cadastro-tecnico";
const DRAFT_TTL_MS = 24 * 3_600_000;
/**
 * Versão 2: as 5 etapas (Endereço numa etapa própria) e os campos novos. Versão 3: áreas e aptidões do catálogo (pela
 * chave); o rascunho de antes perde as duas (a pessoa escolhe de novo).
 */
const DRAFT_VERSION = 3;
/** Etapa do rascunho sem versão (4 etapas: dados, atuação, região e disponibilidade, acesso) nas 5 de hoje. */
const OLD_DRAFT_STEP = [0, 2, 3, 4];
const DRAFT_FIELDS = [
  "full_name",
  "email",
  "phone",
  "phone_secondary",
  "document",
  "birth_date",
  "rg_number",
  "rg_issuer",
  "rg_state",
  "postal_code",
  "address",
  "address_number",
  "address_complement",
  "address_district",
  "city",
  "state",
  "service_areas",
  "years_experience",
  "skills",
  "certifications",
  "tools",
  "bio",
  "company_document",
  "company_name",
  "company_trade_name",
  "coverage_area",
  "availability",
  "has_vehicle",
  "vehicle_type",
  "vehicle_model",
  "vehicle_plate",
  "has_driver_license",
  "notes",
] as const satisfies readonly (keyof FormState)[];

function hasContent(form: FormState): boolean {
  return DRAFT_FIELDS.some((key) => JSON.stringify(form[key]) !== JSON.stringify(EMPTY[key]));
}

interface Draft {
  form: FormState;
  step: number;
  /** Começado neste mesmo link (sem o link, o rascunho é de antes desta regra). */
  sameLink: boolean;
}

/** Rascunho salvo (validado campo a campo: o que estiver fora do formato fica vazio). */
function loadDraft(token: string): Draft | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as {
      v?: unknown;
      savedAt?: number;
      step?: number;
      form?: Record<string, unknown>;
      token?: unknown;
    };
    if (!saved.savedAt || Date.now() - saved.savedAt > DRAFT_TTL_MS || !saved.form) {
      window.localStorage.removeItem(DRAFT_KEY);
      return null;
    }
    const form: FormState = { ...EMPTY };
    const target = form as unknown as Record<string, unknown>;
    // Antes da versão 3, as áreas eram os códigos fixos e as aptidões, texto livre: ficam de fora.
    const current = saved.v === DRAFT_VERSION;
    for (const key of DRAFT_FIELDS) {
      const value = saved.form[key];
      const base = EMPTY[key];
      if (key === "skills") {
        if (current && Array.isArray(value)) {
          const seen = new Set<string>();
          form.skills = value
            .filter((s): s is { key?: unknown; level?: unknown } => !!s && typeof s === "object")
            .flatMap((s) => {
              if (typeof s.key !== "string" || !s.key || seen.has(s.key)) return [];
              seen.add(s.key);
              return [{ key: s.key, level: typeof s.level === "string" && SKILL_LEVELS.includes(s.level) ? s.level : DEFAULT_SKILL_LEVEL }];
            })
            .slice(0, MAX_SKILLS);
        }
      } else if (key === "service_areas" && !current) {
        continue;
      } else if (Array.isArray(base) ? Array.isArray(value) && value.every((v) => typeof v === "string") : typeof value === typeof base) {
        target[key] = value;
      }
    }
    // Rascunho de antes das 5 etapas (sem versão): a etapa dele na ficha de hoje ("address" continua o mesmo campo, agora
    // o logradouro).
    const savedStep = Math.trunc(Number(saved.step) || 0);
    const step = typeof saved.v === "number" && saved.v >= 2 ? savedStep : (OLD_DRAFT_STEP[savedStep] ?? 0);
    return {
      form,
      step: Math.min(Math.max(step, 0), STEPS.length - 1),
      sameLink: typeof saved.token === "string" && saved.token === token,
    };
  } catch {
    return null;
  }
}

/** Grava o rascunho e diz se ele ficou guardado (sem conteúdo, não há o que guardar). */
function saveDraft(form: FormState, step: number, token: string): boolean {
  try {
    if (!hasContent(form)) {
      window.localStorage.removeItem(DRAFT_KEY);
      return true;
    }
    const data = Object.fromEntries(DRAFT_FIELDS.map((key) => [key, form[key]]));
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ v: DRAFT_VERSION, savedAt: Date.now(), step, form: data, token }));
    return true;
  } catch {
    // Sem armazenamento (aba anônima, bloqueio, cota cheia): a ficha funciona, só sem rascunho.
    return false;
  }
}

function clearDraft() {
  try {
    window.localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Idem.
  }
}

/*
 * Foto para o "Recarregar" do aviso de privacidade: o rascunho não leva a foto, que sumia no reload. Ela fica na
 * sessionStorage desta aba (some ao fechá-la), com a chave pelo link, gravada logo antes do reload e apagada assim que a
 * ficha abre. Sem sessionStorage (bloqueada ou cheia), a ficha volta sem a foto, e o painel avisa antes.
 */
const PHOTO_KEY = "mf-cadastro-tecnico-foto:";

/** Dá para gravar este valor agora (sem bloqueio nem cota cheia)? Grava e apaga na hora. */
function fits(area: "localStorage" | "sessionStorage", key: string, value: string): boolean {
  try {
    window[area].setItem(key, value);
    window[area].removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * "Recarregar" do painel do aviso: grava o rascunho (menos com a ficha de outro link esperando resposta) e a foto, e
 * recarrega. A senha e o aceite não voltam, de propósito: o técnico lê o texto novo e aceita de novo.
 */
function reloadKeeping(form: FormState, step: number, token: string, saveForm: boolean) {
  if (saveForm) saveDraft(form, step, token);
  if (form.photo) {
    try {
      window.sessionStorage.setItem(PHOTO_KEY + token, form.photo);
    } catch {
      // Sem sessionStorage: a ficha volta sem a foto (o painel já avisou).
    }
  }
  window.location.reload();
}

/**
 * A linha do painel: o que o técnico informa de novo depois do recarregar. A ficha some quando o painel aparece e não
 * muda mais, então o rascunho já é gravado aqui (o "Recarregar" grava de novo) e a foto é testada com o próprio valor:
 * a linha diz o que de fato volta, também com a cota quase cheia.
 */
function reloadNote(form: FormState, step: number, token: string, saveForm: boolean): string {
  const formKept = !hasContent(form) || (saveForm && saveDraft(form, step, token));
  const photoKept = !form.photo || fits("sessionStorage", PHOTO_KEY + token, form.photo);
  if (formKept) return photoKept ? "A senha você digita de novo." : "A senha e a foto você informa de novo.";
  return form.photo && photoKept ? "Os dados e a senha você informa de novo." : "A ficha volta em branco.";
}

/** A ficha ao abrir, com a foto que este link guardou para o recarregar. Só lê: quem apaga é dropKeptPhotos. */
function withKeptPhoto(form: FormState, token: string): FormState {
  try {
    const photo = window.sessionStorage.getItem(PHOTO_KEY + token);
    return photo?.startsWith("data:image/") ? { ...form, photo } : form;
  } catch {
    return form;
  }
}

/** Tira da aba as fotos guardadas para recarregar: a deste link, já lida, e sobras de outros links. */
function dropKeptPhotos() {
  try {
    const storage = window.sessionStorage;
    for (let i = storage.length - 1; i >= 0; i--) {
      const key = storage.key(i);
      if (key?.startsWith(PHOTO_KEY)) storage.removeItem(key);
    }
  } catch {
    // Sem sessionStorage: não há o que tirar.
  }
}

/**
 * O servidor tem um aviso de privacidade mais novo que o texto desta página (aberta antes de uma atualização): o aceite
 * gravaria a versão nova sobre o texto antigo. Versões AAAA-MM-DD ou AAAA-MM-DD.N, comparadas como texto. Igual, mais
 * antiga ou sem versão (API anterior a ela): segue normal.
 */
function privacyOutdated(server: unknown): boolean {
  return typeof server === "string" && server > PRIVACY_VERSION;
}

/** A versão do aviso que o servidor tem agora; null sem resposta (sem internet, servidor fora, tempo esgotado). */
async function serverPrivacyVersion(): Promise<string | null> {
  try {
    const catalog = await request<{ privacy_version?: unknown } | null>("/public/onboarding/catalog", {
      auth: false,
      timeoutMs: 10_000,
    });
    return typeof catalog?.privacy_version === "string" ? catalog.privacy_version : null;
  } catch {
    return null;
  }
}

/** Escolha marcada no estilo do Chip ativo (áreas, disponibilidade, nível da aptidão). */
const CHOSEN = "border-brand bg-brand text-white dark:border-brand-strong dark:bg-brand-strong";
const UNCHOSEN = "border-line bg-surface text-ink hover:border-brand";
const FOCUS_RING =
  "focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus-visible:outline-none";

function Chip({
  active,
  onClick,
  disabled = false,
  children,
}: {
  active: boolean;
  onClick: () => void;
  /** No limite da escolha: os que não estão marcados ficam travados. */
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      disabled={disabled}
      className={clsx(
        // Alvo de toque de 44 px no celular.
        "inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-9",
        FOCUS_RING,
        // No escuro, o azul forte: o branco sobre o azul da marca ficava abaixo de 4,5:1.
        active ? CHOSEN : UNCHOSEN,
      )}
    >
      {active ? <Check className="size-3.5" /> : null}
      {children}
    </button>
  );
}

type LinkCheck = "loading" | "valid" | "invalid" | "error";

function scrollTop() {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
}

/**
 * Resposta do envio: a validação do e-mail e o token dos documentos vêm das APIs novas (a primeira manda só o
 * protocolo). Sem `upload_token` (API de antes da Entrega 2), a ficha enviada não oferece os documentos.
 */
interface SubmitResult {
  protocol: string;
  email_verification?: EmailQueued["status"];
  /** Envia e tira arquivos desta ficha, e só dela, até `upload_expires_at` (2 h). */
  upload_token?: string;
  upload_expires_at?: string;
}

type FichaKind = FichaDocument["kind"];

/** Um cartão de documento ainda sem o arquivo no servidor (o arquivo escolhido não cabe na sessionStorage). */
interface FichaDraft {
  id: string;
  kind: FichaKind;
  title: string;
  /** "AAAA-MM-DD" ou ""; só na certificação. */
  expires_on: string;
}

/** A ficha enviada, com o login (a ficha some depois do envio), os arquivos já recebidos e os cartões abertos. */
interface SentState extends SubmitResult {
  login: string;
  documents: FichaDocument[];
  drafts: FichaDraft[];
  savedAt: number;
}

/*
 * A ficha enviada fica nesta aba: depois do envio, a pessoa vai à câmera para os documentos, e o navegador do celular
 * pode descartar a aba. A sessionStorage (só desta aba; some ao fechá-la) guarda o protocolo, o login, o token dos
 * arquivos, o que já subiu e os cartões abertos (sem o arquivo): aberto de novo o mesmo link, volta o "Ficha enviada!"
 * com os documentos, até o prazo dos arquivos (sem ele, por 2 h). Sem sessionStorage, a página volta ao começo, como
 * antes.
 */
const SENT_KEY = "mf-cadastro-tecnico-enviada:";
const SENT_TTL_MS = 2 * 3_600_000;
const FICHA_KINDS: readonly string[] = ["certification", "personal", "resume"];

function isFichaDocument(value: unknown): value is FichaDocument {
  if (!value || typeof value !== "object") return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    typeof d.kind === "string" &&
    FICHA_KINDS.includes(d.kind) &&
    typeof d.title === "string" &&
    typeof d.file_name === "string" &&
    typeof d.size === "number" &&
    (d.expires_on === null || d.expires_on === undefined || typeof d.expires_on === "string")
  );
}

function isFichaDraft(value: unknown): value is FichaDraft {
  if (!value || typeof value !== "object") return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    typeof d.kind === "string" &&
    FICHA_KINDS.includes(d.kind) &&
    typeof d.title === "string" &&
    typeof d.expires_on === "string"
  );
}

/** A ficha enviada por este link nesta aba, dentro do prazo; null sem ela. */
function loadSent(token: string): SentState | null {
  try {
    const raw = window.sessionStorage.getItem(SENT_KEY + token);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<Record<keyof SentState, unknown>>;
    const savedAt = typeof saved.savedAt === "number" ? saved.savedAt : 0;
    const expires = typeof saved.upload_expires_at === "string" ? saved.upload_expires_at : undefined;
    const until = expires ? Date.parse(expires) : savedAt + SENT_TTL_MS;
    if (typeof saved.protocol !== "string" || !(until > Date.now())) {
      window.sessionStorage.removeItem(SENT_KEY + token);
      return null;
    }
    return {
      protocol: saved.protocol,
      email_verification: typeof saved.email_verification === "string" ? (saved.email_verification as SubmitResult["email_verification"]) : undefined,
      upload_token: typeof saved.upload_token === "string" ? saved.upload_token : undefined,
      upload_expires_at: expires,
      login: typeof saved.login === "string" ? saved.login : "",
      documents: Array.isArray(saved.documents) ? saved.documents.filter(isFichaDocument) : [],
      drafts: Array.isArray(saved.drafts) ? saved.drafts.filter(isFichaDraft) : [],
      savedAt,
    };
  } catch {
    return null;
  }
}

function saveSent(token: string, sent: SentState) {
  try {
    window.sessionStorage.setItem(SENT_KEY + token, JSON.stringify(sent));
  } catch {
    // Sem sessionStorage: o "Ficha enviada!" não volta depois de recarregar.
  }
}

export default function TechnicianSignupPage() {
  const { token } = useParams<{ token: string }>();
  const catalog = useOnboardingCatalog();
  const confirm = useConfirm();
  const [check, setCheck] = useState<LinkCheck>("loading");
  // Nova tentativa de abrir o link (sem internet ou servidor fora do ar no primeiro acesso).
  const [attempt, setAttempt] = useState(0);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  // O link expirou enquanto a pessoa preenchia: os dados ficam no rascunho para um link novo.
  const [expiredWhileFilling, setExpiredWhileFilling] = useState(false);
  const [draft] = useState(() => loadDraft(token));
  const own = draft?.sameLink ? draft : null;
  // Ficha começada neste aparelho por outro link: espera a pessoa dizer se é a dela.
  const [foreign, setForeign] = useState(() => (draft && !draft.sameLink ? draft : null));
  const [step, setStep] = useState(own?.step ?? 0);
  // Com a foto que este link guardou para o "Recarregar" (o rascunho não leva a foto).
  const [form, setForm] = useState<FormState>(() => withKeptPhoto(own?.form ?? EMPTY, token));
  const [problem, setProblem] = useState<Problem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // A ficha enviada por este link nesta aba (volta depois de recarregar, até o prazo dos documentos). Só depois da
  // hidratação: o servidor desenhou o "carregando".
  const [sent, setSent] = useState<SentState | null>(() => loadSent(token));
  const isClient = useIsClient();
  const shownSent = isClient ? sent : null;
  const cat = catalog.data;
  const choices = useMemo(() => choicesOf(cat), [cat]);
  // Só o que está no catálogo de agora conta e vai no envio: o rascunho pode trazer uma área ou aptidão que saiu dele.
  const chosenAreas = form.service_areas.filter((key) => choices.areas.some((a) => a.key === key));
  const areasFull = chosenAreas.length >= MAX_AREAS;
  const skillLabels = new Map(choices.skills.map((s) => [s.key, s.label]));
  const chosenSkills = form.skills.filter((s) => skillLabels.has(s.key));
  const formRef = useRef<HTMLFormElement>(null);
  const stepRef = useRef<HTMLParagraphElement>(null);
  const focusStepRef = useRef(false);
  const streetRef = useRef<HTMLInputElement>(null);
  const numberRef = useRef<HTMLInputElement>(null);
  // O que a busca do CEP pôs no endereço. A ficha não tem endereço gravado: o "aberto" do CepField é isto, para o campo
  // ainda com o valor da busca continuar livre depois de a pessoa ir a outra etapa e voltar (o campo monta de novo).
  const [cepFilled, setCepFilled] = useState<AddressSlots>(NO_ADDRESS);
  const companyTitleId = useId();
  // A versão do aviso relida no servidor (ao chegar à última etapa e no envio); antes disso, vale a do catálogo.
  const [latestPrivacy, setLatestPrivacy] = useState<string | null>(null);
  const last = step === STEPS.length - 1;

  useEffect(() => {
    let alive = true;
    request<{ valid: boolean; expires_at?: string | null }>(`/public/onboarding/${encodeURIComponent(token)}`, { auth: false })
      .then((r) => {
        if (!alive) return;
        setCheck(r.valid ? "valid" : "invalid");
        setExpiresAt(r.expires_at ?? null);
      })
      .catch((error) => {
        // 4xx: o link não serve. Sem internet (0) ou erro do servidor (5xx): dá para tentar de novo.
        if (alive) setCheck(error instanceof ApiError && error.status >= 400 && error.status < 500 ? "invalid" : "error");
      });
    return () => {
      alive = false;
    };
  }, [token, attempt]);

  // Rascunho neste aparelho enquanto a pessoa preenche (some depois do envio). Com a ficha de outro link
  // esperando a resposta, a ficha vazia não a apaga; a pessoa digitando, o rascunho passa a ser o dela.
  const pendingForeign = foreign !== null && !hasContent(form);
  useEffect(() => {
    if (sent || pendingForeign) return;
    const id = window.setTimeout(() => saveDraft(form, step, token), 600);
    return () => window.clearTimeout(id);
  }, [form, step, sent, pendingForeign, token]);

  // A ficha enviada e os documentos que já subiram ficam nesta aba (a câmera pode fazer o navegador recarregar).
  useEffect(() => {
    if (sent) saveSent(token, sent);
  }, [sent, token]);

  // A foto guardada para o "Recarregar" vale só para esta abertura: sai da aba logo depois de a ficha montar. Num efeito,
  // e não na leitura: um render descartado (suspensão, hidratação refeita) leria de novo e não a acharia mais.
  useEffect(() => {
    dropKeptPhotos();
  }, []);

  const resumeForeign = () => {
    if (!foreign) return;
    setForm(foreign.form);
    setProblem(null);
    setForeign(null);
    goTo(foreign.step);
  };
  const discardForeign = () => {
    clearDraft();
    setForeign(null);
  };

  // Etapa nova: o foco vai para o título da etapa (o leitor de tela anuncia onde a pessoa está).
  useEffect(() => {
    if (!focusStepRef.current) return;
    focusStepRef.current = false;
    stepRef.current?.focus({ preventScroll: true });
  }, [step]);

  // Problema num campo: marca, leva até ele e põe o foco ali.
  useEffect(() => {
    const root = formRef.current;
    if (!problem?.field || !root) return;
    const { field } = problem;
    const target =
      root.querySelector<HTMLElement>(`[name="${problem.target ?? field}"]`) ??
      root.querySelector<HTMLElement>(`[data-field="${field}"] input, [data-field="${field}"] button`);
    target?.focus();
  }, [problem]);

  // Na última etapa (o aviso e o aceite), relê a versão do aviso: a ficha pode ter ficado aberta durante uma atualização.
  useEffect(() => {
    if (!last) return;
    void serverPrivacyVersion().then((version) => {
      if (version !== null) setLatestPrivacy(version);
    });
  }, [last]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const toggle = (key: "service_areas" | "availability", value: string) =>
    setForm((f) => ({
      ...f,
      [key]: f[key].includes(value) ? f[key].filter((v) => v !== value) : [...f[key], value],
    }));
  // A mensagem que fala de um campo só aparece abaixo dele; as demais, no fim da etapa. O RG (três campos numa linha
  // estreita) tem o recado abaixo da linha.
  const inlineProblem = !!problem?.inline && !!problem.field && INLINE_FIELDS.has(problem.field);
  const rgProblem = inlineProblem && problem?.field?.startsWith("rg_") ? problem.message : null;
  const fieldError = (field: string) => (inlineProblem && problem?.field === field && !rgProblem ? problem.message : null);
  /** Marca o campo com problema para o leitor de tela (com a mensagem fora do campo, aponta para ela). */
  const invalid = (field: string) =>
    problem?.field === field
      ? {
          "aria-invalid": true as const,
          ...(rgProblem ? { "aria-describedby": "rg-problem" } : inlineProblem ? {} : { "aria-describedby": "form-problem" }),
        }
      : {};

  function validate(index: number): Problem | null {
    const fail = (field: string, message: string, target?: string): Problem => ({ field, message, inline: true, target });
    if (index === 0) {
      const name = form.full_name.trim();
      if (name.length < 5 || name.split(/\s+/).length < 2) return fail("full_name", "Informe seu nome completo (nome e sobrenome).");
      if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) return fail("email", "Informe um e-mail válido: ele será o seu login no app.");
      if (form.phone.replace(/\D/g, "").length < 10) return fail("phone", "Informe o celular com DDD.");
      const second = form.phone_secondary.replace(/\D/g, "");
      if (second && second.length < 10) return fail("phone_secondary", "Informe o telefone com DDD.");
      if (!isValidCpf(form.document)) return fail("document", "CPF inválido: confira os números.");
      if (form.birth_date) {
        // A mesma conta da API: idade completa no dia de hoje em Brasília.
        const age = ageAt(form.birth_date, todayISO());
        if (age === null || age < 0 || age > BIRTH_AGE.max) return fail("birth_date", "Confira a data de nascimento.");
        if (age < BIRTH_AGE.min) {
          return fail("birth_date", `O cadastro é para maiores de ${BIRTH_AGE.min} anos: confira a data de nascimento.`);
        }
      }
      const rg = rgOf(form);
      if (rg.rg_number || rg.rg_issuer || rg.rg_state) {
        const missing = (Object.keys(rg) as (keyof typeof rg)[]).find((key) => !rg[key]);
        if (missing) return fail(missing, "Informe o número, o órgão emissor e a UF do RG.");
        if (!isValidRg(rg.rg_number)) return fail("rg_number", "Confira o número do RG.");
        if (rg.rg_issuer.length < 2 || rg.rg_issuer.length > PROFILE_LIMITS.rgIssuer) return fail("rg_issuer", "Confira o órgão emissor.");
      }
    }
    if (index === 1) {
      const cep = form.postal_code.replace(/\D/g, "");
      if (cep && cep.length !== 8) return fail("postal_code", CEP_TEXT.invalid);
      if (form.city.trim().length < 2) return fail("city", "Informe a cidade.");
      if (!form.state) return fail("state", "Escolha a UF.");
      if (form.coverage_area.trim().length < 2) return fail("coverage_area", "Informe a região que você atende.");
    }
    if (index === 2) {
      // Sem nenhuma área no catálogo, o grupo nem aparece (e não é obrigatório).
      if (choices.areas.length && chosenAreas.length === 0) return fail("service_areas", "Escolha pelo menos uma área de atuação.");
      if (chosenAreas.length > MAX_AREAS) return fail("service_areas", `Até ${MAX_AREAS} áreas de atuação.`);
      const yearsText = form.years_experience.trim();
      if (yearsText) {
        const years = Number(yearsText);
        if (!Number.isInteger(years) || years < 0 || years > 60) {
          return fail("years_experience", "Anos de experiência: use um número de 0 a 60.");
        }
      }
      // O limite conta como a API grava (normalizeBio: sem as linhas em branco repetidas).
      if (normalizeBio(form.bio).length > PROFILE_LIMITS.bio) return fail("bio", `No máximo ${PROFILE_LIMITS.bio} caracteres.`);
      if (form.company_document.trim() && !isValidCnpj(form.company_document)) {
        return fail("company_document", "CNPJ inválido: confira os números (ou deixe em branco).");
      }
    }
    if (index === 3 && form.has_vehicle && form.vehicle_plate.trim() && !isValidPlate(form.vehicle_plate)) {
      return fail("vehicle_plate", "Placa inválida: confira as letras e os números.");
    }
    if (index === 4) {
      if (form.password.length < 8) return fail("password", "A senha precisa ter pelo menos 8 caracteres.");
      if (form.password !== form.password2) return fail("password2", "As senhas não conferem.");
      if (!form.privacy_consent) return fail("privacy_consent", "Para enviar, aceite o aviso de privacidade.");
    }
    return null;
  }

  function goTo(index: number) {
    focusStepRef.current = true;
    setStep(index);
    scrollTop();
  }

  function next() {
    const found = validate(step);
    setProblem(found);
    if (found) return;
    // O órgão emissor com a UF no fim ("SSP/SP"): a UF vai para o campo dela, se vazio, e o órgão fica sem ela.
    if (step === 0) {
      const rg = rgOf(form);
      if (rg.rg_issuer !== form.rg_issuer || rg.rg_state !== form.rg_state) {
        setForm((f) => ({ ...f, rg_issuer: rg.rg_issuer, rg_state: rg.rg_state }));
      }
    }
    goTo(step + 1);
  }

  function back() {
    setProblem(null);
    goTo(step - 1);
  }

  async function submit() {
    // Confere todas as etapas (um rascunho antigo pode ter pulado alguma) e leva até a primeira com problema.
    for (let index = 0; index < STEPS.length; index++) {
      const found = validate(index);
      if (found) {
        setStep(index);
        setProblem(found);
        return;
      }
    }
    setProblem(null);
    setSubmitting(true);
    try {
      // O aceite grava a versão do aviso que o servidor tem agora: se ela passou à frente do texto desta página, a ficha
      // não sai e a página pede para recarregar. Sem resposta, segue: o próprio envio mostra o problema.
      const latest = await serverPrivacyVersion();
      if (latest !== null) setLatestPrivacy(latest);
      if (privacyOutdated(latest)) {
        window.scrollTo({ top: 0 });
        return;
      }
      const text = (value: string) => value.trim() || null;
      // Razão social e nome fantasia só aparecem com o CNPJ válido: sem ele, não vão.
      const company = isValidCnpj(form.company_document);
      const rg = rgOf(form);
      const res = await request<SubmitResult>(`/public/onboarding/${encodeURIComponent(token)}`, {
        method: "POST",
        auth: false,
        body: {
          full_name: form.full_name.trim(),
          email: form.email.trim(),
          phone: form.phone,
          phone_secondary: text(form.phone_secondary),
          document: form.document,
          birth_date: form.birth_date || null,
          rg_number: text(normalizeRg(form.rg_number)),
          rg_issuer: rg.rg_issuer || null,
          rg_state: rg.rg_state || null,
          postal_code: text(form.postal_code),
          address: text(form.address),
          address_number: normalizeAddressNumber(form.address_number) || null,
          address_complement: text(form.address_complement),
          address_district: text(form.address_district),
          city: form.city.trim(),
          state: form.state,
          photo: form.photo,
          service_areas: chosenAreas,
          years_experience: form.years_experience.trim() ? Number(form.years_experience) : null,
          // Pelo id do catálogo; na API de antes, pelo nome da sugestão.
          skills: chosenSkills.map((s) =>
            choices.skillsById ? { skill_id: s.key, level: s.level } : { name: skillLabels.get(s.key) ?? s.key, level: s.level },
          ),
          certifications: text(form.certifications),
          tools: text(form.tools),
          // Com os parágrafos (as quebras de linha ficam).
          bio: normalizeBio(form.bio) || null,
          company_document: text(form.company_document),
          company_name: company ? text(form.company_name) : null,
          company_trade_name: company ? text(form.company_trade_name) : null,
          coverage_area: form.coverage_area.trim(),
          availability: form.availability,
          has_vehicle: form.has_vehicle,
          vehicle_type: form.has_vehicle ? form.vehicle_type : null,
          vehicle_model: form.has_vehicle ? text(form.vehicle_model) : null,
          vehicle_plate: form.has_vehicle && form.vehicle_plate.trim() ? normalizePlate(form.vehicle_plate) : null,
          has_driver_license: form.has_driver_license,
          notes: text(form.notes),
          password: form.password,
          privacy_consent: form.privacy_consent,
        },
      });
      clearDraft();
      setSent({ ...res, login: form.email.trim().toLowerCase(), documents: [], drafts: [], savedAt: Date.now() });
      window.scrollTo({ top: 0 });
    } catch (error) {
      if (error instanceof ApiError && error.status === 410) {
        // O rascunho continua salvo: com um link novo, a ficha oferece continuar de onde parou.
        saveDraft(form, step, token);
        setExpiredWhileFilling(true);
        setCheck("invalid");
        return;
      }
      // A lista de áreas ou de aptidões mudou enquanto a pessoa preenchia (ou uma regra delas): volta à Atuação, com a
      // lista relida (o que saiu dela some da tela e do envio).
      const listError = CATALOG_ERRORS[apiErrorCode(error) ?? ""];
      if (listError) {
        if (listError.refetch) void catalog.refetch();
        const detail = error instanceof ApiError && typeof error.detail === "string" ? error.detail.trim() : "";
        setStep(2);
        setProblem({ field: listError.field, message: listError.message ?? (detail ? sentence(detail) : errorMessage(error)), inline: true });
        return;
      }
      const found = apiProblem(error);
      const target = found.field ? FIELDS[found.field]?.step : undefined;
      if (target !== undefined && target !== step) setStep(target);
      setProblem(found);
    } finally {
      setSubmitting(false);
    }
  }

  const restart = async () => {
    const ok = await confirm({
      tone: "danger",
      title: "Apagar o que você preencheu?",
      description: "Os dados saem deste aparelho e a ficha volta para o começo.",
      confirmLabel: "Apagar e recomeçar",
    });
    if (!ok) return;
    clearDraft();
    setForeign(null);
    setForm(EMPTY);
    setCepFilled(NO_ADDRESS);
    setProblem(null);
    goTo(0);
  };

  // A ficha volta na mesma etapa, com a foto (sem a senha e o aceite).
  const reload = () => reloadKeeping(form, step, token, !pendingForeign);

  // O texto do aviso desta página ficou para trás do servidor: só recarregando dá para ler o novo e enviar.
  const outdated = privacyOutdated(latestPrivacy ?? cat?.privacy_version);
  const login = form.email.trim().toLowerCase();

  return (
    <PublicShell wide footer="Maxx Field · seus dados são protegidos conforme a LGPD">
      {shownSent ? (
        <>
          <PublicPanel
            icon={<CheckCircle2 className="size-10 text-brand" />}
            title="Ficha enviada!"
            text={`Protocolo ${shownSent.protocol}. A equipe analisa o seu cadastro e te avisa pelo WhatsApp como instalar o app. Seu login será ${shownSent.login || login}, com a senha que você criou.`}
            note={
              shownSent.email_verification === "queued"
                ? `Enviamos um link para ${shownSent.login || login}. Abra para validar o seu e-mail.`
                : undefined
            }
          />
          {/* Sem o token (API de antes da Entrega 2), a ficha enviada não recebe arquivos. */}
          {shownSent.upload_token ? (
            <FichaDocuments
              uploadToken={shownSent.upload_token}
              expiresAt={shownSent.upload_expires_at ?? null}
              documents={shownSent.documents}
              drafts={shownSent.drafts}
              onChange={(update) => setSent((s) => (s ? { ...s, ...update(s) } : s))}
            />
          ) : null}
        </>
      ) : check === "loading" || (catalog.isLoading && check === "valid") ? (
        <LoadingBlock />
      ) : check === "invalid" ? (
        expiredWhileFilling ? (
          <PublicPanel
            icon={<XCircle className="size-10 text-red-600 dark:text-red-400" />}
            title="O link expirou enquanto você preenchia"
            text="Peça um novo link à equipe da Maxx Field. Seus dados ficam salvos neste aparelho por 24 horas: ao abrir o link novo, escolha continuar a ficha começada (só a senha e a foto você informa de novo)."
          />
        ) : (
          <PublicPanel
            icon={<XCircle className="size-10 text-red-600 dark:text-red-400" />}
            title="Link indisponível"
            text="Este link de cadastro expirou, foi cancelado ou já foi usado. Peça um novo link à equipe da Maxx Field."
          />
        )
      ) : check === "error" ? (
        <PublicPanel
          icon={<WifiOff className="size-10 text-ink-muted" />}
          title="Sem conexão"
          text="Não conseguimos abrir a ficha agora. Confira a internet do celular e tente de novo."
          action={
            <Button
              variant="primary"
              onClick={() => {
                setCheck("loading");
                setAttempt((n) => n + 1);
              }}
            >
              Tentar de novo
            </Button>
          }
        />
      ) : catalog.error && !cat ? (
        <PublicPanel
          icon={<WifiOff className="size-10 text-ink-muted" />}
          title="Não foi possível carregar a ficha"
          text="Confira a internet do celular e tente de novo."
          action={
            <Button variant="primary" loading={catalog.isFetching} onClick={() => void catalog.refetch()}>
              Tentar de novo
            </Button>
          }
        />
      ) : outdated ? (
        <OutdatedPanel form={form} step={step} token={token} saveForm={!pendingForeign} onReload={reload} />
      ) : (
        <form
          ref={formRef}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (submitting) return;
            if (last) void submit();
            else next();
          }}
        >
          {/* Sem nome, CPF nem e-mail da outra ficha: pode ser de outra pessoa no mesmo aparelho. */}
          {pendingForeign ? (
            <div
              role="status"
              className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-surface px-4 py-3 text-sm shadow-elev-1"
            >
              <History aria-hidden className="size-4 shrink-0 text-ink-subtle" />
              <p className="min-w-0 flex-1 text-ink">Há uma ficha começada neste aparelho.</p>
              <div className="flex gap-2">
                <Button size="sm" onClick={discardForeign}>
                  Descartar
                </Button>
                <Button size="sm" variant="primary" onClick={resumeForeign}>
                  Continuar com ela
                </Button>
              </div>
            </div>
          ) : null}
          <Card className="overflow-hidden">
            <div className="border-b border-line px-5 py-4">
              <h1 className="text-lg font-bold tracking-[-0.02em] text-ink">Cadastro de técnico parceiro</h1>
              <p ref={stepRef} tabIndex={-1} className="mt-0.5 text-sm text-ink-muted outline-none">
                Etapa {step + 1} de {STEPS.length}: {STEPS[step]}
              </p>
              {expiresAt ? <p className="mt-0.5 text-xs text-ink-muted">Link válido até {formatDate(expiresAt)}.</p> : null}
              <div className="mt-3 flex gap-1.5" aria-hidden>
                {STEPS.map((s, i) => (
                  <span key={s} className={clsx("h-1.5 flex-1 rounded-full", i <= step ? "brand-gradient" : "bg-surface-3")} />
                ))}
              </div>
            </div>

            {/* No celular, campos com letra de 16 px e mais altos: abaixo disso o iPhone dá zoom em cada campo. */}
            <div className="flex flex-col gap-4 px-5 py-5 [&_input:not([type=checkbox])]:h-11 [&_input]:text-base [&_select]:h-11 [&_select]:text-base [&_textarea]:text-base sm:[&_input:not([type=checkbox])]:h-9 sm:[&_input]:text-sm sm:[&_select]:h-9 sm:[&_select]:text-sm sm:[&_textarea]:text-sm">
              {step === 0 ? (
                <>
                  <div className="rounded-lg bg-surface-2 px-3 py-2.5 text-sm">
                    <p className="flex items-start gap-2 text-ink">
                      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-brand" />
                      Usamos seus dados só para avaliar o cadastro e, se você for aprovado, para os atendimentos.
                    </p>
                    <details className="mt-1.5 pl-6">
                      <summary className="cursor-pointer rounded text-xs font-semibold text-brand-ink underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none">
                        Ler o aviso de privacidade
                      </summary>
                      <PrivacyNotice className="mt-2" />
                    </details>
                  </div>
                  <div data-field="photo">
                    <PhotoPicker value={form.photo} onChange={(v) => set("photo", v)} name={form.full_name} />
                  </div>
                  <Field label="Nome completo" required error={fieldError("full_name")}>
                    <Input
                      name="full_name"
                      value={form.full_name}
                      onChange={(e) => set("full_name", e.target.value)}
                      autoComplete="name"
                      {...invalid("full_name")}
                    />
                  </Field>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="E-mail" required hint="Será o seu login no app." error={fieldError("email")}>
                      <Input
                        name="email"
                        type="email"
                        value={form.email}
                        onChange={(e) => set("email", e.target.value)}
                        autoComplete="email"
                        inputMode="email"
                        autoCapitalize="none"
                        {...invalid("email")}
                      />
                    </Field>
                    <Field label="Celular (WhatsApp)" required error={fieldError("phone")}>
                      <Input
                        name="phone"
                        value={form.phone}
                        onChange={(e) => set("phone", maskPhone(e.target.value))}
                        inputMode="tel"
                        autoComplete="tel-national"
                        placeholder="(11) 90000-0000"
                        {...invalid("phone")}
                      />
                    </Field>
                    <Field label="Telefone secundário" error={fieldError("phone_secondary")}>
                      <Input
                        name="phone_secondary"
                        value={form.phone_secondary}
                        onChange={(e) => set("phone_secondary", maskPhone(e.target.value))}
                        inputMode="tel"
                        {...invalid("phone_secondary")}
                      />
                    </Field>
                    <Field label="CPF" required error={fieldError("document")}>
                      <Input
                        name="document"
                        value={form.document}
                        onChange={(e) => set("document", maskCpf(e.target.value))}
                        inputMode="numeric"
                        placeholder="000.000.000-00"
                        {...(problem?.field === "document"
                          ? invalid("document")
                          : { "aria-invalid": form.document.length === 14 && !isValidCpf(form.document) })}
                      />
                    </Field>
                    <Field
                      label="Data de nascimento"
                      hint={`É preciso ter ${BIRTH_AGE.min} anos ou mais.`}
                      error={fieldError("birth_date")}
                    >
                      <Input
                        name="birth_date"
                        type="date"
                        value={form.birth_date}
                        onChange={(e) => set("birth_date", e.target.value)}
                        autoComplete="bday"
                        {...invalid("birth_date")}
                      />
                    </Field>
                  </div>
                  {/* Os três ou nenhum: no celular, o número numa linha e o órgão com a UF na de baixo. */}
                  <div>
                    <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-4 sm:grid-cols-[minmax(0,1fr)_7rem_6rem]">
                      <Field label="RG" className="col-span-2 sm:col-span-1">
                        <Input
                          name="rg_number"
                          value={form.rg_number}
                          onChange={(e) => set("rg_number", normalizeRg(e.target.value))}
                          autoCapitalize="characters"
                          autoCorrect="off"
                          spellCheck={false}
                          maxLength={PROFILE_LIMITS.rgNumber}
                          {...invalid("rg_number")}
                        />
                      </Field>
                      <Field label="Órgão emissor">
                        <Input
                          name="rg_issuer"
                          value={form.rg_issuer}
                          onChange={(e) => set("rg_issuer", normalizeIssuer(e.target.value))}
                          autoCapitalize="characters"
                          autoCorrect="off"
                          spellCheck={false}
                          maxLength={PROFILE_LIMITS.rgIssuer}
                          {...invalid("rg_issuer")}
                        />
                      </Field>
                      <Field label="UF do RG">
                        <Select
                          name="rg_state"
                          value={form.rg_state}
                          onChange={(e) => set("rg_state", e.target.value)}
                          {...invalid("rg_state")}
                        >
                          <option value="">—</option>
                          {UFS.map((uf) => (
                            <option key={uf} value={uf}>
                              {uf}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    </div>
                    {rgProblem ? (
                      <p id="rg-problem" role="alert" className="mt-1.5 text-xs font-medium text-red-600 dark:text-red-400">
                        {rgProblem}
                      </p>
                    ) : null}
                  </div>
                </>
              ) : null}

              {step === 1 ? (
                <>
                  <div className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
                    {/* CEP primeiro: achado, preenche logradouro, bairro, cidade e UF e leva o cursor para o Número. */}
                    <CepField
                      mode="parts"
                      name="postal_code"
                      value={form.postal_code}
                      onChange={(v) => set("postal_code", v)}
                      address={{ street: form.address, district: form.address_district, city: form.city, state: form.state }}
                      // Nada aqui foi gravado: livre é o vazio e o que a busca anterior pôs; o resto a pessoa digitou.
                      // O campo monta de novo ao voltar à etapa: é daqui que ele sabe o que ainda é da busca anterior
                      // (o CEP geral esvazia logradouro e bairro que estão com esse valor).
                      opened={cepFilled}
                      lastFill={cepFilled}
                      onApply={(found, info) => {
                        setCepFilled((before) => ({ ...before, ...Object.fromEntries(info.filled.map((key) => [key, found[key]])) }));
                        setForm((f) => ({
                          ...f,
                          address: found.street,
                          address_district: found.district,
                          city: found.city,
                          state: found.state,
                        }));
                      }}
                      auth={false}
                      focusRef={numberRef}
                      streetRef={streetRef}
                      error={fieldError("postal_code")}
                      inputProps={invalid("postal_code")}
                    />
                    <Field label="Logradouro" error={fieldError("address")}>
                      <Input
                        ref={streetRef}
                        name="address"
                        value={form.address}
                        onChange={(e) => set("address", e.target.value)}
                        autoComplete="address-line1"
                        maxLength={255}
                        {...invalid("address")}
                      />
                    </Field>
                  </div>
                  <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
                    <Field label="Número" error={fieldError("address_number")}>
                      <Input
                        ref={numberRef}
                        name="address_number"
                        value={form.address_number}
                        // Em maiúsculas, como se grava ("100A", "S/N").
                        onChange={(e) => set("address_number", e.target.value.toUpperCase())}
                        autoCapitalize="characters"
                        autoCorrect="off"
                        spellCheck={false}
                        maxLength={PROFILE_LIMITS.addressNumber}
                        {...invalid("address_number")}
                      />
                    </Field>
                    <Field label="Complemento" error={fieldError("address_complement")}>
                      <Input
                        name="address_complement"
                        value={form.address_complement}
                        onChange={(e) => set("address_complement", e.target.value)}
                        autoComplete="address-line2"
                        maxLength={PROFILE_LIMITS.addressComplement}
                        {...invalid("address_complement")}
                      />
                    </Field>
                  </div>
                  <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6rem]">
                    <Field label="Bairro" className="col-span-2 sm:col-span-1" error={fieldError("address_district")}>
                      <Input
                        name="address_district"
                        value={form.address_district}
                        onChange={(e) => set("address_district", e.target.value)}
                        maxLength={120}
                        {...invalid("address_district")}
                      />
                    </Field>
                    <Field label="Cidade" required error={fieldError("city")}>
                      <Input
                        name="city"
                        value={form.city}
                        onChange={(e) => set("city", e.target.value)}
                        autoComplete="address-level2"
                        maxLength={120}
                        {...invalid("city")}
                      />
                    </Field>
                    <Field label="UF" required error={fieldError("state")}>
                      <Select
                        name="state"
                        value={form.state}
                        onChange={(e) => set("state", e.target.value)}
                        autoComplete="address-level1"
                        {...invalid("state")}
                      >
                        <option value="">—</option>
                        {UFS.map((uf) => (
                          <option key={uf} value={uf}>
                            {uf}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <Field label="Região que você atende" required error={fieldError("coverage_area")}>
                    <Textarea
                      name="coverage_area"
                      rows={2}
                      value={form.coverage_area}
                      onChange={(e) => set("coverage_area", e.target.value)}
                      maxLength={1000}
                      {...invalid("coverage_area")}
                    />
                  </Field>
                </>
              ) : null}

              {step === 2 && cat ? (
                <>
                  {/* Sem nenhuma área no catálogo, o grupo some (e não é obrigatório). */}
                  {choices.areas.length ? (
                    <Group
                      label="Em que você atende?"
                      required
                      field="service_areas"
                      error={fieldError("service_areas")}
                      hint={areasFull ? `Limite de ${MAX_AREAS} áreas de atuação.` : undefined}
                    >
                      <div className="flex flex-wrap gap-2">
                        {choices.areas.map((a) => {
                          const active = chosenAreas.includes(a.key);
                          return (
                            <Chip
                              key={a.key}
                              active={active}
                              disabled={!active && areasFull}
                              onClick={() => toggle("service_areas", a.key)}
                            >
                              {a.label}
                            </Chip>
                          );
                        })}
                      </div>
                    </Group>
                  ) : null}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Anos de experiência" error={fieldError("years_experience")}>
                      <Input
                        name="years_experience"
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={60}
                        step={1}
                        value={form.years_experience}
                        onChange={(e) => set("years_experience", e.target.value)}
                        {...invalid("years_experience")}
                      />
                    </Field>
                  </div>
                  {/* Sem nenhuma aptidão no catálogo, o grupo some. */}
                  {choices.skills.length ? (
                    <Group label="Aptidões" field="skills" error={fieldError("skills")}>
                      <SkillCards
                        skills={chosenSkills}
                        options={choices.skills}
                        levels={cat.skill_levels}
                        onChange={(skills) => set("skills", skills)}
                        invalid={problem?.field === "skills"}
                      />
                    </Group>
                  ) : null}
                  <Field label="Certificações e cursos" error={fieldError("certifications")}>
                    <Textarea
                      name="certifications"
                      rows={2}
                      value={form.certifications}
                      onChange={(e) => set("certifications", e.target.value)}
                      {...invalid("certifications")}
                    />
                  </Field>
                  <Field label="Ferramentas próprias" error={fieldError("tools")}>
                    <Textarea
                      name="tools"
                      rows={2}
                      value={form.tools}
                      onChange={(e) => set("tools", e.target.value)}
                      {...invalid("tools")}
                    />
                  </Field>
                  <Field label="Mini biografia" error={fieldError("bio")}>
                    <Textarea
                      name="bio"
                      rows={4}
                      value={form.bio}
                      onChange={(e) => set("bio", e.target.value)}
                      maxLength={PROFILE_LIMITS.bio * 2}
                      {...invalid("bio")}
                    />
                    <span aria-hidden className="self-end text-xs text-ink-muted tabular-nums">
                      {normalizeBio(form.bio).length}/{PROFILE_LIMITS.bio}
                    </span>
                  </Field>
                  <section aria-labelledby={companyTitleId} className="flex flex-col gap-4 border-t border-line pt-4">
                    <h2 id={companyTitleId} className="text-sm font-bold text-ink">
                      Empresa
                    </h2>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="CNPJ / MEI" error={fieldError("company_document")}>
                        <Input
                          name="company_document"
                          value={form.company_document}
                          onChange={(e) => set("company_document", maskCnpj(e.target.value))}
                          placeholder="00.000.000/0000-00"
                          autoCapitalize="characters"
                          {...invalid("company_document")}
                        />
                      </Field>
                    </div>
                    {isValidCnpj(form.company_document) ? (
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Field label="Razão social" error={fieldError("company_name")}>
                          <Input
                            name="company_name"
                            value={form.company_name}
                            onChange={(e) => set("company_name", e.target.value)}
                            autoComplete="organization"
                            maxLength={PROFILE_LIMITS.companyName}
                            {...invalid("company_name")}
                          />
                        </Field>
                        <Field label="Nome fantasia" error={fieldError("company_trade_name")}>
                          <Input
                            name="company_trade_name"
                            value={form.company_trade_name}
                            onChange={(e) => set("company_trade_name", e.target.value)}
                            maxLength={PROFILE_LIMITS.companyName}
                            {...invalid("company_trade_name")}
                          />
                        </Field>
                      </div>
                    ) : null}
                  </section>
                </>
              ) : null}

              {step === 3 && cat ? (
                <>
                  <Group label="Disponibilidade" field="availability" error={fieldError("availability")}>
                    <div className="flex flex-wrap gap-2">
                      {cat.availability.map((a) => (
                        <Chip key={a.key} active={form.availability.includes(a.key)} onClick={() => toggle("availability", a.key)}>
                          {a.label}
                        </Chip>
                      ))}
                    </div>
                  </Group>
                  <div className="flex flex-col gap-3 rounded-lg border border-line p-3">
                    <Checkbox label="Tenho veículo próprio para os atendimentos" checked={form.has_vehicle} onChange={(v) => set("has_vehicle", v)} />
                    {form.has_vehicle ? (
                      <div className="grid grid-cols-2 gap-4 sm:grid-cols-[10rem_minmax(0,1fr)_9rem]">
                        <Field label="Tipo de veículo" className="col-span-2 sm:col-span-1">
                          <Select name="vehicle_type" value={form.vehicle_type} onChange={(e) => set("vehicle_type", e.target.value)}>
                            {cat.vehicle_types.map((v) => (
                              <option key={v.key} value={v.key}>
                                {v.label}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label="Modelo" error={fieldError("vehicle_model")}>
                          <Input
                            name="vehicle_model"
                            value={form.vehicle_model}
                            onChange={(e) => set("vehicle_model", e.target.value)}
                            maxLength={PROFILE_LIMITS.vehicleModel}
                            {...invalid("vehicle_model")}
                          />
                        </Field>
                        <Field label="Placa" error={fieldError("vehicle_plate")}>
                          <Input
                            name="vehicle_plate"
                            value={form.vehicle_plate}
                            onChange={(e) => set("vehicle_plate", e.target.value.toUpperCase())}
                            // Antiga com hífen (ABC-1234) ou Mercosul (ABC1D23), em maiúsculas.
                            onBlur={() => {
                              if (form.vehicle_plate.trim()) set("vehicle_plate", formatPlate(form.vehicle_plate));
                            }}
                            autoCapitalize="characters"
                            autoCorrect="off"
                            spellCheck={false}
                            maxLength={8}
                            {...invalid("vehicle_plate")}
                          />
                        </Field>
                      </div>
                    ) : null}
                    <Checkbox label="Tenho CNH válida" checked={form.has_driver_license} onChange={(v) => set("has_driver_license", v)} />
                  </div>
                  <Field label="Observações" error={fieldError("notes")}>
                    <Textarea
                      name="notes"
                      rows={3}
                      value={form.notes}
                      onChange={(e) => set("notes", e.target.value)}
                      {...invalid("notes")}
                    />
                  </Field>
                </>
              ) : null}

              {step === 4 ? (
                <>
                  <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink">
                    Seu login no app será <strong>{login || "o e-mail informado"}</strong>. Crie uma senha:
                  </p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Senha" required hint="Mínimo de 8 caracteres." error={fieldError("password")}>
                      <Input
                        name="password"
                        type="password"
                        value={form.password}
                        onChange={(e) => set("password", e.target.value)}
                        autoComplete="new-password"
                        maxLength={128}
                        {...invalid("password")}
                      />
                    </Field>
                    <Field label="Confirme a senha" required error={fieldError("password2")}>
                      <Input
                        name="password2"
                        type="password"
                        value={form.password2}
                        onChange={(e) => set("password2", e.target.value)}
                        autoComplete="new-password"
                        maxLength={128}
                        {...invalid("password2")}
                      />
                    </Field>
                  </div>
                  <section className="rounded-lg border border-line" aria-labelledby="privacy-title">
                    <h2 id="privacy-title" className="flex items-center gap-2 border-b border-line px-3 py-2 text-sm font-bold text-ink">
                      <ShieldCheck className="size-4 text-brand" />
                      Aviso de privacidade (LGPD)
                    </h2>
                    <PrivacyNotice className="max-h-64 overflow-y-auto px-3 py-2" />
                  </section>
                  <div data-field="privacy_consent">
                    <Checkbox
                      label="Li o aviso de privacidade e concordo com o tratamento dos meus dados para a homologação e o cadastro na base técnica."
                      checked={form.privacy_consent}
                      onChange={(v) => set("privacy_consent", v)}
                    />
                    {fieldError("privacy_consent") ? (
                      <p role="alert" className="mt-1.5 pl-6 text-xs font-medium text-red-600 dark:text-red-400">
                        {fieldError("privacy_consent")}
                      </p>
                    ) : null}
                  </div>
                </>
              ) : null}

              {/* Problema sem campo próprio (internet, servidor, vários campos): no fim da etapa. O ErrorBox
                  já é anunciado (role="alert"); o id liga a mensagem ao campo marcado. */}
              {problem && !inlineProblem ? (
                <div id="form-problem">
                  <ErrorBox message={problem.message} />
                </div>
              ) : null}
            </div>

            {/* Botões mais altos no celular (alvo de toque de 44 px). */}
            <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-3 [&>button]:h-11 sm:[&>button]:h-9">
              <Button onClick={back} disabled={step === 0 || submitting} className={step === 0 ? "invisible" : ""}>
                <ChevronLeft className="size-4" />
                Voltar
              </Button>
              {last ? (
                <Button variant="primary" type="submit" loading={submitting}>
                  Enviar ficha
                </Button>
              ) : (
                <Button variant="primary" type="submit">
                  Continuar
                  <ChevronRight className="size-4" />
                </Button>
              )}
            </div>
          </Card>
          {hasContent(form) ? (
            <p className="mt-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-xs text-ink-muted">
              Rascunho salvo neste aparelho por 24 horas (sem a senha e a foto).
              <button
                type="button"
                onClick={restart}
                className="rounded font-medium text-ink underline underline-offset-2 hover:text-brand focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none"
              >
                Apagar e recomeçar
              </button>
            </p>
          ) : null}
        </form>
      )}
    </PublicShell>
  );
}

/**
 * O aviso desta página ficou para trás do servidor: só recarregando dá para ler o texto novo e enviar. A linha de baixo
 * é decidida quando o painel aparece (a ficha some e não muda mais).
 */
function OutdatedPanel({
  form,
  step,
  token,
  saveForm,
  onReload,
}: {
  form: FormState;
  step: number;
  token: string;
  saveForm: boolean;
  onReload: () => void;
}) {
  const [note] = useState(() => reloadNote(form, step, token, saveForm));
  const textId = useId();
  return (
    <PublicPanel
      icon={<RefreshCw className="size-10 text-ink-muted" />}
      title="O aviso de privacidade mudou"
      text="Recarregue a página para ler o texto novo."
      note={note}
      textId={textId}
      action={
        // No envio, o painel toma o lugar da ficha: o foco vai para a única ação, que lê o texto junto, e não se perde.
        <Button variant="primary" onClick={onReload} autoFocus aria-describedby={`${textId}-titulo ${textId}`}>
          Recarregar
        </Button>
      }
    />
  );
}

/** O aviso de privacidade (LGPD), na primeira etapa (para ler antes de preencher) e junto do aceite. */
function PrivacyNotice({ className }: { className?: string }) {
  return (
    <dl className={clsx("space-y-2 text-sm", className)}>
      {PRIVACY_NOTICE.map((item) => (
        <div key={item.title}>
          <dt className="font-semibold text-ink">{item.title}</dt>
          <dd className="text-ink-muted">{item.body}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Foto do rosto: a câmera (a da frente, no celular) ou a galeria. Reduzida no próprio aparelho antes de ir. */
function PhotoPicker({ value, onChange, name }: { value: string | null; onChange: (v: string | null) => void; name: string }) {
  const [error, setError] = useState<string | null>(null);
  // Reduzir uma foto de 12 MP leva um instante: o botão avisa e nenhum dos dois aceita outro toque.
  const [preparing, setPreparing] = useState<"camera" | "gallery" | null>(null);
  const initialsText = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");

  async function use(file: File | undefined, source: "camera" | "gallery") {
    if (!file) return;
    setError(null);
    setPreparing(source);
    try {
      onChange(await resizePhoto(file));
    } catch {
      setError("Não foi possível usar esta imagem. Tente outra foto.");
    } finally {
      setPreparing(null);
    }
  }

  const picker = (source: "camera" | "gallery", icon: React.ReactNode, text: string) => (
    <label
      className={clsx(
        // 44 px de altura no celular.
        buttonClassName("secondary", "lg"),
        "cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/45 sm:h-9 sm:px-3.5",
        preparing && "pointer-events-none opacity-60",
      )}
    >
      {preparing === source ? <Loader2 className="size-4 animate-spin" /> : icon}
      {preparing === source ? "Preparando foto…" : text}
      <input
        type="file"
        accept="image/*"
        // "user": a câmera da frente no celular; sem `capture`, o celular abre a galeria (no computador, os dois abrem os
        // arquivos).
        capture={source === "camera" ? "user" : undefined}
        className="sr-only"
        disabled={preparing !== null}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          void use(file, source);
        }}
      />
    </label>
  );

  return (
    <div className="flex items-center gap-4">
      <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-full border border-line bg-surface-2 text-xl font-semibold text-ink-muted">
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element -- prévia local (data URL)
          <img src={value} alt="Sua foto" className="size-full object-cover" />
        ) : (
          initialsText || <Camera className="size-6" />
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap gap-2">
          {picker("camera", <Camera className="size-4" />, "Tirar foto")}
          {picker("gallery", <ImageIcon className="size-4" />, "Escolher da galeria")}
        </div>
        <span className="text-xs text-ink-muted">Foto do rosto, de frente.</span>
        {value ? (
          <button
            type="button"
            className="self-start rounded text-xs text-red-700 hover:underline focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none pointer-coarse:min-h-11 dark:text-red-400"
            onClick={() => onChange(null)}
          >
            Remover foto
          </button>
        ) : null}
        {error ? (
          <span role="alert" className="text-xs text-red-700 dark:text-red-400">
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Aptidões do catálogo, legíveis no celular: um cartão por aptidão escolhida (o nome, o nível em botões de 44 px e
 * Remover) e, abaixo, a busca com as aptidões que casam (sem as escolhidas), em ordem alfabética, até 20 de cada vez.
 * Tocar numa soma o cartão (Intermediário) e leva o foco ao nível. Com 30, a busca dá lugar ao aviso do limite.
 */
function SkillCards({
  skills,
  options,
  levels,
  onChange,
  invalid,
}: {
  /** As escolhidas que estão no catálogo de agora, na ordem em que foram escolhidas. */
  skills: Skill[];
  /** O catálogo da ficha (as ativas), em ordem alfabética. */
  options: CatalogItem[];
  levels: CatalogItem[];
  onChange: (skills: Skill[]) => void;
  /** O grupo tem um problema (a busca é marcada e recebe o foco). */
  invalid: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsId = useId();
  const [query, setQuery] = useState("");
  // Depois de somar ou tirar um cartão, para onde vai o foco: o nível do cartão (o novo ou o que ficou no lugar) ou a
  // busca (sem cartão).
  const [focusRequest, setFocusRequest] = useState<{ key: string } | "search" | null>(null);
  useEffect(() => {
    if (!focusRequest) return;
    if (focusRequest === "search") {
      searchRef.current?.focus();
      return;
    }
    const card = listRef.current?.querySelector<HTMLElement>(`[data-skill="${CSS.escape(focusRequest.key)}"]`);
    (card?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ?? card?.querySelector<HTMLElement>('[role="radio"]'))?.focus();
  }, [focusRequest]);

  const labels = new Map(options.map((o) => [o.key, o.label]));
  const chosen = new Set(skills.map((s) => s.key));
  const term = foldName(query);
  const matches = options.filter((o) => !chosen.has(o.key) && (!term || foldName(o.label).includes(term)));
  const shown = matches.slice(0, SKILL_MATCHES);
  const full = skills.length >= MAX_SKILLS;

  const update = (key: string, level: string) => onChange(skills.map((s) => (s.key === key ? { ...s, level } : s)));
  const add = (key: string) => {
    if (full || chosen.has(key)) return;
    onChange([...skills, { key, level: DEFAULT_SKILL_LEVEL }]);
    setFocusRequest({ key });
  };
  const remove = (index: number) => {
    const left = skills.filter((_, i) => i !== index);
    onChange(left);
    // O botão sumiu com o cartão: o foco vai para o nível do cartão que ficou no lugar (ou o de cima), ou para a busca.
    const neighbor = left[Math.min(index, left.length - 1)];
    setFocusRequest(neighbor ? { key: neighbor.key } : "search");
  };

  return (
    <div className="flex flex-col gap-3">
      {skills.length ? (
        <div ref={listRef} className="flex flex-col gap-2">
          {skills.map((skill, i) => {
            const name = labels.get(skill.key) ?? skill.key;
            return (
              <div key={skill.key} data-skill={skill.key} className="rounded-lg border border-line p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 text-sm font-semibold break-words text-ink">{name}</span>
                  <button
                    type="button"
                    onClick={() => remove(i)}
                    className="-my-2.5 -mr-2.5 inline-flex size-11 shrink-0 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-red-700 focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none dark:hover:text-red-400"
                    aria-label={`Remover ${name}`}
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
                <div className="mt-1.5">
                  <LevelPicker label={`Nível de ${name}`} levels={levels} value={skill.level} onChange={(level) => update(skill.key, level)} />
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      {full ? (
        <p className="text-xs text-ink-muted">Limite de {MAX_SKILLS} aptidões.</p>
      ) : (
        <>
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-subtle" />
            <Input
              ref={searchRef}
              // O problema do grupo (do servidor) leva o foco para cá.
              name="skills"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Enter não envia a etapa: com uma aptidão só na busca, ela entra.
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (term && matches.length === 1) add(matches[0].key);
              }}
              placeholder="Buscar aptidão"
              aria-label="Buscar aptidão"
              aria-controls={resultsId}
              aria-invalid={invalid || undefined}
              autoComplete="off"
              enterKeyHint="search"
              className="pl-9"
            />
          </div>
          <div id={resultsId} className="flex flex-col gap-1.5">
            {shown.length ? (
              <div role="group" aria-label="Aptidões para escolher" className="flex flex-wrap gap-2">
                {shown.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => add(option.key)}
                    className={clsx(
                      "inline-flex min-h-11 items-center gap-1 rounded-full border px-3 py-1.5 text-left text-sm transition-colors",
                      FOCUS_RING,
                      UNCHOSEN,
                    )}
                  >
                    <Plus aria-hidden className="size-3.5 shrink-0" />
                    <span className="sr-only">Adicionar </span>
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}
            <p role="status" className="text-xs text-ink-muted">
              {term && !matches.length
                ? `Nenhuma aptidão com “${query.trim()}”.`
                : matches.length > SKILL_MATCHES
                  ? `Mais ${matches.length - SKILL_MATCHES}: refine a busca.`
                  : ""}
            </p>
          </div>
        </>
      )}
    </div>
  );
}

/** Nível da aptidão em 3 botões (um grupo de opções: setas trocam, Tab entra só no marcado). */
function LevelPicker({
  label,
  levels,
  value,
  onChange,
}: {
  label: string;
  levels: CatalogItem[];
  value: string;
  onChange: (level: string) => void;
}) {
  // Sem nível marcado (não acontece pela ficha), o primeiro recebe o Tab.
  const focusable = levels.some((l) => l.key === value) ? value : levels[0]?.key;
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-1.5">
      {levels.map((level, i) => {
        const checked = level.key === value;
        return (
          <button
            key={level.key}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={level.key === focusable ? 0 : -1}
            onClick={() => onChange(level.key)}
            onKeyDown={(e) => {
              const move = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
              if (!move) return;
              e.preventDefault();
              const next = (i + move + levels.length) % levels.length;
              onChange(levels[next].key);
              e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
            }}
            className={clsx(
              "min-h-11 flex-1 rounded-lg border px-2 text-sm transition-colors sm:min-h-9 sm:flex-none sm:px-3",
              FOCUS_RING,
              checked ? CHOSEN : UNCHOSEN,
            )}
          >
            {level.label}
          </button>
        );
      })}
    </div>
  );
}

/** Como o Field, mas para grupos de controles (chips, listas): um <label> ativaria o primeiro. */
function Group({
  label,
  hint,
  required,
  field,
  error,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  /** Campo da ficha (para levar a pessoa até o grupo quando há um problema nele). */
  field?: string;
  /** Problema no grupo: aparece no lugar da dica, em vermelho, e é anunciado. */
  error?: string | null;
  children: React.ReactNode;
}) {
  const errorId = useId();
  return (
    <fieldset className="flex flex-col gap-1.5" data-field={field} aria-describedby={error ? errorId : undefined}>
      <legend className="mb-1.5 text-xs font-semibold text-ink/80">
        {label}
        {required ? <span className="text-red-600 dark:text-red-400"> *</span> : null}
      </legend>
      {children}
      {error ? (
        <span id={errorId} role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
          {error}
        </span>
      ) : hint ? (
        <span className="text-xs text-ink-muted">{hint}</span>
      ) : null}
    </fieldset>
  );
}
