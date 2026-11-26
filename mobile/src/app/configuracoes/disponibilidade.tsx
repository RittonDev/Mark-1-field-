// Dias e horários (Configurações › Perfil profissional): os turnos em que o técnico pode atender, dia a dia (manhã,
// tarde, noite e madrugada; não é a jornada), e os períodos em que não atende (de/até, sem motivo). Os turnos salvam ao
// tocar, sem botão: os toques de perto vão juntos num envio só (sem rede, avisa e não muda); cada dia abre os seus
// turnos e "Copiar para os dias úteis" repete os de um dia de segunda a sexta. Os períodos entram e mudam numa folha e
// saem com confirmação, como na Formação: uma gravação por vez (a trava vale também depois de sair e voltar à tela,
// lib/technicalProfile.ts), com a lista inteira montada quando a gravação sai da fila (saveProfileWith). O período de
// hoje leva "Agora". Sem a API nova (hasCadastroV2), só os turnos.

import { Stack } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../../components/Icon";
import { useListMotion } from "../../components/motion";
import { DayCard } from "../../components/settings/DayCard";
import { OfflineNotice } from "../../components/settings/OfflineNotice";
import { PeriodSheet, type PeriodSheetTarget } from "../../components/settings/PeriodSheet";
import { ProfileGate } from "../../components/settings/ProfileGate";
import { SavingStatus } from "../../components/settings/SavingStatus";
import { Text } from "../../components/Text";
import { Button, EmptyState, InfoBox } from "../../components/ui";
import { errorMessage } from "../../lib/api";
import { createAutoSave, useAutoSave } from "../../lib/autoSave";
import { periodsPhrase, slotPeriods, sortSlots, UNAVAILABILITY_LIMITS, WEEKDAY_ORDER } from "../../lib/constants";
import { confirmAction } from "../../lib/dialogs";
import { haptic } from "../../lib/haptics";
import { noNetwork, offlineFailure } from "../../lib/net";
import { hasCadastroV2, saveProfileWith } from "../../lib/profile";
import { OFFLINE_SAVE, trackListWrite, UNAVAILABLE, useListWrite, useTechProfileScreen } from "../../lib/technicalProfile";
import { canCopyToWorkdays, copyToWorkdays, sameSlots, toggleSlot } from "../../lib/techProfileForm";
import { showToast } from "../../lib/toast";
import type { AvailabilitySlot, UnavailabilityIn, UnavailabilityPeriod, Weekday } from "../../lib/types";
import {
  currentPeriod,
  localDay,
  PERIOD_MSG,
  periodSpoken,
  periodText,
  unavailabilityWith,
  unavailabilityWithout,
} from "../../lib/unavailability";
import { RADIUS, useStyles, useTheme, type Palette } from "../../theme/theme";

const availabilitySaver = createAutoSave<AvailabilitySlot[]>({
  select: (profile) => profile.availability,
  equals: sameSlots,
  body: (slots) => ({ availability: sortSlots(slots) }),
  offlineHint: "Conecte o aparelho para mudar os turnos.",
  errorTitle: "Não foi possível salvar os turnos",
});

interface SheetState {
  /** Uma folha nova a cada abertura (o formulário começa do zero). */
  key: number;
  open: boolean;
  target: PeriodSheetTarget;
}

const NO_SLOTS: AvailabilitySlot[] = [];
const NO_PERIODS: UnavailabilityPeriod[] = [];
const NO_INTERNET = "Sem internet";
const OFFLINE_DELETE = "Conecte o aparelho para excluir.";

