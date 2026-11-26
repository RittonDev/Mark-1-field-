// Links antigos da Chave PIX (Configurações › Chave PIX e o atalho do Faturamento de antes): as chaves PIX e as contas
// ficam agora em Configurações › Formas de recebimento. Esta rota só troca a tela.

import { Redirect } from "expo-router";

export default function PixRedirect() {
  return <Redirect href="/configuracoes/recebimento" />;
}
