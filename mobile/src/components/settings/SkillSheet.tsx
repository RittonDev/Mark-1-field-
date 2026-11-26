// Folha "Editar aptidão" (Configurações › Aptidões): só o nível. O nome, que vem do catálogo da central, fica na
// descrição da folha; para trocar de aptidão, o técnico exclui e inclui outra pela folha "Adicionar aptidão"
// (SkillCatalogSheet). "Salvar" só com o nível mudado; o erro do servidor aparece no fim da folha. Quem grava é a tela
// (onSubmit).

import { useState } from "react";
import { SKILL_LEVEL, SKILL_LEVEL_ORDER } from "../../lib/constants";
import { haptic } from "../../lib/haptics";
import type { SkillLevel } from "../../lib/types";
import { Field } from "../ui";
import { ChoiceChips, type ChoiceOption } from "./ChoiceChips";
import { FormSheet } from "./FormSheet";

/** As opções de nível das folhas de aptidão (editar e adicionar). */
export const SKILL_LEVEL_OPTIONS: ChoiceOption<SkillLevel>[] = SKILL_LEVEL_ORDER.map((level) => ({ value: level, label: SKILL_LEVEL[level] }));

export function SkillSheet({
  visible,
  skill,
  onSubmit,
  onClose,
  onClosed,
}: {
  visible: boolean;
  /** A aptidão editada: o nome do catálogo e o nível gravado. */
  skill: { name: string; level: SkillLevel };
  /** Grava o nível. Devolve a mensagem de erro, ou null quando gravou (a tela fecha a folha). */
  onSubmit: (level: SkillLevel) => Promise<string | null>;
  onClose: () => void;
  onClosed: () => void;
}) {
  const [level, setLevel] = useState<SkillLevel>(skill.level);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = level !== skill.level;

  async function submit() {
    if (!dirty) return;
    setError(null);
    setBusy(true);
    const message = await onSubmit(level);
    setBusy(false);
    if (message) {
      haptic.warning();
      setError(message);
    }
  }

  return (
    <FormSheet
      visible={visible}
      title="Editar aptidão"
      description={skill.name}
      submitLabel="Salvar"
      onSubmit={() => void submit()}
      onClose={onClose}
      onClosed={onClosed}
      busy={busy}
      error={error}
      dirty={dirty}
      submitDisabled={!dirty}
    >
      <Field label="Nível" required>
        <ChoiceChips
          options={SKILL_LEVEL_OPTIONS}
          value={level}
          accessibilityLabel="Nível"
          disabled={busy}
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
