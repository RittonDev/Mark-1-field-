// Documentos e currículo do técnico (Configurações › Documentos e Configurações › Currículo; contrato da Entrega 2, §6.3
// e §9): as regras das telas sem React nem React Native, para a sonda (tests/documents.test.mjs). Só importa
// ./constants, ./techProfileForm e tipos.
//
// - Arquivo: o tipo pela extensão do nome ou, sem ela, pelo tipo que o sistema informa (`documentFileType`; o servidor
//   confere de novo pelo conteúdo), o nome com que sobe (`documentUploadName`) e o tamanho (`fileSizeProblem`, até
//   10 MB). Os textos de arquivo que não serve: FILE_PROBLEM_TEXT.
// - Formulário (configuracoes/documento): título (2 a 80, com as sugestões de DOCUMENT_TITLE_SUGGESTIONS), validade só
//   na certificação (de 2000-01-01 a hoje + 20 anos) e o arquivo. Os campos do envio (`documentFields`; o currículo,
//   `resumeFields`), os da troca do arquivo (`replaceFields`) e o PATCH só com o que mudou (`documentPatch`).
// - Listas e resumos: `splitDocuments` (a ordem do servidor: a certificação pela validade mais próxima, sem validade por
//   último; o documento pessoal pelo título), `documentFileLine`, `documentSpoken` e os resumos das linhas Documentos e
//   Currículo do menu (`documentsRowSummary`, `resumeRowSummary`).

import { DOCUMENT_ACCEPT, DOCUMENT_KIND, DOCUMENT_LIMITS, documentDue, documentDueText, documentFileKind } from "./constants";
import { cleanText, foldName } from "./techProfileForm";
import type { MyDocument, TechDocumentKind, TechDocumentUpdate } from "./types";

/** Os tipos que o técnico vê e envia (o anexo interno é só da central). */
export type MyDocumentKind = Exclude<TechDocumentKind, "internal">;

/** Os dois blocos da tela Documentos (o currículo tem tela própria). */
export type DocumentGroup = "certification" | "personal";

/** O que o currículo está fazendo agora (lib/resumeFlow.ts): enviando, excluindo ou nada. */
export type ResumeTask = "upload" | "remove" | null;

const pad = (n: number) => String(n).padStart(2, "0");

/** Tamanho em caracteres, como o servidor conta (um emoji ocupa duas posições no texto do JavaScript). */
const chars = (text: string) => Array.from(text).length;

// --------------------------------------------------------------------------- textos de cada bloco

export interface DocumentGroupText {
  /** Título do bloco na tela Documentos. */
  block: string;
  empty: string;
  add: string;
  /** Títulos da tela do formulário. */
  create: string;
  edit: string;
  sent: string;
  updated: string;
  removed: string;
  confirmDelete: string;
  discard: string;
}

export const DOCUMENT_GROUP_TEXT: Record<DocumentGroup, DocumentGroupText> = {
  certification: {
    block: "Certificações",
    empty: "Nenhuma certificação.",
    add: "Adicionar certificação",
    create: "Nova certificação",
    edit: "Editar certificação",
    sent: "Certificação enviada",
    updated: "Certificação atualizada",
    removed: "Certificação excluída",
    confirmDelete: "Excluir a certificação?",
    discard: "Descartar a certificação?",
  },
  personal: {
    block: "Documentos pessoais",
    empty: "Nenhum documento.",
    add: "Adicionar documento",
    create: "Novo documento",
    edit: "Editar documento",
    sent: "Documento enviado",
    updated: "Documento atualizado",
    removed: "Documento excluído",
    confirmDelete: "Excluir o documento?",
    discard: "Descartar o documento?",
  },
};

/** Os blocos, nesta ordem (a mesma da central). */
export const DOCUMENT_GROUPS: readonly DocumentGroup[] = ["certification", "personal"];

const GROUP_PARAM: Record<DocumentGroup, string> = { certification: "certificacao", personal: "pessoal" };

/** `?grupo=` do formulário de incluir: "certificacao" | "pessoal". */
export const documentGroupParam = (group: DocumentGroup) => GROUP_PARAM[group];

