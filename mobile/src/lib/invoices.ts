// Notas fiscais do técnico, na aba Ganhos (contrato em docs/API.md, "Notas fiscais dos técnicos"). Tudo pede internet:
// a nota não entra na fila offline (a fila de fotos é presa à OS, e o servidor confere na hora as OS escolhidas e o
// número repetido). A lista de cada competência fica no aparelho (kv `invoices:AAAA-MM`) para abrir sem rede. O envio
// leva um `client_upload_id`: mandado de novo depois de uma resposta perdida, devolve a mesma nota em vez de duplicar.
// O arquivo é escolhido em invoiceFile.ts (na pré-visualização web, invoiceFile.web.ts), com os tipos e o nome daqui.

import NetInfo from "@react-native-community/netinfo";
import { useSyncExternalStore } from "react";
import { Linking } from "react-native";
import { absoluteApiUrl, api, ApiError, uploadFile } from "./api";
import { INVOICE_LIMITS } from "./constants";
import { getKv, setKv } from "./db";
import { notify } from "./dialogs";
import { session } from "./session";
import type { InvoiceFileKind, InvoicePayoutCandidate, MyInvoice } from "./types";

// ───────────────────────────── versão das notas ─────────────────────────────

let version = 0;
const listeners = new Set<() => void>();

