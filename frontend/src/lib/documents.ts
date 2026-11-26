// Documentos do técnico na central (ficha › Documentos, Currículo e Anexos internos; Homologação): o tempo do link
// assinado, os textos da tela, a conferência do arquivo, do título e da validade antes do envio, a ordem da lista, o
// "enviado por", o vencimento na lista de Técnicos e o link de um arquivo pela lista relida. Puro e só com `import type`
// (a sonda tests/documents.test.mjs roda direto no Node): os limites de lib/constants.ts ficam em cópias locais, que a
// sonda confere com DOCUMENT_LIMITS e DOCUMENT_ACCEPT.

import type {
  CertificationDue,
  TechDocument,
  TechDocumentFile,
  TechDocumentKind,
  TechDocumentUpdate,
  UUID,
} from "./types";

/** A lista de documentos relê sozinha a cada 20 min: o link assinado de cada arquivo vale 30. */
export const DOCUMENT_REFRESH_MS = 20 * 60_000;
/** Lista lida há mais que isto: abrir um arquivo pede a lista de novo antes (o link pode ter vencido). */
export const FILE_LINK_FRESH_MS = 25 * 60_000;

/** = DOCUMENT_LIMITS de constants (a sonda confere). */
const MAX_BYTES = 10 * 1024 * 1024;
const TITLE_MIN = 2;
const TITLE_MAX = 80;
/** Certificações e documentos pessoais, somados (o currículo é um só e fica fora). */
const PER_TECHNICIAN = 30;
const INTERNAL_MAX = 30;
/** = DOCUMENT_ACCEPT (o servidor confere pelo conteúdo). */
const ACCEPTED_TYPES: readonly string[] = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
/** Sem o tipo (alguns sistemas não mandam), vale a extensão. */
const ACCEPTED_EXTENSIONS: readonly string[] = [".pdf", ".jpg", ".jpeg", ".png", ".webp"];

/** A primeira validade aceita; a última é hoje + 20 anos (expiryLastDay). */
export const EXPIRY_FIRST_DAY = "2000-01-01";
const EXPIRY_YEARS = 20;

/** Os erros da tela (com ponto; os do servidor vêm sem). */
export const DOCUMENT_MSG = {
  file: "Escolha o arquivo.",
  empty: "O arquivo está vazio.",
  size: "Arquivo maior que 10 MB.",
  type: "Use PDF ou foto (JPG, PNG ou WebP).",
  title: "Informe o título.",
  titleLong: `O título tem no máximo ${TITLE_MAX} caracteres.`,
  expiry: "Confira a validade.",
} as const;

/** O título do diálogo de envio. */
export const DOCUMENT_CREATE_TITLE: Record<TechDocumentKind, string> = {
  certification: "Enviar certificação",
  personal: "Enviar documento pessoal",
  resume: "Enviar currículo",
  internal: "Enviar anexo",
};

/** O aviso depois do envio. */
export const DOCUMENT_SENT: Record<TechDocumentKind, string> = {
  certification: "Certificação enviada",
  personal: "Documento enviado",
  resume: "Currículo enviado",
  internal: "Anexo enviado",
};

/** O aviso depois de excluir. */
export const DOCUMENT_REMOVED: Record<TechDocumentKind, string> = {
  certification: "Certificação excluída",
  personal: "Documento excluído",
  resume: "Currículo excluído",
  internal: "Anexo excluído",
};

export const DOCUMENT_REPLACED = "Arquivo substituído";
export const DOCUMENT_EDITED = "Alterações salvas";

/** Os limites ao chegar neles (o botão de enviar some e fica o aviso). */
export const DOCUMENT_LIMIT_TEXT = {
  documents: `Limite de ${PER_TECHNICIAN} documentos e certificações. Exclua um para enviar outro.`,
  internal: `Limite de ${INTERNAL_MAX} anexos internos. Exclua um para enviar outro.`,
} as const;

/** Só a certificação tem validade. */
export const hasExpiry = (kind: TechDocumentKind) => kind === "certification";
/** O currículo não tem título (é sempre "Currículo"). */
export const hasTitle = (kind: TechDocumentKind) => kind !== "resume";

// --------------------------------------------------------------------------- texto

/** Tab, LF, VT, FF e CR viram espaço; os outros controles e os caracteres de formatação (invisíveis) saem. */
const CONTROL_SPACE = /[\t\n\v\f\r]/g;
const CONTROL = /[\p{Cc}\p{Cf}]/gu;

