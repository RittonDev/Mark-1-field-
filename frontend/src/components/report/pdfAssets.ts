// Imagens dos PDFs (relatório e orçamento), gerados no navegador. O react-pdf baixaria cada foto no
// tamanho cheio (2 a 4 MB, até 86 por OS) e não abre WebP nem HEIC: aqui cada imagem é reduzida e
// convertida em JPEG (ou PNG, quando a transparência importa) antes de entrar no documento.

/** Lado maior da foto no PDF: sobra nitidez para a impressão sem pesar no celular. */
const MAX_SIDE = 1200;

/**
 * Baixa a imagem e devolve um data URL reduzido. `null` quando não dá: link expirado, servidor que não
 * libera a leitura (CORS) ou formato que o navegador não abre. O PDF mostra um aviso no lugar.
 */
export async function imageDataUrl(
  url: string,
  { maxSide = MAX_SIDE, type = "image/jpeg", quality = 0.8 }: { maxSide?: number; type?: "image/jpeg" | "image/png"; quality?: number } = {},
): Promise<string | null> {
  try {
    const res = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!res.ok) return null;
    const bitmap = await createImageBitmap(await res.blob());
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return null;
    }
    if (type === "image/jpeg") {
      // JPEG não tem transparência: fundo branco (assinatura em PNG transparente fica legível).
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    return canvas.toDataURL(type, quality);
  } catch {
    return null;
  }
}

/** Prepara várias imagens, 4 por vez, avisando o progresso ("Preparando fotos 12/40"). */
export async function prepareImages(
  urls: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, string | null>> {
  const unique = Array.from(new Set(urls));
  const out = new Map<string, string | null>();
  let next = 0;
  let done = 0;
  onProgress?.(0, unique.length);
  const worker = async () => {
    while (next < unique.length) {
      const url = unique[next++];
      out.set(url, await imageDataUrl(url));
      done += 1;
      onProgress?.(done, unique.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, unique.length) }, worker));
  return out;
}

/** A marca do Maxx Field (PNG com transparência) para o cabeçalho dos PDFs. */
export function brandMark(): Promise<string | null> {
  return imageDataUrl(`${window.location.origin}/brand/maxxfield-mark.png`, { maxSide: 240, type: "image/png" });
}

/** Salva o arquivo gerado (no celular abre o compartilhar/baixar do sistema). */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
