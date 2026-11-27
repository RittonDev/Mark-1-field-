// Documentos (Configurações › Dados pessoais e cadastrais): as certificações (com a validade, quando tem) e os documentos
// pessoais que o técnico manda para a central, em dois blocos, na ordem do servidor (a certificação que vence primeiro
// em cima; os documentos pelo título). Cada item mostra o título, a validade no tom do problema (vencida em vermelho,
// vencendo em até 30 dias em âmbar) e o arquivo ("PDF · enviado em …", ou "enviado pela central em …"). Tocar abre o
// formulário (configuracoes/documento?id=), "Adicionar" abre o de incluir (?grupo=) e a lixeira exclui, com confirmação.
// Uma exclusão por vez: enquanto ela está no ar, as outras ações ficam desligadas, também depois de sair e voltar
// (lib/technicalProfile.ts). Até 30 entre certificações e documentos (o currículo tem tela própria). Só online e só na
// memória; sem a API da gestão (hasCadastroE2), "Indisponível".

import { router } from "expo-router";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../../components/Icon";
import { useListMotion } from "../../components/motion";
import { CadastroUnavailable } from "../../components/settings/CadastroUnavailable";
import { OfflineNotice } from "../../components/settings/OfflineNotice";
import { ProfileGate } from "../../components/settings/ProfileGate";
import { Text } from "../../components/Text";
import { Button, InfoBox } from "../../components/ui";
import { errorMessage } from "../../lib/api";
import { documentDue, documentDueText } from "../../lib/constants";
import { confirmAction } from "../../lib/dialogs";
import {
  DOCUMENT_GROUP_TEXT,
  DOCUMENT_GROUPS,
  documentFileLine,
  documentGroupParam,
  documentsFull,
  DOCUMENTS_LIMIT_TEXT,
  documentSpoken,
  splitDocuments,
  type DocumentGroup,
} from "../../lib/documentRules";
import { deleteDocument } from "../../lib/documents";
import { haptic } from "../../lib/haptics";
import { noNetwork, offlineFailure } from "../../lib/net";
import { hasCadastroE2 } from "../../lib/profile";
import { todayIso } from "../../lib/profileForm";
import { trackListWrite, useListWrite, useTechProfileScreen } from "../../lib/technicalProfile";
import { showToast } from "../../lib/toast";
import type { MyDocument } from "../../lib/types";
import { RADIUS, useStyles, useTheme, type Palette } from "../../theme/theme";

const NO_INTERNET = "Sem internet";
const OFFLINE_DELETE = "Conecte o aparelho para excluir.";

