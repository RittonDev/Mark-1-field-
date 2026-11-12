import { LinearGradient } from "expo-linear-gradient";
import { StyleSheet, View } from "react-native";
import Svg, { Circle, G, Path } from "react-native-svg";
import { tint, useTheme } from "../theme/theme";

/**
 * Fundo do login: ruas em traço fino, uma rota tracejada e dois pinos, em tons da marca bem
 * suaves. Some em direção ao conteúdo (sem manchas de degradê).
 */
export function RouteMapPattern({ height = 300 }: { height?: number }) {
  const c = useTheme();
  const street = tint(c.primary, c.scheme === "dark" ? "24" : "1c");
  const avenue = tint(c.primary, c.scheme === "dark" ? "33" : "26");
  const route = tint(c.primary, c.scheme === "dark" ? "99" : "80");
  return (
    <View pointerEvents="none" style={[styles.wrap, { height }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
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
          <Path d="M262 246 C 282 214, 300 196, 322 176 S 352 128, 344 66" stroke={route} strokeWidth={2} strokeDasharray="5 6" />
        </G>
        <Circle cx={262} cy={246} r={5} fill={c.surface} stroke={c.primary} strokeWidth={2.5} />
        <G transform="translate(344 66)">
          <Path d="M0 0 C -9 -10, -12 -16, -12 -22 A 12 12 0 1 1 12 -22 C 12 -16, 9 -10, 0 0 Z" fill={c.primary} />
          <Circle cx={0} cy={-22} r={4.5} fill={c.surface} />
        </G>
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
  wrap: { position: "absolute", top: 0, left: 0, right: 0, overflow: "hidden" },
});
