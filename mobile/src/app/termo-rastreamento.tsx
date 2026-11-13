import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Linking, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "../components/Text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BrandRule } from "../components/Brand";
import { Icon } from "../components/Icon";
import { Button, Card, ErrorBox, SectionTitle } from "../components/ui";
import { locationConsentAt } from "../lib/account";
import { ApiError, errorMessage } from "../lib/api";
import { ensurePushRegistration } from "../lib/auth";
import { formatDateTime } from "../lib/format";
import { useSession } from "../lib/session";
import { showToast } from "../lib/toast";
import { acceptConsent, requestLocationPermissions, startShift, useTracking } from "../lib/tracking";
import { tint, useStyles, useTheme, type Palette } from "../theme/theme";

const RETENTION_DAYS = 90;
const BACKGROUND_HINT = "Sem “Permitir o tempo todo”: só registra com o app aberto. Dá para mudar nas configurações do celular.";

// Texto da ciência (LGPD art. 9º): o que é coletado, quando, para quê, quem vê, por quanto tempo e os
// direitos do técnico. Precisa dizer a verdade sobre TODA coleta do app, inclusive fora da jornada.
const SECTIONS: { title: string; items: string[] }[] = [
  {
    title: "Para quê",
    items: [
      "Organizar as visitas e a distribuição das OS.",
      "Acompanhar o deslocamento até a loja e o andamento dos atendimentos de campo.",
      "Os dados servem só para a gestão dos atendimentos, conforme a LGPD.",
    ],
  },
  {
    title: "Quando",
    items: [
      "Durante a jornada que você inicia e encerra no app: cerca de uma posição a cada 30 segundos, e a cada 15 segundos quando você está a caminho de uma OS.",
      "Com o app aberto ou em segundo plano. No Android aparece uma notificação fixa enquanto a jornada estiver ativa.",
      "Fora da jornada, o app só registra a posição do momento em que você inicia o deslocamento, faz o check-in, conclui a OS, registra visita improdutiva ou colhe a assinatura. Essa posição fica no histórico daquela OS.",
      "O servidor descarta qualquer ponto de rastreamento enviado fora da jornada.",
    ],
  },
  {
    title: "O que é coletado",
    items: [
      "Sua localização (latitude e longitude) e a precisão do GPS.",
      "Durante a jornada, também a velocidade e a direção (quando o aparelho informar) e o nível de bateria.",
      "Se a posição vem de um aplicativo de localização falsa (detecção de GPS simulado).",
    ],
  },
  {
    title: "Quem vê",
    items: [
      "A central (analistas e gestores), no mapa da operação e no histórico das OS.",
      "O cliente não vê sua localização: o relatório da visita mostra só os horários das etapas e se o check-in foi feito com GPS.",
    ],
  },
  {
    title: "Por quanto tempo",
    items: [
      `As posições da jornada ficam guardadas por ${RETENTION_DAYS} dias e depois são apagadas.`,
      "A posição das etapas fica no histórico da OS, junto com os horários do atendimento.",
    ],
  },
  {
    title: "Seus controles",
    items: [
      "Você inicia e encerra a jornada quando quiser, pelo botão na tela inicial.",
      "Fechar o app não encerra a jornada: encerre pelo botão. Sair da conta (Conta → Sair) também encerra.",
      "Nas etapas da OS, dá para desligar o registro da posição na hora de confirmar.",
    ],
  },
  {
    title: "Seus direitos",
    items: [
      "Você pode pedir acesso, correção ou exclusão dos seus dados de localização e retirar este aceite falando com a central.",
      "Sem o aceite você usa o app normalmente, mas não consegue iniciar a jornada.",
    ],
  },
];

/**
 * Termo de ciência do rastreamento (LGPD). Abre sozinho no máximo uma vez por dia enquanto não houver
 * aceite, e antes da primeira jornada. O aceite grava POST /tracking/consent e já pede a permissão de
 * localização do sistema. Com `?start=1` (vindo do botão "Iniciar jornada"), a jornada começa em seguida.
 */
