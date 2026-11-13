import { useSyncExternalStore } from "react";

export type ToastTone = "info" | "success" | "error";

export interface Toast {
  id: number;
  title: string;
  description?: string;
  tone: ToastTone;
  /** Aviso sobre uma OS: tocar abre a OS. */
  ticketId?: string;
}

export interface ToastOptions {
  description?: string;
  tone?: ToastTone;
  ticketId?: string;
}

// Erro fica mais tempo na tela: é o que o técnico precisa ler até o fim.
const DURATION_MS: Record<ToastTone, number> = { info: 4000, success: 4000, error: 6000 };

let toasts: Toast[] = [];
let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

function schedule(toast: Toast) {
  clearTimeout(timers.get(toast.id));
  timers.set(
    toast.id,
    setTimeout(() => dismissToast(toast.id), DURATION_MS[toast.tone]),
  );
}

export function showToast(title: string, options: ToastOptions = {}) {
  const tone = options.tone ?? "info";
  // O mesmo aviso de novo (ex.: duas rodadas sem rede) não empilha: atualiza o que está na tela.
  const same = toasts.find((t) => t.title === title && t.tone === tone);
  if (same) {
    const updated: Toast = { ...same, description: options.description, ticketId: options.ticketId };
    toasts = toasts.map((t) => (t.id === same.id ? updated : t));
    emit();
    schedule(updated);
    return;
  }
  const toast: Toast = { id: nextId++, title, description: options.description, tone, ticketId: options.ticketId };
  const dropped = toasts.slice(0, -2);
  dropped.forEach((t) => {
    clearTimeout(timers.get(t.id));
    timers.delete(t.id);
  });
  toasts = [...toasts.slice(-2), toast];
  emit();
  schedule(toast);
}

export function dismissToast(id: number) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getToasts = () => toasts;

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, getToasts, getToasts);
}
