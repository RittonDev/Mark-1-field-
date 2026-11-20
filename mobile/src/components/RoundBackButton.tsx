// Voltar redondo das telas sem o cabeçalho nativo (a oferta, por cima do mapa). Círculo de 40 com a área de toque de
// 48; sem tela anterior (aberta por uma notificação), vai para Hoje. O voltar do Android e o gesto do iOS continuam.

import { router } from "expo-router";
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { useStyles, useTheme, type Palette } from "../theme/theme";
import { Icon } from "./Icon";

function goBack() {
  if (router.canGoBack()) router.back();
  else router.replace("/");
}

export function RoundBackButton({ onPress = goBack, style }: { onPress?: () => void; style?: StyleProp<ViewStyle> }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Voltar"
      hitSlop={4}
      style={({ pressed }) => [styles.button, pressed && { backgroundColor: c.surface2 }, style]}
    >
      <Icon name="chevronLeft" size={22} color={c.ink} />
    </Pressable>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    button: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      boxShadow: c.elevation,
    },
  });
