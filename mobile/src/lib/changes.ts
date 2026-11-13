// Aviso de "o banco local mudou" para as telas recarregarem as consultas.

import { useEffect, useState, useSyncExternalStore } from "react";

let version = 0;
const listeners = new Set<() => void>();
let pending: ReturnType<typeof setTimeout> | null = null;

/** Rajadas de escritas (uma página do download, várias fotos) viram um aviso só a cada ~50 ms. */
const COALESCE_MS = 50;

export function notifyDataChanged() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    version += 1;
    listeners.forEach((listener) => listener());
  }, COALESCE_MS);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getVersion = () => version;

export function useDataVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

/**
 * Executa `load` e repete a cada mudança no banco local.
 * Passe uma função estável (useCallback) — trocar a função dispara nova consulta.
 * Enquanto a nova consulta roda, devolve o resultado anterior da mesma função (sem piscar).
 */
export function useLiveQuery<T>(load: () => Promise<T>): T | undefined {
  const dataVersion = useDataVersion();
  const [state, setState] = useState<{ load: () => Promise<T>; data: T }>();
  useEffect(() => {
    let alive = true;
    load().then(
      (data) => {
        if (alive) setState({ load, data });
      },
      (error: unknown) => console.warn("Falha ao ler o banco local", error),
    );
    return () => {
      alive = false;
    };
  }, [load, dataVersion]);
  return state && state.load === load ? state.data : undefined;
}

/** Relógio que atualiza a cada `intervalMs` (contagens regressivas de SLA). */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
