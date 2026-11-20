// Transporte (Configurações › Atendimento): os meios com que o técnico chega ao atendimento e se tem CNH, que a central
// vê na ficha. Salva ao tocar, sem botão (os meios e a CNH vão juntos); sem rede, avisa e não muda. "Nenhum", no fim
// dos meios, fica marcado quando o transporte foi informado sem meio: tocar nele grava sem meio e mantém a CNH, e tocar
// num meio o desmarca. Nunca informado (TRANSPORT_UNSET), a tela começa sem nada marcado e qualquer toque grava, mesmo
// voltando a tudo desmarcado antes do envio ("Nenhum · sem CNH").

import { Stack } from "expo-router";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CheckCard } from "../../components/settings/CheckCard";
import { OfflineNotice } from "../../components/settings/OfflineNotice";
import { ProfileGate } from "../../components/settings/ProfileGate";
import { SavingStatus } from "../../components/settings/SavingStatus";
import { Text } from "../../components/Text";
import { EmptyState, InfoBox } from "../../components/ui";
import { createAutoSave, useAutoSave } from "../../lib/autoSave";
import { TRANSPORT_MODE, TRANSPORT_MODE_ORDER } from "../../lib/constants";
import { UNAVAILABLE, useTechProfileScreen } from "../../lib/technicalProfile";
import { markNone, noneMarked, sameSavedTransport, toggleMode, TRANSPORT_UNSET, transportBody } from "../../lib/techProfileForm";
import type { TransportInfo } from "../../lib/types";
import { useStyles, useTheme, type Palette } from "../../theme/theme";

const transportSaver = createAutoSave<TransportInfo>({
  select: (profile) => profile.transport ?? TRANSPORT_UNSET,
  equals: sameSavedTransport,
  body: (transport) => ({ transport: transportBody(transport) }),
  offlineHint: "Conecte o aparelho para mudar o transporte.",
  errorTitle: "Não foi possível salvar o transporte",
});

export default function TransportScreen() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { gate, stale, retry, refresh, refreshing } = useTechProfileScreen();
  const saved = gate.status === "ready" ? (gate.profile.transport ?? TRANSPORT_UNSET) : TRANSPORT_UNSET;
  const { value, change, status } = useAutoSave(transportSaver, saved);
  const none = noneMarked(value);

  const header = <Stack.Screen options={{ headerRight: () => <SavingStatus status={status} /> }} />;

  if (gate.status === "unavailable") {
    return (
      <>
        {header}
        <View style={styles.center}>
          <EmptyState icon="alert" title={UNAVAILABLE.title} description={UNAVAILABLE.description} action={{ label: "Tentar de novo", onPress: retry }} />
        </View>
      </>
    );
  }
  if (gate.status !== "ready") {
    return (
      <>
        {header}
        <ProfileGate load={gate} onRetry={retry} />
      </>
    );
  }

  return (
    <>
      {header}
      <ScrollView
        style={styles.screen}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} colors={[c.primary]} tintColor={c.primary} />}
      >
        <OfflineNotice />
        {stale ? <InfoBox message="Não foi possível atualizar agora. Os dados podem estar desatualizados." /> : null}
        <View style={styles.section}>
          <Text style={styles.title} accessibilityRole="header">
            Meios de transporte
          </Text>
          {TRANSPORT_MODE_ORDER.map((mode) => (
            <CheckCard
              key={mode}
              label={TRANSPORT_MODE[mode]}
              checked={value.modes.includes(mode)}
              onPress={() => change((current) => toggleMode(current, mode))}
            />
          ))}
          {/* Marcado, o toque não muda nada: sai dele marcando um meio. */}
          <CheckCard
            label="Nenhum"
            checked={none}
            onPress={() => {
              if (!none) change(markNone);
            }}
          />
        </View>
        <View style={styles.section}>
          <Text style={styles.title} accessibilityRole="header">
            Habilitação
          </Text>
          <CheckCard
            label="Tenho CNH"
            checked={value.driver_license}
            onPress={() => change((current) => ({ ...current, driver_license: !current.driver_license }))}
          />
        </View>
      </ScrollView>
    </>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    content: { padding: 16, gap: 20 },
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: c.canvas },
    section: { gap: 8 },
    // Como o título de bloco (SectionTitle), com o papel de cabeçalho para o leitor de tela.
    title: { fontSize: 12, fontWeight: "700", color: c.inkMuted, textTransform: "uppercase", letterSpacing: 0.6 },
  });
