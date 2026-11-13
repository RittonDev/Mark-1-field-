import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "./Text";
import { formatTime } from "../lib/format";
import { useSyncStatus, type SyncStatus } from "../lib/sync";
import { useStyles, useTheme, type Palette } from "../theme/theme";

type Tone = "ok" | "busy" | "warn" | "error" | "off";

function describe(s: SyncStatus): { text: string; tone: Tone } {
  const pending = s.pendingOps + s.pendingPhotos;
  const pendingText = pending ? ` · ${pending} ${pending === 1 ? "pendente" : "pendentes"}` : "";
  if (s.network === "offline") return { text: `Offline — suas ações ficam salvas no aparelho${pendingText}`, tone: "off" };
  if (s.server === "unreachable") return { text: `Servidor inacessível${pendingText}`, tone: "warn" };
  if (s.syncing) return { text: `Sincronizando…${pendingText}`, tone: "busy" };
  if (s.lastError) return { text: `Falha na sincronização: ${s.lastError}`, tone: "error" };
  if (s.realtime === "online") {
    const last = s.lastSyncAt ? ` · atualizado ${formatTime(s.lastSyncAt)}` : "";
    return { text: `Online · tempo real${pendingText || last}`, tone: "ok" };
  }
  return { text: `Online · conectando tempo real…${pendingText}`, tone: "busy" };
}

/** Estado da conexão, do tempo real e dos itens pendentes. Toque abre a tela Conta. */
export function ConnectionBar() {
  const status = useSyncStatus();
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const { text, tone } = describe(status);
  // Tudo certo: faixa discreta (fundo da tela, texto neutro, só o ponto verde). Ela só ganha cor quando
  // pede atenção (sincronizando, servidor fora, falha, offline), para não virar ruído o dia inteiro.
  const colors: Record<Tone, { bg: string; fg: string; dot: string }> = {
    ok: { bg: c.canvas, fg: c.inkSubtle, dot: c.success },
    busy: { bg: c.primarySoft, fg: c.primary, dot: c.primary },
    warn: { bg: c.warningSoft, fg: c.warning, dot: c.warning },
    error: { bg: c.dangerSoft, fg: c.danger, dot: c.danger },
    off: { bg: c.surface2, fg: c.inkMuted, dot: c.inkMuted },
  };
  const { bg, fg, dot } = colors[tone];
  return (
    <Pressable
      onPress={() => router.push("/conta")}
      accessibilityRole="button"
      accessibilityLabel={`${text}. Abrir conta e sincronização`}
      style={[styles.bar, { backgroundColor: bg }]}
    >
      <View style={[styles.dot, { backgroundColor: dot }]} />
      <Text style={[styles.text, { color: fg }, tone === "ok" && styles.textQuiet]} numberOfLines={1}>
        {text}
      </Text>
    </Pressable>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    bar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.line,
    },
    dot: { width: 7, height: 7, borderRadius: 4 },
    text: { fontSize: 13, fontWeight: "600", flex: 1 },
    textQuiet: { fontSize: 12, fontWeight: "500" },
  });
