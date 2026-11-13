import { LinearGradient } from "expo-linear-gradient";
import * as Location from "expo-location";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { AppState, Linking, Platform, Pressable, StyleSheet, View } from "react-native";
import { refreshMe } from "../lib/account";
import { ApiError, errorMessage } from "../lib/api";
import { useNow } from "../lib/changes";
import { confirmAction } from "../lib/dialogs";
import { addDays, formatDate, formatMinutes, formatTime, isSameDay, startOfDay } from "../lib/format";
import { haptic } from "../lib/haptics";
import { showToast } from "../lib/toast";
import { ConsentRequiredError, endShift, hasConsent, startShift, useTracking, type TrackingState } from "../lib/tracking";
import { BRAND_GRADIENT, RADIUS, tint, useStyles, useTheme, type Palette } from "../theme/theme";
import { Icon } from "./Icon";
import { Pulse } from "./motion";
import { Text } from "./Text";
import { Button, ErrorBox } from "./ui";

/**
 * Jornada aberta há mais que isso (ou desde outro dia) provavelmente foi esquecida. Mesmo prazo do
 * lembrete do celular (lib/tracking); com 14 h ela é encerrada sozinha.
 */
const FORGOTTEN_MINUTES = 10 * 60;
/** Jornada ativa sem a coleta começar por mais que isso: algo bloqueia o GPS. */
const STALLED_MS = 20_000;

interface GpsState {
  /** O técnico negou a localização para o app. */
  denied: boolean;
  /** O sistema ainda deixa o app pedir de novo (senão, só nas configurações). */
  canAskAgain: boolean;
  /** Localização do aparelho ligada. */
  services: boolean;
}

async function readGps(): Promise<GpsState | null> {
  if (Platform.OS === "web") return null;
  try {
    const [permission, services] = await Promise.all([
      Location.getForegroundPermissionsAsync(),
      Location.hasServicesEnabledAsync(),
    ]);
    return { denied: permission.status === Location.PermissionStatus.DENIED, canAskAgain: permission.canAskAgain, services };
  } catch {
    return null;
  }
}

function trackingLine(tracking: TrackingState): string {
  if (tracking.mode === "background") {
    return tracking.transit ? "Registrando · em deslocamento (a cada ~15 s)" : "Registrando · também com o app em segundo plano";
  }
  if (tracking.mode === "foreground") return "Registrando só com o app aberto";
  return "Preparando o rastreamento…";
}

/** Desde quando a jornada está aberta, para o aviso de jornada esquecida. */
function openSince(startedAt: string, now: number): string {
  const today = startOfDay(new Date(now));
  if (isSameDay(startedAt, today)) return `há ${formatMinutes((now - new Date(startedAt).getTime()) / 60_000)}`;
  if (isSameDay(startedAt, addDays(today, -1))) return `desde ontem às ${formatTime(startedAt)}`;
  return `desde ${formatDate(startedAt)} às ${formatTime(startedAt)}`;
}

/**
 * Jornada do técnico. Parada: o convite para iniciar. Ativa: uma linha compacta (ponto verde, desde
 * quando, duração e "Encerrar"), com os detalhes do rastreamento a um toque, para a lista do dia
 * aparecer logo abaixo. Avisos (localização bloqueada, GPS desligado, jornada esquecida) sempre visíveis.
 */
