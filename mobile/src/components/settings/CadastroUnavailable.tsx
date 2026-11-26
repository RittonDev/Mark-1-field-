// Tela do cadastro com o servidor de antes do cadastro V2 (hasCadastroV2, lib/profile.ts): o app novo pede a API nova,
// que sobe antes dele. Sem ela, Dados pessoais, Endereço, Contato, Mini biografia e Dados empresariais mostram este aviso
// no lugar do formulário e não gravam nada (o mesmo das telas do perfil técnico com a API antiga). "Tentar de novo" relê.

import { StyleSheet, View } from "react-native";
import { UNAVAILABLE } from "../../lib/technicalProfile";
import { useStyles, type Palette } from "../../theme/theme";
import { EmptyState } from "../ui";

export function CadastroUnavailable({ onRetry }: { onRetry: () => void }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.center}>
      <EmptyState
        icon="alert"
        title={UNAVAILABLE.title}
        description={UNAVAILABLE.description}
        action={{ label: "Tentar de novo", onPress: onRetry }}
      />
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: c.canvas },
  });
