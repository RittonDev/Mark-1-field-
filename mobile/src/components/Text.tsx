import { createContext, use, type ComponentProps } from "react";
import { Text as RNText, StyleSheet } from "react-native";
import { brandFont, resolveWeight, type Weight } from "../theme/fonts";

/** Peso do Text pai: um Text aninhado sem `fontWeight` herda o peso (e a família) dele. */
const ParentWeight = createContext<Weight>("400");

/** Teto da fonte ampliada do sistema: acompanha até 160% sem estourar cartões e barras. */
export const MAX_FONT_SCALE = 1.6;

/**
 * Text do app. Troca o `fontWeight` pela família da Manrope do mesmo peso; o resto do estilo
 * passa intacto. Um `fontFamily` explícito no estilo é respeitado. Itens densos (abas, calendário,
 * selos) passam um `maxFontSizeMultiplier` menor.
 */
export function Text({ style, children, maxFontSizeMultiplier, ...rest }: ComponentProps<typeof RNText>) {
  const inherited = use(ParentWeight);
  const flat = StyleSheet.flatten(style);
  const weight = flat?.fontWeight !== undefined ? resolveWeight(flat.fontWeight) : inherited;
  const family = flat?.fontFamily ? undefined : brandFont(weight);
  const text = (
    <RNText
      style={family ? [style, { fontFamily: family, fontWeight: "normal" }] : style}
      maxFontSizeMultiplier={maxFontSizeMultiplier ?? MAX_FONT_SCALE}
      {...rest}
    >
      {children}
    </RNText>
  );
  // Só precisa repassar o peso quando há Text aninhado e ele difere do padrão.
  if (weight === inherited || typeof children !== "object" || children === null) return text;
  return <ParentWeight value={weight}>{text}</ParentWeight>;
}
