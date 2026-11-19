// Rede na hora de salvar (o cadastro e as Configurações são só online): distingue "o aparelho está sem rede" de "o
// servidor falhou", para avisar "Sem internet" em vez da mensagem de erro.

import NetInfo from "@react-native-community/netinfo";
import { ApiError } from "./api";

/** Sem Wi-Fi e sem dados. Alcance incerto (teste de internet do sistema falhando) ainda vale tentar. */
export async function noNetwork(): Promise<boolean> {
  const net = await NetInfo.fetch().catch(() => null);
  return net?.isConnected === false;
}

/** O pedido não saiu porque o aparelho está sem rede (e não por erro do servidor). */
export async function offlineFailure(error: unknown): Promise<boolean> {
  return error instanceof ApiError && error.status === 0 && (await noNetwork());
}
