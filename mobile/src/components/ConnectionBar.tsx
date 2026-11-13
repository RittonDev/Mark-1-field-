import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Text } from "./Text";
import { formatTime } from "../lib/format";
import { useSyncStatus, type SyncStatus } from "../lib/sync";
import { useStyles, useTheme, type Palette } from "../theme/theme";
import { Icon } from "./Icon";

type Tone = "ok" | "busy" | "warn" | "error" | "off";

/** Rodadas rápidas (a maioria) não aparecem: "Sincronizando…" só depois de 1,5 s. */
const SLOW_SYNC_MS = 1500;

function describe(s: SyncStatus, slow: boolean): { text: string; tone: Tone } {
  const pending = s.pendingOps + s.pendingPhotos;
  const items = pending === 1 ? "1 item para enviar" : `${pending} itens para enviar`;
  if (s.network === "offline") {
    return { text: pending ? `Sem internet · ${items}, salvos no aparelho` : "Sem internet · suas ações ficam salvas no aparelho", tone: "off" };
  }
  if (s.server === "unreachable") return { text: pending ? `Sem conexão com o servidor · ${items}` : "Sem conexão com o servidor", tone: "warn" };
  if (s.syncing && (slow || pending)) return { text: pending ? `Enviando · ${items}` : "Sincronizando…", tone: "busy" };
  if (s.lastError) return { text: `Falha ao sincronizar: ${s.lastError}`, tone: "error" };
  if (pending) return { text: items, tone: "busy" };
  if (s.lastSyncAt) return { text: `Sincronizado às ${formatTime(s.lastSyncAt)}`, tone: "ok" };
  return { text: s.server === "reachable" ? "Conectado ao servidor" : "Verificando a conexão…", tone: "ok" };
}

/**
 * Estado da conexão e dos itens para enviar. Tudo certo: faixa discreta (fundo da tela, texto neutro,
 * ponto verde). Só ganha cor quando pede atenção (sem internet, servidor fora, falha). A altura não muda
 * entre os estados. Toque abre a tela Conta.
 */
export function ConnectionBar() {
  const status = useSyncStatus();
  const c = useTheme();
  const styles = useStyles(makeStyles);
  // Identifica a rodada em curso (muda quando ela termina), para o aviso de lentidão não vazar para a próxima.
  const round = `${status.lastSyncAt}|${status.lastError}|${status.server}`;
  const [slowRound, setSlowRound] = useState<string | null>(null);
  useEffect(() => {
    if (!status.syncing) return;
    const id = setTimeout(() => setSlowRound(round), SLOW_SYNC_MS);
    return () => clearTimeout(id);
  }, [status.syncing, round]);
  const { text, tone } = describe(status, status.syncing && slowRound === round);
  const colors: Record<Tone, { bg: string; fg: string; dot: string }> = {
    ok: { bg: c.canvas, fg: c.inkMuted, dot: c.success },
    busy: { bg: c.canvas, fg: c.inkMuted, dot: c.inkMuted },
    warn: { bg: c.warningSoft, fg: c.warning, dot: c.warning },
    error: { bg: c.dangerSoft, fg: c.danger, dot: c.danger },
    off: { bg: c.surface2, fg: c.ink, dot: c.inkMuted },
  };
  const { bg, fg, dot } = colors[tone];
  return (
    <Pressable
      onPress={() => router.push("/conta")}
      accessibilityRole="button"
      accessibilityLabel={`${text}. Abre a conta e a sincronização`}
      style={({ pressed }) => [styles.bar, { backgroundColor: bg }, pressed && { opacity: 0.75 }]}
    >
      <View style={styles.mark}>
        {tone === "off" ? (
          <Icon name="wifiOff" size={14} color={fg} strokeWidth={2} />
        ) : tone === "busy" && status.syncing ? (
          <ActivityIndicator size="small" color={fg} style={styles.spinner} />
        ) : (
          <View style={[styles.dot, { backgroundColor: dot }]} />
        )}
      </View>
      <Text style={[styles.text, { color: fg }, tone !== "ok" && tone !== "busy" && styles.textStrong]} numberOfLines={1}>
        {text}
      </Text>
      <Icon name="chevronRight" size={16} color={c.inkSubtle} />
    </Pressable>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    bar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      minHeight: 44,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.line,
    },
    mark: { width: 16, height: 16, alignItems: "center", justifyContent: "center" },
    dot: { width: 8, height: 8, borderRadius: 4 },
    spinner: { transform: [{ scale: 0.7 }] },
    // Mesmo tamanho e entrelinha em todos os estados: a tela não pula quando a faixa muda.
    text: { fontSize: 13, lineHeight: 18, fontWeight: "500", flex: 1 },
    textStrong: { fontWeight: "700" },
  });
