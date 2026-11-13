// Pré-visualização no navegador: multipart com fetch + FormData (a foto está como data URL).
// O fetch não informa o progresso do envio: `onProgress` existe só para manter o mesmo contrato.

export interface SendFileOptions {
  fileUri: string;
  filename: string;
  mimeType: string;
  fields: Record<string, string>;
  headers: Record<string, string>;
  signal: AbortSignal;
  onProgress?: (sent: number, total: number) => void;
}

export async function sendFile(url: string, options: SendFileOptions): Promise<{ status: number; body: string }> {
  const blob = await (await fetch(options.fileUri)).blob();
  const form = new FormData();
  form.append("file", new Blob([blob], { type: options.mimeType }), options.filename);
  for (const [key, value] of Object.entries(options.fields)) form.append(key, value);
  const response = await fetch(url, { method: "POST", headers: options.headers, body: form, signal: options.signal });
  return { status: response.status, body: await response.text() };
}
