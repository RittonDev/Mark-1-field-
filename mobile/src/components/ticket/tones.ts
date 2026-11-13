// Cor de texto para alerta, sucesso, informação e erro com contraste AA também no sol.
//
// No tema claro os tons puros (laranja #DC6803, verde #0E9384, azul #0086C9) ficam abaixo de 4,5:1
// sobre o branco em texto de 12–13 px; aqui vão as versões escuras (as mesmas da web). Quando o tema
// ganhar os tokens de texto (`warningInk`, `successInk`, `infoInk`, `dangerInk`), eles passam a valer.

import type { Palette } from "../../theme/theme";

export type Tone = "warning" | "success" | "info" | "danger";

const LIGHT_INK: Record<Tone, string> = {
  warning: "#B54708",
  success: "#0B7A6E",
  info: "#026AA2",
  danger: "#D92D20",
};

type WithInk = Palette & Partial<Record<`${Tone}Ink`, string>>;

export function toneInk(c: Palette, tone: Tone): string {
  const token = (c as WithInk)[`${tone}Ink`];
  if (token) return token;
  return c.scheme === "dark" ? c[tone] : LIGHT_INK[tone];
}
