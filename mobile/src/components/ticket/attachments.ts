// Lista de anexos da OS guardada no aparelho (fotos enviadas, fotos dos formulários e assinatura).
// As telas leem do cache (funciona offline) e pedem uma atualização quando há conexão.

import { api } from "../../lib/api";
import { setAttachmentsCache } from "../../lib/db";
import type { Attachment } from "../../lib/types";

const latestRequest = new Map<string, number>();
const fetchedAt = new Map<string, number>();

/**
 * Busca os anexos da OS e guarda no aparelho. Se outra busca começou depois desta, a resposta
 * desta é descartada (chegou atrasada e não traz a foto que acabou de subir).
 */
export async function reloadAttachments(ticketId: string): Promise<void> {
  const seq = (latestRequest.get(ticketId) ?? 0) + 1;
  latestRequest.set(ticketId, seq);
  const list = await api.get<Attachment[]>(`/tickets/${ticketId}/attachments`);
  if (latestRequest.get(ticketId) !== seq) return;
  await setAttachmentsCache(ticketId, list);
  fetchedAt.set(ticketId, Date.now());
}

/**
 * Os links de download vencem (15 min): lista buscada há mais de 10 min nesta sessão é atualizada
 * antes de abrir uma foto.
 */
export function attachmentsStale(ticketId: string): boolean {
  return Date.now() - (fetchedAt.get(ticketId) ?? 0) > 10 * 60_000;
}
