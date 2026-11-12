import { useSyncExternalStore } from "react";

// Momento de sucesso (check desenhado) depois de concluir a OS ou salvar a assinatura.
export interface SuccessMoment {
  id: number;
  title: string;
  description?: string;
}

let current: SuccessMoment | null = null;
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export function showSuccess(title: string, description?: string) {
  const moment = { id: nextId++, title, description };
  current = moment;
  emit();
  setTimeout(() => dismissSuccess(moment.id), 1800);
}

export function dismissSuccess(id?: number) {
  if (!current || (id !== undefined && current.id !== id)) return;
  current = null;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const get = () => current;

export function useSuccess(): SuccessMoment | null {
  return useSyncExternalStore(subscribe, get, get);
}
