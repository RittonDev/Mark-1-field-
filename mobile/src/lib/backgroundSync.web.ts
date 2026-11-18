// Pré-visualização no navegador: não há sincronização em segundo plano nem notificações do sistema.
// Mesmas exportações de backgroundSync.ts, sem efeito.

export const BACKGROUND_SYNC_TASK = "maxxfield-sync";

export type BackgroundSyncStatus = "active" | "restricted" | "unavailable";

export async function runBackgroundRound(): Promise<void> {}

export async function maybeBackgroundSync(): Promise<void> {}

export async function registerBackgroundSync(): Promise<void> {}

export async function unregisterBackgroundSync(): Promise<void> {}

export async function backgroundSyncStatus(): Promise<BackgroundSyncStatus> {
  return "unavailable";
}
