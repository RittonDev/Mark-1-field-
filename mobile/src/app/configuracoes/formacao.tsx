// Formação (Configurações › Perfil profissional): cursos, certificações e escolaridade, com o nível, a instituição e o
// período (o fim vazio é "em andamento"). Incluir e editar numa folha; excluir com confirmação. A lista vem na ordem do
// servidor (em andamento primeiro, depois as mais recentes). Uma gravação por vez, como em Aptidões: a trava vale também
// depois de sair e voltar à tela (lib/technicalProfile.ts), e o corpo é montado quando a gravação sai da fila
// (saveProfileWith), com a lista que a anterior devolveu; salvar a edição de uma formação que já saiu mostra o erro na
// folha. Lista mudada por último pela central: o carimbo "Atualizado pela central em …" no topo.

import { useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeOut } from "react-native-reanimated";
import { Icon } from "../../components/Icon";
import { useListMotion } from "../../components/motion";
import { CentralStamp } from "../../components/settings/CentralStamp";
import { EducationSheet, type EducationSheetTarget } from "../../components/settings/EducationSheet";
import { FixedFooter } from "../../components/settings/FixedFooter";
import { OfflineNotice } from "../../components/settings/OfflineNotice";
import { ProfileGate } from "../../components/settings/ProfileGate";
import { Text } from "../../components/Text";
import { Button, EmptyState, InfoBox } from "../../components/ui";
import { errorMessage } from "../../lib/api";
import { EDUCATION_LEVEL, educationPeriodText, TECH_PROFILE_LIMITS } from "../../lib/constants";
import { confirmAction } from "../../lib/dialogs";
import { haptic } from "../../lib/haptics";
import { noNetwork, offlineFailure } from "../../lib/net";
import { saveProfileWith } from "../../lib/profile";
import { OFFLINE_SAVE, trackListWrite, UNAVAILABLE, useListWrite, useTechProfileScreen } from "../../lib/technicalProfile";
import { EDUCATION_MSG, educationSpoken, educationWith, educationWithout, type EducationEntry } from "../../lib/techProfileForm";
import { showToast } from "../../lib/toast";
import type { EducationItem } from "../../lib/types";
import { RADIUS, useStyles, useTheme, type Palette } from "../../theme/theme";

interface SheetState {
  /** Uma folha nova a cada abertura (o formulário começa do zero). */
  key: number;
  open: boolean;
  target: EducationSheetTarget;
}

const NO_INTERNET = "Sem internet";
const OFFLINE_DELETE = "Conecte o aparelho para excluir.";
const NO_EDUCATION: EducationItem[] = [];