/** Uma nota entrou ou saiu: Ganhos relê as notas e os valores (o "NF" de cada OS). */
export function bumpInvoices(): void {
  version += 1;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getVersion = () => version;

/** Muda a cada nota enviada ou apagada neste aparelho. */
export function useInvoicesVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

// ───────────────────────────── lista por competência ─────────────────────────────

/** As notas de uma competência como vieram do servidor, e quando. */
export interface InvoicesEntry {
  at: string;
  items: MyInvoice[];
}

/** O link do arquivo vale 30 min: com a lista mais velha que 20 min, ela é buscada de novo antes de abrir. */
const LINK_FRESH_MS = 20 * 60_000;

export const invoicesKey = (month: string) => `invoices:${month}`;

/** Nenhuma tela lê o kv das notas direto: a escrita não avisa as listas de OS. */
const QUIET = { notify: false } as const;

function store(month: string, entry: InvoicesEntry) {
  void setKv(invoicesKey(month), JSON.stringify(entry), undefined, QUIET).catch(() => undefined);
}

export async function readCachedInvoices(month: string): Promise<InvoicesEntry | null> {
  try {
    const raw = await getKv(invoicesKey(month));
    if (!raw) return null;
    const entry = JSON.parse(raw) as InvoicesEntry;
    return typeof entry?.at === "string" && Array.isArray(entry.items) ? entry : null;
  } catch {
    return null;
  }
}

/** GET /me/invoices?month=: as notas da competência (as mais novas primeiro). A resposta fica no aparelho. */
export async function loadMyInvoices(month: string): Promise<InvoicesEntry> {
  const userId = session.get().user?.id ?? null;
  const items = await api.get<MyInvoice[]>(`/me/invoices?month=${month}`);
  const entry: InvoicesEntry = { at: new Date().toISOString(), items };
  // Saiu da conta (ou entrou outro técnico) durante o pedido: nada fica no aparelho.
  if (session.get().user?.id === userId) store(month, entry);
  return entry;
}

/** A lista ainda tem links válidos para abrir o arquivo. */
export const linksFresh = (entry: InvoicesEntry, now: number) => now - Date.parse(entry.at) < LINK_FRESH_MS;

/** GET /me/invoices/payouts?month=: as OS que podem entrar numa nota da competência (as do mês primeiro). */
export function loadInvoicePayouts(month: string): Promise<InvoicePayoutCandidate[]> {
  return api.get<InvoicePayoutCandidate[]>(`/me/invoices/payouts?month=${month}`);
}

// ───────────────────────────── envio, exclusão e arquivo ─────────────────────────────

export interface InvoiceInput {
  file: PickedInvoiceFile;
  number: string;
  /** AAAA-MM-DD. */
  issueDate: string;
  amount: number;
  /** AAAA-MM. */
  competence: string;
  note: string;
  payoutIds: string[];
  /** O mesmo em cada tentativa da mesma nota. */
  clientUploadId: string;
}

/** POST /me/invoices (multipart). 201 com a nota, ou 200 com a mesma nota quando o envio repete. */
export async function sendInvoice(input: InvoiceInput): Promise<MyInvoice> {
  const invoice = await uploadFile<MyInvoice>(
    "/me/invoices",
    input.file.uri,
    {
      number: input.number.trim(),
      issue_date: input.issueDate,
      amount: input.amount.toFixed(2),
      competence: input.competence,
      note: input.note.trim(),
      payout_ids: input.payoutIds.join(","),
      client_upload_id: input.clientUploadId,
    },
    input.file.mimeType,
    input.file.name,
  );
  bumpInvoices();
  return invoice;
}

/** DELETE /me/invoices/{id}: só a que a central ainda não conferiu. A que já tinha saído conta como apagada. */
export async function deleteInvoice(invoice: MyInvoice): Promise<void> {
  try {
    await api.delete<void>(`/me/invoices/${invoice.id}`);
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error;
  }
  const cached = await readCachedInvoices(invoice.competence);
  if (cached) store(invoice.competence, { ...cached, items: cached.items.filter((item) => item.id !== invoice.id) });
  bumpInvoices();
}

/** Abre o arquivo pelo link assinado, no navegador do aparelho (PDF e XML baixam; a foto abre na tela). */
export async function openInvoiceFile(downloadUrl: string): Promise<void> {
  const url = absoluteApiUrl(downloadUrl);
  if (!url) throw new Error("Arquivo indisponível");
  await Linking.openURL(url);
}

/** Sem Wi-Fi e sem dados. Alcance incerto (teste de internet do sistema falhando) ainda vale tentar. */
export async function isOffline(): Promise<boolean> {
  const net = await NetInfo.fetch().catch(() => null);
  return net?.isConnected === false;
}

// ───────────────────────────── arquivo escolhido ─────────────────────────────

/** O arquivo da nota já conferido e pronto para enviar (invoiceFile.ts e invoiceFile.web.ts). */
export interface PickedInvoiceFile {
  uri: string;
  /** Nome com que sobe (e que a tela mostra). */
  name: string;
  mimeType: string;
  /** Bytes; null quando o sistema não informa. */
  size: number | null;
  kind: InvoiceFileKind;
  /** Cópia feita pelo app (cache ou blob:): sai com discardPicked. */
  temp: boolean;
}

/** Os tipos que o seletor mostra. O servidor confere de novo pelo conteúdo. */
export const INVOICE_PICKER_TYPES = ["application/pdf", "application/xml", "text/xml", "image/jpeg", "image/png", "image/webp"];

export const INVOICE_MAX_BYTES = INVOICE_LIMITS.maxMb * 1024 * 1024;

export interface InvoiceFileType {
  kind: InvoiceFileKind;
  mime: string;
  /** Extensão do arquivo que sobe. */
  ext: string;
}

const PDF: InvoiceFileType = { kind: "pdf", mime: "application/pdf", ext: "pdf" };
const XML: InvoiceFileType = { kind: "xml", mime: "application/xml", ext: "xml" };
const JPEG: InvoiceFileType = { kind: "image", mime: "image/jpeg", ext: "jpg" };
const PNG: InvoiceFileType = { kind: "image", mime: "image/png", ext: "png" };
const WEBP: InvoiceFileType = { kind: "image", mime: "image/webp", ext: "webp" };

const BY_EXTENSION: Record<string, InvoiceFileType> = { pdf: PDF, xml: XML, jpg: JPEG, jpeg: JPEG, png: PNG, webp: WEBP };
const BY_MIME: Record<string, InvoiceFileType> = {
  "application/pdf": PDF,
  "application/xml": XML,
  "text/xml": XML,
  "image/jpeg": JPEG,
  "image/jpg": JPEG,
  "image/png": PNG,
  "image/webp": WEBP,
};

const extensionOf = (name: string) => /\.([a-z0-9]+)$/i.exec(name.trim())?.[1]?.toLowerCase() ?? "";

/** O nome do aparelho termina numa extensão aceita (no Android, o content:// às vezes só tem um código). */
export const hasInvoiceExtension = (name: string) => extensionOf(name) in BY_EXTENSION;

/**
 * Tipo do arquivo pela extensão do nome (pdf, xml, jpg, jpeg, png, webp) ou, sem ela, pelo tipo que o sistema
 * informa. null: não é nota que a central recebe.
 */
export function invoiceFileType(name: string, mimeType: string | null | undefined): InvoiceFileType | null {
  const byName = BY_EXTENSION[extensionOf(name)];
  if (byName) return byName;
  const mime = (mimeType ?? "").split(";")[0].trim().toLowerCase();
  return BY_MIME[mime] ?? null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "AAAA-MM-DD" no fuso do aparelho. */
export const isoDay = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/**
 * Nome com que o arquivo sobe: o do aparelho sem acentos nem símbolos (o envio nativo usa o nome do arquivo) ou, sem
 * um nome de verdade, "nota-AAAA-MM-DD"; sempre com a extensão do tipo.
 */
export function invoiceUploadName(original: string | null, ext: string, today: Date): string {
  const base = (original ?? "")
    .replace(/\.[^.]*$/, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 80);
  return `${base || `nota-${isoDay(today)}`}.${ext}`;
}

/** Aviso de arquivo que não serve, com o que fazer. */
export function warnInvoiceFile(problem: "type" | "size" | "read"): void {
  if (problem === "type") notify("Arquivo não aceito", "Envie a nota em PDF, XML ou foto (JPG, PNG ou WebP).");
  else if (problem === "size") notify("Arquivo grande demais", `A nota pode ter até ${INVOICE_LIMITS.maxMb} MB.`);
  else notify("Não foi possível abrir o arquivo", "Tente de novo ou escolha outro arquivo.");
}

// ───────────────────────────── datas e meses ─────────────────────────────

/** "AAAA-MM" do mês da data, no fuso do aparelho. */
export const monthKeyOf = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;

/** "2026-11" + delta meses. */
export function shiftMonth(month: string, delta: number): string {
  const [year, mon] = month.split("-").map(Number);
  return monthKeyOf(new Date(year, mon - 1 + delta, 1));
}

/** "2026-11-05" → "05/11/2026" (data sem hora: sem passar por Date, que mudaria o dia no fuso). */
export const formatIsoDay = (value: string) => value.slice(0, 10).split("-").reverse().join("/");

const dayFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });

/** Data e hora do servidor → "20/11/2026" no fuso do aparelho. */
export const formatDayOf = (iso: string) => dayFmt.format(new Date(iso));
