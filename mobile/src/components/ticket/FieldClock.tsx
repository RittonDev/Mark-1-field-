import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { Easing, useAnimatedProps, useReducedMotion, useSharedValue, withTiming } from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";
import { getKv, setKv } from "../../lib/db";
import {
  arrivalClock,
  arrivalResult,
  onsiteClock,
  type ClockTone,
  type OnsiteState,
} from "../../lib/field";
import { formatMinutes, formatTime } from "../../lib/format";
import { haptic } from "../../lib/haptics";
import type { TicketDetail, TicketListItem } from "../../lib/types";
import { RADIUS, tint, useStyles, useTheme, type Palette } from "../../theme/theme";
import { Icon } from "../Icon";
import { Text } from "../Text";

type Clockable = Pick<
  TicketListItem,
  "status" | "arrival_due_at" | "arrived_at" | "onsite_due_at" | "arrival_status" | "onsite_status"
>;

function toneColor(c: Palette, tone: ClockTone | OnsiteState) {
  return tone === "late" || tone === "over" ? c.danger : tone === "risk" || tone === "warning" ? c.warning : c.inkMuted;
}

/**
 * Uma linha com o relógio de campo, para o cartão e o cabeçalho da OS:
 * antes da chegada, "Chegar até 14:35 · faltam 52 min"; na loja, "Na loja 1h 20min · restam 2h 40min".
 */
export function FieldClockLine({ ticket, now, size = 13 }: { ticket: Clockable; now: number; size?: number }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const arrival = arrivalClock(ticket, now);
  if (arrival) {
    const color = toneColor(c, arrival.tone);
    const text =
      arrival.left < 0
        ? `Chegada atrasada ${formatMinutes(-arrival.left)} · prazo ${formatTime(arrival.dueAt)}`
        : `Chegar até ${formatTime(arrival.dueAt)} · faltam ${formatMinutes(arrival.left)}`;
    return (
      <View style={styles.line} accessibilityLabel={text}>
        <Icon name="clock" size={size + 1} color={color} strokeWidth={2} />
        <Text style={[styles.lineText, { fontSize: size, color, fontWeight: arrival.tone === "normal" ? "600" : "700" }]}>{text}</Text>
      </View>
    );
  }
  const onsite = onsiteClock(ticket, now);
  if (onsite) {
    const color = onsite.state === "ok" ? c.inkMuted : toneColor(c, onsite.state);
    const text = `Na loja ${formatMinutes(onsite.elapsed)} · ${onsite.left <= 0 ? `passou ${formatMinutes(-onsite.left)}` : `restam ${formatMinutes(onsite.left)}`}`;
    return (
      <View style={styles.line} accessibilityLabel={text}>
        <Icon name="hourglass" size={size + 1} color={color} strokeWidth={2} />
        <Text style={[styles.lineText, { fontSize: size, color, fontWeight: onsite.state === "ok" ? "600" : "700" }]}>{text}</Text>
      </View>
    );
  }
  return null;
}

/** "Chegou 13:42 · no prazo" depois do check-in. */
export function ArrivalResult({ ticket }: { ticket: Clockable }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const result = arrivalResult(ticket);
  if (!result) return null;
  const color = result.late ? c.danger : c.success;
  return (
    <View style={styles.line}>
      <Icon name="pin" size={14} color={color} strokeWidth={2} />
      <Text style={[styles.lineText, { color, fontWeight: "600" }]}>
        Chegou {formatTime(result.at)} · {result.late ? "com atraso" : "no prazo"}
      </Text>
    </View>
  );
}