/** O título como o servidor grava (core/text.clean): sem invisíveis, NFC e espaços juntados. */
export function cleanDocumentTitle(text: string): string {
  return text.replace(CONTROL_SPACE, " ").replace(CONTROL, "").normalize("NFC").trim().replace(/\s+/g, " ");
}

/** Para ordenar pelo título sem acento e sem maiúsculas (core/text.fold). */
function foldTitle(text: string): string {
  return cleanDocumentTitle(text).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Tamanho em caracteres, como o servidor conta (um emoji é um só). */
const chars = (text: string) => Array.from(text).length;

// --------------------------------------------------------------------------- conferência antes do envio

/** O arquivo escolhido: PDF, JPG, PNG ou WebP (pelo tipo do navegador; sem ele, pela extensão), de 1 byte a 10 MB. */
export function documentFileProblem(file: { name: string; size: number; type: string } | null | undefined): string | null {
  if (!file) return DOCUMENT_MSG.file;
  const type = (file.type ?? "").trim().toLowerCase();
  const name = (file.name ?? "").trim().toLowerCase();
  // Tipo vazio ou genérico (o sistema não reconheceu): vale a extensão.
  const accepted =
    type && type !== "application/octet-stream"
      ? ACCEPTED_TYPES.includes(type) || type === "image/jpg"
      : ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext));
  if (!accepted) return DOCUMENT_MSG.type;
  if (file.size <= 0) return DOCUMENT_MSG.empty;
  if (file.size > MAX_BYTES) return DOCUMENT_MSG.size;
  return null;
}

/** O título (2 a 80 caracteres depois de limpo). */
export function documentTitleProblem(text: string): string | null {
  const size = chars(cleanDocumentTitle(text));
  if (size < TITLE_MIN) return DOCUMENT_MSG.title;
  if (size > TITLE_MAX) return DOCUMENT_MSG.titleLong;
  return null;
}

/** Milissegundos UTC de um "AAAA-MM-DD" que existe; null se não existe ("2026-02-30") ou fora do formato. */
function isoDayMs(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? ms : null;
}

/** A última validade aceita: hoje + 20 anos (29/02 vira 28/02 no ano que não é bissexto). */
export function expiryLastDay(today: string): string {
  const y = Number(today.slice(0, 4)) + EXPIRY_YEARS;
  const md = today.slice(5, 10);
  const day = `${y}-${md}`;
  return isoDayMs(day) === null && md === "02-29" ? `${y}-02-28` : day;
}

/** A validade (opcional): um dia que existe, de 2000-01-01 a hoje + 20 anos. */
export function documentExpiryProblem(value: string, today: string): string | null {
  if (!value) return null;
  if (isoDayMs(value) === null || value < EXPIRY_FIRST_DAY || value > expiryLastDay(today)) return DOCUMENT_MSG.expiry;
  return null;
}

/** Editar: só o que mudou (título limpo; a validade só na certificação, "" tira). O tipo nunca muda. */
export function documentPatch(
  doc: Pick<TechDocument, "kind" | "title" | "expires_on">,
  form: { title: string; expiresOn: string },
): TechDocumentUpdate {
  const patch: TechDocumentUpdate = {};
  const title = cleanDocumentTitle(form.title);
  if (hasTitle(doc.kind) && title !== doc.title) patch.title = title;
  const expiresOn = form.expiresOn || null;
  if (hasExpiry(doc.kind) && expiresOn !== (doc.expires_on ?? null)) patch.expires_on = expiresOn;
  return patch;
}

