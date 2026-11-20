// Aptidões (Configurações › Atendimento): o que o técnico sabe fazer, com o nível e o "desde" (o dia em que entrou no
// perfil; quem guarda é o servidor). Incluir e mudar o nível numa folha; excluir pela lixeira, com confirmação. Uma
// gravação por vez: enquanto uma está no ar, as outras ações da lista ficam desligadas, e o corpo sai sempre da lista
// que voltou do servidor (duas exclusões seguidas não devolvem um item apagado).

import { useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeOut } from "react-native-reanimated";
import { Icon } from "../../components/Icon";
import { useListMotion } from "../../components/motion";
import { FixedFooter } from "../../components/settings/FixedFooter";
import { OfflineNotice } from "../../components/settings/OfflineNotice";
import { ProfileGate } from "../../components/settings/ProfileGate";
import { SkillSheet, type SkillSheetTarget } from "../../components/settings/SkillSheet";
import { Text } from "../../components/Text";
import { Button, EmptyState, InfoBox } from "../../components/ui";
import { errorMessage } from "../../lib/api";
import { TECH_PROFILE_LIMITS } from "../../lib/constants";
import { confirmAction } from "../../lib/dialogs";
import { haptic } from "../../lib/haptics";
import { noNetwork, offlineFailure } from "../../lib/net";
import { getProfile, hasTechnicalProfile, saveProfile } from "../../lib/profile";
import { OFFLINE_SAVE, reloadSkillSuggestions, UNAVAILABLE, useSkillSuggestions, useTechProfileScreen } from "../../lib/technicalProfile";
import { foldName, skillLine, skillsBody, skillSpoken } from "../../lib/techProfileForm";
import { showToast } from "../../lib/toast";
import type { TechnicianSkill, TechnicianSkillIn } from "../../lib/types";
import { RADIUS, useStyles, useTheme, type Palette } from "../../theme/theme";

interface SheetState {
  /** Uma folha nova a cada abertura (o formulário começa do zero). */
  key: number;
  open: boolean;
  target: SkillSheetTarget;
}

const NO_INTERNET = "Sem internet";
const OFFLINE_DELETE = "Conecte o aparelho para excluir.";

/** A lista gravada agora: a do cadastro na memória (ou a da tela, se ele saiu da memória no meio). */
function currentSkills(shown: TechnicianSkill[]): TechnicianSkill[] {
  const profile = getProfile();
  return hasTechnicalProfile(profile) ? profile.skills : shown;
}

