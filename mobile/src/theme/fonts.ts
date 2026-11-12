import { Manrope_400Regular } from "@expo-google-fonts/manrope/400Regular";
import { Manrope_500Medium } from "@expo-google-fonts/manrope/500Medium";
import { Manrope_600SemiBold } from "@expo-google-fonts/manrope/600SemiBold";
import { Manrope_700Bold } from "@expo-google-fonts/manrope/700Bold";
import { Manrope_800ExtraBold } from "@expo-google-fonts/manrope/800ExtraBold";
import { isLoaded } from "expo-font";
import type { TextStyle } from "react-native";

/**
 * Manrope, a mesma fonte da web. Importa só os pesos usados (cada arquivo tem ~100 KB);
 * os subcaminhos evitam empacotar os pesos 200 e 300.
 */
export const BRAND_FONTS = {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
  Manrope_800ExtraBold,
};

export type Weight = "400" | "500" | "600" | "700" | "800";

const FAMILY: Record<Weight, keyof typeof BRAND_FONTS> = {
  "400": "Manrope_400Regular",
  "500": "Manrope_500Medium",
  "600": "Manrope_600SemiBold",
  "700": "Manrope_700Bold",
  "800": "Manrope_800ExtraBold",
};

const NAMED: Record<string, Weight> = {
  normal: "400",
  regular: "400",
  ultralight: "400",
  thin: "400",
  light: "400",
  condensed: "400",
  medium: "500",
  semibold: "600",
  bold: "700",
  condensedBold: "700",
  heavy: "800",
  black: "800",
};

/** Converte qualquer `fontWeight` do RN para um dos pesos carregados. */
export function resolveWeight(weight: TextStyle["fontWeight"]): Weight {
  if (weight === undefined) return "400";
  const numeric = typeof weight === "number" ? weight : Number(weight);
  if (Number.isNaN(numeric)) return NAMED[String(weight)] ?? "400";
  if (numeric <= 450) return "400";
  if (numeric <= 550) return "500";
  if (numeric <= 650) return "600";
  if (numeric <= 750) return "700";
  return "800";
}

let ready = false;

/** Fontes já registradas? Se o carregamento falhar, o app segue com a fonte do sistema. */
function brandFontsReady(): boolean {
  if (!ready) ready = Object.values(FAMILY).every((family) => isLoaded(family));
  return ready;
}

/**
 * Família da Manrope para o peso pedido, ou `undefined` enquanto não carregou.
 * Cada peso é uma família própria: o Android não sintetiza `fontWeight` em fonte carregada.
 */
export function brandFont(weight: Weight): string | undefined {
  return brandFontsReady() ? FAMILY[weight] : undefined;
}
