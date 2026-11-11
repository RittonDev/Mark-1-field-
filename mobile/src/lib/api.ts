// Cliente HTTP da API. Mesmo contrato de erros de frontend/src/lib/api.ts,
// com timeout (rede móvel instável) e refresh automático do access token.

import { File, UploadType } from "expo-file-system";
import { apiOrigin } from "./config";
import { session } from "./session";
import type { TokenResponse } from "./types";

const TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 120_000;

export class ApiError extends Error {
  status: number;
  detail: unknown;

  constructor(status: number, detail: unknown) {
    super(formatDetail(detail, status));
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }

  /** Sem rede, timeout ou servidor fora do ar: vale tentar de novo depois. */
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500 || this.status === 408 || this.status === 429;
  }
}

interface ValidationIssue {
  loc?: (string | number)[];
  msg?: string;
}

function formatDetail(detail: unknown, status: number): string {
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail)) {
    const parts = (detail as ValidationIssue[]).map((issue) => {
      const field = (issue.loc ?? []).filter((p) => p !== "body" && p !== "query").join(".");
      const msg = (issue.msg ?? "inválido").replace(/^Value error, /, "");
      return field ? `${field}: ${msg}` : msg;
    });
    if (parts.length) return parts.join(" · ");
  }
  if (status === 0) return "Sem conexão com o servidor";
  if (status === 401) return "Sessão expirada. Entre novamente.";
  if (status === 403) return "Você não tem permissão para esta ação";
  if (status === 404) return "Registro não encontrado";
  if (status === 409) return "Esta OS foi alterada por outra pessoa.";
  return `Erro inesperado (${status})`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Erro inesperado";
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function detailOf(data: unknown): unknown {
  return data && typeof data === "object" && "detail" in data ? (data as { detail: unknown }).detail : data;
}

export type RefreshResult = "ok" | "invalid" | "offline";
let refreshing: Promise<RefreshResult> | null = null;

/** Troca o refresh token por um novo par. Chamadas concorrentes compartilham a mesma tentativa. */
export function refreshSession(): Promise<RefreshResult> {
  if (refreshing) return refreshing;
  const { refreshToken, apiUrl } = session.get();
  if (!refreshToken) return Promise.resolve("invalid");
  refreshing = (async (): Promise<RefreshResult> => {
    try {
      const res = await fetchWithTimeout(`${apiUrl}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (res.status === 401 || res.status === 403 || res.status === 422) {
        await session.signOut(true);
        return "invalid";
      }
      if (!res.ok) return "offline";
      await session.setTokens((await res.json()) as TokenResponse);
      return "ok";
    } catch {
      return "offline";
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
  timeoutMs?: number;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const send = () => {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const { accessToken, apiUrl } = session.get();
    if (options.auth !== false && accessToken) headers.Authorization = `Bearer ${accessToken}`;
    return fetchWithTimeout(
      `${apiUrl}${path}`,
      {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      },
      options.timeoutMs,
    );
  };

  let res: Response;
  try {
    res = await send();
    if (res.status === 401 && options.auth !== false) {
      const refreshed = await refreshSession();
      if (refreshed === "offline") throw new ApiError(0, null);
      if (refreshed === "ok") res = await send();
      if (res.status === 401) await session.signOut(true);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(0, null);
  }
  if (res.status === 204) return undefined as T;
  const data = await parseBody(res);
  if (!res.ok) throw new ApiError(res.status, detailOf(data));
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

/**
 * Envia um arquivo local como multipart (`file` + campos extras) usando o upload nativo
 * do expo-file-system, que lê do disco sem carregar a imagem inteira na memória do JS.
 */
export async function uploadFile<T>(
  path: string,
  fileUri: string,
  fields: Record<string, string>,
  mimeType: string,
): Promise<T> {
  const file = new File(fileUri);
  const send = async () => {
    const { accessToken, apiUrl } = session.get();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
      return await file.upload(`${apiUrl}${path}`, {
        httpMethod: "POST",
        uploadType: UploadType.MULTIPART,
        fieldName: "file",
        mimeType,
        parameters: fields,
        headers: accessToken ? { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } : {},
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let result;
  try {
    result = await send();
    if (result.status === 401) {
      const refreshed = await refreshSession();
      if (refreshed === "offline") throw new ApiError(0, null);
      if (refreshed === "ok") result = await send();
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(0, null);
  }
  let data: unknown = null;
  try {
    data = result.body ? JSON.parse(result.body) : null;
  } catch {
    data = result.body;
  }
  if (result.status < 200 || result.status >= 300) throw new ApiError(result.status, detailOf(data));
  return data as T;
}

/** URLs como `/api/v1/attachments/{id}/download?token=` viram absolutas. */
export function absoluteApiUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (/^https?:\/\//.test(url)) return url;
  const { apiUrl } = session.get();
  if (url.startsWith("/api/")) return `${apiOrigin(apiUrl)}${url}`;
  return `${apiUrl}${url.startsWith("/") ? "" : "/"}${url}`;
}
