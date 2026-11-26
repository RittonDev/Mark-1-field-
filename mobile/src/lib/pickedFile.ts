// Arquivo escolhido no aparelho para subir (documentos e currículo, Configurações): o mecanismo de lib/invoiceFile.ts,
// com a política como parâmetro (lib/documentFile.ts monta a dos documentos). O documento vem do seletor do sistema
// (File.pickFileAsync do expo-file-system) e a foto, da câmera ou da galeria (photoCapture). O escolhido é copiado para
// uma pasta só dele no cache do app (cache/<pasta>/<uuid>/<nome>): o content:// do Android vira um arquivo que o envio
// nativo lê, o tamanho é conferido na cópia e ele sobe com um nome que a central entende. O original nunca é apagado
// (no Android, apagar o content:// apagaria o arquivo do técnico); a cópia sai com discardFile, e as que sobraram de uma
// tela que o sistema fechou saem com sweepFiles. Na pré-visualização web: pickedFile.web.ts.

import { randomUUID } from "expo-crypto";
import { Directory, File, Paths, type PickSingleFileResult } from "expo-file-system";
import type { ImagePickerAsset } from "expo-image-picker";
import { photoFileType } from "./photoFormat";

/** O arquivo não serve: o tipo, o tamanho ou a leitura. */
export type PickProblem = "type" | "size" | "read";

/** O tipo reconhecido de um arquivo: o grupo dele (`kind`), o tipo que sobe e a extensão do nome que sobe. */
export interface PickedFileType<K extends string> {
  kind: K;
  mime: string;
  ext: string;
}

/** O que muda de um uso para outro: a pasta, os tipos, o tamanho, o nome que sobe e o aviso do arquivo que não serve. */
export interface PickPolicy<K extends string> {
  /** A pasta no cache do app: cada arquivo fica em cache/<folder>/<uuid>/<nome>. */
  folder: string;
  /** Os tipos que o seletor do sistema mostra (o servidor confere de novo pelo conteúdo). */
  pickerTypes: readonly string[];
  /** O `accept` do seletor da pré-visualização web: as extensões e os tipos. */
  webAccept: string;
  maxBytes: number;
  /** Pela extensão do nome ou, sem ela, pelo tipo que o sistema informa; null: não serve. */
  typeOf: (name: string, mime: string | null | undefined) => PickedFileType<K> | null;
  /** O nome que sobe: `original` é o nome do aparelho (null quando ele não tem uma extensão conhecida). */
  uploadName: (original: string | null, ext: string, today: Date) => string;
  /** O arquivo não serve: quem pediu avisa (no campo, num toast). */
  warn: (problem: PickProblem) => void;
}

/** O arquivo já conferido e pronto para enviar. */
export interface PickedFile<K extends string = string> {
  uri: string;
  /** O nome com que sobe (e que a tela mostra). */
  name: string;
  mimeType: string;
  /** Bytes; null quando o sistema não informa. */
  size: number | null;
  kind: K;
  /** Cópia feita pelo app (cache ou blob:): sai com discardFile. */
  temp: boolean;
}

const root = (folder: string) => new Directory(Paths.cache, folder);
const FOLDER_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Pastas de arquivos ainda escolhidos numa tela (ou subindo), "<pasta>/<uuid>": a limpeza não mexe nelas. */
const inUse = new Set<string>();

/** Só apaga dentro da pasta da política no cache, e só pasta com nome de uuid. */
function drop(folder: string, id: string) {
  inUse.delete(`${folder}/${id}`);
  if (!FOLDER_ID.test(id)) return;
  try {
    const dir = new Directory(root(folder), id);
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
async function keep<K extends string>(
  source: File,
  type: PickedFileType<K>,
  name: string,
  knownSize: number,
  policy: PickPolicy<K>,
): Promise<PickedFile<K> | null> {
  if (knownSize > policy.maxBytes) {
    policy.warn("size");
    return null;
  }
  const id = randomUUID();
  inUse.add(`${policy.folder}/${id}`);
  try {
    const dir = new Directory(root(policy.folder), id);
    dir.create({ intermediates: true, idempotent: true });
    const target = new File(dir, name);
    await source.copy(target);
    const size = target.size;
    if (size > 0 && size <= policy.maxBytes) {
      return { uri: target.uri, name, mimeType: type.mime, size, kind: type.kind, temp: true };
    }
    drop(policy.folder, id);
    policy.warn(size > 0 ? "size" : "read");
    return null;
  } catch (error) {
    console.warn("Falha ao copiar o arquivo escolhido", error);
    drop(policy.folder, id);
    policy.warn("read");
    return null;
  }
}

/** Seletor de arquivos do sistema. null: cancelou ou o arquivo não serve (policy.warn já avisou). */
export async function pickFile<K extends string>(policy: PickPolicy<K>): Promise<PickedFile<K> | null> {
  let picked: PickSingleFileResult;
  try {
    picked = await File.pickFileAsync({ mimeTypes: [...policy.pickerTypes] });
  } catch (error) {
    console.warn("Falha ao abrir o seletor de arquivos", error);
    policy.warn("read");
    return null;
  }
  if (picked.canceled) return null;
  const { name, type: mime, size } = describe(picked.result);
  const type = policy.typeOf(name, mime);
  if (!type) {
    policy.warn("type");
    return null;
  }
  // O nome do aparelho só vale com uma extensão conhecida (no Android, o content:// às vezes só tem um código).
  const original = policy.typeOf(name, null) ? name : null;
  return keep(picked.result, type, policy.uploadName(original, type.ext, new Date()), size, policy);
}

/** Foto da câmera ou da galeria (JPG, PNG ou WebP), com o nome-base da política e o dia. */
export async function fileFromPhoto<K extends string>(asset: ImagePickerAsset, policy: PickPolicy<K>): Promise<PickedFile<K> | null> {
  const photo = photoFileType(asset.uri, asset.mimeType);
  const type = policy.typeOf(`foto.${photo.ext}`, photo.mime);
  if (!type || !type.mime.startsWith("image/")) {
    policy.warn("type");
    return null;
  }
  return keep(new File(asset.uri), type, policy.uploadName(null, type.ext, new Date()), asset.fileSize ?? 0, policy);
}

/** Apaga a cópia do app (a pasta dela no cache da política). */
export function discardFile(file: PickedFile | null | undefined, policy: Pick<PickPolicy<string>, "folder">): void {
  if (!file?.temp) return;
  try {
    drop(policy.folder, new File(file.uri).parentDirectory.name);
  } catch {
    // já saiu
  }
}

/** Cópias que ficaram de uma tela que não terminou (o sistema fechou o app): saem ao abrir a tela de novo. */
export function sweepFiles(policy: Pick<PickPolicy<string>, "folder">): void {
  try {
    const dir = root(policy.folder);
    if (!dir.exists) return;
    for (const entry of dir.list()) {
      if (entry instanceof Directory && FOLDER_ID.test(entry.name) && !inUse.has(`${policy.folder}/${entry.name}`)) entry.delete();
    }
  } catch {
    // o cache é do sistema: o que sobrar sai com ele
  }
}
