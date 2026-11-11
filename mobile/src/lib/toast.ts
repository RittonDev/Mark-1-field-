import { useSyncExternalStore } from "react";

export type ToastTone = "info" | "success" | "error";

export interface Toast {
  id: number;
  title: string;
  description?: string;
  tone: ToastTone;
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

export function showToast(title: string, options: { description?: string; tone?: ToastTone } = {}) {
  const toast: Toast = { id: nextId++, title, description: options.description, tone: options.tone ?? "info" };
  toasts = [...toasts.slice(-2), toast];
  emit();
  setTimeout(() => dismissToast(toast.id), 4000);
}

export function dismissToast(id: number) {
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
