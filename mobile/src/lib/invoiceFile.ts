// Arquivo da nota fiscal no aparelho. O documento vem do seletor do sistema (File.pickFileAsync do expo-file-system:
// PDF, XML ou imagem) e a foto, da câmera ou da galeria (photoCapture, alvo "invoice"). O escolhido é copiado para uma
// pasta só dele no cache do app: o content:// do Android vira um arquivo que o envio nativo lê, e ele sobe com um nome
// que a central entende (o do aparelho, ou "nota-AAAA-MM-DD"). O original nunca é apagado: no Android, apagar o
// content:// apagaria o documento do técnico. Na pré-visualização web: invoiceFile.web.ts.

import { randomUUID } from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import type { ImagePickerAsset } from "expo-image-picker";
import {
  hasInvoiceExtension,
  INVOICE_MAX_BYTES,
  INVOICE_PICKER_TYPES,
  invoiceFileType,
  invoiceUploadName,
  warnInvoiceFile,
  type InvoiceFileType,
  type PickedInvoiceFile,
} from "./invoices";
import { photoFileType } from "./photoFormat";

export type { PickedInvoiceFile };

/** Cada arquivo escolhido fica em cache/notas-fiscais/<uuid>/<nome>. */
const root = () => new Directory(Paths.cache, "notas-fiscais");
const FOLDER_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Pastas de arquivos ainda escolhidos numa tela (ou subindo): a limpeza não mexe nelas. */
const inUse = new Set<string>();

/** Só apaga dentro do cache das notas, e só pasta com nome de uuid. */
function drop(id: string) {
  inUse.delete(id);
  if (!FOLDER_ID.test(id)) return;
  try {
    const dir = new Directory(root(), id);
    if (dir.exists) dir.delete();
  } catch {
    // já saiu
  }
}

/** Nome, tipo e tamanho do que o seletor devolveu (no content:// a leitura pode falhar: fica vazio). */
function describe(file: File): { name: string; type: string; size: number } {
  let name = "";
  let type = "";
  let size = 0;
  try {
    name = file.name;
  } catch {
    // sem nome legível: vale o tipo
  }
  try {
    type = file.type;
    size = file.size;
  } catch {
    // o tamanho é conferido na cópia
  }
  return { name, type, size };
}

/** Copia para uma pasta própria no cache (dois arquivos do aparelho podem ter o mesmo nome) e confere o tamanho. */
async function keep(source: File, type: InvoiceFileType, name: string, knownSize: number): Promise<PickedInvoiceFile | null> {
  if (knownSize > INVOICE_MAX_BYTES) {
    warnInvoiceFile("size");
    return null;
  }
  const id = randomUUID();
  inUse.add(id);
  try {
    const dir = new Directory(root(), id);
    dir.create({ intermediates: true, idempotent: true });
    const target = new File(dir, name);
    await source.copy(target);
    const size = target.size;
    if (size > 0 && size <= INVOICE_MAX_BYTES) {
      return { uri: target.uri, name, mimeType: type.mime, size, kind: type.kind, temp: true };
    }
    drop(id);
    warnInvoiceFile(size > 0 ? "size" : "read");
    return null;
  } catch (error) {
    console.warn("Falha ao copiar o arquivo da nota", error);
    drop(id);
    warnInvoiceFile("read");
    return null;
  }
}

/** Seletor de documentos do sistema. null: cancelou ou o arquivo não serve (o aviso já foi mostrado). */
export async function pickInvoiceDocument(): Promise<PickedInvoiceFile | null> {
  const picked = await File.pickFileAsync({ mimeTypes: INVOICE_PICKER_TYPES });
  if (picked.canceled) return null;
  const { name, type: mime, size } = describe(picked.result);
  const type = invoiceFileType(name, mime);
  if (!type) {
    warnInvoiceFile("type");
    return null;
  }
  return keep(picked.result, type, invoiceUploadName(hasInvoiceExtension(name) ? name : null, type.ext, new Date()), size);
}

/** Foto da câmera ou da galeria (JPG, PNG ou WebP), com o nome "nota-AAAA-MM-DD". */
export async function invoiceFromPhoto(asset: ImagePickerAsset): Promise<PickedInvoiceFile | null> {
  const photo = photoFileType(asset.uri, asset.mimeType);
  const type = invoiceFileType(`foto.${photo.ext}`, photo.mime);
  if (!type || type.kind !== "image") {
    warnInvoiceFile("type");
    return null;
  }
  return keep(new File(asset.uri), type, invoiceUploadName(null, type.ext, new Date()), asset.fileSize ?? 0);
}

/** Apaga a cópia do app (a pasta dela no cache das notas). */
export function discardPicked(file: PickedInvoiceFile | null | undefined): void {
  if (!file?.temp) return;
  try {
    drop(new File(file.uri).parentDirectory.name);
  } catch {
    // já saiu
  }
}

/** Cópias que ficaram de uma tela que não terminou (o sistema fechou o app): saem ao abrir a tela de novo. */
export function sweepInvoiceFiles(): void {
  try {
    const dir = root();
    if (!dir.exists) return;
    for (const entry of dir.list()) {
      if (entry instanceof Directory && FOLDER_ID.test(entry.name) && !inUse.has(entry.name)) entry.delete();
    }
  } catch {
    // o cache é do sistema: o que sobrar sai com ele
  }
}
