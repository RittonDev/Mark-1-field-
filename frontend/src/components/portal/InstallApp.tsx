"use client";

import { MonitorDown } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui";

/** Evento que o Edge/Chrome dispara quando o site pode virar app instalado. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isInstalled(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(display-mode: standalone)").matches;
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
 * "Instalar no computador": vira um app do Windows (área de trabalho e menu Iniciar, janela
 * própria). Só aparece quando o navegador oferece a instalação e o app ainda não está instalado.
 */
export function InstallAppButton({ className }: { className?: string }) {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isInstalled);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (installed || !prompt) return null;
  return (
    <Button
      size="sm"
      className={className}
      onClick={async () => {
        await prompt.prompt();
        const choice = await prompt.userChoice;
        if (choice.outcome === "accepted") setInstalled(true);
        setPrompt(null);
      }}
      title="Cria um atalho do Maxx Field na área de trabalho e no menu Iniciar"
    >
      <MonitorDown className="size-4" />
      Instalar no computador
    </Button>
  );
}
