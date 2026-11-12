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
  graphite: "#262B32",
} as const;

export const BRAND_GRADIENT = [BRAND.blue, BRAND.cyan, BRAND.aqua, BRAND.mint] as const;

export interface Palette {
  scheme: "light" | "dark";
  primary: string;
  primaryPressed: string;
  onPrimary: string;
  primarySoft: string;
  canvas: string;
  surface: string;
  surface2: string;
  line: string;
  lineStrong: string;
  ink: string;
  inkMuted: string;
  inkSubtle: string;
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
}

export const LIGHT: Palette = {
  scheme: "light",
  primary: BRAND.blue,
  primaryPressed: "#1A37D6",
  onPrimary: "#FFFFFF",
  primarySoft: "#EEF1FF",
  canvas: "#F6F7F9",
  surface: "#FFFFFF",
  surface2: "#F8FAFC",
  line: "#E4E7EC",
  lineStrong: "#D0D5DD",
  ink: BRAND.graphite,
  inkMuted: "#5D6673",
  inkSubtle: "#98A2B3",
  placeholder: "#98A2B3",
  danger: "#D92D20",
  dangerSoft: "#FEF3F2",
  success: "#0E9384",
  successSoft: "#EFFCF8",
  warning: "#DC6803",
  warningSoft: "#FFF7E8",
  info: "#0086C9",
  segment: "#EAECF0",
  toast: BRAND.graphite,
  toastInk: "#FFFFFF",
  toastMuted: "#C9CED6",
  shadow: "#101828",
};

export const DARK: Palette = {
  scheme: "dark",
  primary: "#5470FF",
  primaryPressed: "#4360F0",
  onPrimary: "#FFFFFF",
  primarySoft: "#1A2250",
  canvas: "#0D1116",
  surface: "#151A21",
  surface2: "#1B2129",
  line: "#262D37",
  lineStrong: "#343C48",
  ink: "#E7EAF0",
  inkMuted: "#A1AAB7",
  inkSubtle: "#6C7685",
  placeholder: "#6C7685",
  danger: "#F97066",
  dangerSoft: "#2B1517",
  success: BRAND.aqua,
  successSoft: "#0F2A26",
  warning: "#FDB022",
  warningSoft: "#2A2111",
  info: "#36BFFA",
  segment: "#1B2129",
  toast: "#232A34",
  toastInk: "#F2F4F7",
  toastMuted: "#A1AAB7",
  shadow: "#000000",
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
