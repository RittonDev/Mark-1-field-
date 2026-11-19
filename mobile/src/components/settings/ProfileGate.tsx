// Telas de Configurações sem o cadastro na memória: carregando, sem internet ou erro do servidor (os textos que o Meu
// cadastro já usava). Com o cadastro na memória, a tela abre com ele e relê do servidor por trás.

import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useStyles, useTheme, type Palette } from "../../theme/theme";
import { Text } from "../Text";
import { EmptyState } from "../ui";

export type ProfileLoad =
  | { status: "loading" }
  | { status: "ok" }
  | { status: "error"; offline: boolean; message: string };

export function ProfileGate({ load, onRetry }: { load: Exclude<ProfileLoad, { status: "ok" }>; onRetry: () => void }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  if (load.status === "loading") {
    return (
      <View style={styles.center} accessibilityLiveRegion="polite">
        <ActivityIndicator color={c.primary} />
        <Text style={styles.loading}>Carregando seu cadastro…</Text>
      </View>
    );
  }
  return (
    <View style={styles.center}>
      {load.offline ? (
        <EmptyState
          icon="wifiOff"
          title="Sem internet"
          description="Conecte o aparelho para abrir e salvar seu cadastro."
          action={{ label: "Tentar de novo", onPress: onRetry }}
        />
      ) : (
        <EmptyState
          icon="alert"
          title="Não foi possível abrir seu cadastro"
          description={load.message}
          action={{ label: "Tentar de novo", onPress: onRetry }}
        />
      )}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24, backgroundColor: c.canvas },
    loading: { fontSize: 14, color: c.inkMuted },
  });