/** O grupo do `?grupo=`; null quando não é um dos dois. */
export function groupOfParam(value: unknown): DocumentGroup | null {
  if (value === GROUP_PARAM.certification) return "certification";
  if (value === GROUP_PARAM.personal) return "personal";
  return null;
}

/** O limite do servidor (certificações e documentos pessoais juntos; o currículo não conta). */
export const DOCUMENTS_LIMIT_TEXT = `Limite de ${DOCUMENT_LIMITS.perTechnician} documentos e certificações. Exclua um para incluir outro.`;

/** Sem rede e demora no envio (os do servidor vêm como chegam). */
export const DOCUMENT_SEND_TEXT = {
  /** Incluir ou trocar o arquivo: nada fica na fila. */
  offlineFile: "Sem internet. O arquivo só é enviado com conexão: tente de novo quando tiver sinal.",
  /** Só o título ou a validade. */
  offlineData: "Sem internet. Conecte o aparelho para salvar.",
  timeout: "O envio demorou demais e foi interrompido. Tente de novo.",
} as const;

// --------------------------------------------------------------------------- arquivo

export type DocumentFileKind = "pdf" | "image";

export interface DocumentFileType {
  kind: DocumentFileKind;
  mime: string;
  /** Extensão do arquivo que sobe. */
  ext: string;
}

/** Os tipos que o seletor do sistema mostra (o servidor confere de novo pelo conteúdo). */
export const DOCUMENT_PICKER_TYPES: readonly string[] = DOCUMENT_ACCEPT.split(",");

/** O seletor da pré-visualização web: as extensões e os tipos. */
export const DOCUMENT_WEB_ACCEPT = [".pdf", ".jpg", ".jpeg", ".png", ".webp", ...DOCUMENT_PICKER_TYPES].join(",");

export const DOCUMENT_MAX_BYTES = DOCUMENT_LIMITS.maxMb * 1024 * 1024;

const PDF: DocumentFileType = { kind: "pdf", mime: "application/pdf", ext: "pdf" };
const JPEG: DocumentFileType = { kind: "image", mime: "image/jpeg", ext: "jpg" };
const PNG: DocumentFileType = { kind: "image", mime: "image/png", ext: "png" };
const WEBP: DocumentFileType = { kind: "image", mime: "image/webp", ext: "webp" };

// Map, e não objeto: um nome como "x.constructor" não acha nada herdado.
const BY_EXTENSION = new Map<string, DocumentFileType>([
  ["pdf", PDF],
  ["jpg", JPEG],
  ["jpeg", JPEG],
  ["png", PNG],
  ["webp", WEBP],
]);
const BY_MIME = new Map<string, DocumentFileType>([
  ["application/pdf", PDF],
  ["image/jpeg", JPEG],
  ["image/jpg", JPEG],
  ["image/pjpeg", JPEG],
  ["image/png", PNG],
  ["image/webp", WEBP],
]);

const extensionOf = (name: string) => /\.([a-z0-9]+)$/i.exec(name.trim())?.[1]?.toLowerCase() ?? "";

/**
 * Tipo do arquivo pela extensão do nome (pdf, jpg, jpeg, png, webp) ou, sem ela (no Android o content:// às vezes só
 * tem um código), pelo tipo que o sistema informa. null: não é PDF nem foto que a central recebe (XML, HEIC, GIF,
 * application/octet-stream…).
 */
export function documentFileType(name: string, mime: string | null | undefined): DocumentFileType | null {
  const byName = BY_EXTENSION.get(extensionOf(name ?? ""));
  if (byName) return byName;
  const type = (mime ?? "").split(";")[0].trim().toLowerCase();
  return BY_MIME.get(type) ?? null;
}

/** "AAAA-MM-DD" no fuso do aparelho. */
const isoDayOf = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/**
 * Nome com que o arquivo sobe (o envio nativo usa o nome do arquivo): o do aparelho sem acentos nem símbolos, até 80
 * caracteres, ou, sem um nome de verdade, "{base}-AAAA-MM-DD" ("documento", "curriculo"); sempre com a extensão do tipo.
 */
