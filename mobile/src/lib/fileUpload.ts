// Upload multipart de um arquivo local. Android/iOS: upload nativo do expo-file-system,
// que lê do disco sem carregar a imagem inteira na memória do JS. Web: fileUpload.web.ts.

import { File, UploadType } from "expo-file-system";

export interface SendFileOptions {
  fileUri: string;
  filename: string;
  mimeType: string;
  fields: Record<string, string>;
  headers: Record<string, string>;
  signal: AbortSignal;
}

export async function sendFile(url: string, options: SendFileOptions): Promise<{ status: number; body: string }> {
  const result = await new File(options.fileUri).upload(url, {
    httpMethod: "POST",
    uploadType: UploadType.MULTIPART,
    fieldName: "file",
    mimeType: options.mimeType,
    parameters: options.fields,
    headers: options.headers,
    signal: options.signal,
  });
  return { status: result.status, body: result.body };
}
