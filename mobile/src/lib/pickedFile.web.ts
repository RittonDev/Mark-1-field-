// Pré-visualização no navegador: <input type="file"> no lugar do seletor do sistema. O arquivo vira um blob: (o envio
// da web, fileUpload.web.ts, lê com fetch) e discardFile libera o blob. Não há cópia em disco: sweepFiles não faz nada.
// Mesmas funções e tipos de pickedFile.ts.

import type { ImagePickerAsset } from "expo-image-picker";
import type { PickedFile, PickPolicy } from "./pickedFile";
import { photoFileType } from "./photoFormat";

export type { PickedFile, PickedFileType, PickPolicy, PickProblem } from "./pickedFile";

function fromBrowser<K extends string>(file: globalThis.File, policy: PickPolicy<K>): PickedFile<K> | null {
  const type = policy.typeOf(file.name, file.type);
  if (!type) {
    policy.warn("type");
    return null;
  }
  if (file.size <= 0 || file.size > policy.maxBytes) {
    policy.warn(file.size > 0 ? "size" : "read");
    return null;
  }
  return {
    uri: URL.createObjectURL(file),
    name: policy.uploadName(policy.typeOf(file.name, null) ? file.name : null, type.ext, new Date()),
    mimeType: type.mime,
    size: file.size,
    kind: type.kind,
    temp: true,
  };
}

/** Abre o seletor de arquivos do navegador. null: cancelou ou o arquivo não serve (policy.warn já avisou). */
export function pickFile<K extends string>(policy: PickPolicy<K>): Promise<PickedFile<K> | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = policy.webAccept;
    input.style.display = "none";
    let done = false;
    const finish = (picked: PickedFile<K> | null) => {
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
      finish(file ? fromBrowser(file, policy) : null);
    });
    input.addEventListener("cancel", () => finish(null));
    window.addEventListener("focus", onFocus);
    document.body.appendChild(input);
    input.click();
  });
}

/** Foto da galeria do navegador (data: ou blob:), com o nome-base da política e o dia. */
export async function fileFromPhoto<K extends string>(asset: ImagePickerAsset, policy: PickPolicy<K>): Promise<PickedFile<K> | null> {
  const photo = photoFileType(asset.uri, asset.mimeType);
  const type = policy.typeOf(`foto.${photo.ext}`, photo.mime);
  if (!type || !type.mime.startsWith("image/")) {
    policy.warn("type");
    return null;
  }
  const size = asset.fileSize ?? null;
  if (size !== null && size > policy.maxBytes) {
    policy.warn("size");
    return null;
  }
  return { uri: asset.uri, name: policy.uploadName(null, type.ext, new Date()), mimeType: type.mime, size, kind: type.kind, temp: false };
}

/** Libera o blob do arquivo escolhido. */
export function discardFile(file: PickedFile | null | undefined, _policy: Pick<PickPolicy<string>, "folder">): void {
  if (file?.temp && file.uri.startsWith("blob:")) URL.revokeObjectURL(file.uri);
}

export function sweepFiles(_policy: Pick<PickPolicy<string>, "folder">): void {
  // na web não há cópia em disco: o blob sai com discardFile
}
