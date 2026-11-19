// O olho do Faturamento: oculta ou mostra os valores (preferência do aparelho, lib/hideValues.ts). Fica à direita do
// título da aba e no cabeçalho do mês. O ícone mostra o estado; o rótulo, o que o toque faz.

import { Pressable, StyleSheet } from "react-native";
import { haptic } from "../../lib/haptics";
import { setHideValues, useHideValues } from "../../lib/hideValues";
import { useTheme } from "../../theme/theme";
import { Icon } from "../Icon";

export function HideValuesButton() {
  const c = useTheme();
  const hidden = useHideValues();
  return (
    <Pressable
      onPress={() => {
        haptic.select();
        setHideValues(!hidden);
      }}
      accessibilityRole="button"
      accessibilityLabel={hidden ? "Mostrar valores" : "Ocultar valores"}
      style={({ pressed }) => [styles.button, pressed && { backgroundColor: c.surface2 }]}
    >
      <Icon name={hidden ? "eyeOff" : "eye"} size={22} color={c.inkMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
});
