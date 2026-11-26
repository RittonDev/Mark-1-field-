// Transporte (Configurações › Perfil profissional): os meios com que o técnico chega ao atendimento, se tem CNH e o
// veículo, que a central vê na ficha. Meios e CNH salvam ao tocar, sem botão (vão juntos); sem rede, avisa e não muda.
// "Nenhum", no fim dos meios, fica marcado quando o transporte foi informado sem meio: tocar nele grava sem meio e mantém
// a CNH, e tocar num meio o desmarca. Nunca informado (TRANSPORT_UNSET), a tela começa sem nada marcado e qualquer toque
// grava, mesmo voltando a tudo desmarcado antes do envio ("Nenhum · sem CNH"). O veículo (modelo e placa, campos
// próprios: gravar os meios não mexe nele) aparece com carro ou moto marcados, ou já informado, e grava pela folha.
// Transporte mudado por último pela central: o carimbo "Atualizado pela central em …" no topo.

import { Stack } from "expo-router";
import { useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../../components/Icon";
import { CentralStamp } from "../../components/settings/CentralStamp";
import { CheckCard } from "../../components/settings/CheckCard";
import { OfflineNotice } from "../../components/settings/OfflineNotice";
import { ProfileGate } from "../../components/settings/ProfileGate";
import { SavingStatus } from "../../components/settings/SavingStatus";
import { VehicleSheet } from "../../components/settings/VehicleSheet";
import { Text } from "../../components/Text";
import { EmptyState, InfoBox } from "../../components/ui";
import { errorMessage } from "../../lib/api";
import { createAutoSave, useAutoSave } from "../../lib/autoSave";
import { TRANSPORT_MODE, TRANSPORT_MODE_ORDER } from "../../lib/constants";
import { haptic } from "../../lib/haptics";
import { noNetwork, offlineFailure } from "../../lib/net";
import { hasCadastroV2, saveProfile } from "../../lib/profile";
import { vehicleText } from "../../lib/profileForm";
import { OFFLINE_SAVE, UNAVAILABLE, useTechProfileScreen } from "../../lib/technicalProfile";
import { markNone, noneMarked, sameSavedTransport, toggleMode, TRANSPORT_UNSET, transportBody } from "../../lib/techProfileForm";
import { showToast } from "../../lib/toast";
import type { MyProfileUpdate, TransportInfo } from "../../lib/types";
import { useStyles, useTheme, type Palette } from "../../theme/theme";

const transportSaver = createAutoSave<TransportInfo>({
  select: (profile) => profile.transport ?? TRANSPORT_UNSET,
  equals: sameSavedTransport,
  body: (transport) => ({ transport: transportBody(transport) }),
  offlineHint: "Conecte o aparelho para mudar o transporte.",
  errorTitle: "Não foi possível salvar o transporte",
});

interface SheetState {
  /** Uma folha nova a cada abertura (o formulário começa do gravado). */
  key: number;
  open: boolean;
}

export default function TransportScreen() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { gate, stale, retry, refresh, refreshing } = useTechProfileScreen();
  const saved = gate.status === "ready" ? (gate.profile.transport ?? TRANSPORT_UNSET) : TRANSPORT_UNSET;
  const { value, change, status } = useAutoSave(transportSaver, saved);
  const none = noneMarked(value);
  const [sheet, setSheet] = useState<SheetState | null>(null);

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

  const profile = gate.profile;
  const vehicle = vehicleText(profile.vehicle_model, profile.vehicle_plate);
  const vehicleSaved = Boolean(profile.vehicle_model || profile.vehicle_plate);
  // Só com o cadastro V2 no servidor; com carro ou moto marcados, ou o veículo já informado (desmarcar não o esconde).
  const vehicleShown =
    hasCadastroV2(profile) && (value.modes.includes("car") || value.modes.includes("motorcycle") || vehicleSaved);

  function openVehicle() {
    setSheet((current) => ({ key: (current?.key ?? 0) + 1, open: true }));
  }

  function closeVehicle() {
    setSheet((current) => (current ? { ...current, open: false } : current));
  }

  function vehicleClosed() {
    setSheet((current) => (current && !current.open ? null : current));
  }

  async function saveVehicle(body: MyProfileUpdate): Promise<string | null> {
    if (await noNetwork()) return OFFLINE_SAVE;
    try {
      await saveProfile(body);
      haptic.success();
      showToast("Veículo atualizado", { tone: "success" });
      closeVehicle();
      return null;
    } catch (error) {
      return (await offlineFailure(error)) ? OFFLINE_SAVE : errorMessage(error);
    }
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
        <CentralStamp stamp={profile.tech_profile_updated.transport} />
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
        {vehicleShown ? (
          <View style={styles.section}>
            <Text style={styles.title} accessibilityRole="header">
              Veículo
            </Text>
            <Pressable
              onPress={openVehicle}
              accessibilityRole="button"
              accessibilityLabel={`Veículo: ${vehicle}`}
              accessibilityHint="Abre o modelo e a placa"
              style={({ pressed }) => [styles.vehicle, pressed && { backgroundColor: c.surface2 }]}
            >
              <Text style={[styles.vehicleText, !vehicleSaved && styles.vehicleEmpty]} numberOfLines={1}>
                {vehicle}
              </Text>
              <Icon name="chevronRight" size={18} color={c.inkSubtle} />
            </Pressable>
          </View>
        ) : null}
      </ScrollView>

      {sheet ? (
        <VehicleSheet
          key={sheet.key}
          visible={sheet.open}
          model={profile.vehicle_model}
          plate={profile.vehicle_plate}
          onSubmit={saveVehicle}
          onClose={closeVehicle}
          onClosed={vehicleClosed}
        />
      ) : null}
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
    // A linha do veículo: o cartão dos meios (CheckCard), com a seta de quem abre outra tela.
    vehicle: {
      minHeight: 52,
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderRadius: 12,
      borderWidth: 1.5,
      borderColor: c.lineStrong,
      backgroundColor: c.surface,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    vehicleText: { flex: 1, fontSize: 15, fontWeight: "600", color: c.ink },
    vehicleEmpty: { fontWeight: "500", color: c.inkMuted },
  });
