// Cartão de largura total com a caixa de marcar à direita, um toque só (Ferramental, Transporte, "Tenho CNH",
// "Em andamento"). Marcado: fundo azul-claro, borda azul e o texto em azul. Sem animação na troca, só o aperto do toque.

import { StyleSheet, View } from "react-native";
import { useStyles, useTheme, type Palette } from "../../theme/theme";
import { PressableScale } from "../motion";
import { Text } from "../Text";
import { Checkbox } from "./Checkbox";

export function CheckCard({
  label,
  sublabel,
  checked,
  onPress,
  disabled = false,
}: {
  label: string;
  sublabel?: string;
  checked: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <PressableScale
      scaleTo={0.98}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={sublabel ? `${label}, ${sublabel}` : label}
      style={[styles.card, checked ? styles.on : styles.off, disabled && styles.disabled]}
      pressedStyle={checked ? null : { backgroundColor: c.surface2 }}
    >
      <View style={styles.text}>
        <Text style={[styles.label, checked && { color: c.brandInk }]}>{label}</Text>
        {sublabel ? <Text style={styles.sublabel}>{sublabel}</Text> : null}
      </View>
      <Checkbox checked={checked} />
    </PressableScale>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    card: {
      minHeight: 56,
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderRadius: 12,
      borderWidth: 1.5,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    off: { backgroundColor: c.surface, borderColor: c.lineStrong },
    on: { backgroundColor: c.primarySoft, borderColor: c.primary },
    disabled: { opacity: 0.5 },
    text: { flex: 1, gap: 2 },
    label: { fontSize: 15, fontWeight: "600", color: c.ink },
    sublabel: { fontSize: 13, color: c.inkMuted },
  });
