// Formato da foto pelo arquivo que o seletor gerou (a extensão do uri), não pelo tipo declarado: no
// Android a foto sai regravada em JPEG, mas o seletor devolve o tipo da original (ex.: "image/heic").
// Na pré-visualização web o uri é data: ou blob: (sem extensão): aí vale o tipo declarado.

/** Extensões que o seletor de fotos gera e o tipo de cada uma. */
const BY_EXTENSION = new Map<string, string>([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
  ["gif", "image/gif"],
  ["bmp", "image/bmp"],
  ["heic", "image/heic"],
  ["heif", "image/heif"],
  ["avif", "image/avif"],
  ["tif", "image/tiff"],
  ["tiff", "image/tiff"],
]);

/** O servidor não aceita como foto e o relatório do cliente não mostra (galeria do iPhone sem conversão). */
const UNSUPPORTED = new Set(["image/heic", "image/heif", "image/avif", "image/tiff"]);

const shortExtension = (ext: string) => (ext === "jpeg" ? "jpg" : ext === "tiff" ? "tif" : ext);

function extensionOf(uri: string): string | null {
  if (/^(data|blob):/i.test(uri)) return null;
  const ext = /\.([a-z0-9]+)$/i.exec(uri.split(/[?#]/, 1)[0])?.[1]?.toLowerCase();
  return ext && BY_EXTENSION.has(ext) ? ext : null;
}

/** Extensão ("jpg", "png"…) e tipo do arquivo da foto, para o nome do arquivo e o envio. */
export function photoFileType(uri: string, mimeType?: string | null): { ext: string; mime: string } {
  const ext = extensionOf(uri);
  if (ext) return { ext: shortExtension(ext), mime: BY_EXTENSION.get(ext)! };
  const mime = mimeType?.toLowerCase() || "image/jpeg";
  const sub = mime.split("/")[1] ?? "";
  return { ext: BY_EXTENSION.has(sub) ? shortExtension(sub) : "jpg", mime };
}

/** Foto que a central abre (JPG, PNG, WebP…); HEIC, HEIF, AVIF e TIFF não passam. */
export const isSupportedPhoto = (uri: string, mimeType?: string | null) => !UNSUPPORTED.has(photoFileType(uri, mimeType).mime);
