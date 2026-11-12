import { useEffect } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { dismissSuccess, useSuccess, type SuccessMoment } from "../lib/success";
import { RADIUS, useStyles, useTheme, type Palette } from "../theme/theme";
import { Text } from "./Text";

const CHECK = 52;

/** Camada do "deu certo": círculo e check desenhado da esquerda para a direita. */
export function SuccessHost() {
  const moment = useSuccess();
  if (!moment) return null;
  return <SuccessOverlay key={moment.id} moment={moment} />;
}

function SuccessOverlay({ moment }: { moment: SuccessMoment }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const reduced = useReducedMotion();
  const ring = useSharedValue(reduced ? 1 : 0.6);
  const draw = useSharedValue(reduced ? 1 : 0);

  useEffect(() => {
    if (reduced) return;
    ring.set(withSpring(1, { damping: 12, stiffness: 190, mass: 0.7 }));
    draw.set(withDelay(150, withTiming(1, { duration: 380, easing: Easing.out(Easing.cubic) })));
  }, [reduced, ring, draw]);

  const ringStyle = useAnimatedStyle(() => ({ transform: [{ scale: ring.get() }] }));
  const drawStyle = useAnimatedStyle(() => ({ width: CHECK * draw.get() }));

  return (
    <Animated.View
      entering={reduced ? undefined : FadeIn.duration(140)}
      exiting={reduced ? undefined : FadeOut.duration(200)}
      style={styles.backdrop}
    >
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={() => dismissSuccess(moment.id)}
        accessibilityRole="button"
        accessibilityLabel="Fechar"
      />
      <View style={styles.card} accessibilityRole="alert" accessibilityLiveRegion="polite">
        <Animated.View style={[styles.circle, ringStyle]}>
          <View style={{ width: CHECK, height: CHECK }}>
            <Animated.View style={[styles.clip, drawStyle]}>
              <Svg width={CHECK} height={CHECK} viewBox="0 0 24 24" fill="none">
                <Path d="M5 12.5l4.5 4.5L19 7.5" stroke={c.success} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
              </Svg>
            </Animated.View>
          </View>
        </Animated.View>
        <Text style={styles.title}>{moment.title}</Text>
        {moment.description ? <Text style={styles.description}>{moment.description}</Text> : null}
      </View>
    </Animated.View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    backdrop: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.scheme === "dark" ? "rgba(0,0,0,0.55)" : "rgba(27,31,38,0.28)",
      padding: 24,
    },
    card: {
      alignItems: "center",
      gap: 8,
      paddingVertical: 28,
      paddingHorizontal: 32,
      minWidth: 240,
      maxWidth: 320,
      borderRadius: RADIUS.card,
      backgroundColor: c.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      boxShadow: c.scheme === "dark" ? undefined : "0px 8px 24px rgba(0, 0, 0, 0.10)",
    },
    circle: {
      width: 88,
      height: 88,
      borderRadius: 44,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.successSoft,
      marginBottom: 8,
    },
    clip: { height: CHECK, overflow: "hidden" },
    title: { fontSize: 17, fontWeight: "700", color: c.ink, textAlign: "center" },
    description: { fontSize: 13, color: c.inkMuted, textAlign: "center", lineHeight: 18 },
  });
