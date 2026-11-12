"use client";

import { Moon, Sun } from "lucide-react";
import Image from "next/image";
import { useSyncExternalStore } from "react";

/** Logo Maxx Field: símbolo (degradê da marca) + nome em texto, que acompanha o tema. */
export function Logo({
  compact = false,
  size = "md",
  inverse = false,
  tone,
}: {
  compact?: boolean;
  size?: "md" | "lg";
  /** Texto claro, para fundo escuro. */
  inverse?: boolean;
  /** Cor fixa do nome (ex.: sobre um selo branco, em qualquer tema). */
  tone?: "dark" | "light";
}) {
  const textColor = tone === "dark" ? "text-[#262b32]" : tone === "light" || inverse ? "text-white" : "text-ink";
  const height = size === "lg" ? 30 : 22;
  return (
    <span className="inline-flex items-center gap-2">
      <Image
        src="/brand/maxxfield-mark.png"
        alt={compact ? "Maxx Field" : ""}
        width={Math.round(height * 2.03)}
        height={height}
        priority
      />
      {compact ? null : (
        <span
          className={`leading-none tracking-tight ${textColor} ${size === "lg" ? "text-2xl" : "text-[17px]"}`}
        >
          <span className="font-semibold">Maxx</span> <span className="font-normal">Field</span>
        </span>
      )}
    </span>
  );
}

export type Theme = "light" | "dark";

/** Aplica e guarda o tema (sem escolha salva, o app segue o tema do sistema). */
export function applyTheme(next: Theme) {
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("theme", next);
  } catch {
    // Armazenamento bloqueado: o tema vale só para esta página.
  }
}

export function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
}

function readTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/** Tema atual (claro/escuro), acompanhando o botão e o tema do sistema. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, readTheme, () => "light" as Theme);
}

/** Alterna claro/escuro; a escolha fica salva. Sem escolha salva, segue o tema do sistema. */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const theme = useTheme();
  const next: Theme = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => applyTheme(next)}
      className={`inline-flex size-8 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink ${className}`}
      aria-label={next === "dark" ? "Ativar modo escuro" : "Ativar modo claro"}
      title={next === "dark" ? "Modo escuro" : "Modo claro"}
    >
      {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

