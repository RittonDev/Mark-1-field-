// Aviso de privacidade do técnico (LGPD), só para leitura: o mesmo texto da ficha da homologação (PRIVACY_NOTICE em
// lib/constants.ts, cópia idêntica da web, com a versão em PRIVACY_VERSION). Abre pela Conta, pelo cartão Pagamento do
// Meu cadastro, pela tela Enviar nota fiscal, pelo "Como funciona" do Meu elo e pelo cartão de Hoje quando o texto muda.
// Aberta por qualquer caminho, grava a versão como vista para o técnico (só no aparelho, lib/privacySeen.ts) quando
// termina de entrar: o cartão de Hoje some sem mexer na tela que ainda aparece por baixo da transição.

import { useNavigation, type NativeStackNavigationProp } from "expo-router";
import type { ParamListBase } from "expo-router/react-navigation";
import { useEffect } from "react";
import { ScrollView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "../components/Text";
import { Card, SectionTitle } from "../components/ui";
import { PRIVACY_NOTICE, PRIVACY_VERSION } from "../lib/constants";
import { markPrivacyNoticeSeen } from "../lib/privacySeen";
import { session, useSession } from "../lib/session";
import { useStyles, type Palette } from "../theme/theme";

/** A versão é a data do texto: "2026-11-19" → "19/11/2026" (sem fuso). */
const VERSION_DATE = PRIVACY_VERSION.split("-").reverse().join("/");

/**
 * Reserva quando o fim da entrada não chega: na web a pilha não avisa as transições. Conta da montagem, ou do início
 * da transição quando ele chega.
 */
const SEEN_FALLBACK_MS = 600;

export default function PrivacyNoticeScreen() {
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<ParamListBase>>();
  const userId = useSession().user?.id;

  // Hoje continua à vista por baixo enquanto esta tela entra: a versão fica vista (e o cartão some) só quando a
  // transição de entrada termina, ou pela reserva. Uma vez por abertura, e só para o técnico que abriu.
  useEffect(() => {
    if (!userId) return;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      settled = true;
      clearTimeout(timer);
      offStart();
      offEnd();
    };
    const markSeen = () => {
      if (settled) return;
      stop();
      // A sessão mudou antes de esta tela fechar: não grava para outro técnico.
      if (session.get().user?.id === userId) markPrivacyNoticeSeen(userId);
    };
    const startFallback = () => {
      clearTimeout(timer);
      timer = setTimeout(markSeen, SEEN_FALLBACK_MS);
    };
    const offStart = navigation.addListener("transitionStart", (event) => {
      if (!event.data.closing) startFallback();
    });
    const offEnd = navigation.addListener("transitionEnd", (event) => {
      if (!event.data.closing) markSeen();
    });
    startFallback();
    return stop;
  }, [navigation, userId]);

  return (
    <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
      <Text style={styles.version}>Atualizado em {VERSION_DATE}</Text>
      {PRIVACY_NOTICE.map((section) => (
        <Card key={section.title}>
          <SectionTitle accent>{section.title}</SectionTitle>
          <Text style={styles.body}>{section.body}</Text>
        </Card>
      ))}
    </ScrollView>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    content: { padding: 16, gap: 14, maxWidth: 640, width: "100%", alignSelf: "center" },
    version: { fontSize: 13, color: c.inkMuted },
    body: { fontSize: 14, lineHeight: 21, color: c.ink },
  });
