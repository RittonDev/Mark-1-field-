// Aptidões (Configurações › Perfil profissional): o que o técnico sabe fazer, do catálogo que a central mantém
// (Configurações › Técnicos, na central), com o nível e o "desde" (o dia em que entrou no perfil; quem guarda é o
// servidor). Incluir pela folha "Adicionar aptidão" (várias da lista de uma vez, com um nível só), mudar o nível na
// folha "Editar aptidão" e excluir pela lixeira, com confirmação. Uma gravação por vez: enquanto uma está no ar, as
// outras ações da lista ficam desligadas, também depois de sair e voltar à tela (o estado fica em
// lib/technicalProfile.ts). O corpo é montado quando a gravação sai da fila (saveProfileWith), com a lista que a
// anterior devolveu: duas exclusões seguidas não devolvem um item apagado, e mudar o nível de uma aptidão que já saiu
// mostra o erro na folha. Cada aptidão tem a chave do catálogo (skillKey); com o servidor de antes da gestão
// (hasCadastroE2 falso) elas vêm só com o nome, o corpo vai pelo nome e a folha de incluir diz que a lista ainda não
// existe. Lista mudada por último pela central: o carimbo "Atualizado pela central em …" no topo.

import { useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeOut } from "react-native-reanimated";
import { Icon } from "../../components/Icon";
import { useListMotion } from "../../components/motion";
import { CentralStamp } from "../../components/settings/CentralStamp";
import { FixedFooter } from "../../components/settings/FixedFooter";
import { OfflineNotice } from "../../components/settings/OfflineNotice";
import { ProfileGate } from "../../components/settings/ProfileGate";
import { SkillCatalogSheet } from "../../components/settings/SkillCatalogSheet";
import { SkillSheet } from "../../components/settings/SkillSheet";
import { Text } from "../../components/Text";
import { Button, EmptyState, InfoBox } from "../../components/ui";
import { ApiError, errorMessage } from "../../lib/api";
import { TECH_PROFILE_LIMITS } from "../../lib/constants";
import { confirmAction } from "../../lib/dialogs";
import { haptic } from "../../lib/haptics";
import { noNetwork, offlineFailure } from "../../lib/net";
import { hasCadastroE2, saveProfileWith } from "../../lib/profile";
import {
  OFFLINE_SAVE,
  reloadSkillCatalog,
  trackListWrite,
  UNAVAILABLE,
  useListWrite,
  useSkillCatalog,
  useTechProfileScreen,
} from "../../lib/technicalProfile";
import {
  availableSkills,
  SKILL_MSG,
  skillKey,
  skillLine,
  skillsAdd,
  skillSpoken,
  skillsWith,
  skillsWithout,
} from "../../lib/techProfileForm";
import { showToast } from "../../lib/toast";
import type { SkillLevel, TechCatalogItem, TechnicianSkill } from "../../lib/types";
import { RADIUS, useStyles, useTheme, type Palette } from "../../theme/theme";

/** Incluir (a lista da central) ou mudar o nível de uma aptidão. */
type SheetTarget = { kind: "add" } | { kind: "edit"; skill: TechnicianSkill };

interface SheetState {
  /** Uma folha nova a cada abertura (o formulário começa do zero). */
  key: number;
  open: boolean;
  target: SheetTarget;
}

const NO_INTERNET = "Sem internet";
const OFFLINE_DELETE = "Conecte o aparelho para excluir.";

/** A recusa que pede a lista de novo: aptidão que a central excluiu ou desativou ("Atualize a lista"), nome fora dela. */
const catalogRefused = (error: unknown) => error instanceof ApiError && error.status === 422;

