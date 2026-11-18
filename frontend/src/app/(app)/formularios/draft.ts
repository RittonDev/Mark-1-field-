// Rascunho do construtor de formulários: tipos de pergunta, perguntas novas, validação (os mesmos
// limites da API, com mensagens em português e o número da pergunta da tela) e o rascunho guardado
// na aba, que sobrevive a recarregar, ao Voltar do navegador e a um clique no menu.

import type { QueryClient } from "@tanstack/react-query";
import { fold } from "@/components/settings/shared";
import type { FormField, FormFieldType, FormPrefill, FormTemplate } from "@/lib/types";

export const TYPE_LABEL: Record<FormFieldType, string> = {
  section: "Seção",
  text: "Texto curto",
  textarea: "Texto longo",
  number: "Número",
  yes_no: "Sim / Não",
  choice: "Escolha única",
  multi_choice: "Múltipla escolha",
  date: "Data",
  confirm: "Confirmação",
  photo: "Fotos",
};
export const ADD_ORDER: FormFieldType[] = ["photo", "yes_no", "text", "textarea", "choice", "multi_choice", "number", "date", "confirm", "section"];

/** Resposta automática: o dado da OS que já vem na pergunta (o técnico corrige). Os mesmos nomes da API. */
export const PREFILL_LABEL: Record<FormPrefill, string> = {
  location_name: "Nome da loja",
  location_code: "Código da loja",
  customer: "Cliente",
  address: "Endereço do atendimento",
  city: "Cidade e UF",
  ticket_code: "Nº da OS",
  technician: "Técnico responsável",
  service_type: "Tipo de OS",
  visit_date: "Data da visita",
};
const PREFILL_ORDER = Object.keys(PREFILL_LABEL) as FormPrefill[];

/** Fontes que a pergunta aceita (a regra da API): texto e texto longo, todas; data, só a data da visita. */
export function prefillSources(type: FormFieldType): FormPrefill[] {
  if (type === "text" || type === "textarea") return PREFILL_ORDER;
  return type === "date" ? ["visit_date"] : [];
}

/** A fonte da pergunta, se o tipo dela aceita (combinação inválida vale como sem fonte). */
export function prefillOf(f: Pick<FormField, "type" | "prefill">): FormPrefill | null {
  return f.prefill && prefillSources(f.type).includes(f.prefill) ? f.prefill : null;
}

// Limites de backend/app/schemas/forms.py.
export const LIMITS = {
  name: 160,
  description: 2000,
  label: 200,
  help: 500,
  fields: 100,
  options: 30,
  minPhotos: 20,
  maxPhotos: 30,
};

export interface Draft {
  id?: string;
  /** Versão salva de onde o rascunho saiu: ao salvar, a API recusa (409) se outra pessoa salvou depois. */
  updated_at?: string;
  name: string;
  description: string;
  fields: FormField[];
  /** Tipos de OS em que o formulário entra sozinho. */
  service_type_ids: string[];
  /** Categorias em que o formulário entra sozinho (valem as subcategorias). */
  category_ids: string[];
  /** Entra na OS como obrigatório (padrão) ou opcional. */
  default_required: boolean;
  requires_signature: boolean;
  is_active: boolean;
}

export const isChoice = (type: FormFieldType) => type === "choice" || type === "multi_choice";
/** Fotos que o técnico precisa enviar (a mesma conta do fechamento e do app). */
export const photoNeed = (f: FormField) => Math.max(f.min_photos, f.required ? 1 : 0);

