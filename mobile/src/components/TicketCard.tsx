import { router } from "expo-router";
import { StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { STATUS } from "../lib/constants";
import { addressOf } from "../lib/device-actions";
import { actualMinutes } from "../lib/duration";
import { arrivalUrgency } from "../lib/field";
import { isHelper } from "../lib/lists";
import { useSession } from "../lib/session";
import { formatMinutes, formatShort, formatTime } from "../lib/format";
import type { LocalTicket } from "../lib/syncTypes";
import { RADIUS, readable, useStyles, useTheme, type Palette } from "../theme/theme";
import { StatusBadge } from "./badges";
import { Icon } from "./Icon";
import { PressableScale, useSwapMotion } from "./motion";
import { Text } from "./Text";
import { AuthorizationBadge, FieldClockLine } from "./ticket/FieldClock";
import { HelperBadge } from "./ticket/VisitInfo";

const IN_FIELD = ["en_route", "in_progress"];

/** Cartão da OS: cliente, endereço e selo de status (troca animada quando o status muda). */
export function TicketCard({
  ticket,
  now,
  showDate = false,
  showTime = true,
}: {
  ticket: LocalTicket;
  now: number;
  showDate?: boolean;
  showTime?: boolean;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const swap = useSwapMotion();
  const { user } = useSession();
  const helping = Boolean(user && isHelper(ticket, user));
  const site = ticket.location ? [ticket.location.code, ticket.location.name].filter(Boolean).join(" ") : null;
  const client = [ticket.customer?.name, site].filter(Boolean).join(" · ");
  const address = ticket.service_address?.trim() || addressOf(ticket.location);
  // Em atendimento, o tempo dele correndo; antes, o horário da visita (até que horas).
  const until = ticket.scheduled_end ? `até ${formatTime(ticket.scheduled_end)}` : null;
  const duration = ticket.work_started_at ? `em atendimento ${formatMinutes(actualMinutes(ticket, now))}` : until;
  const when = [
    showTime && ticket.scheduled_start ? (showDate ? formatShort(ticket.scheduled_start) : formatTime(ticket.scheduled_start)) : null,
    duration,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <PressableScale
      onPress={() => router.push({ pathname: "/ticket/[id]", params: { id: ticket.id } })}
      accessibilityRole="button"
      accessibilityLabel={`${ticket.code}, ${ticket.title}, ${STATUS[ticket.status]?.label ?? ticket.status}`}
      style={styles.card}
      pressedStyle={{ backgroundColor: c.surface2 }}
    >
      <View style={[styles.accent, { backgroundColor: readable(STATUS[ticket.status]?.color ?? c.primary, c) }]} />
      <View style={styles.body}>
        <View style={styles.header}>
          <Text style={[styles.code, { flexShrink: 1 }]} numberOfLines={1}>
            {ticket.code}
          </Text>
          {when ? (
            <Text style={[styles.schedule, ticket.work_started_at ? { color: c.warning } : null]} numberOfLines={1}>
              {when}
            </Text>
          ) : null}
        </View>
        <Text style={styles.title} numberOfLines={2}>
          {ticket.title}
        </Text>
        {client ? (
          <View style={styles.line}>
            <Icon name="building" size={14} color={c.inkSubtle} />
            <Text style={styles.lineText} numberOfLines={1}>
              {client}
            </Text>
          </View>
        ) : null}
        {address ? (
          <View style={styles.line}>
            <Icon name="pin" size={14} color={c.inkSubtle} />
            <Text style={styles.lineText} numberOfLines={1}>
              {address}
            </Text>
          </View>
        ) : null}
        <FieldClockLine ticket={ticket} now={now} />
        <View style={styles.badges}>
          <Animated.View key={ticket.status} entering={swap.entering} exiting={swap.exiting}>
            <StatusBadge status={ticket.status} />
          </Animated.View>
          {helping ? <HelperBadge /> : null}
          <AuthorizationBadge status={ticket.authorization_status} />
        </View>
        {ticket.pending_ops ? (
          <View style={styles.footer}>
            <View />
            <Text style={styles.pending}>
              {ticket.pending_ops === 1 ? "1 ação aguardando envio" : `${ticket.pending_ops} ações aguardando envio`}
            </Text>
          </View>
        ) : null}
      </View>
    </PressableScale>
  );
}

/** Linha do tempo de Hoje: horário à esquerda, trilho com ponto e o cartão. */
export function TimelineRow({ ticket, now, last }: { ticket: LocalTicket; now: number; last: boolean }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const inField = IN_FIELD.includes(ticket.status);
  // Chegada atrasada/em risco também marca o trilho (a lista de Hoje vem por urgência).
  const urgency = arrivalUrgency(ticket, now);
  const dot = urgency === 0 ? c.danger : urgency === 1 || inField ? c.warning : ticket.scheduled_start ? c.primary : c.lineStrong;
  return (
    <View style={styles.timelineRow}>
      <View style={styles.rail}>
        <Text style={[styles.railTime, !ticket.scheduled_start && styles.railNoTime]}>
          {ticket.scheduled_start ? formatTime(ticket.scheduled_start) : "Sem hora"}
        </Text>
        <View style={[styles.railDot, { borderColor: dot, backgroundColor: inField || urgency === 0 ? dot : c.canvas }]} />
        {last ? null : <View style={styles.railLine} />}
      </View>
      <View style={styles.timelineCard}>
        <TicketCard ticket={ticket} now={now} showTime={false} />
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    card: {
      flexDirection: "row",
      backgroundColor: c.surface,
      borderRadius: RADIUS.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      overflow: "hidden",
      boxShadow: c.elevation,
    },
    accent: { width: 3 },
    body: { flex: 1, padding: 16, paddingLeft: 14, gap: 6 },
    header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
    code: { fontSize: 12, fontWeight: "700", color: c.inkMuted, fontVariant: ["tabular-nums"], letterSpacing: 0.3 },
    schedule: { fontSize: 12, fontWeight: "600", color: c.brandInk, flexShrink: 1, fontVariant: ["tabular-nums"] },
    title: { fontSize: 16, fontWeight: "600", color: c.ink, lineHeight: 22 },
    line: { flexDirection: "row", alignItems: "center", gap: 6 },
    lineText: { fontSize: 13, color: c.inkMuted, flex: 1 },
    badges: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 },
    footer: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 2 },
    pending: { fontSize: 12, fontWeight: "600", color: c.warning },
    timelineRow: { flexDirection: "row", gap: 12 },
    rail: { width: 52, alignItems: "center", paddingTop: 16 },
    railTime: { fontSize: 13, fontWeight: "700", color: c.ink, fontVariant: ["tabular-nums"] },
    railNoTime: { fontSize: 11, fontWeight: "600", color: c.inkSubtle },
    railDot: { width: 10, height: 10, borderRadius: 5, borderWidth: 2, marginTop: 8 },
    railLine: { flex: 1, width: 2, backgroundColor: c.line, marginTop: 4, marginBottom: -12, borderRadius: 1 },
    timelineCard: { flex: 1, paddingBottom: 12 },
  });
