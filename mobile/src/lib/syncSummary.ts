// A linha "Sincronização" do Perfil e das Configurações: o resumo à direita, a pílula com os itens para enviar e o que
// o leitor de tela fala. Vermelho só nas ações que a central recusou (o mesmo da faixa de Hoje); o resto é neutro.

import { useLiveQuery } from "./changes";
import { listNotices } from "./db";
import { useSyncStatus } from "./sync";

export interface SyncSummary {
  /** "1 ação recusada" | "N ações recusadas" | "Sem internet" | "Tudo enviado" | null */
  value: string | null;
  /** "danger" só nas recusadas. */
  valueTone: "muted" | "danger";
  /** pendingOps + pendingPhotos (pílula neutra; 0 some). */
  count: number;
  /** "Sincronização, 3 itens para enviar, 1 ação recusada pela central" | "…, sem internet" | "…, tudo enviado" */
  accessibilityLabel: string;
}

const refusedText = (n: number) => (n === 1 ? "1 ação recusada" : `${n} ações recusadas`);
const itemsText = (n: number) => (n === 1 ? "1 item para enviar" : `${n} itens para enviar`);

/**
 * Recusadas > 0: o resumo delas (vermelho) e a pílula; senão itens para enviar: só a pílula; senão sem rede: "Sem
 * internet"; senão "Tudo enviado". Enquanto os avisos não foram lidos do aparelho (milissegundos), sem resumo: nada de
 * "Tudo enviado" piscando antes de "1 ação recusada".
 */
export function useSyncSummary(): SyncSummary {
  const sync = useSyncStatus();
  const notices = useLiveQuery(listNotices);
  const refused = notices?.length ?? 0;
  const count = sync.pendingOps + sync.pendingPhotos;
  const spoken = ["Sincronização"];
  if (count > 0) spoken.push(itemsText(count));

  let value: string | null = null;
  let valueTone: SyncSummary["valueTone"] = "muted";
  if (refused > 0) {
    value = refusedText(refused);
    valueTone = "danger";
    spoken.push(`${value} pela central`);
  } else if (count === 0 && notices !== undefined) {
    value = sync.network === "offline" ? "Sem internet" : "Tudo enviado";
    spoken.push(value.toLowerCase());
  }
  return { value, valueTone, count, accessibilityLabel: spoken.join(", ") };
}
