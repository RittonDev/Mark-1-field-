// Folha da aptidão (Configurações › Aptidões). Incluir: o nome (texto livre ou uma das sugestões da ficha) e o nível.
// Editar: só o nível (o nome fica na descrição da folha; para mudar o nome, exclui e inclui de novo). Os erros aparecem
// depois de tocar no botão; o do servidor, no fim da folha. Quem grava é a tela (onSubmit).

import { useState } from "react";
import { View } from "react-native";
import { SKILL_LEVEL, SKILL_LEVEL_ORDER, TECH_PROFILE_LIMITS } from "../../lib/constants";
import { haptic } from "../../lib/haptics";
import { cleanText, foldName, skillProblem, suggestionsFor } from "../../lib/techProfileForm";
import type { SkillLevel, TechnicianSkill, TechnicianSkillIn } from "../../lib/types";
import { Field, Input, SectionTitle } from "../ui";
import { ChoiceChips, type ChoiceOption } from "./ChoiceChips";
import { FormSheet } from "./FormSheet";

export type SkillSheetTarget = { kind: "add" } | { kind: "edit"; skill: TechnicianSkill };

const LEVEL_OPTIONS: ChoiceOption<SkillLevel>[] = SKILL_LEVEL_ORDER.map((level) => ({ value: level, label: SKILL_LEVEL[level] }));

export function SkillSheet({
  visible,
  target,
  others,
  suggestions,
  onSubmit,
  onClose,
  onClosed,
}: {
  visible: boolean;
  target: SkillSheetTarget;
  /** As outras aptidões do técnico (na edição, sem a editada): o nome não pode repetir. */
  others: readonly TechnicianSkill[];
  /** As sugestões da ficha; null sem catálogo (a seção some e o texto livre continua valendo). */
  suggestions: readonly string[] | null;
  /** Grava. Devolve a mensagem de erro, ou null quando gravou (a tela fecha a folha). */
  onSubmit: (skill: TechnicianSkillIn) => Promise<string | null>;
  onClose: () => void;
  onClosed: () => void;
}) {
  const editing = target.kind === "edit" ? target.skill : null;
  const [name, setName] = useState(editing?.name ?? "");
  const [level, setLevel] = useState<SkillLevel | null>(editing?.level ?? null);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problems = skillProblem({ name, level }, others);
  const shown = attempted ? problems : {};
  const dirty = editing ? level !== editing.level : cleanText(name) !== "" || level !== null;
  const offered = editing || !suggestions ? [] : suggestionsFor(name, suggestions, others.map((skill) => skill.name));
  const picked = offered.find((suggestion) => foldName(suggestion) === foldName(name)) ?? null;

  async function submit() {
    setAttempted(true);
    setError(null);
    if (problems.name || problems.level || !level) {
      haptic.warning();
      return;
    }
    setBusy(true);
    const message = await onSubmit({ name: cleanText(editing?.name ?? name), level });
    setBusy(false);
    if (message) {
      haptic.warning();
      setError(message);
    }
  }

  return (
    <FormSheet
      visible={visible}
      title={editing ? "Editar aptidão" : "Adicionar aptidão"}
      description={editing?.name}
      submitLabel={editing ? "Salvar" : "Adicionar"}
      onSubmit={() => void submit()}
      onClose={onClose}
      onClosed={onClosed}
      busy={busy}
      error={error}
      dirty={dirty}
      submitDisabled={Boolean(editing) && !dirty}
    >
      {editing ? null : (
        <Field label="Aptidão" required error={shown.name}>
          <Input
            value={name}
            onChangeText={(text) => {
              setName(text);
              setError(null);
            }}
            maxLength={TECH_PROFILE_LIMITS.skillName}
            autoCapitalize="sentences"
            returnKeyType="done"
            accessibilityLabel="Aptidão"
          />
        </Field>
      )}
      {offered.length ? (
        <View>
          <SectionTitle>Sugestões</SectionTitle>
          <ChoiceChips
            options={offered.map((suggestion) => ({ value: suggestion, label: suggestion }))}
            value={picked}
            accessibilityLabel="Sugestões"
            onChange={(next) => {
              if (Array.isArray(next)) return;
              haptic.select();
              setName(next);
              setError(null);
            }}
          />
        </View>
      ) : null}
      <Field label="Nível" required error={shown.level}>
        <ChoiceChips
          options={LEVEL_OPTIONS}
          value={level}
          accessibilityLabel="Nível"
          onChange={(next) => {
            if (Array.isArray(next)) return;
            haptic.select();
            setLevel(next);
            setError(null);
          }}
        />
      </Field>
    </FormSheet>
  );
}
