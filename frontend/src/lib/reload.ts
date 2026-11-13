// Versão nova publicada com a central aberta: os "pedaços" de JS da versão antiga deixam de existir e a
// próxima tela que precisar de um deles quebra ("Loading chunk ... failed"). Só recarregar resolve.

const STALE_BUILD = /Loading (CSS )?chunk|dynamically imported module|Importing a module script failed/i;
const RELOAD_KEY = "mf:recarga";
// Recarregou há menos que isso e quebrou de novo: não é versão nova, então não recarrega em laço.
const RELOAD_GUARD_MS = 60_000;

/** O erro é de um pedaço de JS que não existe mais (a versão mudou desde que a página abriu). */
export function isStaleBuildError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  return name === "ChunkLoadError" || (typeof message === "string" && STALE_BUILD.test(message));
}

/** Recarrega a página uma vez por minuto no máximo; devolve false quando não recarregou. */
export function reloadOnce(): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < RELOAD_GUARD_MS) return false;
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // Sem armazenamento não dá para evitar o laço: fica com o botão "Atualizar".
    return false;
  }
  window.location.reload();
  return true;
}
