import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useState } from "react";
import { StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { RADIUS, useStyles, useTheme, type Palette } from "../theme/theme";

/** Bloco de carregamento com brilho passando (no lugar de spinner). */
export function Skeleton({
  width = "100%",
  height = 14,
  radius = 6,
  style,
}: {
  width?: DimensionValue;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useTheme();
  const reduced = useReducedMotion();
  const [boxWidth, setBoxWidth] = useState(0);
  const progress = useSharedValue(0);

  useEffect(() => {
    if (reduced || !boxWidth) return;
    progress.set(withRepeat(withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.ease) }), -1, false));
    return () => cancelAnimation(progress);
  }, [reduced, boxWidth, progress]);

  const shine = useAnimatedStyle(() => ({
    transform: [{ translateX: -boxWidth + progress.get() * boxWidth * 2 }],
  }));
  const highlight = c.scheme === "dark" ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.7)";

  return (
    <View
      onLayout={(e) => setBoxWidth(e.nativeEvent.layout.width)}
      style={[{ width, height, borderRadius: radius, backgroundColor: c.surface3, overflow: "hidden" }, style]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {reduced || !boxWidth ? null : (
        <Animated.View style={[StyleSheet.absoluteFill, shine]}>
          <LinearGradient
            colors={["transparent", highlight, "transparent"]}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      )}
    </View>
  );
}

/** Cartões de OS enquanto a lista local carrega (mesmo desenho do cartão: código e hora, título, loja, endereço, selo). */
export function TicketListSkeleton({ count = 3 }: { count?: number }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.list} accessibilityLabel="Carregando suas OS" accessibilityRole="progressbar">
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={styles.card}>
          <View style={styles.row}>
            <Skeleton width={64} height={12} />
            <Skeleton width={56} height={14} />
          </View>
          <Skeleton width="80%" height={16} />
          <Skeleton width="60%" height={14} />
          <Skeleton width="75%" height={12} />
          <View style={styles.badges}>
            <Skeleton width={96} height={22} radius={RADIUS.chip} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** Detalhe da OS enquanto lê do banco local. */
export function DetailSkeleton() {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.list} accessibilityLabel="Carregando a OS" accessibilityRole="progressbar">
      <View style={styles.card}>
        <Skeleton width={90} height={12} />
        <Skeleton width="85%" height={20} />
        <Skeleton width="50%" height={12} />
        <Skeleton height={6} radius={3} style={{ marginTop: 8 }} />
      </View>
      <View style={styles.card}>
        <Skeleton width={120} height={12} />
        <Skeleton width="90%" height={14} />
        <Skeleton width="70%" height={14} />
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    list: { padding: 16, gap: 12 },
    card: {
      backgroundColor: c.surface,
      borderRadius: RADIUS.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      padding: 16,
      gap: 10,
    },
    row: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
    badges: { flexDirection: "row", gap: 6, marginTop: 2 },
  });
