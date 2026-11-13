import { StyleSheet, View } from "react-native";
import { actualMinutes } from "../../lib/duration";
import { formatDateTime, formatMinutes } from "../../lib/format";
import type { LocalTicket } from "../../lib/syncTypes";
import { useStyles, useTheme, type Palette } from "../../theme/theme";
import { Icon } from "../Icon";
import { Text } from "../Text";
import { Card, InfoRow } from "../ui";

/**
 * Tempo do atendimento, só para ver. O técnico nunca mexe no horário: o tempo começa quando ele
 * inicia o atendimento e só para quando conclui a OS. Agenda e ajustes de horário são da central.
 */
export function TimePanel({ ticket, now }: { ticket: LocalTicket; now: number }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const running = Boolean(ticket.work_started_at);
  const minutes = actualMinutes(ticket, now);
  const started = ticket.arrived_at ?? ticket.work_started_at;
  return (
    <View style={{ gap: 12 }}>
      <Card style={{ gap: 6 }}>
        <Text style={styles.label}>Tempo de atendimento</Text>
        <View style={styles.totalRow}>
          <Text style={[styles.total, running && { color: c.warning }]}>
            {started ? formatMinutes(minutes) : "Não iniciado"}
          </Text>
          {running ? <Text style={[styles.running, { color: c.warning }]}>correndo</Text> : null}
        </View>
        {started ? <InfoRow label="Início" value={formatDateTime(started)} /> : null}
        {ticket.resolved_at ? <InfoRow label="Conclusão" value={formatDateTime(ticket.resolved_at)} /> : null}
      </Card>
      <View style={styles.note}>
        <Icon name="clock" size={16} color={c.inkSubtle} />
        <Text style={styles.noteText}>
          O tempo começa quando você inicia o atendimento e para quando conclui a OS. Horários e agenda são
          ajustados só pela central.
        </Text>
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    label: { fontSize: 12, fontWeight: "700", color: c.inkMuted, textTransform: "uppercase", letterSpacing: 0.4 },
    totalRow: { flexDirection: "row", alignItems: "baseline", gap: 8 },
    total: { fontSize: 28, fontWeight: "700", color: c.ink, fontVariant: ["tabular-nums"] },
    running: { fontSize: 13, fontWeight: "700" },
    note: { flexDirection: "row", gap: 8, alignItems: "flex-start", paddingHorizontal: 4 },
    noteText: { flex: 1, fontSize: 13, color: c.inkMuted, lineHeight: 18 },
  });
