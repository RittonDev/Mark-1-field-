// Preferências e rascunhos guardados só neste navegador. O armazenamento pode estar bloqueado (janela
// anônima, dados do site limpos): aí tudo continua funcionando, só sem lembrar.

type Area = "local" | "session";

function area(kind: Area): Storage | null {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readStored<T>(kind: Area, key: string): T | null {
  try {
    const raw = area(kind)?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** Grava o valor (null apaga). */
export function writeStored(kind: Area, key: string, value: unknown): void {
  try {
    const storage = area(kind);
    if (!storage) return;
    if (value === null || value === undefined) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
  } catch {
    // Cota cheia ou armazenamento bloqueado: segue sem guardar.
  }
}