export function ShiftCard() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const tracking = useTracking();
  const now = useNow(30_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [gps, setGps] = useState<GpsState | null>(null);
  const [stalledFor, setStalledFor] = useState<string | null>(null);
  const shift = tracking.shift;
  const shiftId = shift?.id ?? null;
  const active = Boolean(shift);

  // Permissão e GPS: ao focar a tela e quando o app volta ao primeiro plano (ex.: das configurações).
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      const check = () => {
        void readGps().then((state) => {
          if (alive) setGps(state);
        });
      };
      check();
      const sub = AppState.addEventListener("change", (next) => {
        if (next === "active") check();
      });
      return () => {
        alive = false;
        sub.remove();
      };
    }, []),
  );

  // A jornada começou e a coleta não: depois de 20 s, avisa em vez de "Preparando…" para sempre.
  useEffect(() => {
    if (!shiftId || tracking.mode !== "off") return;
    const id = setTimeout(() => setStalledFor(shiftId), STALLED_MS);
    return () => clearTimeout(id);
  }, [shiftId, tracking.mode]);

  async function recheckGps() {
    setGps(await readGps());
  }

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
      if (e instanceof ConsentRequiredError) {
        router.push({ pathname: "/termo-rastreamento", params: { start: "1" } });
      } else if (e instanceof ApiError && e.status === 409) {
        // O servidor não tem o aceite (retirado em outro aparelho): relê o usuário e mostra o termo.
        await refreshMe().catch(() => undefined);
        router.push({ pathname: "/termo-rastreamento", params: { start: "1" } });
      } else {
        setError(errorMessage(e));
      }
      void recheckGps();
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

  async function turnOnLocation() {
    try {
      // Android: o sistema mostra o pedido para ligar a localização sem sair do app.
      await Location.enableNetworkProviderAsync();
    } catch {
      // recusado: o aviso continua na tela
    }
    void recheckGps();
  }

  // Bloqueada: na jornada, sempre avisa; parada, só quando o sistema não deixa mais o app pedir.
  const blocked = Boolean(gps?.denied && (active || !gps.canAskAgain));
  const gpsOff = active && gps !== null && !gps.services;
  const stalled = active && tracking.mode === "off" && stalledFor === shiftId && !blocked && !gpsOff;
  const serverOff = tracking.serverAvailable === false;
  // O aviso do rastreamento fala do mesmo problema de GPS (permissão, localização desligada, GPS que não
  // liga): com o aviso daqui na tela, que já traz o botão para resolver, ele não aparece repetido.
  const trackingNotice = blocked || gpsOff || stalled ? null : tracking.notice;
  const hasNotices = blocked || gpsOff || stalled || serverOff || Boolean(trackingNotice);
  const settingsButton = (
    <Button compact variant="secondary" title="Abrir configurações" onPress={() => void Linking.openSettings()} style={styles.noticeAction} />
  );
  const gpsNotices = (
    <>
      {blocked ? (
        <View style={styles.notice} accessibilityRole="alert">
          <Icon name="alert" size={16} color={c.warning} />
          <View style={styles.noticeBody}>
            <Text style={styles.noticeText}>
              Localização bloqueada para o Maxx Field. Libere nas configurações do celular para {active ? "registrar" : "iniciar"} a jornada.
            </Text>
            {settingsButton}
          </View>
        </View>
      ) : null}
      {gpsOff ? (
        <View style={styles.notice} accessibilityRole="alert">
          <Icon name="alert" size={16} color={c.warning} />
          <View style={styles.noticeBody}>
            <Text style={styles.noticeText}>GPS desligado: ligue a localização do celular para registrar a jornada.</Text>
            {Platform.OS === "android" ? (
              <Button compact variant="secondary" title="Ligar localização" onPress={() => void turnOnLocation()} style={styles.noticeAction} />
            ) : null}
          </View>
        </View>
      ) : null}
      {stalled ? (
        <View style={styles.notice} accessibilityRole="alert">
          <Icon name="alert" size={16} color={c.warning} />
          <View style={styles.noticeBody}>
            <Text style={styles.noticeText}>
              O rastreamento não começou. Confira se a localização está ligada e permitida para o Maxx Field.
            </Text>
            {settingsButton}
          </View>
        </View>
      ) : null}
      {serverOff ? (
        <View style={styles.notice}>
          <Icon name="alert" size={16} color={c.warning} />
          <Text style={[styles.noticeText, styles.noticeBody]}>
            O servidor ainda não recebe o rastreamento; os pontos ficam guardados no aparelho.
          </Text>
        </View>
      ) : null}
    </>
  );

  if (!shift) {
    return (
      <View style={styles.card}>
        <View style={styles.body}>
          <View style={styles.top}>
            <Text style={styles.eyebrow}>Jornada</Text>
            <View style={[styles.state, { backgroundColor: c.surface3 }]}>
              <Text style={[styles.stateText, { color: c.inkMuted }]}>Parada</Text>
            </View>
          </View>
          <Text style={styles.status}>
            Inicie a jornada para registrar seus deslocamentos. Fora dela, o app só registra a posição nas etapas da OS.
          </Text>
          {gpsNotices}
          {error ? <ErrorBox message={error} /> : null}
          <Button title="Iniciar jornada" icon="clock" variant="primary" onPress={() => void start()} loading={busy} />
        </View>
      </View>
    );
  }

  const elapsed = Math.max(0, (now - new Date(shift.started_at).getTime()) / 60_000);
  const forgotten = elapsed >= FORGOTTEN_MINUTES || !isSameDay(shift.started_at, new Date(now));
  const summary = `desde ${formatTime(shift.started_at)} · ${formatMinutes(elapsed)}`;

  return (
    <View style={[styles.card, styles.cardActive]}>
      <LinearGradient colors={BRAND_GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.bar} />
      <View style={styles.compactRow}>
        <Pressable
          onPress={() => setExpanded((v) => !v)}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={`Jornada ativa, ${summary}`}
          accessibilityHint={expanded ? "Esconde os detalhes do rastreamento" : "Mostra os detalhes do rastreamento"}
          style={styles.compactInfo}
        >
          <Pulse color={c.success} size={8} active />
          <Text style={styles.compactText} numberOfLines={2}>
            <Text style={styles.compactStrong}>Jornada</Text> {summary}
          </Text>
          <Icon name={expanded ? "chevronUp" : "chevronDown"} size={18} color={c.inkMuted} />
        </Pressable>
        {forgotten ? null : <Button compact variant="secondary" title="Encerrar" onPress={() => void end()} loading={busy} />}
      </View>
      {expanded || forgotten || hasNotices || error ? (
        <View style={styles.details}>
          {expanded ? (
            <View style={{ gap: 2 }}>
              <Text style={styles.status}>{trackingLine(tracking)}</Text>
              <Text style={styles.meta}>
                {tracking.lastSentAt
                  ? `Última posição enviada às ${formatTime(tracking.lastSentAt)}`
                  : tracking.lastFixAt
                    ? `Última posição registrada às ${formatTime(tracking.lastFixAt)}`
                    : "Aguardando a primeira posição do GPS"}
                {tracking.queued ? ` · ${tracking.queued} na fila` : ""}
              </Text>
            </View>
          ) : null}
          {trackingNotice ? (
            <View style={styles.notice}>
              <Icon name="alert" size={16} color={c.warning} />
              <Text style={[styles.noticeText, styles.noticeBody]}>{trackingNotice}</Text>
            </View>
          ) : null}
          {gpsNotices}
          {forgotten ? (
            <View style={styles.notice} accessibilityRole="alert">
              <Icon name="clock" size={16} color={c.warning} />
              <Text style={[styles.noticeText, styles.noticeBody]}>
                Jornada aberta {openSince(shift.started_at, now)}. Esqueceu de encerrar?
              </Text>
            </View>
          ) : null}
          {error ? <ErrorBox message={error} /> : null}
          {forgotten ? <Button title="Encerrar jornada" variant="danger" onPress={() => void end()} loading={busy} /> : null}
        </View>
      ) : null}
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
    body: { padding: 16, gap: 10 },
    top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    eyebrow: { fontSize: 12, fontWeight: "700", color: c.inkMuted, textTransform: "uppercase", letterSpacing: 0.6 },
    state: { borderRadius: RADIUS.chip, paddingHorizontal: 8, paddingVertical: 4 },
    stateText: { fontSize: 12, fontWeight: "700" },
    status: { fontSize: 13, color: c.inkMuted, lineHeight: 18 },
    meta: { fontSize: 12, color: c.inkMuted, fontVariant: ["tabular-nums"] },
    compactRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6, paddingLeft: 6, paddingRight: 12 },
    compactInfo: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44, paddingHorizontal: 8 },
    compactText: { flex: 1, fontSize: 14, color: c.inkMuted, fontVariant: ["tabular-nums"] },
    compactStrong: { fontWeight: "700", color: c.ink },
    details: { paddingHorizontal: 14, paddingBottom: 14, gap: 10 },
    notice: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 8,
      backgroundColor: c.warningSoft,
      borderColor: tint(c.warning, "40"),
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: RADIUS.control,
      padding: 12,
    },
    noticeBody: { flex: 1, gap: 8 },
    noticeText: { fontSize: 13, color: c.warning, lineHeight: 18, fontWeight: "600" },
    noticeAction: { alignSelf: "flex-start" },
  });
