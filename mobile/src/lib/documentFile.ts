// O arquivo dos documentos e do currículo (Configurações › Documentos e Currículo): a política de lib/pickedFile.ts (na
// pré-visualização web, pickedFile.web.ts) com as regras de lib/documentRules.ts. PDF, JPG, PNG ou WebP, até 10 MB; a
// cópia fica em cache/documentos/<uuid>/ só enquanto o formulário está aberto ou o envio corre, e sobe com o nome do
// aparelho limpo ou "documento-AAAA-MM-DD" / "curriculo-AAAA-MM-DD". O arquivo que não serve é avisado por quem pediu
// (`warn`): o formulário mostra no campo; o currículo, num toast.

import type { ImagePickerAsset } from "expo-image-picker";
import {
  DOCUMENT_MAX_BYTES,
  DOCUMENT_PICKER_TYPES,
  DOCUMENT_WEB_ACCEPT,
  documentFileType,
  documentUploadName,
  type DocumentFileKind,
  type FileProblem,
} from "./documentRules";
import { discardFile, fileFromPhoto, pickFile, sweepFiles, type PickedFile, type PickPolicy } from "./pickedFile";

/** Para onde vai o arquivo: o formulário de um documento ou o currículo (o mesmo `slot` do alvo da câmera). */
export type DocumentSlot = "document" | "resume";

/** O arquivo escolhido, pronto para subir (o envio lê `uri`; a tela mostra `name`, `kind` e `size`). */
export type PickedDocumentFile = PickedFile<DocumentFileKind>;

/** A pasta dos dois no cache: a limpeza de uma tela não apaga a cópia que a outra ainda está enviando. */
const FOLDER = "documentos";

/** O nome que sobe quando o do aparelho não serve: "documento-2026-11-26.pdf", "curriculo-2026-11-26.jpg". */
const BASE_NAME: Record<DocumentSlot, string> = { document: "documento", resume: "curriculo" };

function policyOf(slot: DocumentSlot, warn: (problem: FileProblem) => void): PickPolicy<DocumentFileKind> {
  return {
    folder: FOLDER,
    pickerTypes: DOCUMENT_PICKER_TYPES,
    webAccept: DOCUMENT_WEB_ACCEPT,
    maxBytes: DOCUMENT_MAX_BYTES,
    typeOf: documentFileType,
    uploadName: (original, ext, today) => documentUploadName(original, ext, BASE_NAME[slot], today),
    warn,
  };
}

/** Seletor de arquivos do sistema. null: cancelou ou o arquivo não serve (`warn` já foi chamado). */
export function pickDocumentFile(slot: DocumentSlot, warn: (problem: FileProblem) => void): Promise<PickedDocumentFile | null> {
  return pickFile(policyOf(slot, warn));
}

/** A foto da câmera ou da galeria (photoCapture, alvo "document"). null: não serve (`warn` já foi chamado). */
export function documentFromPhoto(
  asset: ImagePickerAsset,
  slot: DocumentSlot,
  warn: (problem: FileProblem) => void,
): Promise<PickedDocumentFile | null> {
  return fileFromPhoto(asset, policyOf(slot, warn));
}

/** Apaga a cópia do app (depois do envio, ou quando o arquivo é trocado ou a tela fecha). */
export function discardDocumentFile(file: PickedDocumentFile | null | undefined): void {
  discardFile(file, { folder: FOLDER });
}

/** As cópias que sobraram de uma tela que o sistema fechou no meio saem ao abrir a tela de novo. */
export function sweepDocumentFiles(): void {
  sweepFiles({ folder: FOLDER });
}
