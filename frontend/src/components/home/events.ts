// Ações da busca que abrem algo de outra parte da central (sem importar a tela inteira aqui).

const CHANGE_PASSWORD_EVENT = "mf:trocar-senha";

/** Abre o diálogo "Trocar senha" (quem escuta é a barra do topo). */
export function openChangePassword() {
  window.dispatchEvent(new Event(CHANGE_PASSWORD_EVENT));
}

/** Escuta o pedido de "Trocar senha"; devolve a função que para de escutar. */
export function onChangePasswordRequest(handler: () => void): () => void {
  window.addEventListener(CHANGE_PASSWORD_EVENT, handler);
  return () => window.removeEventListener(CHANGE_PASSWORD_EVENT, handler);
}
