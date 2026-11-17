// Lista de anexos da OS guardada no aparelho (fotos enviadas, fotos dos formulários e assinatura).
// As telas leem do cache (funciona offline) e pedem uma atualização quando há conexão.

import { api } from "../../lib/api";
import { getAttachmentsCache, setAttachmentsCache, transaction } from "../../lib/db";
import type { Attachment } from "../../lib/types";

const latestRequest = new Map<string, number>();
const fetchedAt = new Map<string, number>();

/**
 * Busca os anexos da OS e guarda no aparelho. Se outra busca começou depois desta, a resposta
 * desta é descartada (chegou atrasada). A foto que o sync subiu enquanto a busca estava no ar
 * continua na lista: a resposta pode ter saído do servidor antes dela, e o campo do formulário
 * ficaria com uma foto a menos.
 */
export async function reloadAttachments(ticketId: string): Promise<void> {
  const seq = (latestRequest.get(ticketId) ?? 0) + 1;
  latestRequest.set(ticketId, seq);
  const known = new Set((await getAttachmentsCache(ticketId)).map((a) => a.id));
  const list = await api.get<Attachment[]>(`/tickets/${ticketId}/attachments`);
  if (latestRequest.get(ticketId) !== seq) return;
  const received = new Set(list.map((a) => a.id));
  // Leitura e gravação na mesma transação: o envio de uma foto não escreve no meio.
  await transaction(async (db) => {
    const arrived = (await getAttachmentsCache(ticketId, db)).filter((a) => !known.has(a.id) && !received.has(a.id));
    await setAttachmentsCache(ticketId, arrived.length ? [...list, ...arrived] : list, db);
  });
  fetchedAt.set(ticketId, Date.now());
}

/**
 * Os links de download vencem (15 min): lista buscada há mais de 10 min nesta sessão é atualizada
 * antes de abrir uma foto.
 */
export function attachmentsStale(ticketId: string): boolean {
  return Date.now() - (fetchedAt.get(ticketId) ?? 0) > 10 * 60_000;
}
