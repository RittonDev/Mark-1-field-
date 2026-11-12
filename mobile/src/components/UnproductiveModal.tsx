import { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "./Text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { errorMessage } from "../lib/api";
import { useLiveQuery } from "../lib/changes";
import { RESPONSIBILITY } from "../lib/constants";
import { getUnproductiveReasons } from "../lib/db";
import { currentPosition } from "../lib/device-actions";
import { enqueueUnproductive, isOnline, useSyncStatus } from "../lib/sync";
import type { LocalTicket } from "../lib/syncTypes";
import { showToast } from "../lib/toast";
import { readable, useStyles, useTheme, type Palette } from "../theme/theme";
import { Button, ErrorBox, Field, Input, SwitchRow } from "./ui";

/**
 * Visita improdutiva: o técnico foi ao local e não conseguiu atender. A OS volta para
 * "Atribuído" sem agenda (a central reagenda) e o motivo vai para o histórico, com GPS.
 * Vai pela fila de sync: funciona offline.
 */
export function UnproductiveModal({ ticket, onClose }: { ticket: LocalTicket; onClose: () => void }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const online = isOnline(useSyncStatus());
  const reasons = useLiveQuery(getUnproductiveReasons) ?? [];
  const [reasonId, setReasonId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [shareLocation, setShareLocation] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setError(null);
    if (!reasonId) return setError("Escolha o motivo da visita improdutiva.");
    setBusy(true);
    try {
      const position = shareLocation ? await currentPosition() : null;
      await enqueueUnproductive(ticket.id, {
        reason_id: reasonId,
        note: note.trim() || null,
        latitude: position?.latitude ?? null,
        longitude: position?.longitude ?? null,
      });
      showToast(`${ticket.code}: visita improdutiva registrada`, {
        tone: "success",
        description: online
          ? "A OS voltou para a central reagendar."
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
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.canvas }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={[styles.header, { paddingTop: Platform.OS === "android" ? insets.top + 12 : 20 }]}>
          <Text style={styles.title}>Visita improdutiva</Text>
          <Text style={styles.code}>{ticket.code}</Text>
          <Text style={styles.description}>
            Use quando você foi ao local e não conseguiu atender. A OS volta para a central reagendar e sai da sua
            agenda.
          </Text>
        </View>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Field label="Motivo" required>
            {reasons.length === 0 ? (
              <Text style={styles.hint}>
                A lista de motivos ainda não foi baixada neste aparelho. Conecte-se e tente de novo.
              </Text>
            ) : (
              <View style={{ gap: 6 }} accessibilityRole="radiogroup">
                {reasons.map((reason) => {
                  const selected = reasonId === reason.id;
                  const responsibility = RESPONSIBILITY[reason.responsibility];
                  return (
                    <Pressable
                      key={reason.id}
                      onPress={() => setReasonId(reason.id)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      style={[styles.option, selected && styles.optionSelected]}
                    >
                      <View style={[styles.radio, selected && styles.radioSelected]} />
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text style={styles.optionText}>{reason.name}</Text>
                        {reason.description ? <Text style={styles.hint}>{reason.description}</Text> : null}
                        {responsibility ? (
                          <Text style={[styles.responsibility, { color: readable(responsibility.color, c) }]}>
                            Responsabilidade: {responsibility.label}
                          </Text>
                        ) : null}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </Field>
          <Field label="Observação">
            <Input value={note} onChangeText={setNote} multiline placeholder="Opcional: o que aconteceu no local?" />
          </Field>
          <SwitchRow
            label="Registrar minha localização"
            hint="Comprova a ida ao local (funciona sem internet)."
            value={shareLocation}
            onValueChange={setShareLocation}
          />
          {error ? <ErrorBox message={error} /> : null}
        </ScrollView>
        <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
          <Button title="Voltar" onPress={onClose} disabled={busy} style={{ flex: 1 }} />
          <Button
            title={busy && shareLocation ? "Obtendo GPS…" : "Registrar"}
            variant="danger"
            onPress={() => void confirm()}
            loading={busy}
            disabled={!reasons.length}
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
      gap: 6,
      backgroundColor: c.surface,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.line,
    },
    title: { fontSize: 20, fontWeight: "700", color: c.ink },
    code: { fontSize: 12, fontWeight: "700", color: c.inkMuted },
    description: { fontSize: 13, color: c.inkMuted, lineHeight: 18 },
    body: { padding: 20, gap: 16 },
    hint: { fontSize: 12, color: c.inkMuted, lineHeight: 17 },
    option: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 10,
      padding: 12,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.line,
      backgroundColor: c.surface,
    },
    optionSelected: { borderColor: c.danger, backgroundColor: c.dangerSoft },
    radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: c.inkSubtle, marginTop: 1 },
    radioSelected: { borderColor: c.danger, backgroundColor: c.danger },
    optionText: { fontSize: 15, fontWeight: "600", color: c.ink },
    responsibility: { fontSize: 12, fontWeight: "600" },
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
