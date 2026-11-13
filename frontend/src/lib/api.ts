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

/** Item do 422 de validação da API (Pydantic): onde (`loc`), o tipo do erro e os limites (`ctx`). */
interface ValidationIssue {
  loc?: (string | number)[];
  msg?: string;
  type?: string;
  ctx?: Record<string, unknown>;
}

/** Nome dos campos mais comuns nos erros de validação; os demais aparecem só com a mensagem. */
const FIELD_LABELS: Record<string, string> = {
  title: "Título",
  description: "Descrição",
  email: "E-mail",
  password: "Senha",
  current_password: "Senha atual",
  new_password: "Nova senha",
  name: "Nome",
  phone: "Telefone",
  amount: "Valor",
  quantity: "Quantidade",
  unit_value: "Valor unitário",
  reason: "Motivo",
  scheduled_start: "Início",
  scheduled_end: "Fim",
  customer_id: "Cliente",
  location_id: "Local",
};

/** Limite do erro (ex.: 3 caracteres, 0), com vírgula decimal. */
function limit(ctx: Record<string, unknown> | undefined, key: string): string {
  const value = ctx?.[key];
  return typeof value === "number" || typeof value === "string" ? String(value).replace(".", ",") : "";
}

/** Mensagem do Pydantic (em inglês) traduzida pelo tipo do erro. */
function validationText(issue: ValidationIssue): string {
  const msg = issue.msg ?? "";
  switch (issue.type) {
    case "missing":
      return "obrigatório";
    case "string_too_short":
      return limit(issue.ctx, "min_length") === "1" ? "obrigatório" : `mínimo de ${limit(issue.ctx, "min_length")} caracteres`;
    case "string_too_long":
      return `máximo de ${limit(issue.ctx, "max_length")} caracteres`;
    case "too_short":
      return `escolha pelo menos ${limit(issue.ctx, "min_length")}`;
    case "too_long":
      return `no máximo ${limit(issue.ctx, "max_length")} itens`;
    case "greater_than":
      return `precisa ser maior que ${limit(issue.ctx, "gt")}`;
    case "greater_than_equal":
      return `precisa ser pelo menos ${limit(issue.ctx, "ge")}`;
    case "less_than":
      return `precisa ser menor que ${limit(issue.ctx, "lt")}`;
    case "less_than_equal":
      return `pode ser no máximo ${limit(issue.ctx, "le")}`;
    case "int_parsing":
    case "int_type":
    case "int_from_float":
    case "float_parsing":
    case "float_type":
    case "decimal_parsing":
    case "decimal_type":
      return "precisa ser um número";
    case "date_parsing":
    case "date_type":
    case "date_from_datetime_parsing":
    case "datetime_parsing":
    case "datetime_type":
    case "datetime_from_date_parsing":
      return "data inválida";
    case "string_pattern_mismatch":
      return "formato inválido";
    case "enum":
    case "literal_error":
      return "opção inválida";
    case "value_error":
      // Validação da própria API (já em português), exceto a do e-mail, que vem da biblioteca.
      if (/^value is not a valid email address/i.test(msg)) return "e-mail inválido";
      return msg.replace(/^Value error, /, "") || "inválido";
    case "assertion_error":
      return msg.replace(/^Assertion failed, /, "") || "inválido";
    default:
      return "inválido";
  }
}

function validationMessage(issues: ValidationIssue[]): string {
  const parts = issues.map((issue) => {
    const text = validationText(issue);
    const key = [...(issue.loc ?? [])].reverse().find((p): p is string => typeof p === "string");
    const label = key ? FIELD_LABELS[key] : undefined;
    if (label) return `${label}: ${text}`;
    if (text === "obrigatório") return "Falta preencher um campo obrigatório";
    return text.charAt(0).toUpperCase() + text.slice(1);
  });
  return Array.from(new Set(parts)).join(" · ");
}

