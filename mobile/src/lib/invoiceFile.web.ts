// Pré-visualização no navegador: <input type="file"> no lugar do seletor do sistema. O arquivo vira um blob: (o envio
// da web, fileUpload.web.ts, lê com fetch) e discardPicked libera o blob. Mesmas funções de invoiceFile.ts.

import type { ImagePickerAsset } from "expo-image-picker";
import {
  hasInvoiceExtension,
  INVOICE_MAX_BYTES,
  INVOICE_PICKER_TYPES,
  invoiceFileType,
  invoiceUploadName,
  warnInvoiceFile,
  type PickedInvoiceFile,
} from "./invoices";
import { photoFileType } from "./photoFormat";

export type { PickedInvoiceFile };

const ACCEPT = [".pdf", ".xml", ...INVOICE_PICKER_TYPES].join(",");

function fromBrowser(file: globalThis.File): PickedInvoiceFile | null {
  const type = invoiceFileType(file.name, file.type);
  if (!type) {
    warnInvoiceFile("type");
    return null;
  }
  if (file.size <= 0 || file.size > INVOICE_MAX_BYTES) {
    warnInvoiceFile(file.size > 0 ? "size" : "read");
    return null;
  }
  return {
    uri: URL.createObjectURL(file),
    name: invoiceUploadName(hasInvoiceExtension(file.name) ? file.name : null, type.ext, new Date()),
    mimeType: type.mime,
    size: file.size,
    kind: type.kind,
    temp: true,
  };
}

/** Abre o seletor de arquivos do navegador. null: cancelou ou o arquivo não serve (o aviso já foi mostrado). */
export function pickInvoiceDocument(): Promise<PickedInvoiceFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ACCEPT;
    input.style.display = "none";
    let done = false;
    const finish = (picked: PickedInvoiceFile | null) => {
      if (done) return;
      done = true;
      window.removeEventListener("focus", onFocus);
      input.remove();
      resolve(picked);
    };
    // Navegador sem o evento "cancel": a janela volta ao foco sem "change".
    const onFocus = () => setTimeout(() => finish(null), 1500);
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      finish(file ? fromBrowser(file) : null);
    });
    input.addEventListener("cancel", () => finish(null));
    window.addEventListener("focus", onFocus);
    document.body.appendChild(input);
    input.click();
  });
}

/** Foto da galeria do navegador (data: ou blob:), com o nome "nota-AAAA-MM-DD". */
export async function invoiceFromPhoto(asset: ImagePickerAsset): Promise<PickedInvoiceFile | null> {
  const photo = photoFileType(asset.uri, asset.mimeType);
  const type = invoiceFileType(`foto.${photo.ext}`, photo.mime);
  if (!type || type.kind !== "image") {
    warnInvoiceFile("type");
    return null;
  }
  const size = asset.fileSize ?? null;
  if (size !== null && size > INVOICE_MAX_BYTES) {
    warnInvoiceFile("size");
    return null;
  }
  return { uri: asset.uri, name: invoiceUploadName(null, type.ext, new Date()), mimeType: type.mime, size, kind: type.kind, temp: false };
}

/** Libera o blob do arquivo escolhido. */
export function discardPicked(file: PickedInvoiceFile | null | undefined): void {
  if (file?.temp && file.uri.startsWith("blob:")) URL.revokeObjectURL(file.uri);
}

export function sweepInvoiceFiles(): void {
  // na web não há cópia em disco: o blob sai com discardPicked
}
