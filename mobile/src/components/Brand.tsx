import { LinearGradient } from "expo-linear-gradient";
import { Image, StyleSheet, Text, View } from "react-native";
import { BRAND_GRADIENT, useTheme } from "../theme/theme";

const MARK = require("../../assets/brand/maxxfield-mark.png");

/** Faixa em degradê da marca (o sublinhado da logo), usada como detalhe. */
export function BrandRule({ width = 40, height = 3 }: { width?: number | `${number}%`; height?: number }) {
  return (
    <LinearGradient
      colors={BRAND_GRADIENT}
      start={{ x: 0, y: 0.5 }}
      end={{ x: 1, y: 0.5 }}
      style={{ width, height, borderRadius: height }}
    />
  );
}

/** Logo Maxx Field: símbolo + "Maxx" (semibold) "Field" (regular) + sublinhado em degradê. */
export function BrandLogo({ size = "md", underline = true }: { size?: "sm" | "md" | "lg"; underline?: boolean }) {
  const c = useTheme();
  const scale = { sm: 0.8, md: 1, lg: 1.5 }[size];
  const markHeight = 22 * scale;
  return (
    <View accessibilityRole="header" accessibilityLabel="Maxx Field" style={{ alignItems: "flex-start" }}>
      <View style={[styles.row, { gap: 8 * scale }]}>
        <Image source={MARK} style={{ height: markHeight, width: markHeight * 1.85 }} resizeMode="contain" />
        <Text style={[styles.word, { fontSize: 20 * scale, color: c.ink }]}>
          <Text style={styles.strong}>Maxx</Text> Field
        </Text>
      </View>
      {underline ? (
        <View style={{ marginTop: 6 * scale, marginLeft: markHeight * 1.85 + 8 * scale }}>
          <BrandRule width={44 * scale} height={3 * scale} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
  word: { fontWeight: "400", letterSpacing: -0.2 },
  strong: { fontWeight: "600" },
});