export default function SkillsScreen() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const motion = useListMotion();
  const { gate, stale, retry, refresh, refreshing } = useTechProfileScreen();
  const catalog = useSkillCatalog();
  const [sheet, setSheet] = useState<SheetState | null>(null);
  // Uma gravação da lista no ar (`writing`): incluir, editar e excluir ficam desligados. `removing`: as aptidões que
  // estão saindo, pela chave (skillKey).
  const { busy: writing, removing } = useListWrite("skills");

  if (gate.status === "unavailable") {
    return (
      <View style={styles.center}>
        <EmptyState icon="alert" title={UNAVAILABLE.title} description={UNAVAILABLE.description} action={{ label: "Tentar de novo", onPress: retry }} />
      </View>
    );
  }
  if (gate.status !== "ready") return <ProfileGate load={gate} onRetry={retry} />;

  const profile = gate.profile;
  const skills = profile.skills;
  const full = skills.length >= TECH_PROFILE_LIMITS.skills;

  function pull() {
    refresh();
    void reloadSkillCatalog();
  }

  function openSheet(target: SheetTarget) {
    if (writing) return;
    setSheet((current) => ({ key: (current?.key ?? 0) + 1, open: true, target }));
  }

  function closeSheet() {
    setSheet((current) => (current ? { ...current, open: false } : current));
  }

  function sheetClosed() {
    setSheet((current) => (current && !current.open ? null : current));
  }

  /** Inclui as escolhidas na folha, com o nível. Devolve o erro para a folha (null: gravou e a folha fecha). */
  async function add(picked: TechCatalogItem[], level: SkillLevel): Promise<string | null> {
    if (await noNetwork()) return OFFLINE_SAVE;
    try {
      const saved = await trackListWrite("skills", null, () =>
        saveProfileWith((current) => ({ skills: skillsAdd(current.skills, picked, level, hasCadastroE2(current)) })),
      );
      haptic.success();
      closeSheet();
      // A central desativou alguma enquanto a folha estava aberta: o servidor a ignorou.
      if (availableSkills(picked, saved.skills).length) {
        showToast("Nem todas foram incluídas", { description: "A lista da central mudou. Confira as aptidões." });
        void reloadSkillCatalog();
      }
      return null;
    } catch (error) {
      if (catalogRefused(error)) void reloadSkillCatalog();
      return (await offlineFailure(error)) ? OFFLINE_SAVE : errorMessage(error);
    }
  }

  /** Muda o nível. A chave vale para a lista gravada na hora do envio, que pode não ter mais a aptidão. */
  async function changeLevel(skill: TechnicianSkill, level: SkillLevel): Promise<string | null> {
    if (await noNetwork()) return OFFLINE_SAVE;
    const key = skillKey(skill);
    try {
      await trackListWrite("skills", null, () =>
        saveProfileWith((current) => {
          const next = skillsWith(current.skills, key, level, hasCadastroE2(current));
          if (!next) throw new Error(SKILL_MSG.gone);
          return { skills: next };
        }),
      );
      haptic.success();
      closeSheet();
      return null;
    } catch (error) {
      if (catalogRefused(error)) void reloadSkillCatalog();
      return (await offlineFailure(error)) ? OFFLINE_SAVE : errorMessage(error);
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
    const key = skillKey(skill);
    try {
      await trackListWrite("skills", key, () =>
        saveProfileWith((current) => ({ skills: skillsWithout(current.skills, key, hasCadastroE2(current)) })),
      );
      haptic.success();
    } catch (error) {
      if (await offlineFailure(error)) showToast(NO_INTERNET, { description: OFFLINE_DELETE });
      else showToast("Não foi possível excluir", { tone: "error", description: errorMessage(error) });
    }
  }

  const target = sheet?.target ?? null;

  return (
    <View style={styles.screen}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pull} colors={[c.primary]} tintColor={c.primary} />}
      >
        <OfflineNotice />
        {stale ? <InfoBox message="Não foi possível atualizar agora. Os dados podem estar desatualizados." /> : null}
        <CentralStamp stamp={profile.tech_profile_updated.skills} />
        {skills.length ? (
          skills.map((skill, index) => {
            const key = skillKey(skill);
            const leaving = removing.includes(key);
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

      {sheet && target?.kind === "add" ? (
        <SkillCatalogSheet
          key={sheet.key}
          visible={sheet.open}
          catalog={catalog}
          mine={skills}
          onRetry={() => void reloadSkillCatalog()}
          onSubmit={add}
          onClose={closeSheet}
          onClosed={sheetClosed}
        />
      ) : null}
      {sheet && target?.kind === "edit" ? (
        <SkillSheet
          key={sheet.key}
          visible={sheet.open}
          skill={target.skill}
          onSubmit={(level) => changeLevel(target.skill, level)}
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
