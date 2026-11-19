// Aviso de privacidade do técnico (LGPD), só para leitura: o mesmo texto da ficha da homologação (PRIVACY_NOTICE em
// lib/constants.ts, cópia idêntica da web, com a versão em PRIVACY_VERSION). Abre pela Conta, pelo cartão Pagamento do
// Meu cadastro, pela tela Enviar nota fiscal e pelo "Como funciona" do Meu elo.

import { ScrollView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "../components/Text";
import { Card, SectionTitle } from "../components/ui";
import { PRIVACY_NOTICE, PRIVACY_VERSION } from "../lib/constants";
import { useStyles, type Palette } from "../theme/theme";

/** A versão é a data do texto: "2026-11-19" → "19/11/2026" (sem fuso). */
const VERSION_DATE = PRIVACY_VERSION.split("-").reverse().join("/");

export default function PrivacyNoticeScreen() {
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
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