export default function SkillsScreen() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const motion = useListMotion();
  const { gate, stale, retry, refresh, refreshing } = useTechProfileScreen();
  const suggestions = useSkillSuggestions();
  const [sheet, setSheet] = useState<SheetState | null>(null);
  // Uma gravação da lista no ar: incluir, editar e excluir ficam desligados.
  const [writing, setWriting] = useState(false);
  // A aptidão que está saindo (pelo nome sem acento e maiúsculas).
  const [removing, setRemoving] = useState<string | null>(null);

  if (gate.status === "unavailable") {
    return (
      <View style={styles.center}>
        <EmptyState icon="alert" title={UNAVAILABLE.title} description={UNAVAILABLE.description} action={{ label: "Tentar de novo", onPress: retry }} />
      </View>
    );
  }
  if (gate.status !== "ready") return <ProfileGate load={gate} onRetry={retry} />;

  const skills = gate.profile.skills;
  const full = skills.length >= TECH_PROFILE_LIMITS.skills;
  const editing = sheet?.target.kind === "edit" ? sheet.target.skill : null;
  const others = editing ? skills.filter((skill) => foldName(skill.name) !== foldName(editing.name)) : skills;

  function pull() {
    refresh();
    void reloadSkillSuggestions();
  }

  function openSheet(target: SkillSheetTarget) {
    if (writing) return;
    setSheet({ key: Date.now(), open: true, target });
  }

  function closeSheet() {
    setSheet((current) => (current ? { ...current, open: false } : current));
  }

  function sheetClosed() {
    setSheet((current) => (current && !current.open ? null : current));
  }

  async function submit(target: SkillSheetTarget, skill: TechnicianSkillIn): Promise<string | null> {
    if (await noNetwork()) return OFFLINE_SAVE;
    const list = currentSkills(skills);
    const next =
      target.kind === "add"
        ? [...list, skill]
        : list.map((item) => (foldName(item.name) === foldName(target.skill.name) ? { name: item.name, level: skill.level } : item));
    setWriting(true);
    try {
      await saveProfile({ skills: skillsBody(next) });
      haptic.success();
      closeSheet();
      return null;
    } catch (error) {
      return (await offlineFailure(error)) ? OFFLINE_SAVE : errorMessage(error);
    } finally {
      setWriting(false);
    }
  }

  async function remove(skill: TechnicianSkill) {
    if (writing) return;
    const ok = await confirmAction("Excluir a aptidão?", `“${skill.name}” sai da sua lista.`, { confirmText: "Excluir", destructive: true });
    if (!ok) return;
    if (await noNetwork()) {
      showToast(NO_INTERNET, { description: OFFLINE_DELETE });
      return;
    }
    const key = foldName(skill.name);
    setWriting(true);
    setRemoving(key);
    try {
      await saveProfile({ skills: skillsBody(currentSkills(skills).filter((item) => foldName(item.name) !== key)) });
      haptic.success();
    } catch (error) {
      if (await offlineFailure(error)) showToast(NO_INTERNET, { description: OFFLINE_DELETE });
      else showToast("Não foi possível excluir", { tone: "error", description: errorMessage(error) });
    } finally {
      setRemoving(null);
      setWriting(false);
    }
  }

  return (
    <View style={styles.screen}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pull} colors={[c.primary]} tintColor={c.primary} />}
      >
        <OfflineNotice />
        {stale ? <InfoBox message="Não foi possível atualizar agora. Os dados podem estar desatualizados." /> : null}
        {skills.length ? (
          skills.map((skill, index) => {
            const key = foldName(skill.name);
            const leaving = removing === key;
            return (
              <Animated.View
                key={key}
                entering={motion.entering(index)}
                exiting={motion.reduced ? undefined : FadeOut.duration(150)}
                layout={motion.layout}
                style={[styles.item, leaving && styles.leaving]}
              >
                <Pressable
                  onPress={() => openSheet({ kind: "edit", skill })}
                  disabled={writing}
                  accessibilityRole="button"
                  accessibilityLabel={skillSpoken(skill)}
                  accessibilityHint="Muda o nível"
                  accessibilityState={{ disabled: writing }}
                  style={({ pressed }) => [styles.itemText, pressed && styles.pressed]}
                >
                  <Text style={styles.name} numberOfLines={2}>
                    {skill.name}
                  </Text>
                  <Text style={styles.meta}>{skillLine(skill)}</Text>
                </Pressable>
                {leaving ? (
                  <View style={styles.trash}>
                    <ActivityIndicator size="small" color={c.danger} />
                  </View>
                ) : (
                  <Pressable
                    onPress={() => void remove(skill)}
                    disabled={writing}
                    accessibilityRole="button"
                    accessibilityLabel={`Excluir ${skill.name}`}
                    accessibilityState={{ disabled: writing }}
                    style={({ pressed }) => [styles.trash, pressed && { backgroundColor: c.dangerSoft }, writing && styles.off]}
                  >
                    <Icon name="trash" size={20} color={c.danger} />
                  </Pressable>
                )}
              </Animated.View>
            );
          })
        ) : (
          <EmptyState icon="target" title="Nenhuma aptidão" description="Inclua as aptidões em que você atende chamados." />
        )}
      </ScrollView>

      <FixedFooter>
        {full ? <InfoBox message={`Limite de ${TECH_PROFILE_LIMITS.skills} aptidões. Exclua uma para incluir outra.`} /> : null}
        <Button title="Adicionar aptidão" icon="plus" variant="primary" onPress={() => openSheet({ kind: "add" })} disabled={full || writing} />
      </FixedFooter>

      {sheet ? (
        <SkillSheet
          key={sheet.key}
          visible={sheet.open}
          target={sheet.target}
          others={others}
          suggestions={suggestions}
          onSubmit={(skill) => submit(sheet.target, skill)}
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
    },
    leaving: { opacity: 0.6 },
    itemText: { flex: 1, gap: 2, paddingVertical: 2 },
    pressed: { opacity: 0.7 },
    name: { fontSize: 15, fontWeight: "700", color: c.ink },
    meta: { fontSize: 13, color: c.inkMuted },
    trash: { width: 44, height: 44, borderRadius: RADIUS.control, alignItems: "center", justifyContent: "center" },
    off: { opacity: 0.4 },
  });
