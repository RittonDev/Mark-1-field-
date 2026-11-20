// Caixa de marcar (só o desenho; quem fala com o leitor de tela é o cartão em volta). Desmarcada: borda cinza.
// Marcada: azul cheio com o check branco; o estado não depende só da cor.

import { StyleSheet, View } from "react-native";
import { useStyles, useTheme, type Palette } from "../../theme/theme";
import { Icon } from "../Icon";

export function Checkbox({ checked }: { checked: boolean }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.box, checked ? styles.on : styles.off]}>
      {checked ? <Icon name="check" size={15} color={c.onPrimary} strokeWidth={3} /> : null}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    box: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, alignItems: "center", justifyContent: "center" },
    off: { borderColor: c.inkMuted },
    on: { borderColor: c.primaryFill, backgroundColor: c.primaryFill },
  });
