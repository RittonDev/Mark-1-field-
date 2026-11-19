// Aba Faturamento. Provisório: mostra o conteúdo de hoje (EarningsView) com as mesmas props, para a aba já usar este
// componente; a aba nova (totais, cartões por mês e a chave PIX) substitui este arquivo inteiro.

import { EarningsView } from "../EarningsView";

/** `refreshKey` muda a cada "puxar para atualizar" na aba; `onSettled` avisa quando essa atualização terminou. */
export function BillingView({ refreshKey, onSettled }: { refreshKey?: number; onSettled?: () => void }) {
  return <EarningsView refreshKey={refreshKey} onSettled={onSettled} />;
}