export default function ScheduleScreen() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const motion = useListMotion();
  const { gate, stale, retry, refresh, refreshing } = useTechProfileScreen();
  const saved = gate.status === "ready" ? gate.profile.availability : NO_SLOTS;
  const { value, change, ready, status } = useAutoSave(availabilitySaver, saved);
  // Todos começam fechados; mais de um pode ficar aberto.
  const [open, setOpen] = useState<Weekday[]>([]);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  // Uma gravação dos períodos no ar (`writing`): incluir, editar e excluir ficam desligados. `removing`: os que estão
  // saindo, pelo id.
  const { busy: writing, removing } = useListWrite("unavailability");

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

  const withPeriods = hasCadastroV2(gate.profile);
  const periods = withPeriods ? (gate.profile.unavailability ?? NO_PERIODS) : NO_PERIODS;
  const today = localDay();
  const full = periods.length >= UNAVAILABILITY_LIMITS.periods;

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

  function openSheet(target: PeriodSheetTarget) {
    if (writing) return;
    setSheet((current) => ({ key: (current?.key ?? 0) + 1, open: true, target }));
  }

  function closeSheet() {
    setSheet((current) => (current ? { ...current, open: false } : current));
  }

  function sheetClosed() {
    setSheet((current) => (current && !current.open ? null : current));
  }

  async function submit(entry: UnavailabilityIn): Promise<string | null> {
    if (await noNetwork()) return OFFLINE_SAVE;
    try {
      await trackListWrite("unavailability", null, () =>
        saveProfileWith((profile) => {
          const next = unavailabilityWith(profile.unavailability ?? NO_PERIODS, entry);
          if (!next) throw new Error(PERIOD_MSG.gone);
          return { unavailability: next };
        }),
      );
      haptic.success();
      closeSheet();
      return null;
    } catch (error) {
      return (await offlineFailure(error)) ? OFFLINE_SAVE : errorMessage(error);
    }
  }

  async function remove(period: UnavailabilityPeriod) {
    if (writing) return;
    const ok = await confirmAction("Excluir o período?", `${periodText(period)} sai da lista.`, { confirmText: "Excluir", destructive: true });
    if (!ok) return;
    if (await noNetwork()) {
      showToast(NO_INTERNET, { description: OFFLINE_DELETE });
      return;
    }
    try {
      await trackListWrite("unavailability", period.id, () =>
        saveProfileWith((profile) => ({ unavailability: unavailabilityWithout(profile.unavailability ?? NO_PERIODS, period.id) })),
      );
      haptic.success();
    } catch (error) {
      if (await offlineFailure(error)) showToast(NO_INTERNET, { description: OFFLINE_DELETE });
      else showToast("Não foi possível excluir", { tone: "error", description: errorMessage(error) });
    }
  }

  const now = currentPeriod(periods, today);
  const editingId = sheet?.target.kind === "edit" ? sheet.target.period.id : null;

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
          <Text style={styles.sectionTitle} accessibilityRole="header">
            Turnos
          </Text>
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
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle} accessibilityRole="header">
            Indisponibilidade
          </Text>
          {!withPeriods ? (
            <InfoBox message={UNAVAILABLE.description} />
          ) : (
            <>
              {periods.length ? (
                periods.map((period, index) => {
                  const leaving = removing.includes(period.id);
                  const text = periodText(period);
                  return (
                    <Animated.View
                      key={period.id}
                      entering={motion.entering(index)}
                      exiting={motion.reduced ? undefined : FadeOut.duration(150)}
                      layout={motion.layout}
                      style={[styles.card, leaving && styles.leaving]}
                    >
                      <View style={styles.cardText} accessible accessibilityLabel={periodSpoken(period, today)}>
                        <Icon name="calendar" size={16} color={c.inkSubtle} />
                        <Text style={styles.period}>{text}</Text>
                        {now?.id === period.id ? (
                          <View style={styles.chip}>
                            <Text style={styles.chipText} maxFontSizeMultiplier={1.4}>
                              Agora
                            </Text>
                          </View>
                        ) : null}
                      </View>
                      <View style={styles.actions}>
                        <Pressable
                          onPress={() => openSheet({ kind: "edit", period })}
                          disabled={writing}
                          hitSlop={4}
                          accessibilityRole="button"
                          accessibilityLabel={`Editar o período ${text}`}
                          accessibilityState={{ disabled: writing }}
                          style={({ pressed }) => [styles.action, styles.edit, pressed && styles.pressed, writing && styles.off]}
                        >
                          <Icon name="pencil" size={18} color={c.brandInk} />
                        </Pressable>
                        {leaving ? (
                          <View style={[styles.action, styles.delete]}>
                            <ActivityIndicator size="small" color={c.danger} />
                          </View>
                        ) : (
                          <Pressable
                            onPress={() => void remove(period)}
                            disabled={writing}
                            hitSlop={4}
                            accessibilityRole="button"
                            accessibilityLabel={`Excluir o período ${text}`}
                            accessibilityState={{ disabled: writing }}
                            style={({ pressed }) => [styles.action, styles.delete, pressed && styles.pressed, writing && styles.off]}
                          >
                            <Icon name="trash" size={18} color={c.danger} />
                          </Pressable>
                        )}
                      </View>
                    </Animated.View>
                  );
                })
              ) : (
                <Text style={styles.empty}>Nenhum período.</Text>
              )}
              {full ? <InfoBox message={PERIOD_MSG.limit} /> : null}
              <Button
                title="Adicionar período"
                icon="plus"
                onPress={() => openSheet({ kind: "add" })}
                disabled={full || writing}
              />
            </>
          )}
        </View>
      </ScrollView>

      {sheet ? (
        <PeriodSheet
          key={sheet.key}
          visible={sheet.open}
          target={sheet.target}
          others={periods.filter((period) => period.id !== editingId)}
          today={today}
          onSubmit={submit}
          onClose={closeSheet}
          onClosed={sheetClosed}
        />
      ) : null}
    </>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    content: { padding: 16, gap: 24 },
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: c.canvas },
    section: { gap: 10 },
    // Como o título de bloco (SectionTitle), com o papel de cabeçalho para o leitor de tela.
    sectionTitle: { fontSize: 12, fontWeight: "700", color: c.inkMuted, textTransform: "uppercase", letterSpacing: 0.6 },
    card: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 12,
      paddingHorizontal: 16,
      backgroundColor: c.surface,
      borderRadius: RADIUS.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      boxShadow: c.elevation,
    },
    leaving: { opacity: 0.6 },
    cardText: { flex: 1, flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
    period: { fontSize: 15, fontWeight: "700", color: c.ink, fontVariant: ["tabular-nums"] },
    chip: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: RADIUS.chip, backgroundColor: c.surface3 },
    chipText: { fontSize: 12, fontWeight: "700", color: c.ink },
    empty: { fontSize: 14, color: c.inkMuted },
    actions: { flexDirection: "row", gap: 8 },
    action: { width: 40, height: 40, borderRadius: RADIUS.control, alignItems: "center", justifyContent: "center" },
    edit: { backgroundColor: c.primarySoft },
    delete: { backgroundColor: c.dangerSoft },
    pressed: { opacity: 0.7 },
    off: { opacity: 0.4 },
  });
