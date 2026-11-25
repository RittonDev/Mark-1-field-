"use client";

// Busca de CEP pela API (GET /public/cep/{8 números}: ViaCEP, BrasilAPI de reserva e cache no servidor). Na central a
// chamada vai logada (o limite é por pessoa: a central inteira sai pelo mesmo IP); a ficha pública chama sem login (limite
// por IP). O resultado fica na memória da aba: o mesmo CEP não é buscado de novo.

import { queryOptions, useQuery } from "@tanstack/react-query";
import { cepDigits } from "./address";
import { ApiError, apiErrorCode, request } from "./api";
import type { CepAddress } from "./types";

export type CepLookupState = "idle" | "loading" | "found" | "not_found" | "unavailable";

/** A consulta de um CEP (8 números): a mesma chave para a linha de status e para quem aplica o resultado. */
export function cepQuery(digits: string, auth = true) {
  return queryOptions({
    queryKey: ["cep", digits] as const,
    queryFn: ({ signal }) => request<CepAddress>(`/public/cep/${digits}`, { auth, timeoutMs: 8000, signal }),
    staleTime: Infinity,
    gcTime: 3_600_000,
    retry: false,
    // Não achou ou fora do ar: a pessoa digita o CEP de novo para buscar outra vez (nada se repete sozinho).
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/** Só o 404 com CEP_NOT_FOUND é "não existe"; o resto (API sem a rota, 422, 429, 5xx, sem internet) é busca indisponível. */
export function cepMiss(error: unknown): "not_found" | "unavailable" {
  return error instanceof ApiError && error.status === 404 && apiErrorCode(error) === "CEP_NOT_FOUND" ? "not_found" : "unavailable";
}

/**
 * O estado da busca do CEP digitado. `armed`: a pessoa digitou no campo (abrir um cadastro que já tem CEP não busca).
 * Fora isso, ou com menos de 8 números, "idle".
 */
export function useCepLookup(
  text: string,
  armed: boolean,
  options: { auth?: boolean } = {},
): { state: CepLookupState; cep: CepAddress | null } {
  const digits = cepDigits(text);
  const enabled = armed && digits.length === 8;
  const query = useQuery({ ...cepQuery(digits, options.auth ?? true), enabled });
  if (!enabled) return { state: "idle", cep: null };
  if (query.data) return { state: "found", cep: query.data };
  if (query.error) return { state: cepMiss(query.error), cep: null };
  return { state: "loading", cep: null };
}