export default function TrackingConsentScreen() {
  const { user } = useSession();
  const { start } = useLocalSearchParams<{ start?: string }>();
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const tracking = useTracking();
  const acceptedAt = locationConsentAt(user);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const wantsShift = start === "1";

  // O pedido de notificações espera o termo fechar: nunca dois pedidos de permissão ao mesmo tempo.
  useEffect(
    () => () => {
      void ensurePushRegistration();
    },
    [],
  );

  function close() {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }

  /** Inicia a jornada; se falhar (ex.: sem internet), o erro fica na tela com o botão para tentar de novo. */
  async function begin(background: boolean | null): Promise<boolean> {
    try {
      await startShift();
      showToast("Jornada iniciada", { tone: "success", description: background === false ? BACKGROUND_HINT : "Registrando até você encerrar." });
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  }

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      await acceptConsent();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 0
          ? "Sem internet: o aceite precisa chegar à central. Tente de novo quando tiver sinal."
          : errorMessage(e),
      );
      setBusy(false);
      return;
    }
    const permissions = await requestLocationPermissions();
    if (!permissions.foreground) {
      setDenied(true);
      setError("Termo aceito, mas o acesso à localização foi negado. Libere a localização para o Maxx Field nas configurações do celular para iniciar a jornada.");
      setBusy(false);
      return;
    }
    if (wantsShift) {
      if (!(await begin(permissions.background))) {
        setBusy(false);
        return;
      }
    } else {
      showToast("Termo aceito", {
        tone: "success",
        description: permissions.background === false ? BACKGROUND_HINT : "Inicie a jornada quando começar o trabalho.",
      });
    }
    close();
  }

  async function startNow() {
    setBusy(true);
    setError(null);
    if (await begin(null)) close();
    else setBusy(false);
  }

  return (
    <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
      <View style={{ gap: 8 }}>
        <Text style={styles.title} accessibilityRole="header">
          Uso da sua localização
        </Text>
        <BrandRule width={44} />
        <Text style={styles.lead}>
          O Maxx Field registra sua localização durante a jornada de trabalho e nas etapas das OS, para a central
          acompanhar os atendimentos. Leia como funciona e confirme.
        </Text>
      </View>
      {SECTIONS.map((section) => (
        <Card key={section.title} style={{ gap: 8 }}>
          <SectionTitle accent>{section.title}</SectionTitle>
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
      {denied ? <Button title="Abrir configurações" icon="shield" onPress={() => void Linking.openSettings()} /> : null}
      {acceptedAt ? (
        <View style={styles.accepted} accessibilityLiveRegion="polite">
          <Icon name="checkCircle" size={18} color={c.success} />
          <Text style={styles.acceptedText}>Termo aceito em {formatDateTime(acceptedAt)}.</Text>
        </View>
      ) : (
        <Button
          title={wantsShift ? "Concordo · iniciar jornada" : "Concordo e permitir localização"}
          variant="primary"
          onPress={() => void accept()}
          loading={busy}
        />
      )}
      {acceptedAt && wantsShift && !tracking.shift && !denied ? (
        <Button title="Iniciar jornada" icon="clock" variant="primary" onPress={() => void startNow()} loading={busy} />
      ) : null}
      <Button title={acceptedAt ? "Fechar" : "Agora não"} variant="ghost" onPress={close} disabled={busy} />
    </ScrollView>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    content: { padding: 20, gap: 14, maxWidth: 640, width: "100%", alignSelf: "center" },
    title: { fontSize: 22, fontWeight: "700", color: c.ink, letterSpacing: -0.3 },
    lead: { fontSize: 15, color: c.inkMuted, lineHeight: 21 },
    item: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
    bullet: { width: 5, height: 5, borderRadius: 3, backgroundColor: c.inkSubtle, marginTop: 9 },
    itemText: { flex: 1, fontSize: 14, color: c.ink, lineHeight: 21 },
    permission: { gap: 6, backgroundColor: c.surface2, borderColor: tint(c.primary, "33") },
    permissionTitle: { fontSize: 14, fontWeight: "700", color: c.ink },
    accepted: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 44 },
    acceptedText: { fontSize: 14, color: c.success, fontWeight: "700" },
  });
