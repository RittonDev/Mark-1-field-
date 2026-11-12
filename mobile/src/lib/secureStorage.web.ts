// Pré-visualização no navegador: não existe Keychain/Keystore, então os tokens ficam no localStorage.
// Só para desenvolvimento; o app real (Android/iOS) usa secureStorage.ts.

const PREFIX = "maxxchamados.mobile.";

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export const secureStorage = {
  async getItem(key: string): Promise<string | null> {
    return storage()?.getItem(PREFIX + key) ?? null;
  },
  async setItem(key: string, value: string): Promise<void> {
    storage()?.setItem(PREFIX + key, value);
  },
  async removeItem(key: string): Promise<void> {
    storage()?.removeItem(PREFIX + key);
  },
};
