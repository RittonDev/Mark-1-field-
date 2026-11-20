// Hoje > "Aviso de privacidade atualizado": cartão discreto para quem já é técnico quando o texto do aviso muda
// (PRIVACY_VERSION em lib/constants.ts). Não bloqueia nada. Abrir o aviso por qualquer caminho marca a versão como
// vista quando a tela do aviso termina de entrar (privacidade.tsx), e o cartão some.
//
// A versão vista e a leitura dela ficam em lib/privacySeen.ts; o cartão só lê a memória. A abertura do app com técnico
// salvo e o login esperam essa leitura (no máximo PRIVACY_SEEN_WAIT_MS), então o cartão já entra no primeiro quadro de
// Hoje. Se ela demorar mais que isso, Hoje abre sem esperar e o cartão entra depois, com um fade curto. Se falhar, o
// cartão não aparece.

import { router } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { loadPrivacySeen, privacyUpdateDue, subscribePrivacySeen } from "../lib/privacySeen";
import { RADIUS, useStyles, useTheme, type Palette } from "../theme/theme";
import { Icon } from "./Icon";
import { useSwapMotion } from "./motion";
import { Text } from "./Text";
import { Button } from "./ui";

/** true: mostra o cartão; false: o técnico já abriu esta versão; undefined: leitura pendente ou que falhou. */
function usePrivacyUpdateDue(userId: string): boolean | undefined {
  const snapshot = () => privacyUpdateDue(userId);
  const due = useSyncExternalStore(subscribePrivacySeen, snapshot, snapshot);
  // Se a leitura da abertura ou do login falhou, Hoje tenta de novo quando monta. Já lida ou lendo, não faz nada.
  useEffect(() => {
    void loadPrivacySeen(userId);
  }, [userId]);
  return due;
}

export function PrivacyUpdateCard({ userId }: { userId: string }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const swap = useSwapMotion();
  const due = usePrivacyUpdateDue(userId);
  // Leitura que terminou depois do primeiro quadro (passou do teto): o cartão aparece com um fade curto. Já
  // conhecido, entra parado.
  const [late] = useState(() => due === undefined);
  if (!due) return null;
  return (
    <Animated.View entering={late ? swap.entering : undefined} style={styles.card}>
      <View style={styles.icon}>
        <Icon name="shield" size={20} color={c.brandInk} />
      </View>
      <View style={styles.body}>
        <Text style={styles.title} accessibilityRole="header">
          Aviso de privacidade atualizado
        </Text>
        <Text style={styles.text}>Agora ele fala do seu perfil técnico e dos registros das ofertas de OS.</Text>
        <Button compact title="Ler aviso" onPress={() => router.push("/privacidade")} style={styles.action} />
      </View>
    </Animated.View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    card: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 12,
      paddingHorizontal: 14,
      paddingVertical: 14,
      backgroundColor: c.surface,
      borderRadius: RADIUS.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      boxShadow: c.elevation,
    },
    icon: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.primarySoft,
    },
    body: { flex: 1, gap: 4 },
    title: { fontSize: 14, fontWeight: "700", color: c.ink },
    text: { fontSize: 13, lineHeight: 18, color: c.inkMuted },
    action: { alignSelf: "flex-start", marginTop: 6 },
  });
