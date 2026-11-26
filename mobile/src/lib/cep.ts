// Busca de CEP do Endereço (Configurações): GET /public/cep/{8 números}, logado (o limite do servidor é por pessoa). O
// servidor busca no ViaCEP (BrasilAPI de reserva) e guarda; aqui o que achou e o que não achou ficam na memória (o mesmo
// CEP não sai de novo) até a troca de sessão. Nunca lança: sem rede, fora do ar, pedidos demais ou a API de antes (404
// sem código) dão "unavailable", e o técnico preenche à mão. A regra de preencher é a dos 6 lugares (cepFill, por
// cepPatch em lib/profileForm.ts).

import { api, ApiError } from "./api";
import { noNetwork } from "./net";
import { cepMiss } from "./profileForm";
import { session } from "./session";
import type { CepAddress } from "./types";

export type CepOutcome = { status: "found"; address: CepAddress } | { status: "not_found" } | { status: "unavailable" };

/** Mais que isso, a pessoa já está digitando o endereço: a busca vira "indisponível". */
const TIMEOUT_MS = 8_000;

const NOT_FOUND: CepOutcome = { status: "not_found" };
const UNAVAILABLE: CepOutcome = { status: "unavailable" };

/** O que o servidor respondeu, pelos 8 números (o "indisponível" não fica: a próxima tentativa busca de novo). */
const known = new Map<string, CepOutcome>();
const inflight = new Map<string, Promise<CepOutcome>>();
let owner: string | null = null;

// Saiu da conta ou entrou outro técnico: o que o anterior buscou sai da memória.
session.subscribe(() => {
  const user = session.get().user?.id ?? null;
  if (user === owner) return;
  owner = user;
  known.clear();
});

const isCepAddress = (value: unknown): value is CepAddress =>
  !!value && typeof value === "object" && typeof (value as CepAddress).city === "string" && typeof (value as CepAddress).state === "string";

async function fetchCep(digits: string): Promise<CepOutcome> {
  if (await noNetwork()) return UNAVAILABLE;
  try {
    const address = await api.get<unknown>(`/public/cep/${digits}`, { timeoutMs: TIMEOUT_MS });
    if (!isCepAddress(address)) return UNAVAILABLE;
    const outcome: CepOutcome = { status: "found", address };
    known.set(digits, outcome);
    return outcome;
  } catch (error) {
    if (error instanceof ApiError && cepMiss(error.status, error.code) === "not_found") {
      known.set(digits, NOT_FOUND);
      return NOT_FOUND;
    }
    return UNAVAILABLE;
  }
}

/** O endereço de um CEP (os 8 números, com ou sem máscara). Pedidos do mesmo CEP ao mesmo tempo dividem a busca. */
export function lookupCep(zip: string): Promise<CepOutcome> {
  const digits = zip.replace(/\D/g, "");
  if (digits.length !== 8) return Promise.resolve(UNAVAILABLE);
  const cached = known.get(digits);
  if (cached) return Promise.resolve(cached);
  const running = inflight.get(digits);
  if (running) return running;
  const run = fetchCep(digits).finally(() => inflight.delete(digits));
  inflight.set(digits, run);
  return run;
}
