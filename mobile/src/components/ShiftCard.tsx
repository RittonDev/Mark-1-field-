import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { errorMessage } from "../lib/api";
import { confirmAction } from "../lib/dialogs";
import { formatTime } from "../lib/format";
import { showToast } from "../lib/toast";
import { ConsentRequiredError, endShift, hasConsent, startShift, useTracking } from "../lib/tracking";
import { BRAND_GRADIENT, useStyles, useTheme, type Palette } from "../theme/theme";
import { Button, ErrorBox } from "./ui";

/** Jornada do técnico: iniciar/encerrar e o estado do rastreamento. */
export function ShiftCard() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const tracking = useTracking();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = Boolean(tracking.shift);

  async function start() {
    setError(null);
    if (!hasConsent()) {
      router.push({ pathname: "/termo-rastreamento", params: { start: "1" } });
      return;
    }
    setBusy(true);
    try {
      await startShift();
      showToast("Jornada iniciada", { tone: "success" });
    } catch (e) {
      if (e instanceof ConsentRequiredError) router.push({ pathname: "/termo-rastreamento", params: { start: "1" } });
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function end() {
    const ok = await confirmAction("Encerrar a jornada?", "O rastreamento para agora. Você pode iniciar outra jornada depois.", {
      confirmText: "Encerrar",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await endShift();
      showToast("Jornada encerrada");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const statusLine = !active
    ? "Inicie a jornada para registrar seus deslocamentos. Fora dela nada é coletado."
    : tracking.mode === "background"
      ? tracking.transit
        ? "Rastreamento ativo · em deslocamento (a cada ~15 s)"
        : "Rastreamento ativo · também em segundo plano"
      : tracking.mode === "foreground"
        ? "Rastreamento ativo · só com o app aberto"
        : "Preparando o rastreamento…";

  return (
    <View style={styles.card}>
      {active ? <LinearGradient colors={BRAND_GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.stripe} /> : null}
      <View style={styles.body}>
        <View style={styles.row}>
          <View style={[styles.pulse, { backgroundColor: active ? c.success : c.inkSubtle }]} />
          <Text style={styles.title}>
            {active && tracking.shift ? `Jornada em andamento desde ${formatTime(tracking.shift.started_at)}` : "Jornada não iniciada"}
          </Text>
        </View>
        <Text style={styles.status}>{statusLine}</Text>
        {active ? (
          <Text style={styles.meta}>
            {tracking.lastSentAt
              ? `Última posição enviada às ${formatTime(tracking.lastSentAt)}`
              : tracking.lastFixAt
                ? `Última posição registrada às ${formatTime(tracking.lastFixAt)}`
                : "Aguardando a primeira posição do GPS"}
            {tracking.queued ? ` · ${tracking.queued} na fila` : ""}
          </Text>
        ) : null}
        {active && tracking.notice ? <Text style={styles.notice}>{tracking.notice}</Text> : null}
        {tracking.serverAvailable === false ? (
          <Text style={styles.notice}>O servidor ainda não recebe o rastreamento; os pontos ficam guardados no aparelho.</Text>
        ) : null}
        {error ? <ErrorBox message={error} /> : null}
        {active ? (
          <Button title="Encerrar jornada" variant="danger" onPress={() => void end()} loading={busy} />
        ) : (
          <Button title="Iniciar jornada" variant="primary" onPress={() => void start()} loading={busy} />
        )}
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    card: {
      backgroundColor: c.surface,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      overflow: "hidden",
    },
    stripe: { height: 4 },
    body: { padding: 16, gap: 8 },
    row: { flexDirection: "row", alignItems: "center", gap: 8 },
    pulse: { width: 10, height: 10, borderRadius: 5 },
    title: { fontSize: 16, fontWeight: "700", color: c.ink, flex: 1 },
    status: { fontSize: 13, color: c.inkMuted, lineHeight: 18 },
    meta: { fontSize: 12, color: c.inkMuted, fontVariant: ["tabular-nums"] },
    notice: {
      fontSize: 12,
      color: c.warning,
      backgroundColor: c.warningSoft,
      borderRadius: 10,
      padding: 10,
      lineHeight: 17,
      overflow: "hidden",
    },
  });