export default function DocumentsScreen() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const motion = useListMotion();
  const { gate, stale, retry, refresh, refreshing } = useTechProfileScreen(hasCadastroE2);
  // Uma exclusão no ar (`writing`): incluir, abrir e excluir ficam desligados. `removing`: os documentos saindo, pelo id.
  const { busy: writing, removing } = useListWrite("documents");

  if (gate.status === "unavailable") return <CadastroUnavailable onRetry={retry} />;
  if (gate.status !== "ready") return <ProfileGate load={gate} onRetry={retry} />;

  const today = todayIso();
  const blocks = splitDocuments(gate.profile.documents);
  const full = documentsFull(gate.profile.documents);
  const listOf = (group: DocumentGroup) => (group === "certification" ? blocks.certifications : blocks.personal);

  function open(doc: MyDocument) {
    if (writing) return;
    router.push({ pathname: "/configuracoes/documento", params: { id: doc.id } });
  }

  function add(group: DocumentGroup) {
    if (writing || full) return;
    router.push({ pathname: "/configuracoes/documento", params: { grupo: documentGroupParam(group) } });
  }

  async function remove(group: DocumentGroup, doc: MyDocument) {
    if (writing) return;
    const text = DOCUMENT_GROUP_TEXT[group];
    const ok = await confirmAction(text.confirmDelete, `“${doc.title}” sai do seu cadastro.`, { confirmText: "Excluir", destructive: true });
    if (!ok) return;
    if (await noNetwork()) {
      showToast(NO_INTERNET, { description: OFFLINE_DELETE });
      return;
    }
    try {
      await trackListWrite("documents", doc.id, () => deleteDocument(doc.id));
      haptic.success();
      showToast(text.removed, { tone: "success", description: doc.title });
    } catch (error) {
      if (await offlineFailure(error)) showToast(NO_INTERNET, { description: OFFLINE_DELETE });
      else showToast("Não foi possível excluir", { tone: "error", description: errorMessage(error) });
    }
  }

  /** A validade no tom do problema: vencida em vermelho, vencendo em âmbar, válida neutra. */
  function dueColor(expiresOn: string | null) {
    const state = documentDue(expiresOn, today)?.state;
    return state === "expired" ? c.dangerInk : state === "soon" ? c.warningInk : c.inkMuted;
  }

  function renderItem(group: DocumentGroup, doc: MyDocument, index: number) {
    const leaving = removing.includes(doc.id);
    const due = documentDueText(doc.expires_on, today);
    return (
      <Animated.View
        key={doc.id}
        entering={motion.entering(index)}
        exiting={motion.reduced ? undefined : FadeOut.duration(150)}
        layout={motion.layout}
        style={[styles.item, leaving && styles.leaving]}
      >
        <Pressable
          onPress={() => open(doc)}
          disabled={writing}
          accessibilityRole="button"
          accessibilityLabel={documentSpoken(doc, today)}
          accessibilityHint="Abre para editar"
          accessibilityState={{ disabled: writing, busy: leaving }}
          style={({ pressed }) => [styles.itemMain, pressed && styles.pressed]}
        >
          <View style={styles.icon}>
            <Icon name={doc.content_type === "application/pdf" ? "note" : "camera"} size={20} color={c.brandInk} />
          </View>
          <View style={styles.itemText}>
            <Text style={styles.title} numberOfLines={2}>
              {doc.title}
            </Text>
            {due ? <Text style={[styles.due, { color: dueColor(doc.expires_on) }]}>{due}</Text> : null}
            <Text style={styles.meta}>{documentFileLine(doc)}</Text>
          </View>
        </Pressable>
        {leaving ? (
          <View style={styles.trash}>
            <ActivityIndicator size="small" color={c.danger} />
          </View>
        ) : (
          <Pressable
            onPress={() => void remove(group, doc)}
            disabled={writing}
            accessibilityRole="button"
            accessibilityLabel={`Excluir ${doc.title}`}
            accessibilityState={{ disabled: writing }}
            style={({ pressed }) => [styles.trash, pressed && { backgroundColor: c.dangerSoft }, writing && styles.off]}
          >
            <Icon name="trash" size={20} color={c.danger} />
          </Pressable>
        )}
      </Animated.View>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} colors={[c.primary]} tintColor={c.primary} />}
    >
      <OfflineNotice text="Sem internet: conecte o aparelho para enviar ou excluir." />
      {stale ? <InfoBox message="Não foi possível atualizar agora. Os dados podem estar desatualizados." /> : null}
      {full ? <InfoBox message={DOCUMENTS_LIMIT_TEXT} /> : null}

      {DOCUMENT_GROUPS.map((group) => {
        const text = DOCUMENT_GROUP_TEXT[group];
        const items = listOf(group);
        return (
          <View key={group} style={styles.section}>
            <Text style={styles.sectionTitle} accessibilityRole="header">
              {text.block}
            </Text>
            {items.length ? items.map((doc, index) => renderItem(group, doc, index)) : <Text style={styles.empty}>{text.empty}</Text>}
            <Button title={text.add} icon="plus" onPress={() => add(group)} disabled={full || writing} />
          </View>
        );
      })}

      <Pressable
        onPress={() => router.push("/privacidade")}
        hitSlop={14}
        accessibilityRole="link"
        style={({ pressed }) => [styles.privacy, pressed && styles.linkPressed]}
      >
        <Text style={styles.link}>Aviso de privacidade</Text>
      </Pressable>
    </ScrollView>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    content: { padding: 16, gap: 24 },
    section: { gap: 10 },
    // Como o título de bloco (SectionTitle), com o papel de cabeçalho para o leitor de tela.
    sectionTitle: { fontSize: 12, fontWeight: "700", color: c.inkMuted, textTransform: "uppercase", letterSpacing: 0.6 },
    empty: { fontSize: 14, color: c.inkMuted },
    item: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingVertical: 12,
      paddingLeft: 16,
      paddingRight: 8,
      backgroundColor: c.surface,
      borderRadius: RADIUS.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      boxShadow: c.elevation,
    },
    leaving: { opacity: 0.6 },
    itemMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 2 },
    pressed: { opacity: 0.7 },
    icon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: c.primarySoft },
    itemText: { flex: 1, gap: 2 },
    title: { fontSize: 15, fontWeight: "700", color: c.ink },
    due: { fontSize: 13, fontWeight: "600" },
    meta: { fontSize: 13, color: c.inkMuted },
    trash: { width: 44, height: 44, borderRadius: RADIUS.control, alignItems: "center", justifyContent: "center" },
    off: { opacity: 0.4 },
    privacy: { alignSelf: "flex-start" },
    link: { fontSize: 13, fontWeight: "600", color: c.brandInk },
    linkPressed: { opacity: 0.6 },
  });
