// Rodapé fixo fora da rolagem ("Salvar", "Adicionar aptidão", "Adicionar formação"): fundo de cartão, traço em cima e
// o espaço da barra de gestos do aparelho. O mesmo rodapé que o Meu cadastro tinha.

import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useStyles, type Palette } from "../../theme/theme";

export function FixedFooter({ children }: { children: ReactNode }) {
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  return <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>{children}</View>;
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    footer: {
      gap: 10,
      paddingHorizontal: 16,
      paddingTop: 12,
      backgroundColor: c.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.line,
    },
  });