/** O `client_upload_id` de um arquivo escolhido: o mesmo nas novas tentativas do mesmo envio (o servidor não duplica). */
export function newUploadId(): string {
  const c = globalThis.crypto;
  // randomUUID só existe com HTTPS (ou localhost); getRandomValues, sempre.
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// --------------------------------------------------------------------------- lista

const KIND_ORDER: readonly TechDocumentKind[] = ["certification", "personal", "resume", "internal"];

/**
 * A ordem do servidor: certificação (a validade mais próxima primeiro; sem validade por último), documento pessoal,
 * currículo e anexo interno; dentro de cada um, o título sem acento e sem maiúsculas.
 */
export function sortDocuments(docs: readonly TechDocument[]): TechDocument[] {
  return [...docs].sort((a, b) => {
    const kind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    if (kind) return kind;
    if (a.kind === "certification" && a.expires_on !== b.expires_on) {
      if (!a.expires_on) return 1;
      if (!b.expires_on) return -1;
      return a.expires_on < b.expires_on ? -1 : 1;
    }
    const ta = foldTitle(a.title);
    const tb = foldTitle(b.title);
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Os documentos de um tipo, na ordem da tela. */
export function documentsOfKind(docs: readonly TechDocument[] | null | undefined, kind: TechDocumentKind): TechDocument[] {
  return sortDocuments((docs ?? []).filter((doc) => doc.kind === kind));
}

/** A lista com o documento enviado, substituído ou editado (no lugar do de mesmo id, ou novo), na ordem. */
export function withDocument(docs: readonly TechDocument[] | null | undefined, doc: TechDocument): TechDocument[] {
  const list = docs ?? [];
  const found = list.some((d) => d.id === doc.id);
  return sortDocuments(found ? list.map((d) => (d.id === doc.id ? doc : d)) : [...list, doc]);
}

/** A lista sem o documento excluído. */
export function withoutDocument(docs: readonly TechDocument[] | null | undefined, id: UUID): TechDocument[] {
  return (docs ?? []).filter((doc) => doc.id !== id);
}

/** No limite: certificações e documentos pessoais somam 30; anexos internos, 30 à parte; o currículo é um só. */
export function documentsAtLimit(docs: readonly TechDocument[] | null | undefined, kind: TechDocumentKind): boolean {
  const list = docs ?? [];
  if (kind === "internal") return list.filter((d) => d.kind === "internal").length >= INTERNAL_MAX;
  if (kind === "resume") return false;
  return list.filter((d) => d.kind === "certification" || d.kind === "personal").length >= PER_TECHNICIAN;
}

/**
 * O link assinado de um arquivo (o atual ou uma versão anterior) na lista relida; null se ele saiu da lista. Abrir um
 * arquivo de uma lista lida há mais de FILE_LINK_FRESH_MS passa por aqui.
 */
export function findFileUrl(docs: readonly TechDocument[] | null | undefined, fileId: UUID): string | null {
  for (const doc of docs ?? []) {
    if (doc.file.id === fileId) return doc.file.url;
    const old = (doc.previous ?? []).find((file) => file.id === fileId);
    if (old) return old.url;
  }
  return null;
}

/**
 * Quem mandou o arquivo e quando (`date` já formatada): "Enviado pelo técnico em 25/11/2026" (app), "Enviado por {nome}
 * em 25/11/2026" (central) ou "Da ficha da homologação, 25/11/2026".
 */
export function documentSentText(file: Pick<TechDocumentFile, "via" | "uploaded_by">, date: string): string {
  if (file.via === "app") return `Enviado pelo técnico em ${date}`;
  if (file.via === "ficha") return `Da ficha da homologação, ${date}`;
  return file.uploaded_by ? `Enviado por ${file.uploaded_by.name} em ${date}` : `Enviado pela central em ${date}`;
}

/**
 * A certificação mais urgente na linha da lista de Técnicos: "NR10 venceu", "NR10 vence hoje", "NR10 vence amanhã",
 * "NR10 vence em 10 dias" e, com mais de uma assim, " (+{n−1})". null sem certificação vencendo (ou data inválida).
 */
export function certificationDueRowText(due: CertificationDue | null | undefined, today: string): string | null {
  if (!due) return null;
  const end = isoDayMs(due.expires_on);
  const now = isoDayMs(today);
  if (end === null || now === null) return null;
  const days = Math.round((end - now) / 86_400_000);
  const head =
    days < 0
      ? `${due.title} venceu`
      : days === 0
        ? `${due.title} vence hoje`
        : days === 1
          ? `${due.title} vence amanhã`
          : `${due.title} vence em ${days} dias`;
  return due.count > 1 ? `${head} (+${due.count - 1})` : head;
}

/**
 * O tom do selo da linha: vencida (vermelho) ou vencendo (âmbar). O servidor só manda a certificação vencida ou que
 * vence em até DOCUMENT_WARN_DAYS dias; null sem ela (ou com data inválida).
 */
export function certificationDueState(due: CertificationDue | null | undefined, today: string): "expired" | "soon" | null {
  if (!due) return null;
  const end = isoDayMs(due.expires_on);
  const now = isoDayMs(today);
  if (end === null || now === null) return null;
  return end < now ? "expired" : "soon";
}
