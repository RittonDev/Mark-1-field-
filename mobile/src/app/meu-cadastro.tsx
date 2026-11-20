// Links antigos do Meu cadastro: o cadastro do técnico agora fica em Configurações (Perfil › Configurações), dividido
// em Foto do perfil, Dados pessoais, Contato, Endereço e Chave PIX. Esta rota só troca a tela por Configurações.

import { Redirect } from "expo-router";

export default function MyProfileRedirect() {
  return <Redirect href="/configuracoes" />;
}
