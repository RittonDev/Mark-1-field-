// O cartão herói de duas metades (Perfil: total de atendimentos | patente; Estatísticas: total | chegada no horário):
// um cartão só, com um traço fino vertical entre as metades. Cada metade pode ser um botão.

import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { RADIUS, useStyles, useTheme, type Palette } from "../theme/theme";
import { PressableScale } from "./motion";
import { Card } from "./ui";

/** Dois números lado a lado num cartão, separados por um traço fino (Perfil e Estatísticas). */
export function HeroPair({ left, right }: { left: ReactNode; right: ReactNode }) {
  const styles = useStyles(makeStyles);
  return (
    <Card style={styles.card}>
      {left}
      <View style={styles.rule} />
      {right}
    </Card>
  );
}

/**
 * Uma metade. Com `onPress`, vira botão (PressableScale 0,98, fundo surface2 ao pressionar, nos cantos do cartão);
 * sem ele, um elemento só para o leitor de tela, com o `accessibilityLabel`.
 */
export function HeroHalf({
  onPress,
  side,
  accessibilityLabel,
  accessibilityHint,
  children,
}: {
  onPress?: () => void;
  /** Qual metade: o fundo de pressionado acompanha os cantos arredondados do cartão. */
  side: "left" | "right";
  accessibilityLabel: string;
  accessibilityHint?: string;
  children: ReactNode;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const shape = side === "left" ? styles.left : styles.right;
  if (!onPress) {
    return (
      <View style={[styles.half, shape]} accessible accessibilityLabel={accessibilityLabel} accessibilityHint={accessibilityHint}>
        {children}
      </View>
    );
  }
  return (
    <PressableScale
      onPress={onPress}
      scaleTo={0.98}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      style={[styles.half, shape]}
      pressedStyle={{ backgroundColor: c.surface2 }}
    >
      {children}
    </PressableScale>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    card: { padding: 0, flexDirection: "row", alignItems: "stretch" },
    half: {
      flex: 1,
      minWidth: 0,
      alignItems: "center",
      justifyContent: "center",
      minHeight: 128,
      paddingVertical: 18,
      paddingHorizontal: 12,
      gap: 6,
    },
    // O cartão tem borda fina: o fundo de pressionado fica um ponto para dentro do raio dele.
    left: { borderTopLeftRadius: RADIUS.card - 1, borderBottomLeftRadius: RADIUS.card - 1 },
    right: { borderTopRightRadius: RADIUS.card - 1, borderBottomRightRadius: RADIUS.card - 1 },
    rule: { width: StyleSheet.hairlineWidth, backgroundColor: c.line, marginVertical: 16 },
  });
