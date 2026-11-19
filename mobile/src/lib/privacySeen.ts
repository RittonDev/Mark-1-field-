// Versão do aviso de privacidade (PRIVACY_VERSION) que cada técnico já abriu. Enquanto for outra, Hoje mostra o cartão
// "Aviso de privacidade atualizado" (components/PrivacyUpdateCard.tsx), que só lê a memória daqui.
//
// Fica só no aparelho, por técnico (a chave leva o id), no Keychain/Keystore, como a preferência de tema: sobrevive ao
// Sair e à troca de técnico, vale offline e nada vai para o servidor.
//
// O _layout.tsx importa este módulo, então a memória já existe antes de a rota de Hoje carregar. A abertura do app com
// técnico salvo (_layout.tsx) e o login (auth.ts) esperam a leitura no máximo PRIVACY_SEEN_WAIT_MS antes de mostrar
// Hoje: o cartão já entra no primeiro quadro. Leitura mais lenta não prende nada: Hoje abre e o cartão entra depois.

import { PRIVACY_VERSION } from "./constants";
import { secureStorage } from "./secureStorage";

/** Quanto a abertura do app e o login esperam a leitura da versão vista antes de mostrar Hoje. */
export const PRIVACY_SEEN_WAIT_MS = 300;

/** mc_privacy_seen_<id do técnico> (o armazenamento seguro só aceita letras, números, ".", "-" e "_"). */
const seenKey = (userId: string) => `mc_privacy_seen_${userId.replace(/[^\w.-]/g, "_")}`;

/** Versão aberta por técnico (null: nenhuma). Sem o técnico no mapa, a leitura não terminou ou falhou. */
const seen = new Map<string, string | null>();
const reading = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((listener) => listener());

/**
 * Lê a versão vista do técnico uma vez; quem chama durante a leitura espera a mesma. Não lança erro: se a leitura
 * falhar, o cartão não aparece, e a próxima chamada (Hoje montando) tenta de novo.
 */
export function loadPrivacySeen(userId: string): Promise<void> {
  if (seen.has(userId)) return Promise.resolve();
  let task = reading.get(userId);
  if (!task) {
    task = Promise.resolve()
      .then(() => secureStorage.getItem(seenKey(userId)))
      .then((value) => {
        // Aberto enquanto lia: vale o que acabou de ser gravado.
        if (seen.has(userId)) return;
        seen.set(userId, value);
        emit();
      })
      .catch((error: unknown) => console.warn("Não foi possível ler o aviso de privacidade visto", error))
      .finally(() => reading.delete(userId));
    reading.set(userId, task);
  }
  return task;
}

/** loadPrivacySeen esperado no máximo `ms`: a leitura continua e preenche a memória quando terminar. Não lança erro. */
export function waitPrivacySeen(userId: string, ms = PRIVACY_SEEN_WAIT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ceiling = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([loadPrivacySeen(userId), ceiling]).finally(() => clearTimeout(timer));
}

/** true: mostra o cartão; false: o técnico já abriu esta versão; undefined: leitura pendente ou que falhou. */
export function privacyUpdateDue(userId: string): boolean | undefined {
  return seen.has(userId) ? seen.get(userId) !== PRIVACY_VERSION : undefined;
}

/** O técnico abriu o aviso de privacidade: a versão atual fica vista para ele e o cartão de Hoje some. */
export function markPrivacyNoticeSeen(userId: string) {
  if (seen.get(userId) === PRIVACY_VERSION) return;
  seen.set(userId, PRIVACY_VERSION);
  emit();
  secureStorage.setItem(seenKey(userId), PRIVACY_VERSION).catch((error: unknown) => {
    // Some nesta sessão; na próxima abertura do app, o cartão volta.
    console.warn("Não foi possível guardar o aviso de privacidade visto", error);
  });
}

/** Avisa quando a versão vista de algum técnico muda (leitura que terminou ou aviso aberto). */
export function subscribePrivacySeen(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
