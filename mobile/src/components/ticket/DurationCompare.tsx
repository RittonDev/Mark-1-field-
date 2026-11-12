import { StyleSheet, Text, View } from "react-native";
import { durationSummary } from "../../lib/duration";
import { formatMinutes } from "../../lib/format";
import type { TicketDetail } from "../../lib/types";
import { colors } from "../ui";

/**
 * "Estimada 20min · Real 3h 55min · 11,8× o estimado", como o DurationCompare da web.
 * Em atendimento, o real conta com o relógio do aparelho (funciona offline).
 */
export function DurationCompare({ ticket, now }: { ticket: TicketDetail; now: number }) {
  const d = durationSummary(ticket, now);
  return (
    <View style={styles.box} accessibilityLabel="Duração estimada e real">
      <View style={styles.row}>
        <Text style={styles.label}>Estimada</Text>
        <Text style={styles.value}>{d.estimated ? formatMinutes(d.estimated) : "—"}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.label}>Real</Text>
        <Text style={styles.value}>
          {d.actual > 0 || d.running ? formatMinutes(d.actual) : "—"}
          {d.running ? <Text style={styles.running}>  em atendimento</Text> : null}
        </Text>
      </View>
      {d.ratioText ? <Text style={[styles.ratio, d.over && styles.over]}>{d.ratioText}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 4, paddingVertical: 6 },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  label: { fontSize: 14, color: colors.inkMuted },
  value: { fontSize: 15, fontWeight: "600", color: colors.ink, fontVariant: ["tabular-nums"] },
  running: { fontSize: 12, fontWeight: "600", color: colors.warning },
  ratio: { fontSize: 13, color: colors.inkMuted, textAlign: "right" },
  over: { color: colors.danger, fontWeight: "700" },
});
