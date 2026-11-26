// Folha do período de indisponibilidade (Configurações › Dias e horários), para incluir e para editar: "De" e "Até", os
// dois dias inclusive, de hoje até 365 dias à frente (editando um período que já começou, o início gravado continua
// valendo). Os erros aparecem depois de tocar no botão, na ordem da tela; o do servidor, no fim da folha. Quem grava é a
// tela (onSubmit).

import { useState } from "react";
import { haptic } from "../../lib/haptics";
import { periodBounds, periodProblem, type PeriodDraft } from "../../lib/unavailability";
import type { UnavailabilityIn, UnavailabilityPeriod } from "../../lib/types";
import { DateField } from "../forms/DateField";
import { Field } from "../ui";
import { FormSheet } from "./FormSheet";

export type PeriodSheetTarget = { kind: "add" } | { kind: "edit"; period: UnavailabilityPeriod };

export function PeriodSheet({
  visible,
  target,
  others,
  today,
  onSubmit,
  onClose,
  onClosed,
}: {
  visible: boolean;
  target: PeriodSheetTarget;
  /** Os outros períodos (na edição, sem o editado): nenhum dia em comum. */
  others: readonly UnavailabilityPeriod[];
  /** Hoje, "AAAA-MM-DD". */
  today: string;
  /** Grava. Devolve a mensagem de erro, ou null quando gravou (a tela fecha a folha). */
  onSubmit: (entry: UnavailabilityIn) => Promise<string | null>;
  onClose: () => void;
  onClosed: () => void;
}) {
  const editing = target.kind === "edit" ? target.period : null;
  const [base] = useState<PeriodDraft>(() => ({ start: editing?.start ?? null, end: editing?.end ?? null }));
  const [draft, setDraft] = useState<PeriodDraft>(base);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { min, max } = periodBounds(today, editing);
  // O fim vai do início (ou de hoje, se o início já passou): um fim antes de hoje tiraria o período da lista.
  const endMin = draft.start && draft.start > today ? draft.start : today;
  const problems = periodProblem(draft, others, today, editing);
  const shown = attempted ? problems : {};
  const dirty = draft.start !== base.start || draft.end !== base.end;

  function update(patch: Partial<PeriodDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  }

  async function submit() {
    setAttempted(true);
    setError(null);
    const { start, end } = draft;
    if (Object.keys(problems).length || !start || !end) {
      haptic.warning();
      return;
    }
    setBusy(true);
    const message = await onSubmit(editing ? { id: editing.id, start, end } : { start, end });
    setBusy(false);
    if (message) {
      haptic.warning();
      setError(message);
    }
  }

  return (
    <FormSheet
      visible={visible}
      title={editing ? "Editar período" : "Adicionar período"}
      submitLabel={editing ? "Salvar" : "Adicionar"}
      onSubmit={() => void submit()}
      onClose={onClose}
      onClosed={onClosed}
      busy={busy}
      error={error}
      dirty={dirty}
      submitDisabled={Boolean(editing) && !dirty}
    >
      <Field label="De" required error={shown.start}>
        <DateField label="De" value={draft.start} min={min} max={max} onChange={(start) => update({ start })} />
      </Field>
      <Field label="Até" required error={shown.end}>
        <DateField
          label="Até"
          value={draft.end}
          min={endMin}
          max={max}
          initial={draft.start ?? undefined}
          onChange={(end) => update({ end })}
        />
      </Field>
    </FormSheet>
  );
}
