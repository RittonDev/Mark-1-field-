// Planilha da lista de chamados (CSV montado pela API, com as colunas da lista do Field Control):
// a do filtro de agora ou só a das OS escolhidas.

import { saveBlob } from "@/components/report/pdfAssets";
import { api, API_URL, ApiError, buildQuery, type Query } from "@/lib/api";
import { todayISO } from "@/lib/format";
import { sessionStore } from "@/lib/session";

/** A API põe no máximo esta quantidade de OS numa planilha. */
export const EXPORT_LIMIT = 20_000;

/** Planilha grande leva alguns segundos para sair. */
const EXPORT_TIMEOUT_MS = 120_000;

/** Nome do arquivo que a API mandou ("chamados-2026-11-16.csv"); sem ele, o mesmo padrão com o dia de hoje. */
function filenameOf(disposition: string | null): string {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition ?? "")?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim());
    } catch {
      // Nome malformado: fica o padrão abaixo.
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition ?? "")?.[1]?.trim();
  return plain || `chamados-${todayISO()}.csv`;
}

function timeout(ms: number): AbortSignal | undefined {
  return typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}

/** Falha sem resposta da API (tempo esgotado ou sem rede), com a mensagem das outras chamadas. */
function transportError(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  return new ApiError(error instanceof DOMException && error.name === "TimeoutError" ? 408 : 0, null);
}

function send(query: Query, signal: AbortSignal | undefined): Promise<Response> {
  const token = sessionStore.get()?.accessToken;
  return fetch(`${API_URL}/tickets/export${buildQuery(query)}`, {
    headers: { Accept: "text/csv", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal,
  });
}

/**
 * Baixa a planilha com os filtros e a ordem de `query` (com `ids`, só aquelas OS). O arquivo vem
 * pronto da API (o Excel brasileiro abre direto: ";" e UTF-8 com BOM); devolve o nome do arquivo.
 */
export async function downloadTicketsCsv(query: Query): Promise<string> {
  const signal = timeout(EXPORT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await send(query, signal);
    if (res.status === 401) {
      // O acesso venceu: uma chamada comum da API renova a sessão (ou a encerra, se for o caso) e a
      // planilha é pedida de novo com o token novo.
      await api.get("/auth/me");
      res = await send(query, signal);
    }
  } catch (error) {
    throw transportError(error);
  }
  if (!res.ok) {
    let detail: unknown = null;
    try {
      const body: unknown = await res.json();
      if (body && typeof body === "object" && "detail" in body) detail = (body as { detail: unknown }).detail;
    } catch {
      // Resposta sem JSON (página de erro do proxy): fica a mensagem padrão do status.
    }
    throw new ApiError(res.status, detail);
  }
  let file: Blob;
  try {
    file = await res.blob();
  } catch (error) {
    throw transportError(error);
  }
  const filename = filenameOf(res.headers.get("Content-Disposition"));
  saveBlob(file, filename);
  return filename;
}