function formatDetail(detail: unknown, status: number): string {
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail) && detail.length) return validationMessage(detail as ValidationIssue[]);
  if (status === 0) return "Sem conexão com o servidor. Confira a internet e tente de novo.";
  if (status === 401) return "Sessão expirada. Entre novamente.";
  if (status === 403) return "Você não tem permissão para esta ação";
  if (status === 404) return "Registro não encontrado";
  if (status === 408 || status === 504) return "O servidor demorou para responder. Tente de novo.";
  if (status === 409) return "Esta OS foi alterada por outra pessoa. Recarregamos os dados.";
  if (status === 413) return "Arquivo maior que o permitido.";
  if (status === 429) return "Muitas tentativas. Aguarde um pouco e tente de novo.";
  if (status === 502 || status === 503) return "O servidor está indisponível no momento. Tente de novo em instantes.";
  if (status >= 500) return "Erro no servidor. Tente de novo; se continuar, avise o suporte.";
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

/** Opções de uma chamada: cancelamento (ex.: o `signal` do React Query) e tempo limite. */
export interface CallOptions {
  /** Cancela a requisição: a busca ficou obsoleta ou a tela fechou. */
  signal?: AbortSignal;
  /** Tempo limite em ms (padrão 30 s; 120 s para envio de arquivo). */
  timeoutMs?: number;
}

interface RequestOptions extends CallOptions {
  method?: string;
  body?: unknown;
  form?: FormData;
  query?: Query;
  auth?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const REFRESH_TIMEOUT_MS = 15_000;

/** Respostas do /auth/refresh que encerram a sessão de verdade (as demais são falha passageira). */
const REFRESH_DENIED = new Set([400, 401, 403, 422]);

function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  window.setTimeout(() => controller.abort(new DOMException("Tempo esgotado", "TimeoutError")), ms);
  return controller.signal;
}

/** Sinal que dispara com o de quem chamou ou com o tempo limite, o que vier primeiro. */
function requestSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = timeoutSignal(ms);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
  const controller = new AbortController();
  for (const source of [signal, timeout]) {
    if (source.aborted) controller.abort(source.reason);
    else source.addEventListener("abort", () => controller.abort(source.reason), { once: true });
  }
  return controller.signal;
}

/** Falha sem resposta da API: cancelamento de quem pediu (repassado), tempo esgotado ou sem rede. */
function transportError(error: unknown, signal: AbortSignal | undefined): unknown {
  if (signal?.aborted) return error;
  if (error instanceof DOMException && error.name === "TimeoutError") return new ApiError(408, null);
  return new ApiError(0, null);
}

/**
 * Resultado da renovação: "ok" (tokens novos), "denied" (a sessão acabou de verdade: refresh vencido,
 * revogado ou usuário desativado) ou "unavailable" (sem rede, tempo esgotado ou API fora do ar, como
 * num deploy): nesse caso a sessão continua e a tela tenta de novo depois.
 */
export type RefreshResult = "ok" | "denied" | "unavailable";

let refreshing: Promise<RefreshResult> | null = null;

