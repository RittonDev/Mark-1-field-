// Hoje > "Aviso de privacidade atualizado": cartão discreto para quem já é técnico quando o texto do aviso muda
// (PRIVACY_VERSION em lib/constants.ts). Não bloqueia nada. Abrir o aviso por qualquer caminho (privacidade.tsx chama
// markPrivacyNoticeSeen) grava a versão como vista, e o cartão some.
//
// A versão vista fica só no aparelho, por técnico (a chave leva o id), no Keychain/Keystore, como a preferência de
// tema: sobrevive ao Sair e à troca de técnico, vale offline e nada vai para o servidor.

import { router } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { PRIVACY_VERSION } from "../lib/constants";
import { secureStorage } from "../lib/secureStorage";
import { session } from "../lib/session";
import { RADIUS, useStyles, useTheme, type Palette } from "../theme/theme";
import { Icon } from "./Icon";
import { useSwapMotion } from "./motion";
import { Text } from "./Text";
import { Button } from "./ui";

/** mc_privacy_seen_<id do técnico> (o armazenamento seguro só aceita letras, números, ".", "-" e "_"). */
const seenKey = (userId: string) => `mc_privacy_seen_${userId.replace(/[^\w.-]/g, "_")}`;

/** Versão aberta por técnico (null: nenhuma). Sem o técnico no mapa, a leitura ainda não terminou. */
const seen = new Map<string, string | null>();
const reading = new Set<string>();
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((listener) => listener());

/** Lê uma vez a versão vista do técnico. Se a leitura falhar, o cartão não aparece (tenta de novo quando Hoje monta). */
function load(userId: string) {
  if (seen.has(userId) || reading.has(userId)) return;
  reading.add(userId);
  secureStorage
    .getItem(seenKey(userId))
    .then(
      (value) => {
        // Aberto enquanto lia: vale o que acabou de ser gravado.
        if (seen.has(userId)) return;
        seen.set(userId, value);
        emit();
      },
      (error: unknown) => console.warn("Não foi possível ler o aviso de privacidade visto", error),
    )
    .finally(() => reading.delete(userId));
}

// A leitura começa assim que o técnico é conhecido (abertura do app ou login), antes de Hoje desenhar: o cartão já
// entra no primeiro quadro, em vez de empurrar a tela depois.
const preload = () => {
  const userId = session.get().user?.id;
  if (userId) load(userId);
};
preload();
session.subscribe(preload);

/** O técnico abriu o aviso de privacidade: a versão atual fica vista para ele e o cartão de Hoje some. */
export function markPrivacyNoticeSeen(userId: string) {
  if (seen.get(userId) === PRIVACY_VERSION) return;
  seen.set(userId, PRIVACY_VERSION);
  emit();
  secureStorage.setItem(seenKey(userId), PRIVACY_VERSION).catch((error: unknown) => {
    // Some nesta sessão; na próxima abertura do app, o cartão volta.
    console.warn("Não foi possível guardar o aviso de privacidade visto", error);
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** true: mostra o cartão; false: o técnico já abriu esta versão; undefined: ainda lendo. */
function usePrivacyUpdateDue(userId: string): boolean | undefined {
  const snapshot = () => (seen.has(userId) ? seen.get(userId) !== PRIVACY_VERSION : undefined);
  const due = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    load(userId);
  }, [userId]);
  return due;
}

export function PrivacyUpdateCard({ userId }: { userId: string }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const swap = useSwapMotion();
  const due = usePrivacyUpdateDue(userId);
  // Leitura que terminou depois do primeiro quadro: o cartão aparece com um fade curto. Já conhecido, entra parado.
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
        <Text style={styles.text}>Agora ele fala da chave PIX, das notas fiscais e do Elo.</Text>
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
