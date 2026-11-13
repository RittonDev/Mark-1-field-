import { useStyles, useTheme, type Palette } from "../theme/theme";
import { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "./Text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { errorMessage } from "../lib/api";
import { STATUS, TRANSITION_ACTION } from "../lib/constants";
import { currentPosition } from "../lib/device-actions";
import { enqueueTransition, isOnline, useSyncStatus } from "../lib/sync";
import type { LocalTicket } from "../lib/syncTypes";
import { haptic } from "../lib/haptics";
import { showSuccess } from "../lib/success";
import { showToast } from "../lib/toast";
import type { TicketStatus, TicketTransitionPayload } from "../lib/types";
import { transitionRequirements } from "../lib/workflow";
import { StatusBadge } from "./badges";
import { Button, ErrorBox, Field, Input, SwitchRow } from "./ui";

/**
 * Confirma a mudança de status pedindo só o que o destino exige (a solução, ao concluir), com o
 * GPS do check-in. O técnico nunca mexe no horário: agenda e prazos são da central.
 * A mudança entra na fila local e vale na hora, mesmo sem conexão.
 */
export function TransitionModal({ ticket, to, onClose }: { ticket: LocalTicket; to: TicketStatus; onClose: () => void }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const req = transitionRequirements(to);
  // GPS em deslocamento, atendimento e também ao resolver: o mapa de histórico do gestor usa esses pontos.
  const offersLocation = req.offersLocation || to === "resolved";
  const insets = useSafeAreaInsets();
  const online = isOnline(useSyncStatus());
  const [note, setNote] = useState("");
  const [resolution, setResolution] = useState("");
  const [shareLocation, setShareLocation] = useState(offersLocation);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setError(null);
    if (req.needsResolution && !resolution.trim()) return setError("Descreva a solução aplicada.");
    if (req.needsNote && !note.trim()) return setError("Informe o motivo.");

    setBusy(true);
    try {
      const payload: TicketTransitionPayload = { to_status: to, note: note.trim() || null };
      if (req.needsResolution) payload.resolution_notes = resolution.trim();
      let gpsFailed = false;
      if (offersLocation && shareLocation) {
        const position = await currentPosition();
        if (position) Object.assign(payload, position);
        else gpsFailed = true;
      }
      await enqueueTransition(ticket.id, payload);
      const warning = gpsFailed ? "Sem localização (permissão negada ou sem sinal de GPS)." : null;
      const offline = online ? undefined : "Salvo no aparelho; será enviado quando houver conexão.";
      if (to === "resolved" || to === "closed") {
        // Fim do atendimento: o check animado no lugar do aviso comum.
        haptic.success();
        showSuccess(to === "resolved" ? "OS concluída" : "OS fechada", offline ?? `${ticket.code} enviada para a central.`);
        if (warning) showToast(ticket.code, { tone: "info", description: warning });
      } else {
        // Iniciar deslocamento e o check-in (iniciar atendimento) vibram como passo do atendimento.
        if (to === "en_route" || to === "in_progress") haptic.step();
        showToast(`${ticket.code} → ${STATUS[to].label}`, { tone: "success", description: warning ?? offline });
      }
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.canvas }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
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
          {offersLocation ? (
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
            title={busy && offersLocation && shareLocation ? "Obtendo GPS…" : "Confirmar"}
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

const makeStyles = (c: Palette) =>
  StyleSheet.create({
  header: {
    paddingHorizontal: 20,
    paddingBottom: 14,
    gap: 8,
    backgroundColor: c.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.line,
  },
  title: { fontSize: 20, fontWeight: "700", color: c.ink },
  flow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
  code: { fontSize: 12, fontWeight: "700", color: c.inkMuted },
  arrow: { color: c.inkMuted },
  description: { fontSize: 13, color: c.inkMuted },
  body: { padding: 20, gap: 16 },
  footer: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 12,
    backgroundColor: c.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.line,
  },
});
