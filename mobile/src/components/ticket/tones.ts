// Cor de texto para alerta, sucesso, informação e erro: os tokens de texto do tema (`warningInk`,
// `successInk`, `infoInk`, `dangerInk`), com contraste AA no fundo do tema e no fundo suave do tom,
// também no sol. Para tom escolhido em tempo de execução (status de peça, de custo).

import type { Palette } from "../../theme/theme";

export type Tone = "warning" | "success" | "info" | "danger";

const INK = { warning: "warningInk", success: "successInk", info: "infoInk", danger: "dangerInk" } as const satisfies Record<
  Tone,
  keyof Palette
>;

export const toneInk = (c: Palette, tone: Tone): string => c[INK[tone]];
