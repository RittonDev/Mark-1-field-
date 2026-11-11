import { router } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { formatTime } from "../lib/format";
import { useSyncStatus, type SyncStatus } from "../lib/sync";
import { colors } from "./ui";

function describe(s: SyncStatus): { text: string; color: string } {
  const pending = s.pendingOps + s.pendingPhotos;
  const pendingText = pending ? ` · ${pending} ${pending === 1 ? "pendente" : "pendentes"}` : "";
  if (s.network === "offline") {
    return { text: `Offline — suas ações ficam salvas no aparelho${pendingText}`, color: "#475569" };
  }
  if (s.server === "unreachable") {
    return { text: `Servidor inacessível${pendingText}`, color: colors.warning };
  }
  if (s.syncing) return { text: `Sincronizando…${pendingText}`, color: colors.brand };
  if (s.lastError) return { text: `Falha na sincronização: ${s.lastError}`, color: colors.danger };
  if (s.realtime === "online") {
    const last = s.lastSyncAt ? ` · atualizado ${formatTime(s.lastSyncAt)}` : "";
    return { text: `Online · tempo real${pendingText || last}`, color: colors.success };
  }
  return { text: `Online · conectando tempo real…${pendingText}`, color: colors.brand };
}

/** Faixa de estado: online/offline, tempo real e operações pendentes. Toque abre a tela Conta. */
export function ConnectionBar() {
  const status = useSyncStatus();
  const { text, color } = describe(status);
  return (
    <Pressable
      onPress={() => router.push("/conta")}
      accessibilityRole="button"
      accessibilityLabel={`${text}. Abrir sincronização`}
      style={[styles.bar, { backgroundColor: color }]}
    >
      <View style={styles.dot} />
      <Text style={styles.text} numberOfLines={1}>
        {text}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 7 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#ffffffcc" },
  text: { color: "#fff", fontSize: 13, fontWeight: "600", flex: 1 },
});
