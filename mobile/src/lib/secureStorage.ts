// Armazenamento dos tokens: Keychain (iOS) / Keystore (Android) via expo-secure-store.
// Na pré-visualização web, secureStorage.web.ts usa localStorage.

import * as SecureStore from "expo-secure-store";

// iOS: legível com o iPhone bloqueado (depois do primeiro desbloqueio), para a tarefa de segundo
// plano da jornada renovar o token e enviar os pontos. Regravar com a opção atualiza também os
// itens antigos (gravados no padrão WHEN_UNLOCKED); os tokens são regravados a cada renovação.
const WRITE_OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

export const secureStorage = {
  // A leitura continua podendo falhar: com o iPhone bloqueado, um item antigo ainda não regravado
  // não abre, e apagá-lo aqui deslogaria o técnico. Quem chama decide (o layout volta ao login).
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value, WRITE_OPTIONS),
  /** Nunca falha: um item corrompido que não sai não pode travar o "Sair" nem a tela de abertura. */
  async removeItem(key: string): Promise<void> {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch (error) {
      console.warn("Não foi possível apagar um item do armazenamento seguro", error);
    }
  },
};