export function documentUploadName(original: string | null, ext: string, base: string, today: Date): string {
  const name = (original ?? "")
    .replace(/\.[^.]*$/, "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 80)
    .replace(/[._-]+$/, "");
  return `${name || `${base}-${isoDayOf(today)}`}.${ext}`;
}

/** Arquivo que não serve: o tipo, o tamanho ou a leitura. */
export type FileProblem = "type" | "size" | "read";

/** Vazio (0 byte): "read"; acima de 10 MB: "size"; sem o tamanho (o sistema não informou): null (vale a cópia). */
export function fileSizeProblem(size: number | null | undefined): FileProblem | null {
  if (size === null || size === undefined || Number.isNaN(size)) return null;
  if (size <= 0) return "read";
  return size > DOCUMENT_MAX_BYTES ? "size" : null;
}

/** O que a tela diz do arquivo que não serve (contrato §9). */
export const FILE_PROBLEM_TEXT: Record<FileProblem, string> = {
  type: "Use PDF ou foto (JPG, PNG ou WebP).",
  size: `Arquivo maior que ${DOCUMENT_LIMITS.maxMb} MB.`,
  read: "Não foi possível abrir o arquivo. Tente de novo ou escolha outro.",
};

// --------------------------------------------------------------------------- formulário

/** O formulário de um documento pessoal ou de uma certificação. */
export interface DocumentDraft {
  title: string;
  /** "AAAA-MM-DD"; só na certificação (no documento pessoal fica null). */
  expiresOn: string | null;
}

export type DocumentField = "title" | "expiresOn" | "file";

/** Ordem da tela: o primeiro erro vai para o rodapé. */
export const DOCUMENT_FIELDS: readonly DocumentField[] = ["title", "expiresOn", "file"];

export const DOCUMENT_MSG = {
  title: "Informe o título.",
  titleMax: `No máximo ${DOCUMENT_LIMITS.titleMax} caracteres.`,
  expiresOn: "Confira a validade.",
  file: "Escolha o arquivo.",
} as const;

/** A validade mais antiga que o servidor aceita. */
export const EXPIRES_MIN = "2000-01-01";
/** A mais distante: hoje + 20 anos. */
export const EXPIRES_YEARS = 20;

/** Hoje ("AAAA-MM-DD") + 20 anos; 29/02 num ano que não é bissexto vira 28/02. */
export function expiresMax(today: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!m) return today;
  const year = Number(m[1]) + EXPIRES_YEARS;
  const month = Number(m[2]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${m[2]}-${pad(Math.min(Number(m[3]), lastDay))}`;
}

/** A validade existe e está entre 2000-01-01 e hoje + 20 anos. */
export function expiresOk(value: string, today: string): boolean {
  return documentDue(value, today) !== null && value >= EXPIRES_MIN && value <= expiresMax(today);
}

/** O formulário de um documento gravado; null: vazio (incluir). */
export function documentDraftOf(doc: Pick<MyDocument, "title" | "expires_on"> | null | undefined): DocumentDraft {
  return { title: doc?.title ?? "", expiresOn: doc?.expires_on ?? null };
}

/** Os erros do formulário (com ponto final, como os do Meu cadastro; os do servidor vêm sem ponto). */
export function documentProblem(
  group: DocumentGroup,
  draft: DocumentDraft,
  hasFile: boolean,
  today: string,
): Partial<Record<DocumentField, string>> {
  const errors: Partial<Record<DocumentField, string>> = {};
  const length = chars(cleanText(draft.title));
  if (length < DOCUMENT_LIMITS.titleMin) errors.title = DOCUMENT_MSG.title;
  else if (length > DOCUMENT_LIMITS.titleMax) errors.title = DOCUMENT_MSG.titleMax;
  if (group === "certification" && draft.expiresOn !== null && !expiresOk(draft.expiresOn, today)) {
    errors.expiresOn = DOCUMENT_MSG.expiresOn;
  }
  if (!hasFile) errors.file = DOCUMENT_MSG.file;
  return errors;
}

/** O primeiro erro, na ordem da tela. */
export function firstDocumentProblem(errors: Partial<Record<DocumentField, string>>): string | null {
  return DOCUMENT_FIELDS.map((field) => errors[field]).find(Boolean) ?? null;
}

/**
 * POST /me/profile/documents (multipart, com o arquivo): o tipo, o título limpo, a validade só na certificação
 * preenchida e o `client_upload_id` (o mesmo em cada tentativa do mesmo arquivo).
 */
export function documentFields(group: DocumentGroup, draft: DocumentDraft, clientUploadId: string): Record<string, string> {
  const fields: Record<string, string> = { kind: group, title: cleanText(draft.title), client_upload_id: clientUploadId };
  if (group === "certification" && draft.expiresOn) fields.expires_on = draft.expiresOn;
  return fields;
}

/** O currículo: o título é sempre "Currículo" (enviar com um currículo gravado troca o arquivo dele). */
export function resumeFields(clientUploadId: string): Record<string, string> {
  return { kind: "resume", title: DOCUMENT_KIND.resume, client_upload_id: clientUploadId };
}

/**
 * PATCH /me/profile/documents/{id}: só o que mudou (o tipo nunca muda). A validade só na certificação; null tira a
 * validade.
 */
export function documentPatch(
  group: DocumentGroup,
  draft: DocumentDraft,
  doc: Pick<MyDocument, "title" | "expires_on">,
): TechDocumentUpdate {
  const body: TechDocumentUpdate = {};
  const title = cleanText(draft.title);
  if (title !== doc.title) body.title = title;
  if (group === "certification" && (draft.expiresOn ?? null) !== (doc.expires_on ?? null)) body.expires_on = draft.expiresOn ?? null;
  return body;
}

/** O formulário mudou algo do documento gravado (ou tem arquivo novo). */
export function documentChanged(
  group: DocumentGroup,
  draft: DocumentDraft,
  doc: Pick<MyDocument, "title" | "expires_on">,
  newFile: boolean,
): boolean {
  return newFile || Object.keys(documentPatch(group, draft, doc)).length > 0;
}

/**
 * POST /me/profile/documents/{id}/replace (multipart, com o arquivo novo): o `client_upload_id` e só o que mudou junto
 * (título; validade, "" tira). O que não vai fica como está.
 */
export function replaceFields(
  group: DocumentGroup,
  draft: DocumentDraft,
  doc: Pick<MyDocument, "title" | "expires_on">,
  clientUploadId: string,
): Record<string, string> {
  const patch = documentPatch(group, draft, doc);
  const fields: Record<string, string> = { client_upload_id: clientUploadId };
  if (patch.title !== undefined) fields.title = patch.title;
  if (patch.expires_on !== undefined) fields.expires_on = patch.expires_on ?? "";
  return fields;
}

// --------------------------------------------------------------------------- listas e resumos

const MY_KINDS = new Set<string>(["certification", "personal", "resume"]);

/** Os documentos que o app conhece (um tipo novo, de um servidor mais novo, não aparece). */
export function knownDocuments(list: readonly MyDocument[] | null | undefined): MyDocument[] {
  return Array.isArray(list) ? list.filter((doc) => !!doc && MY_KINDS.has(doc.kind)) : [];
}

const time = (iso: string) => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
};

/** O mais novo primeiro. */
const byNewest = (a: MyDocument, b: MyDocument) => time(b.uploaded_at) - time(a.uploaded_at);

/** Pelo título sem acento e maiúsculas; empate, o mais novo primeiro. */
function byTitle(a: MyDocument, b: MyDocument): number {
  const x = foldName(a.title);
  const y = foldName(b.title);
  if (x !== y) return x < y ? -1 : 1;
  return byNewest(a, b);
}

/** A validade mais próxima primeiro (a vencida antes); sem validade por último; empate, pelo título. */
function byExpiry(a: MyDocument, b: MyDocument): number {
  const x = a.expires_on ?? null;
  const y = b.expires_on ?? null;
  if (x === y) return byTitle(a, b);
  if (x === null) return 1;
  if (y === null) return -1;
  return x < y ? -1 : 1;
}

export interface SplitDocuments {
  certifications: MyDocument[];
  personal: MyDocument[];
  /** O currículo (um só; com mais de um, o mais novo). */
  resume: MyDocument | null;
}

/** Os blocos da tela, na ordem do servidor (contrato §6.3), e o currículo à parte. */
export function splitDocuments(list: readonly MyDocument[] | null | undefined): SplitDocuments {
  const known = knownDocuments(list);
  return {
    certifications: known.filter((doc) => doc.kind === "certification").sort(byExpiry),
    personal: known.filter((doc) => doc.kind === "personal").sort(byTitle),
    resume: known.filter((doc) => doc.kind === "resume").sort(byNewest)[0] ?? null,
  };
}

/** O documento pessoal ou a certificação do formulário de editar (o currículo tem tela própria); null: não está. */
export function editableDocument(list: readonly MyDocument[] | null | undefined, id: string | null | undefined): MyDocument | null {
  if (!id) return null;
  return knownDocuments(list).find((doc) => doc.id === id && doc.kind !== "resume") ?? null;
}

/** Certificações e documentos pessoais no limite do servidor: incluir fica desligado. */
export function documentsFull(list: readonly MyDocument[] | null | undefined): boolean {
  const { certifications, personal } = splitDocuments(list);
  return certifications.length + personal.length >= DOCUMENT_LIMITS.perTechnician;
}

/** Data e hora do servidor → "20/11/2026" no fuso do aparelho. */
function dayText(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

/** "enviado em 20/11/2026"; o arquivo que a central mandou, "enviado pela central em 20/11/2026". */
export function documentSentText(doc: Pick<MyDocument, "uploaded_at" | "via">): string {
  return `${doc.via === "central" ? "enviado pela central em" : "enviado em"} ${dayText(doc.uploaded_at)}`;
}

/** "PDF · enviado em 20/11/2026" | "Foto · enviado pela central em 20/11/2026". */
export function documentFileLine(doc: Pick<MyDocument, "content_type" | "uploaded_at" | "via">): string {
  return `${documentFileKind(doc.content_type)} · ${documentSentText(doc)}`;
}

/** O que o leitor de tela fala do item: "NR10, Vence em 12 dias, PDF, enviado em 20/11/2026". */
export function documentSpoken(doc: MyDocument, today: string): string {
  return [doc.title, documentDueText(doc.expires_on, today), documentFileKind(doc.content_type), documentSentText(doc)]
    .filter(Boolean)
    .join(", ");
}

/** Resumo de uma linha do menu: o texto e o tom (âmbar quando pede atenção). */
export interface DocumentsRowSummary {
  value: string;
  tone: "muted" | "warning";
}

/**
 * Linha Documentos do menu (o currículo não conta): "1 vencida" / "2 vencidas" (âmbar); senão a que vence primeiro em
 * até 30 dias, "Vence hoje" / "Vence amanhã" / "Vence em 12 dias" (âmbar); senão "Nenhum", "1 documento", "3 documentos".
 */
export function documentsRowSummary(list: readonly MyDocument[] | null | undefined, today: string): DocumentsRowSummary {
  const { certifications, personal } = splitDocuments(list);
  let expired = 0;
  let soonest: { expiresOn: string; days: number } | null = null;
  for (const doc of certifications) {
    const due = documentDue(doc.expires_on, today);
    if (!due || !doc.expires_on) continue;
    if (due.state === "expired") expired += 1;
    else if (due.state === "soon" && (!soonest || due.days < soonest.days)) soonest = { expiresOn: doc.expires_on, days: due.days };
  }
  if (expired) return { value: expired === 1 ? "1 vencida" : `${expired} vencidas`, tone: "warning" };
  const soon = soonest ? documentDueText(soonest.expiresOn, today) : null;
  if (soon) return { value: soon, tone: "warning" };
  const count = certifications.length + personal.length;
  return { value: count === 0 ? "Nenhum" : count === 1 ? "1 documento" : `${count} documentos`, tone: "muted" };
}

function isList(value: unknown): value is readonly MyDocument[] {
  return Array.isArray(value);
}

/**
 * Linha Currículo do menu: "Enviando…" / "Excluindo…" (`task`, de useResumeTask), senão "Enviado" ou "Não enviado".
 * Aceita o currículo (splitDocuments(…).resume) ou a lista inteira (MyProfile.documents).
 */
export function resumeRowSummary(resume: MyDocument | readonly MyDocument[] | null | undefined, task: ResumeTask = null): string {
  if (task === "upload") return "Enviando…";
  if (task === "remove") return "Excluindo…";
  const found = isList(resume) ? splitDocuments(resume).resume : (resume ?? null);
  return found ? "Enviado" : "Não enviado";
}
