// "Ocultar valores" do Faturamento (o olho): guardado no aparelho, no Keychain/Keystore, como o tema. É preferência do
// aparelho, não do técnico: fica na troca de técnico e no Sair, e nada vai para o servidor.
//
// O _layout.tsx lê na abertura (loadHideValues, junto do tema) e a splash espera: a aba já abre oculta ou à mostra.
// Enquanto não leu, conta como oculto (nada de valor piscando). Vale na aba Faturamento e no mês; não vale na OS
// ("Valor desta OS") nem na oferta.

import { useCallback, useSyncExternalStore } from "react";
import { formatBRL } from "./expenses";
import { secureStorage } from "./secureStorage";

/** Sempre 5 pontos: o tamanho não denuncia o valor. */
export const HIDDEN_MONEY = "R$ •••••";

const KEY = "mc_hide_values";
/** null: ainda não leu. */
let hidden: boolean | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

/** Lê a preferência salva (abertura do app). Não lança erro: sem leitura, os valores ficam à mostra (o padrão). */
export async function loadHideValues(): Promise<void> {
  let saved: string | null = null;
  try {
    saved = await secureStorage.getItem(KEY);
  } catch {
    // sem preferência legível: vale o padrão
  }
  // Tocou no olho enquanto lia: vale o toque.
  if (hidden !== null) return;
  hidden = saved === "1";
  emit();
}

export function setHideValues(next: boolean): void {
  hidden = next;
  emit();
  secureStorage.setItem(KEY, next ? "1" : "0").catch(() => {
    // vale só nesta sessão do app
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getHidden = () => hidden ?? true;

/** true: valores ocultos (também enquanto a preferência não foi lida). */
export function useHideValues(): boolean {
  return useSyncExternalStore(subscribe, getHidden, getHidden);
}

/** Formata o valor em reais, ou HIDDEN_MONEY com os valores ocultos. */
export function useMoney(): (value: number) => string {
  const hide = useHideValues();
  return useCallback((value: number) => (hide ? HIDDEN_MONEY : formatBRL(value)), [hide]);
}
