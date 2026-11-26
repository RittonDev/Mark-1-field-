// Stub da sonda da sessão: só o que session.ts e profile.ts importam do React (os hooks não rodam no teste).
export function useSyncExternalStore(_subscribe, getSnapshot) {
  return getSnapshot();
}
