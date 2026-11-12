import { router } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { actualMinutes } from "../lib/duration";
import { formatMinutes, formatRelative, formatShort, formatTime } from "../lib/format";
import type { LocalTicket } from "../lib/syncTypes";
import { PriorityBadge, SlaBadge, StatusBadge } from "./badges";
import { colors } from "./ui";

export function TicketCard({ ticket, now, showDate = false }: { ticket: LocalTicket; now: number; showDate?: boolean }) {
  const site = ticket.location ? [ticket.location.code, ticket.location.name].filter(Boolean).join(" ") : null;
  const place = [ticket.customer?.name, site].filter(Boolean).join(" · ");
  const due = ticket.resolution_due_at && !ticket.sla_paused_at ? `solução ${formatRelative(ticket.resolution_due_at, now)}` : null;
  // Duração estimada ajuda a planejar o dia; em atendimento, mostra o tempo real correndo.
  const duration = ticket.work_started_at
    ? `em atendimento ${formatMinutes(actualMinutes(ticket, now))}`
    : ticket.estimated_minutes
      ? `${formatMinutes(ticket.estimated_minutes)} estimados`
      : null;
  return (
    <Pressable
      onPress={() => router.push({ pathname: "/ticket/[id]", params: { id: ticket.id } })}
      accessibilityRole="button"
      accessibilityLabel={`${ticket.code}, ${ticket.title}`}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
    >
      <View style={styles.header}>
        <Text style={styles.code}>{ticket.code}</Text>
        {ticket.scheduled_start || duration ? (
          <Text style={[styles.schedule, ticket.work_started_at ? { color: colors.warning } : null]}>
            {[
              ticket.scheduled_start
                ? `Visita ${showDate ? formatShort(ticket.scheduled_start) : formatTime(ticket.scheduled_start)}`
                : null,
              duration,
            ]
              .filter(Boolean)
              .join(" · ")}
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
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    padding: 14,
    gap: 6,
  },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  code: { fontSize: 12, fontWeight: "700", color: colors.inkMuted, fontVariant: ["tabular-nums"] },
  schedule: { fontSize: 12, fontWeight: "600", color: colors.brand },
  title: { fontSize: 16, fontWeight: "600", color: colors.ink },
  place: { fontSize: 13, color: colors.inkMuted },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2 },
  footer: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 2 },
  due: { fontSize: 12, color: colors.inkMuted },
  pending: { fontSize: 12, fontWeight: "600", color: colors.warning },
});
