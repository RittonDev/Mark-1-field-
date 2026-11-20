import { LinearGradient } from "expo-linear-gradient";
import { StyleSheet, View } from "react-native";
import Svg, { Circle, G, Path } from "react-native-svg";
import { tint, useTheme } from "../theme/theme";

/** O pino da marca, com a ponta na origem (o grupo leva a ponta até o lugar). */
const PIN = "M0 0 C -9 -10, -12 -16, -12 -22 A 12 12 0 1 1 12 -22 C 12 -16, 9 -10, 0 0 Z";

/**
 * Ruas em traço fino em tons da marca bem suaves, que somem em direção ao conteúdo (sem manchas de degradê).
 * - "route" (login): uma rota tracejada entre dois pinos.
 * - "area" (topo da oferta): a área do atendimento, um círculo tracejado com o pino no centro. Ilustração: nunca o
 *   endereço nem o lugar exato (antes do aceite o técnico só sabe o bairro e a cidade).
 */
export function RouteMapPattern({ height = 300, variant = "route" }: { height?: number; variant?: "route" | "area" }) {
  const c = useTheme();
  const dark = c.scheme === "dark";
  const street = tint(c.primary, dark ? "24" : "1c");
  const avenue = tint(c.primary, dark ? "33" : "26");
  const route = tint(c.primary, dark ? "99" : "80");
  return (
    <View style={[styles.wrap, { height }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Svg width="100%" height="100%" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice">
        <G fill="none" strokeLinecap="round">
          {/* quarteirões */}
          <Path d="M-10 62 C 80 54, 170 70, 260 58 S 380 50, 420 56" stroke={street} strokeWidth={1.2} />
          <Path d="M-10 138 C 90 128, 190 146, 300 132 S 390 124, 420 130" stroke={avenue} strokeWidth={2} />
          <Path d="M-10 214 C 70 206, 160 222, 250 210 S 370 202, 420 208" stroke={street} strokeWidth={1.2} />
          <Path d="M58 -10 C 64 80, 50 170, 62 310" stroke={street} strokeWidth={1.2} />
          <Path d="M148 -10 C 140 90, 156 190, 144 310" stroke={avenue} strokeWidth={2} />
          <Path d="M246 -10 C 254 70, 238 180, 250 310" stroke={street} strokeWidth={1.2} />
          <Path d="M338 -10 C 330 100, 346 200, 334 310" stroke={street} strokeWidth={1.2} />
          <Path d="M-10 280 L 120 170 L 210 96 L 300 20 L 360 -10" stroke={street} strokeWidth={1.2} />
          {/* rota entre os dois pinos */}
          {variant === "route" ? (
            <Path d="M262 246 C 282 214, 300 196, 322 176 S 352 128, 344 66" stroke={route} strokeWidth={2} strokeDasharray="5 6" />
          ) : null}
        </G>
        {variant === "route" ? (
          <>
            <Circle cx={262} cy={246} r={5} fill={c.surface} stroke={c.primary} strokeWidth={2.5} />
            <G transform="translate(344 66)">
              <Path d={PIN} fill={c.primary} />
              <Circle cx={0} cy={-22} r={4.5} fill={c.surface} />
            </G>
          </>
        ) : (
          <>
            {/* a área (bairro e cidade), com o pino no centro */}
            <Circle
              cx={200}
              cy={150}
              r={64}
              fill={tint(c.primary, dark ? "1f" : "14")}
              stroke={tint(c.primary, dark ? "66" : "4d")}
              strokeWidth={1.5}
              strokeDasharray="4 5"
            />
            <G transform="translate(200 150)">
              <Path d={PIN} fill={c.primary} />
              <Circle cx={0} cy={-22} r={4.5} fill={c.surface} />
            </G>
          </>
        )}
      </Svg>
      <LinearGradient
        colors={[tint(c.canvas, "00"), c.canvas]}
        start={{ x: 0.5, y: 0.35 }}
        end={{ x: 0.5, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Desenho de fundo: não recebe toque.
  wrap: { position: "absolute", top: 0, left: 0, right: 0, overflow: "hidden", pointerEvents: "none" },
});
