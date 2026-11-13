// Cliente HTTP da API. Mesmo contrato de erros de frontend/src/lib/api.ts,
// com timeout (rede móvel instável), refresh automático do access token e o relógio do servidor.

import { Platform } from "react-native";
import { MOBILE_DENIED_MESSAGE } from "./access";
import { apiOrigin, APP_VERSION } from "./config";
import { sendFile } from "./fileUpload";
import { session } from "./session";
import type { TokenResponse } from "./types";

const TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 120_000;

/** Versão e sistema do app em toda requisição: o servidor sabe quem ainda roda uma versão antiga. */
const APP_HEADERS: Record<string, string> = { "X-App-Version": APP_VERSION, "X-App-Platform": Platform.OS };

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
  // Texto da API. A página HTML de um proxy (502, 413…) não vira mensagem para o técnico.
  if (typeof detail === "string" && detail && !/^\s*</.test(detail)) return detail;
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
  if (status === 413) return "O envio é grande demais para o servidor.";
  if (status === 426) return "Atualize o app para continuar.";
  if (status === 429) return "Muitas tentativas seguidas. Aguarde um pouco e tente de novo.";
  if (status >= 500) return `O servidor está com problema (erro ${status}). Tente de novo em instantes.`;
  return `Erro inesperado (${status})`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Erro inesperado";
}

// ───────────────────────────── relógio do servidor ─────────────────────────────

const clockSamples: number[] = [];
let serverOffsetMs = 0;

/** Cabeçalho Date de cada resposta: mediana das 5 últimas diferenças para o relógio do aparelho. */
function sampleServerClock(res: Response) {
  const header = res.headers.get("date");
  const at = header ? Date.parse(header) : Number.NaN;
  if (!Number.isFinite(at)) return;
  clockSamples.push(at - Date.now());
  if (clockSamples.length > 5) clockSamples.shift();
  const sorted = [...clockSamples].sort((a, b) => a - b);
  serverOffsetMs = sorted[Math.floor(sorted.length / 2)];
}

/** Quanto o relógio do servidor está à frente (positivo) ou atrás (negativo) do relógio do aparelho. */
export const getServerOffsetMs = () => serverOffsetMs;

/** Agora pelo relógio do servidor: o do celular pode ter sido acertado à mão. */
export const serverNow = () => Date.now() + serverOffsetMs;

// ───────────────────────────── requisições ─────────────────────────────

interface RawResponse {
  status: number;
  ok: boolean;
  data: unknown;
}

