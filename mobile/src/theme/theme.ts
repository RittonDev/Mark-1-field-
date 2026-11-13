// Tema Maxx Field: paleta da marca, modo claro/escuro seguindo o sistema e preferência do técnico.
//
// Uso: const c = useTheme();  ou  const styles = useStyles(makeStyles)  com
//      const makeStyles = (c: Palette) => StyleSheet.create({...})  definido no módulo.

import { useMemo, useSyncExternalStore } from "react";
import { useColorScheme } from "react-native";
import { secureStorage } from "../lib/secureStorage";

/** Cores da logo (azul → ciano → verde-água → menta) e o grafite do texto. */
export const BRAND = {
  blue: "#2447FF",
  cyan: "#00B7DF",
  aqua: "#2BD4AF",
  mint: "#76F6C6",
  graphite: "#1B1F26",
} as const;

/** Degradê da marca: só em detalhes (logo, barra ativa fina, progresso), nunca como fundo. */
export const BRAND_GRADIENT = [BRAND.blue, BRAND.cyan, BRAND.aqua, BRAND.mint] as const;

/** Raios e grade de 4 pt, iguais aos tokens da web. */
export const RADIUS = { card: 14, control: 10, chip: 999 } as const;
export const SPACE = (n: number) => n * 4;

/**
 * Tokens compartilhados com a web. `backdrop` é o fundo atrás da tela (login, áreas de destaque);
 * `canvas` é o fundo das telas; superfícies 1–3 para cartões e camadas.
 */
export interface Palette {
  scheme: "light" | "dark";
  backdrop: string;
  canvas: string;
  surface: string;
  surface2: string;
  surface3: string;
  line: string;
  lineStrong: string;
  ink: string;
  inkMuted: string;
  inkSubtle: string;
  primary: string;
  primaryPressed: string;
  primarySoft: string;
  brandInk: string;
  onPrimary: string;
  placeholder: string;
  danger: string;
  dangerSoft: string;
  success: string;
  successSoft: string;
  warning: string;
  warningSoft: string;
  info: string;
  segment: string;
  toast: string;
  toastInk: string;
  toastMuted: string;
  shadow: string;
  /** Sombra muito leve (y1, blur 3, ~5%); vazia no modo escuro, onde a borda basta. */
  elevation: string | undefined;
}

export const LIGHT: Palette = {
  scheme: "light",
  backdrop: "#F0F2F5",
  canvas: "#F9FAFB",
  surface: "#FFFFFF",
  surface2: "#F4F5F7",
  surface3: "#ECEEF1",
  line: "#E5E7EB",
  lineStrong: "#D4D8DE",
  ink: "#1B1F26",
  inkMuted: "#5D6676",
  inkSubtle: "#7A8290",
  primary: "#2447FF",
  primaryPressed: "#1A36D6",
  primarySoft: "#EEF1FF",
  brandInk: "#1F3BE0",
  onPrimary: "#FFFFFF",
  placeholder: "#8B93A1",
  danger: "#D92D20",
  dangerSoft: "#FEF3F2",
  success: "#0E9384",
  successSoft: "#EFFCF8",
  warning: "#DC6803",
  warningSoft: "#FFF7E8",
  info: "#0086C9",
  segment: "#ECEEF1",
  toast: "#1B1F26",
  toastInk: "#FFFFFF",
  toastMuted: "#C4C9D1",
  shadow: "#000000",
  elevation: "0px 1px 3px rgba(0, 0, 0, 0.05)",
};

export const DARK: Palette = {
  scheme: "dark",
  backdrop: "#08090B",
  canvas: "#0D0E11",
  surface: "#141519",
  surface2: "#1A1C20",
  surface3: "#222429",
  line: "#24262C",
  lineStrong: "#31343B",
  ink: "#ECECF0",
  inkMuted: "#9BA1AC",
  inkSubtle: "#7B818C",
  primary: "#5470FF",
  primaryPressed: "#3D5AF7",
  primarySoft: "rgba(84, 112, 255, 0.14)",
  brandInk: "#9FB0FF",
  onPrimary: "#FFFFFF",
  placeholder: "#6C727D",
  danger: "#F97066",
  dangerSoft: "rgba(249, 112, 102, 0.12)",
  success: BRAND.aqua,
  successSoft: "rgba(43, 212, 175, 0.12)",
  warning: "#FDB022",
  warningSoft: "rgba(253, 176, 34, 0.12)",
  info: "#36BFFA",
  segment: "#1A1C20",
  toast: "#222429",
  toastInk: "#ECECF0",
  toastMuted: "#9BA1AC",
  shadow: "#000000",
  elevation: undefined,
};

// ─────────────────────────── preferência ───────────────────────────

export type ThemePreference = "system" | "light" | "dark";

const KEY = "mc_theme";
let preference: ThemePreference = "system";
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

/** Lê a preferência salva (chamado na abertura do app). */
export async function loadThemePreference() {
  try {
    const saved = await secureStorage.getItem(KEY);
    if (saved === "light" || saved === "dark" || saved === "system") {
      preference = saved;
      emit();
    }
  } catch {
    // sem preferência salva: segue o sistema
  }
}

export async function setThemePreference(next: ThemePreference) {
  preference = next;
  emit();
  try {
    await secureStorage.setItem(KEY, next);
  } catch {
    // vale só nesta sessão
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getPreference = () => preference;

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, getPreference, getPreference);
}

/** Paleta ativa: preferência do técnico ou, em "system", o modo do aparelho. */
export function useTheme(): Palette {
  const system = useColorScheme();
  const pref = useThemePreference();
  const scheme = pref === "system" ? (system === "dark" ? "dark" : "light") : pref;
  return scheme === "dark" ? DARK : LIGHT;
}

/** Estilos dependentes do tema; passe uma função definida no módulo (estável). */
export function useStyles<T>(factory: (c: Palette) => T): T {
  const c = useTheme();
  return useMemo(() => factory(c), [factory, c]);
}

// ─────────────────────────── utilitários ───────────────────────────

/** Cor com transparência (#rrggbb + alfa) para fundos de selos. */
export const tint = (hex: string, alpha = "1f") => `${hex.slice(0, 7)}${alpha}`;

function channel(hex: string, i: number) {
  return parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
}

/** Mistura duas cores (#rrggbb). `amount` 0 = a, 1 = b. */
export function mix(a: string, b: string, amount: number) {
  const out = [0, 1, 2].map((i) => Math.round(channel(a, i) * (1 - amount) + channel(b, i) * amount));
  return `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Cor de status/prioridade legível no modo escuro (clareia tons escuros). */
export function readable(color: string, c: Palette) {
  return c.scheme === "dark" ? mix(color.slice(0, 7), "#FFFFFF", 0.35) : color;
}
