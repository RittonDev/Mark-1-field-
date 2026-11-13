"use client";

import { Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";
import { THEME_COLOR } from "@/lib/theme";

/**
 * Símbolo da marca desenhado em vetor (três barras e o ponto, nas cores da logo): nítido em qualquer
 * densidade de tela, inclusive nos notebooks Windows a 125-150% e nas telas de celular.
 * Com `label`, é a imagem com nome; sem, é decorativo (o nome está ao lado).
 */
export function BrandMark({ height = 22, label }: { height?: number; label?: string }) {
  return (
    <svg
      viewBox="0 0 67 33"
      width={Math.round(height * 2.03)}
      height={height}
      fill="none"
      strokeWidth={10.75}
      strokeLinecap="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className="shrink-0"
    >
      <path d="M17.9 7.5L7.71 25.55" stroke="#2447ff" />
      <path d="M32.9 7.5L22.71 25.55" stroke="#00b7df" />
      <path d="M47.65 7.5L37.46 25.55" stroke="#2bd4af" />
      <path d="M47.65 7.5L59.25 15" stroke="#76f6c6" />
      <circle cx="52.5" cy="25.5" r="5.6" fill="#76f6c6" />
    </svg>
  );
}

/** Logo Maxx Field: símbolo + nome em texto, que acompanha o tema. */
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
      <BrandMark height={height} label={compact ? "Maxx Field" : undefined} />
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
/** Escolha da pessoa: um tema fixo ou "system" (segue o tema do Windows/celular, inclusive quando muda). */
export type ThemeChoice = Theme | "system";

const STORAGE_KEY = "theme";
const CHOICE_EVENT = "mf:theme-choice";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemTheme(): Theme {
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

/** Pinta o tema e a cor da barra do navegador e do app instalado (antes seguia só o tema do sistema). */
function paint(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = THEME_COLOR[theme];
}

/** Tema escolhido (salvo no navegador) ou "system". */
export function themeChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

/** Aplica e guarda o tema escolhido. */
export function applyTheme(next: Theme) {
  paint(next);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Armazenamento bloqueado: o tema vale só para esta página.
  }
  window.dispatchEvent(new Event(CHOICE_EVENT));
}

/** "Automático": esquece a escolha e volta a seguir o tema do sistema. */
export function clearThemeChoice() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Sem armazenamento não havia escolha salva.
  }
  paint(systemTheme());
  window.dispatchEvent(new Event(CHOICE_EVENT));
}

export function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
}

if (typeof window !== "undefined") {
  // Sem escolha salva, acompanha o sistema na hora (ex.: modo escuro automático do Windows à noite).
  window.matchMedia(DARK_QUERY).addEventListener("change", () => {
    if (themeChoice() === "system") paint(systemTheme());
  });
  // Escolha feita em outra aba vale nesta também.
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    const choice = themeChoice();
    paint(choice === "system" ? systemTheme() : choice);
    window.dispatchEvent(new Event(CHOICE_EVENT));
  });
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

function subscribeChoice(onChange: () => void) {
  window.addEventListener(CHOICE_EVENT, onChange);
  return () => window.removeEventListener(CHOICE_EVENT, onChange);
}

/** Escolha de tema atual (Claro, Escuro ou Automático), para o menu do usuário. */
export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribeChoice, themeChoice, () => "system" as ThemeChoice);
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

