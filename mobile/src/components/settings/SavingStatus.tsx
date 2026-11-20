// O andamento do salvar ao tocar, no canto direito do cabeçalho (Disponibilidade, Transporte e Ferramental):
// "Salvando…" enquanto espera ou envia; "Salvo" por 2 s depois de gravar; fora isso, nada. O leitor de tela do Android
// fala a mudança (região viva).

import { ActivityIndicator, StyleSheet, View } from "react-native";
import type { AutoSaveStatus } from "../../lib/techProfileForm";
import { useStyles, useTheme, type Palette } from "../../theme/theme";
import { Icon } from "../Icon";
import { Text } from "../Text";

export function SavingStatus({ status }: { status: AutoSaveStatus }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.row} accessibilityLiveRegion="polite">
      {status === "saving" ? <ActivityIndicator size="small" color={c.inkMuted} /> : null}
      {status === "saved" ? <Icon name="check" size={16} color={c.inkMuted} strokeWidth={2.2} /> : null}
      {status !== "idle" ? (
        <Text style={styles.text} maxFontSizeMultiplier={1.3}>
          {status === "saving" ? "Salvando…" : "Salvo"}
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 24 },
    text: { fontSize: 13, fontWeight: "600", color: c.inkMuted },
  });
