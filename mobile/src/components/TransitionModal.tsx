import { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { errorMessage } from "../lib/api";
import { STATUS, TRANSITION_ACTION } from "../lib/constants";
import { currentPosition } from "../lib/device-actions";
import { enqueueTransition, isOnline, useSyncStatus } from "../lib/sync";
import type { LocalTicket } from "../lib/syncTypes";
import { showToast } from "../lib/toast";
import type { TicketStatus, TicketTransitionPayload } from "../lib/types";
import { transitionRequirements } from "../lib/workflow";
import { StatusBadge } from "./badges";
import { DateTimeField } from "./DateTimeField";
import { Button, colors, ErrorBox, Field, Input, SwitchRow } from "./ui";

/**
 * Confirma a mudança de status pedindo só o que o destino exige
 * (agenda, solução, motivo), como o TransitionDialog da web.
 * A mudança entra na fila local e vale na hora, mesmo sem conexão.
 */
export function TransitionModal({ ticket, to, onClose }: { ticket: LocalTicket; to: TicketStatus; onClose: () => void }) {
  const req = transitionRequirements(to);
  const insets = useSafeAreaInsets();
  const online = isOnline(useSyncStatus());
  const [note, setNote] = useState("");
  const [resolution, setResolution] = useState("");
  const [start, setStart] = useState<Date | null>(() => (ticket.scheduled_start ? new Date(ticket.scheduled_start) : null));
  const [end, setEnd] = useState<Date | null>(() => (ticket.scheduled_end ? new Date(ticket.scheduled_end) : null));
  const [shareLocation, setShareLocation] = useState(req.offersLocation);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setError(null);
    if (req.needsSchedule && !start) return setError("Informe a data e hora da visita.");
    if (req.needsSchedule && start && end && end <= start) return setError("O fim previsto deve ser depois do início.");
    if (req.needsResolution && !resolution.trim()) return setError("Descreva a solução aplicada.");
    if (req.needsNote && !note.trim()) return setError("Informe o motivo.");

    setBusy(true);
    try {
      const payload: TicketTransitionPayload = { to_status: to, note: note.trim() || null };
      if (req.needsResolution) payload.resolution_notes = resolution.trim();
      if (req.needsSchedule && start) {
        payload.scheduled_start = start.toISOString();
        payload.scheduled_end = end ? end.toISOString() : null;
      }
      let gpsFailed = false;
      if (req.offersLocation && shareLocation) {
        const position = await currentPosition();
        if (position) Object.assign(payload, position);
        else gpsFailed = true;
      }
      await enqueueTransition(ticket.id, payload);
      showToast(`${ticket.code} → ${STATUS[to].label}`, {
        tone: "success",
        description: gpsFailed
          ? "Sem localização (permissão negada ou sem sinal de GPS)."
          : online
            ? undefined
            : "Salvo no aparelho; será enviado quando houver conexão.",
      });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.canvas }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={[styles.header, { paddingTop: Platform.OS === "android" ? insets.top + 12 : 20 }]}>
          <Text style={styles.title}>{TRANSITION_ACTION[to]}</Text>
          <View style={styles.flow}>
            <Text style={styles.code}>{ticket.code}</Text>
            <StatusBadge status={ticket.status} />
            <Text style={styles.arrow}>→</Text>
            <StatusBadge status={to} />
          </View>
          <Text style={styles.description}>{STATUS[to].description}</Text>
        </View>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {req.needsSchedule ? (
            <>
              <Field label="Início da visita" required>
                <DateTimeField value={start} onChange={setStart} />
              </Field>
              <Field label="Fim previsto">
                <DateTimeField value={end} onChange={setEnd} minimumDate={start ?? undefined} clearable />
              </Field>
            </>
          ) : null}
          {req.needsResolution ? (
            <Field label="Solução aplicada" required hint="Fica visível para o solicitante e no histórico da OS.">
              <Input value={resolution} onChangeText={setResolution} multiline placeholder="O que foi feito para resolver?" />
            </Field>
          ) : null}
          <Field label={req.needsNote ? "Motivo" : "Observação"} required={req.needsNote}>
            <Input
              value={note}
              onChangeText={setNote}
              multiline
              placeholder={req.needsNote ? "Explique o motivo" : "Opcional"}
            />
          </Field>
          {req.offersLocation ? (
            <SwitchRow
              label="Registrar minha localização"
              hint="Check-in de campo por GPS (funciona sem internet)."
              value={shareLocation}
              onValueChange={setShareLocation}
            />
          ) : null}
          {error ? <ErrorBox message={error} /> : null}
        </ScrollView>
        <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
          <Button title="Voltar" onPress={onClose} style={{ flex: 1 }} disabled={busy} />
          <Button
            title={busy && req.offersLocation && shareLocation ? "Obtendo GPS…" : "Confirmar"}
            variant={to === "cancelled" ? "danger" : "primary"}
            onPress={confirm}
            loading={busy}
            style={{ flex: 1 }}
          />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: 20,
    paddingBottom: 14,
    gap: 8,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  title: { fontSize: 20, fontWeight: "700", color: colors.ink },
  flow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
  code: { fontSize: 12, fontWeight: "700", color: colors.inkMuted },
  arrow: { color: colors.inkMuted },
  description: { fontSize: 13, color: colors.inkMuted },
  body: { padding: 20, gap: 16 },
  footer: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 12,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
});