/** fetch com tempo limite que cobre também o download do corpo (pull grande em rede lenta). */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = TIMEOUT_MS): Promise<RawResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    sampleServerClock(res);
    const data = res.status === 204 ? null : await parseBody(res);
    return { status: res.status, ok: res.ok, data };
  } catch (error) {
    if (timedOut) throw new ApiError(0, "O servidor demorou para responder.");
    throw error;
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
/** Renovação em andamento, pelo refresh token usado: chamadas concorrentes da mesma sessão compartilham. */
let refreshing: { token: string; promise: Promise<RefreshResult> } | null = null;

/**
 * Chamado quando o servidor diz que este usuário não pode mais usar o app
 * (ex.: técnico promovido a analista). auth.ts registra o handler que apaga os dados locais.
 */
let accessRevokedHandler: ((message: string) => Promise<void>) | null = null;
export function setAccessRevokedHandler(handler: (message: string) => Promise<void>) {
  accessRevokedHandler = handler;
}

const GENERIC_EXPIRED = /^sess[aã]o expirada/i;

/**
 * Troca o refresh token por um novo par. Chamadas concorrentes da mesma sessão compartilham a
 * mesma tentativa. Só um 401 encerra a sessão; e nada é gravado se, durante a renovação, o técnico
 * saiu ou outro entrou no aparelho (o "Sair" não pode ser desfeito por uma resposta atrasada).
 */
export function refreshSession(): Promise<RefreshResult> {
  const { refreshToken, apiUrl } = session.get();
  if (!refreshToken) return Promise.resolve("invalid");
  if (refreshing?.token === refreshToken) return refreshing.promise;
  const used = refreshToken;
  const sameSession = () => session.get().status === "signedIn" && session.get().refreshToken === used;
  const promise = (async (): Promise<RefreshResult> => {
    try {
      const res = await fetchWithTimeout(`${apiUrl}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...APP_HEADERS },
        body: JSON.stringify({ refresh_token: used }),
      });
      // 401 = token inválido, expirado, revogado ou papel sem acesso ao app. Outro erro (proxy,
      // firewall, servidor fora do ar) não tira o técnico do app no meio do dia: tenta depois.
      if (res.status === 401) {
        if (!sameSession()) return "invalid";
        const detail = detailOf(res.data);
        const message = typeof detail === "string" && detail && !GENERIC_EXPIRED.test(detail) ? detail : null;
        if (message === MOBILE_DENIED_MESSAGE && accessRevokedHandler) await accessRevokedHandler(message);
        else await session.signOut(true, message);
        return "invalid";
      }
      const tokens = res.data as TokenResponse | null;
      if (!res.ok || !tokens?.access_token || !tokens.refresh_token) return "offline";
      if (!sameSession()) return "invalid";
      await session.setTokens(tokens);
      return "ok";
    } catch {
      return "offline";
    } finally {
      if (refreshing?.promise === promise) refreshing = null;
    }
  })();
  refreshing = { token: used, promise };
  return promise;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
  timeoutMs?: number;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  // Quem fez o pedido: depois de renovar o token, só repete se ainda for a mesma pessoa logada.
  const userId = session.get().user?.id ?? null;
  const send = () => {
    const headers: Record<string, string> = { Accept: "application/json", ...APP_HEADERS };
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

  let res: RawResponse;
  try {
    res = await send();
    if (res.status === 401 && options.auth !== false) {
      const refreshed = await refreshSession();
      if (refreshed === "offline") throw new ApiError(0, null);
      // "invalid": refreshSession já encerrou a sessão (com o motivo do servidor) ou ela mudou.
      if (refreshed === "ok" && session.get().user?.id === userId) {
        const token = session.get().accessToken;
        res = await send();
        if (res.status === 401 && session.get().accessToken === token) await session.signOut(true);
      }
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(0, null);
  }
  if (res.status === 204) return undefined as T;
  if (!res.ok) throw new ApiError(res.status, detailOf(res.data));
  return res.data as T;
}

export interface CallOptions {
  /** Tempo limite próprio (ex.: envio e download do sync, maiores que uma consulta comum). */
  timeoutMs?: number;
}

export const api = {
  get: <T>(path: string, options: CallOptions = {}) => request<T>(path, options),
  post: <T>(path: string, body?: unknown, options: CallOptions = {}) => request<T>(path, { ...options, method: "POST", body }),
  delete: <T>(path: string, options: CallOptions = {}) => request<T>(path, { ...options, method: "DELETE" }),
};

/**
 * Envia um arquivo local como multipart (`file` + campos extras). No aparelho usa o upload
 * nativo do expo-file-system (fileUpload.ts); na pré-visualização web, fetch + FormData.
 */
export async function uploadFile<T>(
  path: string,
  fileUri: string,
  fields: Record<string, string>,
  mimeType: string,
  filename: string,
): Promise<T> {
  const userId = session.get().user?.id ?? null;
  let timedOut = false;
  const send = async () => {
    const { accessToken, apiUrl } = session.get();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, UPLOAD_TIMEOUT_MS);
    try {
      return await sendFile(`${apiUrl}${path}`, {
        fileUri,
        filename,
        mimeType,
        fields,
        headers: {
          Accept: "application/json",
          ...APP_HEADERS,
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
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
      if (refreshed === "ok" && session.get().user?.id === userId) result = await send();
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(0, timedOut ? "O envio demorou demais e foi interrompido. Vamos tentar de novo." : null);
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
