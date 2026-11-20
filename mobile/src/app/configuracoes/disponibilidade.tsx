// Disponibilidade (Configurações › Atendimento): os turnos em que o técnico pode atender, dia a dia (manhã, tarde,
// noite e madrugada; não é a jornada). Salva ao tocar, sem botão: os toques de perto vão juntos num envio só (sem rede,
// avisa e não muda). Cada dia abre os seus turnos; "Copiar para os dias úteis" repete os de um dia de segunda a sexta.

import { Stack } from "expo-router";
import { useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DayCard } from "../../components/settings/DayCard";
import { OfflineNotice } from "../../components/settings/OfflineNotice";
import { ProfileGate } from "../../components/settings/ProfileGate";
import { SavingStatus } from "../../components/settings/SavingStatus";
import { EmptyState, InfoBox } from "../../components/ui";
import { createAutoSave, useAutoSave } from "../../lib/autoSave";
import { periodsPhrase, slotPeriods, sortSlots, WEEKDAY_ORDER } from "../../lib/constants";
import { confirmAction } from "../../lib/dialogs";
import { haptic } from "../../lib/haptics";
import { UNAVAILABLE, useTechProfileScreen } from "../../lib/technicalProfile";
import { canCopyToWorkdays, copyToWorkdays, sameSlots, toggleSlot } from "../../lib/techProfileForm";
import type { AvailabilitySlot, Weekday } from "../../lib/types";
import { useStyles, useTheme, type Palette } from "../../theme/theme";

const availabilitySaver = createAutoSave<AvailabilitySlot[]>({
  select: (profile) => profile.availability,
  equals: sameSlots,
  body: (slots) => ({ availability: sortSlots(slots) }),
  offlineHint: "Conecte o aparelho para mudar a disponibilidade.",
  errorTitle: "Não foi possível salvar a disponibilidade",
});

const NO_SLOTS: AvailabilitySlot[] = [];

export default function AvailabilityScreen() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { gate, stale, retry, refresh, refreshing } = useTechProfileScreen();
  const saved = gate.status === "ready" ? gate.profile.availability : NO_SLOTS;
  const { value, change, ready, status } = useAutoSave(availabilitySaver, saved);
  // Todos começam fechados; mais de um pode ficar aberto.
  const [open, setOpen] = useState<Weekday[]>([]);

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

  function toggleDay(day: Weekday) {
    setOpen((days) => (days.includes(day) ? days.filter((d) => d !== day) : [...days, day]));
  }

  async function copy(day: Weekday) {
    if (!ready()) return;
    const { overwrites } = copyToWorkdays(value, day);
    if (overwrites) {
      const ok = await confirmAction("Copiar para os dias úteis?", `Segunda a sexta ficam com: ${periodsPhrase(slotPeriods(value, day))}.`, {
        confirmText: "Copiar",
      });
      if (!ok) return;
    }
    change((current) => copyToWorkdays(current, day).next, haptic.success);
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
        {WEEKDAY_ORDER.map((day) => (
          <DayCard
            key={day}
            day={day}
            periods={slotPeriods(value, day)}
            expanded={open.includes(day)}
            onToggleExpanded={() => toggleDay(day)}
            onTogglePeriod={(period) => change((current) => toggleSlot(current, `${day}:${period}`))}
            onCopy={canCopyToWorkdays(value, day) ? () => void copy(day) : undefined}
          />
        ))}
      </ScrollView>
    </>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    content: { padding: 16, gap: 10 },
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: c.canvas },
  });
