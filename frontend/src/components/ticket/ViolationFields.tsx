"use client";

import { Field, Select, Textarea } from "@/components/ui";
import { RESPONSIBILITY } from "@/lib/constants";
import { useViolationReasons } from "@/lib/queries";
import type { ViolationReason, ViolationScope } from "@/lib/types";

export interface ViolationValues {
  response: string;
  resolution: string;
  note: string;
}

function ReasonSelect({
  scope,
  label,
  value,
  onChange,
  reasons,
  required,
}: {
  scope: Exclude<ViolationScope, "both">;
  label: string;
  value: string;
  onChange: (v: string) => void;
  reasons: ViolationReason[];
  required: boolean;
}) {
  const options = reasons.filter((r) => r.applies_to === scope || r.applies_to === "both");
  return (
    <Field label={label} required={required}>
      <Select value={value} onChange={(e) => onChange(e.target.value)} required={required}>
        <option value="">Selecione o motivo...</option>
        {options.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name} ({RESPONSIBILITY[r.responsibility].label})
          </option>
        ))}
      </Select>
    </Field>
  );
}

/**
 * Motivo da violação por relógio de SLA, como no Field Control. Só mostra o relógio que furou.
 * "Quando fura, o sistema pergunta por quê — e isso vira estatística em vez de desculpa."
 */
export function ViolationFields({
  responseBreached,
  resolutionBreached,
  values,
  onChange,
  required,
}: {
  responseBreached: boolean;
  resolutionBreached: boolean;
  values: ViolationValues;
  onChange: (values: ViolationValues) => void;
  required: boolean;
}) {
  const reasons = useViolationReasons(true);
  const list = reasons.data ?? [];
  if (!responseBreached && !resolutionBreached) return null;
  return (
    <div className="space-y-3 rounded-lg border border-red-200 bg-red-50/60 p-3 dark:border-red-500/30 dark:bg-red-500/5">
      <p className="text-sm font-semibold text-red-700 dark:text-red-300">
        Esta OS violou o prazo de {[responseBreached && "1ª resposta", resolutionBreached && "solução"].filter(Boolean).join(" e ")}.
        Qual foi o motivo?
      </p>
      {responseBreached ? (
        <ReasonSelect
          scope="response"
          label="Motivo — 1ª resposta"
          value={values.response}
          onChange={(response) => onChange({ ...values, response })}
          reasons={list}
          required={required}
        />
      ) : null}
      {resolutionBreached ? (
        <ReasonSelect
          scope="resolution"
          label="Motivo — solução"
          value={values.resolution}
          onChange={(resolution) => onChange({ ...values, resolution })}
          reasons={list}
          required={required}
        />
      ) : null}
      <Field label="Detalhe (opcional)">
        <Textarea rows={2} value={values.note} onChange={(e) => onChange({ ...values, note: e.target.value })} />
      </Field>
    </div>
  );
}
