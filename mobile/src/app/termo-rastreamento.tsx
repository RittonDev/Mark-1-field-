import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Text } from "../components/Text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BrandRule } from "../components/Brand";
import { Button, Card, ErrorBox } from "../components/ui";
import { locationConsentAt } from "../lib/account";
import { errorMessage } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useSession } from "../lib/session";
import { showToast } from "../lib/toast";
import { acceptConsent, requestLocationPermissions, startShift } from "../lib/tracking";
import { useStyles, type Palette } from "../theme/theme";

const RETENTION_DAYS = 90;

const SECTIONS: { title: string; items: string[] }[] = [
  {
    title: "Para quê",
    items: [
      "Acompanhar o seu deslocamento até o cliente e o andamento dos atendimentos de campo.",
      "Dar previsão de chegada ao cliente e organizar a distribuição das OS.",
      "Os dados são usados só para a gestão dos atendimentos, conforme a LGPD.",
    ],
  },
  {
    title: "Quando",
    items: [
      "Somente durante a jornada que você inicia e encerra no app. Fora dela nada é coletado, e o servidor descarta qualquer ponto fora da jornada.",
      "Durante a jornada, cerca de uma posição a cada 30 segundos, e a cada 15 segundos quando você estiver a caminho de uma OS.",
      "Com o app aberto ou em segundo plano. No Android aparece uma notificação fixa enquanto a jornada estiver ativa.",
    ],
  },
  {
    title: "O que é coletado",
    items: [
      "Sua localização (latitude e longitude) e a precisão do GPS.",
      "Velocidade e direção, quando o aparelho informar.",
      "Nível de bateria do celular.",
      "Se a posição vem de um aplicativo de localização falsa (detecção de GPS simulado).",
    ],
  },
  {
    title: "Por quanto tempo",
    items: [`As posições ficam guardadas por ${RETENTION_DAYS} dias e depois são apagadas.`],
  },
  {
    title: "Seus controles",
    items: [
      "Você inicia e encerra a jornada quando quiser, pelo botão na tela inicial. Sair do app também encerra a jornada.",
      "Dúvidas sobre seus dados: fale com o responsável pela operação na sua empresa.",
    ],
  },
];

/**
 * Termo de ciência do rastreamento (LGPD). Aparece no primeiro acesso e antes da primeira jornada.
 * O aceite grava POST /tracking/consent e já pede a permissão de localização do sistema.
 * Com `?start=1` (vindo do botão "Iniciar jornada"), a jornada começa logo após o aceite.
 */
export default function TrackingConsentScreen() {
  const { user } = useSession();
  const { start } = useLocalSearchParams<{ start?: string }>();
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
      const permissions = await requestLocationPermissions();
      if (!permissions.foreground) {
        setError(
          "Termo aceito, mas o acesso à localização foi negado. Libere a localização para o Maxx Field nas configurações do celular antes de iniciar a jornada.",
        );
        setBusy(false);
        return;
      }
      if (start === "1") {
        await startShift();
        showToast("Jornada iniciada", { tone: "success", description: "Rastreamento ativo até você encerrar." });
      } else {
        showToast("Termo aceito", {
          tone: "success",
          description:
            permissions.background === false
              ? "Sem “Sempre”: o rastreamento só funcionará com o app aberto. Dá para mudar nas configurações."
              : "Inicie a jornada quando começar o trabalho.",
        });
      }
      if (router.canGoBack()) router.back();
      else router.replace("/");
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
      <View style={{ gap: 8 }}>
        <Text style={styles.title}>Uso da sua localização</Text>
        <BrandRule width={44} />
        <Text style={styles.lead}>
          O Maxx Field registra sua localização só durante a jornada de trabalho, para acompanhar o deslocamento
          até o cliente. Leia como funciona e confirme.
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
      {!acceptedAt ? (
        <Card style={styles.permission}>
          <Text style={styles.permissionTitle}>Permissão do celular</Text>
          <Text style={styles.itemText}>
            Ao confirmar, o celular vai pedir acesso à localização. Escolha “Permitir o tempo todo” (Android) ou
            “Sempre” (iPhone) para registrar também com o app em segundo plano durante a jornada.
          </Text>
        </Card>
      ) : null}
      {error ? <ErrorBox message={error} /> : null}
      {acceptedAt ? (
        <Text style={styles.accepted}>Termo aceito em {formatDateTime(acceptedAt)}.</Text>
      ) : (
        <Button
          title={start === "1" ? "Concordo · iniciar jornada" : "Concordo e permitir localização"}
          variant="primary"
          onPress={accept}
          loading={busy}
        />
      )}
      <Button title={acceptedAt ? "Fechar" : "Agora não"} variant="ghost" onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))} disabled={busy} />
      {!acceptedAt ? (
        <Text style={styles.footnote}>Sem o aceite você usa o app normalmente, mas não consegue iniciar a jornada.</Text>
      ) : null}
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
    permission: { gap: 6, backgroundColor: c.primarySoft, borderColor: c.primary + "33" },
    permissionTitle: { fontSize: 14, fontWeight: "700", color: c.ink },
    accepted: { textAlign: "center", fontSize: 13, color: c.success, fontWeight: "600" },
    footnote: { textAlign: "center", fontSize: 12, color: c.inkSubtle, lineHeight: 17 },
  });
