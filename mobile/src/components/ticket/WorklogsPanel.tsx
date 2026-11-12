import { useStyles, useTheme, type Palette } from "../../theme/theme";
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "../Text";
import { errorMessage } from "../../lib/api";
import { useLiveQuery } from "../../lib/changes";
import { isStaff } from "../../lib/constants";
import { listWorklogs } from "../../lib/db";
import { formatDateTime, formatMinutes } from "../../lib/format";
import { enqueueWorklog } from "../../lib/sync";
import type { LocalTicket } from "../../lib/syncTypes";
import type { User } from "../../lib/types";
import { DateTimeField } from "../DateTimeField";
import { Badge, Button, Card, EmptyState, ErrorBox, Field, Input } from "../ui";

const QUICK_MINUTES = [15, 30, 60, 90, 120];

export function WorklogsPanel({ ticket, user }: { ticket: LocalTicket; user: User }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const load = useCallback(() => listWorklogs(ticket.id), [ticket.id]);
  const worklogs = useLiveQuery(load);
  const [description, setDescription] = useState("");
  const [startedAt, setStartedAt] = useState<Date | null>(null);
  const [minutes, setMinutes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const total = (worklogs ?? []).reduce((sum, w) => sum + w.minutes, 0);
  const canLog = isStaff(user.role) && ticket.status !== "closed" && ticket.status !== "cancelled";
  const minutesNumber = Number(minutes);
  const valid = description.trim().length > 0 && Number.isInteger(minutesNumber) && minutesNumber > 0 && minutesNumber <= 1440;

  async function save() {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      // Sem início informado, considera que a atividade terminou agora.
      const start = startedAt ?? new Date(Date.now() - minutesNumber * 60_000);
      await enqueueWorklog(ticket.id, {
        description: description.trim(),
        started_at: start.toISOString(),
        minutes: minutesNumber,
      });
      setDescription("");
      setMinutes("");
      setStartedAt(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={{ gap: 12 }}>
      <View style={styles.total}>
        <Text style={styles.totalLabel}>Tempo total apontado</Text>
        <Text style={styles.totalValue}>{formatMinutes(total)}</Text>
      </View>

      {worklogs === undefined ? null : worklogs.length === 0 ? (
        <EmptyState title="Nenhum apontamento registrado" />
      ) : (
        worklogs.map((w) => (
          <Card key={w.id} style={{ gap: 4 }}>
            <View style={styles.row}>
              <Text style={styles.who}>{w.user?.name ?? "—"}</Text>
              <Text style={styles.minutes}>{formatMinutes(w.minutes)}</Text>
            </View>
            <Text style={styles.date}>{formatDateTime(w.started_at)}</Text>
            {w.local_state === "pending" ? <Badge label="Aguardando envio" color={c.warning} /> : null}
            {w.local_state === "sent" ? <Badge label="Enviado" color={c.success} /> : null}
            <Text style={styles.description}>{w.description}</Text>
          </Card>
        ))
      )}

      {canLog ? (
        <Card style={{ gap: 12 }}>
          <Field label="Atividade executada" required>
            <Input
              value={description}
              onChangeText={setDescription}
              multiline
              placeholder="Ex.: Troca do fusor e teste de impressão"
            />
          </Field>
          <Field label="Duração (minutos)" required>
            <View style={styles.chips}>
              {QUICK_MINUTES.map((value) => (
                <Pressable
                  key={value}
                  onPress={() => setMinutes(String(value))}
                  style={[styles.chip, minutesNumber === value && styles.chipActive]}
                  accessibilityRole="button"
                >
                  <Text style={[styles.chipText, minutesNumber === value && styles.chipTextActive]}>{formatMinutes(value)}</Text>
                </Pressable>
              ))}
            </View>
            <Input value={minutes} onChangeText={setMinutes} keyboardType="number-pad" placeholder="Ex.: 45" maxLength={4} />
          </Field>
          <Field label="Início" hint="Se não informar, considera que a atividade terminou agora.">
            <DateTimeField value={startedAt} onChange={setStartedAt} placeholder="Agora menos a duração" clearable />
          </Field>
          {error ? <ErrorBox message={error} /> : null}
          <Button title="Apontar horas" variant="primary" onPress={save} loading={saving} disabled={!valid} />
        </Card>
      ) : null}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
  total: {
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: c.surface,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.line,
  },
  totalLabel: { color: c.inkMuted, fontSize: 14 },
  totalValue: { color: c.ink, fontSize: 14, fontWeight: "700" },
  row: { flexDirection: "row", justifyContent: "space-between" },
  who: { fontSize: 14, fontWeight: "600", color: c.ink },
  minutes: { fontSize: 14, fontWeight: "700", color: c.ink },
  date: { fontSize: 12, color: c.inkMuted },
  description: { fontSize: 15, color: c.ink, marginTop: 2 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: c.surface },
  chipActive: { borderColor: c.primary, backgroundColor: c.primarySoft },
  chipText: { fontSize: 13, color: c.ink },
  chipTextActive: { color: c.primary, fontWeight: "600" },
});
