// Caminhos que mais de uma tela usa: a tela Sincronização (a rota continua /conta) já rolada até um cartão, e abrir
// uma OS de qualquer lugar (Histórico, Meu elo, Faturamento), esteja ela no aparelho ou não.

import { router } from "expo-router";
import { getTicket } from "./db";
import { isOnline } from "./sync";
import { showToast } from "./toast";

/** Cartões da Sincronização que abrem direto (`/conta?secao=`): itens para enviar, ações recusadas, rastreamento. */
export type SyncSection = "pendencias" | "avisos" | "rastreamento";

/** A tela Sincronização (/conta), rolada até o cartão pedido. */
export function openSync(secao?: SyncSection): void {
  router.push(secao ? { pathname: "/conta", params: { secao } } : "/conta");
}

/**
 * Abre a OS: na hora se está no aparelho; com internet, a tela da OS busca na central (MissingTicket); sem, avisa
 * com o toast "Sem internet" / "Esta OS não está no aparelho. Ela abre quando a conexão voltar."
 */
export async function openTicketAnywhere(id: string): Promise<void> {
  const local = await getTicket(id).catch(() => null);
  if (local || isOnline()) {
    router.push({ pathname: "/ticket/[id]", params: { id } });
    return;
  }
  showToast("Sem internet", { description: "Esta OS não está no aparelho. Ela abre quando a conexão voltar." });
}
