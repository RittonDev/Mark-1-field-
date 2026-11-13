"use client";

import { Download, MonitorDown } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { Button } from "@/components/ui";

/** Evento que o Edge/Chrome dispara quando o site pode virar app instalado. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

// O navegador avisa uma vez só, logo depois de carregar a página, e muitas vezes antes de o login
// terminar e o cabeçalho aparecer. O aviso é guardado aqui, desde que este arquivo carrega, para o
// botão aparecer mesmo assim.
let deferred: InstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

if (typeof window !== "undefined") {
  installed = window.matchMedia("(display-mode: standalone)").matches;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferred = null;
    notify();
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const installPrompt = () => (installed ? null : deferred);

/** Abre a janela de instalação do navegador (cada aviso só pode ser usado uma vez). */
async function install(prompt: InstallPromptEvent) {
  try {
    await prompt.prompt();
    if ((await prompt.userChoice).outcome === "accepted") installed = true;
  } catch {
    // O navegador recusou mostrar a instalação: o botão some até o próximo aviso.
  } finally {
    deferred = null;
    notify();
  }
}

/** Registra o service worker do app instalável (aviso de "sem internet"). */
export function useServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Sem service worker o portal funciona igual; só não mostra a página de "sem internet".
    });
  }, []);
}

/**
 * "Instalar no computador": vira um app (no Windows, atalho na área de trabalho e no menu Iniciar,
 * janela própria; no celular, ícone na tela inicial). Só aparece quando o navegador oferece a
 * instalação e o app ainda não está instalado. No celular, só o ícone.
 */
export function InstallAppButton({ className }: { className?: string }) {
  const prompt = useSyncExternalStore(subscribe, installPrompt, () => null);
  if (!prompt) return null;
  return (
    <Button
      size="sm"
      className={className}
      onClick={() => void install(prompt)}
      title="Instala o Maxx Field como app: atalho próprio e janela própria"
    >
      <MonitorDown className="hidden size-4 sm:block" aria-hidden />
      <Download className="size-4 sm:hidden" aria-hidden />
      <span className="hidden sm:inline">Instalar no computador</span>
      <span className="sr-only sm:hidden">Instalar o app</span>
    </Button>
  );
}
