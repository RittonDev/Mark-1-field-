// Pré-visualização no navegador: não há sistema de arquivos do app. A foto fica no próprio
// registro do banco local como data URL (sobrevive a recarregar a página, ao contrário de blob:).

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Falha ao ler a imagem"));
    reader.readAsDataURL(blob);
  });
}

export async function persistPhoto(sourceUri: string, _filename: string): Promise<string> {
  if (sourceUri.startsWith("data:")) return sourceUri;
  const response = await fetch(sourceUri);
  return blobToDataUrl(await response.blob());
}

export function photoExists(uri: string): boolean {
  return uri.length > 0;
}

export function deletePhotoFile(_uri: string) {
  // nada a apagar: a imagem some junto com o registro
}

export function deleteAllPhotoFiles() {
  // idem
}
