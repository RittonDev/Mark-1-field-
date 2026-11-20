// Folha da formação (Configurações › Formação), para incluir e para editar: curso, nível, instituição, início e fim
// (ou "Em andamento", que limpa o fim). Os meses vão de 1950-01 ao mês atual; o fim não pode ser antes do início. Os
// erros aparecem depois de tocar no botão, na ordem da tela; o do servidor, no fim da folha. Quem grava é a tela.

import { useRef, useState } from "react";
import { StyleSheet, View, type TextInputInstance } from "react-native";
import { EDUCATION_LEVEL, EDUCATION_LEVEL_ORDER, TECH_PROFILE_LIMITS } from "../../lib/constants";
import { haptic } from "../../lib/haptics";
import {
  educationChanged,
  educationDraftOf,
  educationEntry,
  educationProblem,
  thisMonth,
  type EducationDraft,
  type EducationEntry,
} from "../../lib/techProfileForm";
import type { EducationItem, EducationLevel } from "../../lib/types";
import { Field, Input } from "../ui";
import { CheckCard } from "./CheckCard";
import { ChoiceChips, type ChoiceOption } from "./ChoiceChips";
import { FormSheet } from "./FormSheet";
import { MonthField } from "./MonthField";

export type EducationSheetTarget = { kind: "add" } | { kind: "edit"; item: EducationItem };

const LEVEL_OPTIONS: ChoiceOption<EducationLevel>[] = EDUCATION_LEVEL_ORDER.map((level) => ({
  value: level,
  label: EDUCATION_LEVEL[level],
}));

export function EducationSheet({
  visible,
  target,
  onSubmit,
  onClose,
  onClosed,
}: {
  visible: boolean;
  target: EducationSheetTarget;
  /** Grava. Devolve a mensagem de erro, ou null quando gravou (a tela fecha a folha). */
  onSubmit: (entry: EducationEntry) => Promise<string | null>;
  onClose: () => void;
  onClosed: () => void;
}) {
  const editing = target.kind === "edit" ? target.item : null;
  const [base] = useState(() => educationDraftOf(editing));
  const [draft, setDraft] = useState<EducationDraft>(base);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const institutionRef = useRef<TextInputInstance>(null);

  const max = thisMonth();
  const problems = educationProblem(draft);
  const shown = attempted ? problems : {};
  const dirty = educationChanged(draft, base);

  function update(patch: Partial<EducationDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  }

  async function submit() {
    setAttempted(true);
    setError(null);
    const entry = Object.keys(problems).length ? null : educationEntry(draft, editing?.id);
    if (!entry) {
      haptic.warning();
      return;
    }
    setBusy(true);
    const message = await onSubmit(entry);
    setBusy(false);
    if (message) {
      haptic.warning();
      setError(message);
    }
  }

  return (
    <FormSheet
      visible={visible}
      title={editing ? "Editar formação" : "Adicionar formação"}
      submitLabel={editing ? "Salvar" : "Adicionar"}
      onSubmit={() => void submit()}
      onClose={onClose}
      onClosed={onClosed}
      busy={busy}
      error={error}
      dirty={dirty}
      submitDisabled={Boolean(editing) && !dirty}
    >
      <Field label="Curso" required error={shown.course}>
        <Input
          value={draft.course}
          onChangeText={(course) => update({ course })}
          maxLength={TECH_PROFILE_LIMITS.course}
          autoCapitalize="sentences"
          autoFocus={!editing}
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => institutionRef.current?.focus()}
          accessibilityLabel="Curso"
        />
      </Field>
      <Field label="Nível" required error={shown.level}>
        <ChoiceChips
          options={LEVEL_OPTIONS}
          value={draft.level}
          accessibilityLabel="Nível"
          onChange={(next) => {
            if (Array.isArray(next)) return;
            haptic.select();
            update({ level: next });
          }}
        />
      </Field>
      <Field label="Instituição" required error={shown.institution}>
        <Input
          ref={institutionRef}
          value={draft.institution}
          onChangeText={(institution) => update({ institution })}
          maxLength={TECH_PROFILE_LIMITS.institution}
          autoCapitalize="words"
          returnKeyType="done"
          accessibilityLabel="Instituição"
        />
      </Field>
      <View style={styles.months}>
        <View style={styles.month}>
          <Field label="Início" required error={shown.start}>
            <MonthField
              label="Início"
              value={draft.start}
              min={TECH_PROFILE_LIMITS.firstMonth}
              max={max}
              onChange={(start) => update({ start })}
            />
          </Field>
        </View>
        <View style={styles.month}>
          <Field label="Fim" required={!draft.ongoing} error={shown.end}>
            <MonthField
              label="Fim"
              value={draft.ongoing ? null : draft.end}
              min={draft.start ?? TECH_PROFILE_LIMITS.firstMonth}
              max={max}
              disabled={draft.ongoing}
              disabledText="Em andamento"
              onChange={(end) => update({ end })}
            />
          </Field>
        </View>
      </View>
      <CheckCard
        label="Em andamento"
        checked={draft.ongoing}
        onPress={() => {
          haptic.select();
          // Marcar limpa o fim; desmarcar pede o fim de novo.
          update(draft.ongoing ? { ongoing: false } : { ongoing: true, end: null });
        }}
      />
    </FormSheet>
  );
}

const styles = StyleSheet.create({
  // Lado a lado; com a fonte grande, o Fim desce para baixo do Início.
  months: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  month: { flexGrow: 1, flexBasis: 140 },
});
