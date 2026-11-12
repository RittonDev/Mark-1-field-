import { router } from "expo-router";
import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BrandRule } from "../components/Brand";
import { Button, Card, ErrorBox } from "../components/ui";
import { locationConsentAt } from "../lib/account";
import { errorMessage } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useSession } from "../lib/session";
import { showToast } from "../lib/toast";
import { acceptConsent, startShift } from "../lib/tracking";
import { useStyles, type Palette } from "../theme/theme";

const SECTIONS: { title: string; items: string[] }[] = [
  {
    title: "O que é coletado",
    items: [
      "Sua localização (latitude e longitude) e a precisão do GPS.",
      "Velocidade e direção, quando o aparelho informar.",
      "Nível de bateria do celular.",
      "Se a localização vem de um aplicativo de localização falsa (detecção de GPS simulado).",
    ],
  },
  {
    title: "Quando",
    items: [
      "Somente entre “Iniciar jornada” e “Encerrar jornada”. Fora da jornada nada é coletado, e o servidor descarta qualquer ponto fora dela.",
      "Durante a jornada, a cada 30 segundos aproximadamente, e a cada 15 segundos quando você estiver em deslocamento para uma OS.",
      "Com o app aberto ou em segundo plano. No Android aparece uma notificação fixa enquanto a jornada estiver ativa.",
    ],
  },
  {
    title: "Para quê",
    items: [
      "Para a central acompanhar os atendimentos em andamento e o status do deslocamento até o cliente.",
      "Para organizar a distribuição das OS e dar previsão de chegada ao cliente.",
      "Os dados são usados só para a gestão dos atendimentos de campo, conforme a LGPD.",
    ],
  },
  {
    title: "Seus controles",
    items: [
      "Você inicia e encerra a jornada quando quiser, pelo botão na tela inicial.",
      "Sair do app também encerra a jornada.",
      "Dúvidas sobre seus dados: fale com o responsável pela operação na sua empresa.",
    ],
  },
];

/** Termo de ciência do rastreamento (LGPD), aceito uma vez antes da primeira jornada. */
export default function TrackingConsentScreen() {
  const { user } = useSession();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const acceptedAt = locationConsentAt(user);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      await acceptConsent();
      await startShift();
      showToast("Jornada iniciada", { tone: "success", description: "Rastreamento ativo até você encerrar." });
      router.back();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
      <View style={{ gap: 8 }}>
        <Text style={styles.title}>Rastreamento durante a jornada</Text>
        <BrandRule width={44} />
        <Text style={styles.lead}>
          Para iniciar a jornada, leia como sua localização é usada. Você precisa aceitar este termo uma vez.
        </Text>
      </View>
      {SECTIONS.map((section) => (
        <Card key={section.title} style={{ gap: 8 }}>
          <Text style={styles.sectionTitle}>{section.title}</Text>
          {section.items.map((item) => (
            <View key={item} style={styles.item}>
              <View style={styles.bullet} />
              <Text style={styles.itemText}>{item}</Text>
            </View>
          ))}
        </Card>
      ))}
      {error ? <ErrorBox message={error} /> : null}
      {acceptedAt ? (
        <Text style={styles.accepted}>Termo aceito em {formatDateTime(acceptedAt)}.</Text>
      ) : (
        <Button title="Li e aceito · iniciar jornada" variant="primary" onPress={accept} loading={busy} />
      )}
      <Button title={acceptedAt ? "Fechar" : "Agora não"} variant="ghost" onPress={() => router.back()} disabled={busy} />
    </ScrollView>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    content: { padding: 20, gap: 14, maxWidth: 640, width: "100%", alignSelf: "center" },
    title: { fontSize: 22, fontWeight: "700", color: c.ink, letterSpacing: -0.3 },
    lead: { fontSize: 15, color: c.inkMuted, lineHeight: 21 },
    sectionTitle: { fontSize: 13, fontWeight: "700", color: c.primary, textTransform: "uppercase", letterSpacing: 0.5 },
    item: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
    bullet: { width: 6, height: 6, borderRadius: 3, backgroundColor: c.primary, marginTop: 8 },
    itemText: { flex: 1, fontSize: 14, color: c.ink, lineHeight: 21 },
    accepted: { textAlign: "center", fontSize: 13, color: c.success, fontWeight: "600" },
  });
