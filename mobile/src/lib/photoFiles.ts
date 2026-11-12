// Fotos aguardando upload: copiadas para a pasta do app (o cache do picker pode ser limpo).
// Na pré-visualização web, photoFiles.web.ts guarda a imagem como data URL.

import { Directory, File, Paths } from "expo-file-system";

const photosDir = () => new Directory(Paths.document, "pending-photos");

/** Copia a foto do picker para a pasta do app e devolve o novo URI. */
export async function persistPhoto(sourceUri: string, filename: string): Promise<string> {
  const dir = photosDir();
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const target = new File(dir, filename);
  await new File(sourceUri).copy(target);
  return target.uri;
}

export function photoExists(uri: string): boolean {
  try {
    return new File(uri).exists;
  } catch {
    return false;
  }
}

export function deletePhotoFile(uri: string) {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // arquivo já removido
  }
}

export function deleteAllPhotoFiles() {
  try {
    const dir = photosDir();
    if (dir.exists) dir.delete();
  } catch {
    // pasta já removida
  }
}
