import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { errorMessage } from "../lib/api";
import { useNow } from "../lib/changes";
import { confirmAction } from "../lib/dialogs";
import { formatMinutes, formatTime } from "../lib/format";
import { haptic } from "../lib/haptics";
import { showToast } from "../lib/toast";
import { ConsentRequiredError, endShift, hasConsent, startShift, useTracking } from "../lib/tracking";
import { BRAND_GRADIENT, RADIUS, useStyles, useTheme, type Palette } from "../theme/theme";
import { Pulse } from "./motion";
import { Text } from "./Text";
import { Button, ErrorBox } from "./ui";

/** Jornada do técnico: iniciar/encerrar e o estado do rastreamento, com o pulso "ao vivo". */
export function ShiftCard() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const tracking = useTracking();
  const now = useNow(30_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shift = tracking.shift;
  const active = Boolean(shift);

  async function start() {
    setError(null);
    if (!hasConsent()) {
      router.push({ pathname: "/termo-rastreamento", params: { start: "1" } });
      return;
    }
    setBusy(true);
    try {
      await startShift();
      haptic.step();
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
  const elapsed = shift ? Math.max(0, (now - new Date(shift.started_at).getTime()) / 60_000) : 0;

  return (
    <View style={[styles.card, active && styles.cardActive]}>
      {active ? <LinearGradient colors={BRAND_GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.bar} /> : null}
      <View style={styles.body}>
        <View style={styles.top}>
          <View style={styles.label}>
            <Pulse color={active ? c.success : c.inkSubtle} size={8} active={active} />
            <Text style={styles.eyebrow}>Jornada</Text>
          </View>
          <View style={[styles.state, { backgroundColor: active ? c.successSoft : c.surface3 }]}>
            <Text style={[styles.stateText, { color: active ? c.success : c.inkMuted }]}>{active ? "Ao vivo" : "Parada"}</Text>
          </View>
        </View>

        {shift ? (
          <View style={styles.timeRow}>
            <Text style={styles.time}>{formatTime(shift.started_at)}</Text>
            <Text style={styles.elapsed}>início · {formatMinutes(elapsed)} em jornada</Text>
          </View>
        ) : (
          <Text style={styles.title}>Jornada não iniciada</Text>
        )}

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
          <Button title="Iniciar jornada" icon="clock" variant="primary" onPress={() => void start()} loading={busy} />
        )}
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    card: {
      backgroundColor: c.surface,
      borderRadius: RADIUS.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      overflow: "hidden",
      boxShadow: c.elevation,
    },
    cardActive: { borderColor: c.lineStrong },
    bar: { height: 3 },
    body: { padding: 16, gap: 8 },
    top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    label: { flexDirection: "row", alignItems: "center", gap: 8 },
    eyebrow: { fontSize: 12, fontWeight: "700", color: c.inkMuted, textTransform: "uppercase", letterSpacing: 0.6 },
    state: { borderRadius: RADIUS.chip, paddingHorizontal: 8, paddingVertical: 4 },
    stateText: { fontSize: 12, fontWeight: "700" },
    timeRow: { flexDirection: "row", alignItems: "baseline", gap: 8, flexWrap: "wrap" },
    time: { fontSize: 28, fontWeight: "700", color: c.ink, fontVariant: ["tabular-nums"], letterSpacing: -0.5 },
    elapsed: { fontSize: 13, color: c.inkMuted, fontVariant: ["tabular-nums"] },
    title: { fontSize: 18, fontWeight: "700", color: c.ink },
    status: { fontSize: 13, color: c.inkMuted, lineHeight: 18 },
    meta: { fontSize: 12, color: c.inkMuted, fontVariant: ["tabular-nums"] },
    notice: {
      fontSize: 12,
      color: c.warning,
      backgroundColor: c.warningSoft,
      borderRadius: RADIUS.control,
      padding: 12,
      lineHeight: 17,
      overflow: "hidden",
    },
  });
