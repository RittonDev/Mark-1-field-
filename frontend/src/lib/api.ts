import { sessionStore } from "./session";
import type { TokenResponse } from "./types";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000/api/v1").replace(/\/$/, "");
export const WS_URL = (process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000/api/v1/ws").replace(/\/$/, "");

/** Origem da API (sem o prefixo /api/v1), para montar URLs relativas como download_url. */
export const API_ORIGIN = (() => {
  try {
    return new URL(API_URL).origin;
  } catch {
    return "";
  }
})();

export class ApiError extends Error {
  status: number;
  detail: unknown;
  // Corpo completo da resposta (ex.: code e conflicts no 409 de conflito de agenda).
  body: unknown;

  constructor(status: number, detail: unknown, body: unknown = null) {
    super(formatDetail(detail, status));
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.body = body;
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
  if (status === 0) return "Não foi possível conectar à API";
  if (status === 401) return "Sessão expirada. Entre novamente.";
  if (status === 403) return "Você não tem permissão para esta ação";
  if (status === 404) return "Registro não encontrado";
  if (status === 409) return "Esta OS foi alterada por outra pessoa. Recarregamos os dados.";
  return `Erro inesperado (${status})`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Erro inesperado";
}

type QueryValue = string | number | boolean | null | undefined | (string | number)[];
export type Query = Record<string, QueryValue>;

export function buildQuery(query?: Query): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    if (Array.isArray(value)) value.forEach((v) => params.append(key, String(v)));
    else params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  form?: FormData;
  query?: Query;
  auth?: boolean;
}

let refreshing: Promise<boolean> | null = null;

/** Troca o refresh token por um novo par. Chamadas concorrentes compartilham a mesma tentativa. */
export function refreshSession(): Promise<boolean> {
  if (refreshing) return refreshing;
  const session = sessionStore.get();
  if (!session?.refreshToken) return Promise.resolve(false);
  refreshing = (async () => {
    try {
      const res = await fetch(`${API_URL}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: session.refreshToken }),
      });
      if (!res.ok) return false;
      sessionStore.fromTokenResponse((await res.json()) as TokenResponse);
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  let body: BodyInit | undefined;
  if (options.form) {
    body = options.form;
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  if (options.auth !== false) {
    const token = sessionStore.get()?.accessToken;
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return fetch(`${API_URL}${path}${buildQuery(options.query)}`, {
    method: options.method ?? "GET",
    headers,
    body,
  });
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await send(path, options);
    if (res.status === 401 && options.auth !== false) {
      if (await refreshSession()) {
        res = await send(path, options);
      }
      if (res.status === 401) {
        sessionStore.set(null);
      }
    }
  } catch {
    throw new ApiError(0, null);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const detail = data && typeof data === "object" && "detail" in data ? (data as { detail: unknown }).detail : data;
    throw new ApiError(res.status, detail, data);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>(path, { query }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  upload: <T>(path: string, form: FormData) => request<T>(path, { method: "POST", form }),
};

export function absoluteApiUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (/^https?:\/\//.test(url)) return url;
  if (url.startsWith("/api/")) return `${API_ORIGIN}${url}`;
  return `${API_URL}${url.startsWith("/") ? "" : "/"}${url}`;
}