export default function EducationScreen() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const motion = useListMotion();
  const { gate, stale, retry, refresh, refreshing } = useTechProfileScreen();
  const [sheet, setSheet] = useState<SheetState | null>(null);
  // Uma gravação da lista no ar (`writing`): incluir, editar e excluir ficam desligados. `removing`: os cursos que estão
  // saindo, pelo id.
  const { busy: writing, removing } = useListWrite("education");

  if (gate.status === "unavailable") {
    return (
      <View style={styles.center}>
        <EmptyState icon="alert" title={UNAVAILABLE.title} description={UNAVAILABLE.description} action={{ label: "Tentar de novo", onPress: retry }} />
      </View>
    );
  }
  if (gate.status !== "ready") return <ProfileGate load={gate} onRetry={retry} />;

  const items = gate.profile.education ?? NO_EDUCATION;
  const full = items.length >= TECH_PROFILE_LIMITS.education;

  function openSheet(target: EducationSheetTarget) {
    if (writing) return;
    setSheet((current) => ({ key: (current?.key ?? 0) + 1, open: true, target }));
  }

  function closeSheet() {
    setSheet((current) => (current ? { ...current, open: false } : current));
  }

  function sheetClosed() {
    setSheet((current) => (current && !current.open ? null : current));
  }

  async function submit(entry: EducationEntry): Promise<string | null> {
    if (await noNetwork()) return OFFLINE_SAVE;
    try {
      await trackListWrite("education", null, () =>
        saveProfileWith((profile) => {
          const next = educationWith(profile.education ?? NO_EDUCATION, entry);
          if (!next) throw new Error(EDUCATION_MSG.gone);
          return { education: next };
        }),
      );
      haptic.success();
      closeSheet();
      return null;
    } catch (error) {
      return (await offlineFailure(error)) ? OFFLINE_SAVE : errorMessage(error);
    }
  }

  async function remove(item: EducationItem) {
    if (writing) return;
    const ok = await confirmAction("Excluir a formação?", `“${item.course}” sai da sua lista.`, { confirmText: "Excluir", destructive: true });
    if (!ok) return;
    if (await noNetwork()) {
      showToast(NO_INTERNET, { description: OFFLINE_DELETE });
      return;
    }
    try {
      await trackListWrite("education", item.id, () =>
        saveProfileWith((profile) => ({ education: educationWithout(profile.education ?? NO_EDUCATION, item.id) })),
      );
      haptic.success();
    } catch (error) {
      if (await offlineFailure(error)) showToast(NO_INTERNET, { description: OFFLINE_DELETE });
      else showToast("Não foi possível excluir", { tone: "error", description: errorMessage(error) });
    }
  }

  return (
    <View style={styles.screen}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} colors={[c.primary]} tintColor={c.primary} />}
      >
        <OfflineNotice />
        {stale ? <InfoBox message="Não foi possível atualizar agora. Os dados podem estar desatualizados." /> : null}
        <CentralStamp stamp={gate.profile.tech_profile_updated.education} />
        {items.length ? (
          items.map((item, index) => {
            const leaving = removing.includes(item.id);
            return (
              <Animated.View
                key={item.id}
                entering={motion.entering(index)}
                exiting={motion.reduced ? undefined : FadeOut.duration(150)}
                layout={motion.layout}
                style={[styles.card, leaving && styles.leaving]}
              >
                <View style={styles.cardText} accessible accessibilityLabel={educationSpoken(item)}>
                  <Text style={styles.course}>{item.course}</Text>
                  <Text style={styles.level}>{EDUCATION_LEVEL[item.level] ?? item.level}</Text>
                  <Text style={styles.institution}>{item.institution}</Text>
                  <View style={styles.periodRow}>
                    <Icon name="calendar" size={14} color={c.inkSubtle} />
                    <Text style={styles.period}>{educationPeriodText(item.start, item.end)}</Text>
                  </View>
                </View>
                <View style={styles.actions}>
                  <Pressable
                    onPress={() => openSheet({ kind: "edit", item })}
                    disabled={writing}
                    hitSlop={4}
                    accessibilityRole="button"
                    accessibilityLabel={`Editar ${item.course}`}
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
                      onPress={() => void remove(item)}
                      disabled={writing}
                      hitSlop={4}
                      accessibilityRole="button"
                      accessibilityLabel={`Excluir ${item.course}`}
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
          <EmptyState icon="graduation" title="Nenhuma formação" description="Inclua cursos, certificações e a sua escolaridade." />
        )}
      </ScrollView>

      <FixedFooter>
        {full ? <InfoBox message={`Limite de ${TECH_PROFILE_LIMITS.education} formações. Exclua uma para incluir outra.`} /> : null}
        <Button title="Adicionar formação" icon="plus" variant="primary" onPress={() => openSheet({ kind: "add" })} disabled={full || writing} />
      </FixedFooter>

      {sheet ? (
        <EducationSheet
          key={sheet.key}
          visible={sheet.open}
          target={sheet.target}
          onSubmit={submit}
          onClose={closeSheet}
          onClosed={sheetClosed}
        />
      ) : null}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    scroll: { flex: 1 },
    content: { padding: 16, gap: 10 },
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: c.canvas },
    card: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 12,
      paddingVertical: 14,
      paddingHorizontal: 16,
      backgroundColor: c.surface,
      borderRadius: RADIUS.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      boxShadow: c.elevation,
    },
    leaving: { opacity: 0.6 },
    cardText: { flex: 1, gap: 3 },
    course: { fontSize: 15, fontWeight: "700", color: c.ink },
    level: { fontSize: 13, fontWeight: "600", color: c.inkMuted },
    institution: { fontSize: 13, color: c.ink },
    periodRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
    period: { fontSize: 13, color: c.inkMuted, fontVariant: ["tabular-nums"] },
    actions: { flexDirection: "row", gap: 8 },
    action: { width: 40, height: 40, borderRadius: RADIUS.control, alignItems: "center", justifyContent: "center" },
    edit: { backgroundColor: c.primarySoft },
    delete: { backgroundColor: c.dangerSoft },
    pressed: { opacity: 0.7 },
    off: { opacity: 0.4 },
  });