const RING = 64;
const STROKE = 6;
const RADIUS_RING = (RING - STROKE) / 2;
const CIRC = 2 * Math.PI * RADIUS_RING;
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/** Tempo do chamado na loja: anel da chegada até o limite (4h), com o que resta no centro. */
export function OnsiteTimer({ ticket, now }: { ticket: Clockable & Pick<TicketDetail, "id" | "code">; now: number }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const reduced = useReducedMotion();
  const clock = onsiteClock(ticket, now);
  const ratio = clock?.ratio ?? 0;
  const progress = useSharedValue(0);
  const state = clock?.state ?? "ok";

  useEffect(() => {
    progress.set(reduced ? ratio : withTiming(ratio, { duration: 700, easing: Easing.out(Easing.cubic) }));
  }, [ratio, reduced, progress]);

  // Vibra uma vez ao entrar no aviso (faltando 30 min) e uma vez no estouro, mesmo reabrindo a tela.
  useEffect(() => {
    if (state === "ok") return;
    const key = `onsite_alert:${ticket.id}:${state}`;
    let alive = true;
    void getKv(key).then((done) => {
      if (!alive || done) return;
      haptic.warning();
      void setKv(key, new Date().toISOString());
    });
    return () => {
      alive = false;
    };
  }, [state, ticket.id]);

  const ringProps = useAnimatedProps(() => ({ strokeDashoffset: CIRC * (1 - progress.get()) }));
  if (!clock) return null;
  const color = state === "over" ? c.danger : state === "warning" ? c.warning : c.primary;
  const center = clock.left <= 0 ? `+${formatMinutes(-clock.left)}` : formatMinutes(clock.left);

  return (
    <View style={{ gap: 10 }}>
      <View style={styles.timer} accessibilityRole="progressbar" accessibilityLabel={`Tempo na loja: restam ${formatMinutes(clock.left)}`}>
        <View style={styles.ring}>
          <Svg width={RING} height={RING} viewBox={`0 0 ${RING} ${RING}`}>
            <Circle cx={RING / 2} cy={RING / 2} r={RADIUS_RING} stroke={c.surface3} strokeWidth={STROKE} fill="none" />
            <AnimatedCircle
              cx={RING / 2}
              cy={RING / 2}
              r={RADIUS_RING}
              stroke={color}
              strokeWidth={STROKE}
              strokeLinecap="round"
              fill="none"
              strokeDasharray={`${CIRC} ${CIRC}`}
              animatedProps={ringProps}
              transform={`rotate(-90 ${RING / 2} ${RING / 2})`}
            />
          </Svg>
          <View style={styles.ringCenter}>
            <Text style={[styles.ringValue, { color: state === "ok" ? c.ink : color }]} numberOfLines={1} adjustsFontSizeToFit>
              {center}
            </Text>
          </View>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.eyebrow}>TEMPO DO CHAMADO NA LOJA</Text>
          <Text style={[styles.timerMain, { color: state === "ok" ? c.ink : color }]}>
            {clock.left <= 0 ? `Passou ${formatMinutes(-clock.left)} do limite` : `Restam ${formatMinutes(clock.left)}`}
          </Text>
          <Text style={styles.timerSub}>
            {formatMinutes(clock.elapsed)} na loja de {formatMinutes(clock.total)} · limite {formatTime(ticket.onsite_due_at ?? null)}
          </Text>
        </View>
      </View>
      {state !== "ok" ? (
        <View style={[styles.banner, { backgroundColor: state === "over" ? c.dangerSoft : c.warningSoft, borderColor: tint(color, "55") }]}>
          <Icon name="alert" size={18} color={color} strokeWidth={2} />
          <Text style={[styles.bannerText, { color }]}>
            {state === "over"
              ? `Tempo do chamado esgotado: avise o analista no grupo antes de continuar.`
              : `Faltam ${formatMinutes(clock.left)} do tempo do chamado: avise o analista no grupo.`}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    line: { flexDirection: "row", alignItems: "center", gap: 6 },
    lineText: { fontSize: 13, color: c.inkMuted, flexShrink: 1, fontVariant: ["tabular-nums"] },
    timer: { flexDirection: "row", alignItems: "center", gap: 14 },
    ring: { width: RING, height: RING, alignItems: "center", justifyContent: "center" },
    ringCenter: { position: "absolute", left: 8, right: 8, alignItems: "center" },
    ringValue: { fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] },
    eyebrow: { fontSize: 11, fontWeight: "700", color: c.inkSubtle, letterSpacing: 0.6 },
    timerMain: { fontSize: 17, fontWeight: "700", fontVariant: ["tabular-nums"] },
    timerSub: { fontSize: 12, color: c.inkMuted, fontVariant: ["tabular-nums"] },
    banner: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 8,
      padding: 12,
      borderRadius: RADIUS.control,
      borderWidth: StyleSheet.hairlineWidth,
    },
    bannerText: { fontSize: 13, fontWeight: "700", lineHeight: 18, flex: 1 },
  });
