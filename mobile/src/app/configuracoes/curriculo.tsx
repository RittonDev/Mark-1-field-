// Currículo (Configurações › Perfil profissional): um arquivo só (PDF ou foto, até 10 MB). Escolher o arquivo, tirar a
// foto ou pegar da galeria já envia, como a foto do perfil; com um currículo gravado, o novo troca o arquivo dele
// ("Substituir") e a central guarda o anterior. "Abrir" pede o link na hora; "Excluir" pergunta antes. O andamento
// (enviando ou excluindo) é o mesmo da linha do menu e continua se a tela sair (lib/resumeFlow.ts). Só online e só na
// memória; sem a API da gestão (hasCadastroE2), "Indisponível".

import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CadastroUnavailable } from "../../components/settings/CadastroUnavailable";
import { FileCard, FileChoices, FileSourceSheet, shownStored } from "../../components/settings/FileField";
import { OfflineNotice } from "../../components/settings/OfflineNotice";
import { ProfileGate } from "../../components/settings/ProfileGate";
import { Text } from "../../components/Text";
import { Button, Card, EmptyState, InfoBox } from "../../components/ui";
import { splitDocuments } from "../../lib/documentRules";
import { openDocument } from "../../lib/documents";
import { hasCadastroE2 } from "../../lib/profile";
import { changeResume, deleteResume, useResumeRecovery, useResumeTask } from "../../lib/resumeFlow";
import { useTechProfileScreen } from "../../lib/technicalProfile";
import { useStyles, useTheme, type Palette } from "../../theme/theme";

export default function ResumeScreen() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { gate, stale, retry, refresh, refreshing } = useTechProfileScreen(hasCadastroE2);
  const task = useResumeTask();
  const [menu, setMenu] = useState(false);
  useResumeRecovery();

  if (gate.status === "unavailable") return <CadastroUnavailable onRetry={retry} />;
  if (gate.status !== "ready") return <ProfileGate load={gate} onRetry={retry} />;

  const resume = splitDocuments(gate.profile.documents).resume;
  const busy = task !== null;
  const status = busy ? (
    <View style={styles.status} accessibilityLiveRegion="polite">
      <ActivityIndicator size="small" color={c.inkMuted} />
      <Text style={styles.statusText}>{task === "upload" ? "Enviando currículo…" : "Excluindo currículo…"}</Text>
    </View>
  ) : null;

  return (
    <>
      <ScrollView
        style={styles.screen}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} colors={[c.primary]} tintColor={c.primary} />}
      >
        <OfflineNotice text="Sem internet: conecte o aparelho para enviar ou excluir." />
        {stale ? <InfoBox message="Não foi possível atualizar agora. Os dados podem estar desatualizados." /> : null}

        {resume ? (
          <Card style={styles.card}>
            <FileCard file={shownStored(resume)} />
            {status}
            <View style={styles.actions}>
              <Button compact title="Abrir" onPress={() => void openDocument(resume)} disabled={busy} />
              <Button compact title="Substituir" onPress={() => setMenu(true)} disabled={busy} />
              <Button compact variant="danger" title="Excluir" onPress={() => void deleteResume(resume)} disabled={busy} />
            </View>
          </Card>
        ) : (
          <View style={styles.empty}>
            <EmptyState icon="fileText" title="Nenhum currículo" />
            {status}
            <FileChoices onPick={(source) => void changeResume(source)} disabled={busy} />
          </View>
        )}

        <Pressable
          onPress={() => router.push("/privacidade")}
          hitSlop={14}
          accessibilityRole="link"
          style={({ pressed }) => [styles.privacy, pressed && styles.linkPressed]}
        >
          <Text style={styles.link}>Aviso de privacidade</Text>
        </Pressable>
      </ScrollView>

      <FileSourceSheet
        visible={menu}
        title="Substituir o currículo"
        onPick={(source) => void changeResume(source)}
        onClose={() => setMenu(false)}
      />
    </>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    content: { padding: 16, gap: 16 },
    card: { gap: 12 },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    empty: { gap: 12 },
    status: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 24 },
    statusText: { fontSize: 13, fontWeight: "600", color: c.inkMuted },
    privacy: { alignSelf: "flex-start" },
    link: { fontSize: 13, fontWeight: "600", color: c.brandInk },
    linkPressed: { opacity: 0.6 },
  });
