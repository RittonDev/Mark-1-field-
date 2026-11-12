import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from "react-native-reanimated";
import { FIELD_STEPS, fieldProgress } from "../lib/progress";
import type { TicketDetail } from "../lib/types";
import { BRAND_GRADIENT, useStyles, useTheme, type Palette } from "../theme/theme";
import { Icon } from "./Icon";
import { Pulse } from "./motion";
import { Text } from "./Text";

const DOT = 22;

/** Deslocamento → Chegada → Atendimento → Concluir, com a trilha preenchendo até a etapa atual. */
export function FieldStepper({ ticket }: { ticket: Pick<TicketDetail, "status" | "work_started_at" | "work_seconds"> }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const reduced = useReducedMotion();
  const progress = fieldProgress(ticket);
  const target = progress?.fill ?? 0;
  const [trackWidth, setTrackWidth] = useState(0);
  const fill = useSharedValue(0);

  useEffect(() => {
    fill.set(reduced ? target : withTiming(target, { duration: 650, easing: Easing.out(Easing.cubic) }));
  }, [target, reduced, fill]);

  const fillStyle = useAnimatedStyle(() => ({ width: trackWidth * fill.get() }));
  if (!progress) return null;
  const { reached, active, paused } = progress;
  const label = (i: number) =>
    i === reached && paused ? "Pausado" : i === reached && active ? "Agora" : i < reached || (i === reached && !active) ? "Feito" : "";

  return (
    <View
      style={styles.wrap}
      accessibilityRole="progressbar"
      accessibilityLabel={`Etapa do atendimento: ${reached < 0 ? "não iniciado" : FIELD_STEPS[reached]}${paused ? " (pausado)" : ""}`}
    >
      <View style={styles.track} onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}>
        <Animated.View style={[styles.fill, fillStyle]}>
          <LinearGradient colors={BRAND_GRADIENT} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={StyleSheet.absoluteFill} />
        </Animated.View>
      </View>
      {FIELD_STEPS.map((step, i) => {
        const done = i < reached || (i === reached && !active && !paused);
        const current = i === reached && (active || paused);
        const tone = paused && current ? c.warning : c.primary;
        return (
          <View key={step} style={styles.node}>
            <View
              style={[
                styles.dot,
                done
                  ? { backgroundColor: c.primary, borderColor: c.primary }
                  : current
                    ? { backgroundColor: c.surface, borderColor: tone }
                    : { backgroundColor: c.surface, borderColor: c.lineStrong },
              ]}
            >
              {done ? <Icon name="check" size={13} color={c.onPrimary} strokeWidth={2.6} /> : null}
              {current ? <Pulse color={tone} size={8} active={active} /> : null}
            </View>
            <Text style={[styles.step, done && styles.stepDone, current && { color: paused ? c.warning : c.brandInk, fontWeight: "700" }]}>
              {step}
            </Text>
            <Text style={styles.state}>{label(i)}</Text>
          </View>
        );
      })}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    wrap: { flexDirection: "row", paddingTop: 4 },
    // A trilha vai do centro do primeiro ponto ao centro do último (colunas de 25%).
    track: {
      position: "absolute",
      top: 4 + DOT / 2 - 1.5,
      left: "12.5%",
      right: "12.5%",
      height: 3,
      borderRadius: 2,
      backgroundColor: c.surface3,
      overflow: "hidden",
    },
    fill: { height: 3, borderRadius: 2, overflow: "hidden" },
    node: { flex: 1, alignItems: "center", gap: 6 },
    dot: {
      width: DOT,
      height: DOT,
      borderRadius: DOT / 2,
      borderWidth: 2,
      alignItems: "center",
      justifyContent: "center",
    },
    step: { fontSize: 12, fontWeight: "500", color: c.inkSubtle, textAlign: "center" },
    stepDone: { color: c.ink, fontWeight: "600" },
    state: { fontSize: 11, color: c.inkSubtle, minHeight: 14 },
  });