/** Troca o refresh token por um novo par. Chamadas concorrentes compartilham a mesma tentativa. */
export function refreshSessionResult(): Promise<RefreshResult> {
  if (refreshing) return refreshing;
  const session = sessionStore.get();
  if (!session?.refreshToken) return Promise.resolve("denied");
  refreshing = (async (): Promise<RefreshResult> => {
    try {
      const res = await fetch(`${API_URL}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ refresh_token: session.refreshToken }),
        signal: timeoutSignal(REFRESH_TIMEOUT_MS),
      });
      if (!res.ok) return REFRESH_DENIED.has(res.status) ? "denied" : "unavailable";
      const data = (await res.json()) as TokenResponse;
      // Saiu (ou entrou outra pessoa) enquanto renovava: não ressuscita a sessão antiga.
      const now = sessionStore.get();
      if (now?.refreshToken !== session.refreshToken) return now ? "ok" : "denied";
      sessionStore.fromTokenResponse(data);
      return "ok";
    } catch {
      return "unavailable";
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Compatível com o uso antigo: true só quando renovou. */
export async function refreshSession(): Promise<boolean> {
  return (await refreshSessionResult()) === "ok";
}

/** Envia a requisição; devolve também o token usado (para saber se outra já o renovou). */
async function send(path: string, options: RequestOptions): Promise<{ res: Response; token: string | undefined }> {
  const headers: Record<string, string> = { Accept: "application/json" };
  let body: BodyInit | undefined;
  if (options.form) {
    body = options.form;
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const token = options.auth !== false ? sessionStore.get()?.accessToken : undefined;
  if (token) headers.Authorization = `Bearer ${token}`;
  const ms = options.timeoutMs ?? (options.form ? UPLOAD_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  const res = await fetch(`${API_URL}${path}${buildQuery(options.query)}`, {
    method: options.method ?? "GET",
    headers,
    body,
    signal: requestSignal(options.signal, ms),
  });
  return { res, token };
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let res: Response;
  try {
    let sent = await send(path, options);
    res = sent.res;
    // 401 com token: o acesso venceu. Sem token (ex.: senha errada no login) a resposta vale como veio.
    if (res.status === 401 && sent.token) {
      const current = sessionStore.get()?.accessToken;
      // A sessão terminou enquanto esta ia e voltava (Sair, outra aba): nada a renovar nem a encerrar.
      if (!current) throw new ApiError(401, null);
      // Outra requisição pode ter renovado nesse meio-tempo: aí basta reenviar.
      if (current === sent.token) {
        const result = await refreshSessionResult();
        if (result === "unavailable") {
          // Falha passageira (rede, deploy): a sessão e o que está aberto na tela continuam.
          throw new ApiError(503, "Sem conexão com o servidor. Tente de novo em instantes.");
        }
        if (result === "denied") {
          // Só marca "venceu" se ninguém encerrou antes (quem clicou em Sair não vê "sessão expirada").
          if (sessionStore.get()) sessionStore.set(null, "expired");
          throw new ApiError(401, null);
        }
      }
      sent = await send(path, options);
      res = sent.res;
      // Recusado até com o token novo: a sessão acabou mesmo.
      if (res.status === 401 && sent.token && sessionStore.get()?.accessToken === sent.token) {
        sessionStore.set(null, "expired");
      }
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw transportError(error, options.signal);
  }
  if (res.status === 204) return undefined as T;
  let text: string;
  try {
    text = await res.text();
  } catch (error) {
    throw transportError(error, options.signal);
  }
  let data: unknown = null;
  let json = false;
  if (text) {
    try {
      data = JSON.parse(text);
      json = true;
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    // Só o corpo JSON da API vira mensagem: a página HTML de erro do proxy (502, 504, 413) não.
    const detail = !json
      ? null
      : data && typeof data === "object" && "detail" in data
        ? (data as { detail: unknown }).detail
        : typeof data === "string"
          ? data
          : null;
    throw new ApiError(res.status, detail, json ? data : null);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Query, opts?: CallOptions) => request<T>(path, { query, ...opts }),
  post: <T>(path: string, body?: unknown, opts?: CallOptions) => request<T>(path, { method: "POST", body, ...opts }),
  put: <T>(path: string, body?: unknown, opts?: CallOptions) => request<T>(path, { method: "PUT", body, ...opts }),
  patch: <T>(path: string, body?: unknown, opts?: CallOptions) => request<T>(path, { method: "PATCH", body, ...opts }),
  delete: <T>(path: string, opts?: CallOptions) => request<T>(path, { method: "DELETE", ...opts }),
  upload: <T>(path: string, form: FormData, opts?: CallOptions) => request<T>(path, { method: "POST", form, ...opts }),
};

export function absoluteApiUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (/^https?:\/\//.test(url)) return url;
  if (url.startsWith("/api/")) return `${API_ORIGIN}${url}`;
  return `${API_URL}${url.startsWith("/") ? "" : "/"}${url}`;
}
