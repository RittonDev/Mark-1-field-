"use client";

import { ErrorBox, Field, Select, Textarea } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { RESPONSIBILITY } from "@/lib/constants";
import { useViolationReasons } from "@/lib/queries";
import type { ViolationReason, ViolationReasonRef, ViolationScope } from "@/lib/types";

export interface ViolationValues {
  response: string;
  resolution: string;
  note: string;
}

/** O motivo já gravado em cada relógio (pode ter sido desativado depois no cadastro). */
export interface CurrentViolation {
  response?: ViolationReasonRef | null;
  resolution?: ViolationReasonRef | null;
}

function ReasonSelect({
  scope,
  label,
  value,
  onChange,
  reasons,
  current,
  required,
}: {
  scope: Exclude<ViolationScope, "both">;
  label: string;
  value: string;
  onChange: (v: string) => void;
  reasons: ViolationReason[];
  current: ViolationReasonRef | null | undefined;
  required: boolean;
}) {
  const options = reasons.filter((r) => r.applies_to === scope || r.applies_to === "both");
  // O motivo gravado saiu da lista (desativado): continua aparecendo, senão o campo ficaria vazio.
  const missing = current && !options.some((r) => r.id === current.id) ? current : null;
  return (
    <Field label={label} required={required}>
      <Select value={value} onChange={(e) => onChange(e.target.value)} required={required}>
        <option value="">Selecione o motivo...</option>
        {options.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name} ({RESPONSIBILITY[r.responsibility].label})
          </option>
        ))}
        {missing ? (
          <option value={missing.id}>
            {missing.name} ({RESPONSIBILITY[missing.responsibility].label}, inativo)
          </option>
        ) : null}
      </Select>
    </Field>
  );
}

/**
 * Só os motivos que mudaram vão para a API: o que já estava gravado pode ter sido desativado no
 * cadastro, e reenviá-lo seria recusado ("motivo inativo").
 */
export function changedViolation(values: ViolationValues, current: CurrentViolation) {
  return {
    response: values.response && values.response !== current.response?.id ? values.response : null,
    resolution: values.resolution && values.resolution !== current.resolution?.id ? values.resolution : null,
  };
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
  current,
}: {
  responseBreached: boolean;
  resolutionBreached: boolean;
  values: ViolationValues;
  onChange: (values: ViolationValues) => void;
  required: boolean;
  /** Motivos já gravados na OS: aparecem mesmo que tenham sido desativados no cadastro. */
  current?: CurrentViolation;
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
      {reasons.error ? <ErrorBox message={`Não foi possível carregar os motivos: ${errorMessage(reasons.error)}`} /> : null}
      {responseBreached ? (
        <ReasonSelect
          scope="response"
          label="Motivo — 1ª resposta"
          value={values.response}
          onChange={(response) => onChange({ ...values, response })}
          reasons={list}
          current={current?.response}
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
          current={current?.resolution}
          required={required}
        />
      ) : null}
      <Field label="Detalhe (opcional)">
        <Textarea rows={2} maxLength={2000} value={values.note} onChange={(e) => onChange({ ...values, note: e.target.value })} />
      </Field>
    </div>
  );
}
