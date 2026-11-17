"use client";

import { useSyncExternalStore } from "react";

// Fundo animado da Início parado pelo botão "Animação" (WCAG 2.2.2): a escolha fica salva neste navegador.
const STORAGE_KEY = "mf:inicio:fundo";
const CHANGE_EVENT = "mf:inicio:fundo";
/** Escolha que não coube no armazenamento (bloqueado ou cheio): vale até recarregar. */
let memory: boolean | null = null;

export function readBackdropStopped(): boolean {
  if (memory !== null) return memory;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "parado";
  } catch {
    return false;
  }
}

export function writeBackdropStopped(stopped: boolean): void {
  try {
    if (stopped) window.localStorage.setItem(STORAGE_KEY, "parado");
    else window.localStorage.removeItem(STORAGE_KEY);
    memory = null;
  } catch {
    memory = stopped;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange);
  // Escolha feita em outra aba vale nesta também.
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** true quando a pessoa parou a animação do fundo. No servidor, false. */
export function useBackdropStopped(): boolean {
  return useSyncExternalStore(subscribe, readBackdropStopped, () => false);
}
