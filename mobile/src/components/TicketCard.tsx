import { router } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { PRIORITY } from "../lib/constants";
import { actualMinutes } from "../lib/duration";
import { formatMinutes, formatRelative, formatShort, formatTime } from "../lib/format";
import type { LocalTicket } from "../lib/syncTypes";
import { readable, useStyles, useTheme, type Palette } from "../theme/theme";
import { PriorityBadge, ProjectBadge, SlaBadge, StatusBadge } from "./badges";

export function TicketCard({ ticket, now, showDate = false }: { ticket: LocalTicket; now: number; showDate?: boolean }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const site = ticket.location ? [ticket.location.code, ticket.location.name].filter(Boolean).join(" ") : null;
  const place = [ticket.customer?.name, site].filter(Boolean).join(" · ");
  const due = ticket.resolution_due_at && !ticket.sla_paused_at ? `solução ${formatRelative(ticket.resolution_due_at, now)}` : null;
  // Duração estimada ajuda a planejar o dia; em atendimento, mostra o tempo real correndo.
  const duration = ticket.work_started_at
    ? `em atendimento ${formatMinutes(actualMinutes(ticket, now))}`
    : ticket.estimated_minutes
      ? `${formatMinutes(ticket.estimated_minutes)} estimados`
      : null;
  const when = [
    ticket.scheduled_start ? `Visita ${showDate ? formatShort(ticket.scheduled_start) : formatTime(ticket.scheduled_start)}` : null,
    duration,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Pressable
      onPress={() => router.push({ pathname: "/ticket/[id]", params: { id: ticket.id } })}
      accessibilityRole="button"
      accessibilityLabel={`${ticket.code}, ${ticket.title}`}
      style={({ pressed }) => [styles.card, pressed && { backgroundColor: c.surface2 }]}
    >
      <View style={[styles.accent, { backgroundColor: readable(PRIORITY[ticket.priority].color, c) }]} />
      <View style={styles.body}>
        <View style={styles.header}>
          <Text style={styles.code}>{ticket.code}</Text>
          {when ? (
            <Text style={[styles.schedule, ticket.work_started_at ? { color: c.warning } : null]} numberOfLines={1}>
              {when}
            </Text>
          ) : null}
        </View>
        <Text style={styles.title} numberOfLines={2}>
          {ticket.title}
        </Text>
        {place ? (
          <Text style={styles.place} numberOfLines={1}>
            {place}
          </Text>
        ) : null}
        <View style={styles.badges}>
          <StatusBadge status={ticket.status} />
          <PriorityBadge priority={ticket.priority} />
          <SlaBadge ticket={ticket} now={now} />
          <ProjectBadge project={ticket.project} />
        </View>
        {due || ticket.pending_ops ? (
          <View style={styles.footer}>
            {due ? <Text style={styles.due}>{due}</Text> : <View />}
            {ticket.pending_ops ? (
              <Text style={styles.pending}>
                {ticket.pending_ops === 1 ? "1 ação aguardando envio" : `${ticket.pending_ops} ações aguardando envio`}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    card: {
      flexDirection: "row",
      backgroundColor: c.surface,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      overflow: "hidden",
      shadowColor: c.shadow,
      shadowOpacity: c.scheme === "dark" ? 0 : 0.04,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 2 },
      elevation: c.scheme === "dark" ? 0 : 1,
    },
    accent: { width: 4 },
    body: { flex: 1, padding: 14, gap: 6 },
    header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
    code: { fontSize: 12, fontWeight: "700", color: c.inkMuted, fontVariant: ["tabular-nums"], letterSpacing: 0.3 },
    schedule: { fontSize: 12, fontWeight: "600", color: c.primary, flexShrink: 1 },
    title: { fontSize: 16, fontWeight: "600", color: c.ink, lineHeight: 21 },
    place: { fontSize: 13, color: c.inkMuted },
    badges: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2 },
    footer: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 2 },
    due: { fontSize: 12, color: c.inkMuted },
    pending: { fontSize: 12, fontWeight: "600", color: c.warning },
  });