let seq = 0;
/** Identificador da pergunta: letras, números e "_", único no formulário (as respostas usam ele). */
export function newId(): string {
  seq += 1;
  return `f_${Date.now().toString(36).slice(-5)}${seq.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/** Pergunta nova. Foto: obrigatória quando pede ao menos uma (mínimo 0 = opcional). */
export function newField(type: FormFieldType, label = "", extra: Partial<FormField> = {}): FormField {
  const min_photos = type === "photo" ? (extra.min_photos ?? 1) : 0;
  return {
    id: newId(),
    type,
    label,
    help: null,
    required: type === "photo" ? min_photos > 0 : type !== "section",
    options: isChoice(type) ? ["Opção 1", "Opção 2"] : [],
    min_photos,
    max_photos: 10,
    ...extra,
  };
}

/**
 * Troca o tipo mantendo o texto, a orientação e o "obrigatória" (seção nunca é obrigatória). A resposta
 * automática que o tipo novo não aceita sai.
 */
export function retype(f: FormField, type: FormFieldType): FormField {
  if (type === f.type) return f;
  const required = type === "section" ? false : f.type === "section" ? true : f.type === "photo" ? photoNeed(f) > 0 : f.required;
  return {
    ...f,
    type,
    required,
    options: isChoice(type) && f.options.filter((o) => o.trim()).length < 2 ? ["Opção 1", "Opção 2"] : f.options,
    min_photos: type === "photo" ? (required ? 1 : 0) : 0,
    max_photos: Math.max(1, f.max_photos || 10),
    prefill: prefillOf({ type, prefill: f.prefill }),
  };
}

export function emptyDraft(): Draft {
  return {
    name: "",
    description: "",
    fields: [newField("text")],
    service_type_ids: [],
    category_ids: [],
    default_required: true,
    requires_signature: true,
    is_active: true,
  };
}

export function fromTemplate(t: FormTemplate): Draft {
  return {
    id: t.id,
    updated_at: t.updated_at,
    name: t.name,
    description: t.description ?? "",
    fields: t.fields,
    service_type_ids: t.service_type_ids,
    // Servidor anterior aos vínculos por categoria não manda os dois campos.
    category_ids: t.category_ids ?? [],
    default_required: t.default_required ?? true,
    requires_signature: t.requires_signature,
    is_active: t.is_active,
  };
}

/**
 * Cópia ativa (a cópia de um inativo ficava escondida na lista), com perguntas de identificador novo. Sai sem
 * os tipos de OS e as categorias: ligada aos mesmos, a cópia entraria nas mesmas OS que o original.
 */
export function duplicateOf(t: FormTemplate): Draft {
  const suffix = " (cópia)";
  return {
    ...fromTemplate(t),
    id: undefined,
    updated_at: undefined,
    name: `${t.name.slice(0, LIMITS.name - suffix.length)}${suffix}`,
    is_active: true,
    service_type_ids: [],
    category_ids: [],
    fields: t.fields.map((f) => ({ ...f, id: newId() })),
  };
}

// Pontos de partida para não começar do zero (o analista ajusta à vontade).
export const EXAMPLES: { name: string; build: () => Draft }[] = [
  {
    name: "Preventiva de rack",
    build: () => ({
      name: "Preventiva de rack",
      description: "Fotos antes e depois e a checagem da organização do rack.",
      requires_signature: true,
      is_active: true,
      service_type_ids: [],
      category_ids: [],
      default_required: true,
      fields: [
        newField("section", "Antes do serviço"),
        newField("photo", "Foto do rack antes", { min_photos: 2, max_photos: 6, help: "Frente e lateral, com a porta aberta" }),
        newField("textarea", "Problemas encontrados", { required: false }),
        newField("section", "Depois do serviço"),
        newField("photo", "Foto do rack depois", { min_photos: 2, max_photos: 6 }),
        newField("yes_no", "Cabos organizados e identificados?"),
        newField("yes_no", "Patch cords com velcro?"),
        newField("number", "Quantidade de velcro usada (unidades)", { required: false }),
        newField("confirm", "Ambiente limpo e equipamentos ligados"),
      ],
    }),
  },
  {
    name: "Organização de PDV",
    build: () => ({
      name: "Organização de PDV",
      description: "Antes e depois de cada caixa.",
      requires_signature: true,
      is_active: true,
      service_type_ids: [],
      category_ids: [],
      default_required: true,
      fields: [
        newField("number", "Quantidade de PDVs atendidos"),
        newField("photo", "Fotos dos PDVs antes", { min_photos: 1, max_photos: 20 }),
        newField("photo", "Fotos dos PDVs depois", { min_photos: 1, max_photos: 20 }),
        newField("multi_choice", "Itens verificados", { options: ["Impressora fiscal", "Leitor de código", "Gaveta", "Cabos", "Nobreak"] }),
        newField("textarea", "Observações", { required: false }),
      ],
    }),
  },
  {
    name: "Instalação de câmera (CFTV)",
    build: () => ({
      name: "Instalação de câmera (CFTV)",
      description: "",
      requires_signature: true,
      is_active: true,
      service_type_ids: [],
      category_ids: [],
      default_required: true,
      fields: [
        newField("text", "Local da câmera"),
        newField("choice", "Tipo de câmera", { options: ["Bullet", "Dome", "PTZ", "Fisheye"] }),
        newField("photo", "Foto da câmera instalada", { min_photos: 1, max_photos: 4 }),
        newField("photo", "Print da imagem no DVR/NVR", { min_photos: 1, max_photos: 4 }),
        newField("yes_no", "Gravação testada?"),
      ],
    }),
  },
];

function cleanField(f: FormField): FormField {
  const photo = f.type === "photo";
  const prefill = prefillOf(f);
  return {
    id: f.id,
    type: f.type,
    label: f.label.trim(),
    help: f.help?.trim() || null,
    // Foto: obrigatória = pede ao menos uma (o "mínimo" manda; 0 = opcional).
    required: f.type === "section" ? false : photo ? photoNeed(f) > 0 : f.required,
    options: isChoice(f.type) ? f.options.map((o) => o.trim()).filter(Boolean) : [],
    min_photos: photo ? photoNeed(f) : 0,
    max_photos: f.max_photos,
    // Só quando há resposta automática (como a API grava): a pergunta sem fonte não muda de forma.
    ...(prefill ? { prefill } : {}),
  };
}

/** Corpo do PUT/POST /form-templates (textos aparados, opções limpas). */
export function payload(d: Draft) {
  return {
    name: d.name.trim(),
    description: d.description.trim() || null,
    fields: d.fields.map(cleanField),
    service_type_ids: d.service_type_ids,
    category_ids: d.category_ids,
    default_required: d.default_required,
    requires_signature: d.requires_signature,
    is_active: d.is_active,
  };
}

/** Mesmo conteúdo salvo? (a ordem dos tipos de OS e das categorias escolhidos não conta) */
export function sameDraft(a: Draft, b: Draft): boolean {
  const canon = (d: Draft) =>
    JSON.stringify({ ...payload(d), service_type_ids: [...d.service_type_ids].sort(), category_ids: [...d.category_ids].sort() });
  return canon(a) === canon(b);
}

/** Mudou o que a OS recebe do modelo (as perguntas ou o nome), e não só a descrição ou os vínculos. */
export function changesTickets(draft: Draft, saved: Draft): boolean {
  const a = payload(draft);
  const b = payload(saved);
  return a.name !== b.name || JSON.stringify(a.fields) !== JSON.stringify(b.fields);
}

/** Os tipos de OS e as categorias que valem (só modelo ativo entra sozinho), sem ordem. */
const linksKey = (d: Draft) =>
  d.is_active ? JSON.stringify([[...d.service_type_ids].sort(), [...d.category_ids].sort()]) : "";

/**
 * Os vínculos que valem mudaram (outros tipos ou categorias, ou o modelo voltou a ficar ativo com vínculo; num
 * formulário novo, ter vínculo): dá para levar às OS que ainda não começaram, onde ele entra e de onde sai.
 * Desativar não conta: as OS que já têm o formulário continuam com ele.
 */
export function changesLinks(draft: Draft, saved: Draft | null): boolean {
  if (!draft.is_active) return false;
  if (!saved || !saved.is_active) return draft.service_type_ids.length + draft.category_ids.length > 0;
  return linksKey(draft) !== linksKey(saved);
}

/** O que falta corrigir numa pergunta, por campo (cada mensagem aparece embaixo do seu campo). */
export interface FieldProblems {
  label?: string;
  options?: string;
  photos?: string;
}

export interface Problems {
  name?: string;
  general: string[];
  /** Por identificador da pergunta. */
  fields: Record<string, FieldProblems>;
}

export function hasProblems(p: Problems): boolean {
  return Boolean(p.name) || p.general.length > 0 || Object.keys(p.fields).length > 0;
}

function optionProblem(f: FormField): string | undefined {
  const options = f.options.map((o) => o.trim()).filter(Boolean);
  const list: string[] = [];
  if (options.length < 2) list.push("Informe pelo menos duas opções, uma por linha.");
  if (options.length > LIMITS.options) list.push(`No máximo ${LIMITS.options} opções (hoje são ${options.length}).`);
  // Opção repetida confunde o técnico e o relatório ("Sim" e "sim" contam como a mesma).
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const option of options) {
    const key = fold(option);
    if (seen.has(key)) repeated.add(option);
    seen.add(key);
  }
  if (repeated.size) list.push(`Opção repetida: ${[...repeated].map((o) => `“${o}”`).join(", ")}.`);
  return list.length ? list.join(" ") : undefined;
}

export function validate(d: Draft): Problems {
  const fields: Record<string, FieldProblems> = {};
  const general: string[] = [];
  const nameLength = d.name.trim().length;
  const name =
    nameLength === 0 ? "Dê um nome ao formulário." : nameLength < 3 ? "O nome precisa de pelo menos 3 letras." : undefined;
  if (d.fields.length > LIMITS.fields) {
    general.push(`Use no máximo ${LIMITS.fields} perguntas e seções (hoje são ${d.fields.length}).`);
  }
  if (!d.fields.some((f) => f.type !== "section")) {
    general.push("Inclua pelo menos uma pergunta: só seções não formam um formulário.");
  }
  for (const f of d.fields) {
    const problem: FieldProblems = {};
    if (!f.label.trim()) problem.label = f.type === "section" ? "Escreva o título da seção." : "Escreva a pergunta.";
    if (isChoice(f.type)) problem.options = optionProblem(f);
    if (f.type === "photo" && f.min_photos > f.max_photos) {
      problem.photos = `O mínimo (${f.min_photos}) passa do máximo de fotos (${f.max_photos}).`;
    }
    if (problem.label || problem.options || problem.photos) fields[f.id] = problem;
  }
  return { name, general, fields };
}

/** Depois de salvar: a lista e as sugestões de formulário das OS abertas no painel. */
export function invalidateForms(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: ["form-templates"] });
  // Modelo desativado ou desligado do tipo ou da categoria não pode continuar sugerido numa OS aberta.
  queryClient.invalidateQueries({
    predicate: (q) => q.queryKey[0] === "ticket" && q.queryKey[2] === "form-suggestions",
  });
}

// ------------------------------------------------------------ rascunho guardado na aba

const STORAGE_KEY = "mf.formularios.rascunho";
/** Chave do editor na URL (?editar=...) para um formulário ainda não salvo. */
export const NEW_KEY = "novo";

export interface StoredDraft {
  /** Id do modelo ou NEW_KEY. */
  key: string;
  initial: Draft;
  draft: Draft;
}

const isDraft = (value: unknown): value is Draft =>
  !!value && typeof value === "object" && Array.isArray((value as Draft).fields) && typeof (value as Draft).name === "string";

/** Rascunho guardado antes dos vínculos por categoria: sem categorias e obrigatório (os padrões da API). */
function withDefaults(d: Draft): Draft {
  return {
    ...d,
    service_type_ids: Array.isArray(d.service_type_ids) ? d.service_type_ids : [],
    category_ids: Array.isArray(d.category_ids) ? d.category_ids : [],
    default_required: typeof d.default_required === "boolean" ? d.default_required : true,
  };
}

export function readStored(): StoredDraft | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDraft>;
    return typeof parsed.key === "string" && isDraft(parsed.initial) && isDraft(parsed.draft)
      ? { key: parsed.key, initial: withDefaults(parsed.initial), draft: withDefaults(parsed.draft) }
      : null;
  } catch {
    return null;
  }
}

export function writeStored(value: StoredDraft | null) {
  try {
    if (value) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Sem armazenamento (aba privada ou bloqueado): o rascunho vive só na tela.
  }
}

/** Rascunho guardado com alterações de verdade (não só aberto e deixado como estava). */
export function storedChanges(): StoredDraft | null {
  const stored = readStored();
  return stored && !sameDraft(stored.draft, stored.initial) ? stored : null;
}

/**
 * Ponto de partida do editor: o rascunho guardado desta mesma chave (recarregou a página, usou o
 * Voltar ou o menu no meio da edição) ou, sem ele, o modelo salvo / um formulário em branco.
 */
export function resumeDraft(key: string, template: FormTemplate | null): { initial: Draft; draft: Draft; restored: boolean } {
  const saved = template ? fromTemplate(template) : null;
  const stored = readStored();
  if (stored && stored.key === key) {
    const initial = saved ?? stored.initial;
    return { initial, draft: stored.draft, restored: !sameDraft(stored.draft, initial) };
  }
  const initial = saved ?? emptyDraft();
  return { initial, draft: initial, restored: false };
}
