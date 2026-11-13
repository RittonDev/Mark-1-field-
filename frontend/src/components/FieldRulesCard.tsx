"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { useId, useState } from "react";
import { FieldError, useLeaveGuard } from "@/components/settings/shared";
import { useToast } from "@/components/Toaster";
import { Button, Card, CardHeader, ErrorBox, Field, Input, LoadingBlock } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import type { FieldRules } from "@/lib/types";

// Limites de backend/app/schemas/field.py (horas e minutos inteiros).
const LIMITS = {
  capital: 72,
  interior: 240,
  onsite: 24,
  warning: 240,
};
const MIN_WARNING = 5;

type Key = "capital" | "interior" | "onsite" | "warning";
type Values = Record<Key, string>;

/** Número inteiro digitado (vazio ou com vírgula/ponto vira NaN). */
const whole = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : Number.NaN);

function problemsOf(v: Values): Partial<Record<Key, string>> {
  const out: Partial<Record<Key, string>> = {};
  const arrival = (key: "capital" | "interior") => {
    if (!v[key].trim()) return;
    const n = whole(v[key]);
    if (!(n >= 1 && n <= LIMITS[key])) out[key] = `Use horas inteiras de 1 a ${LIMITS[key]}, ou deixe vazio.`;
  };
  arrival("capital");
  arrival("interior");
  const onsite = whole(v.onsite);
  if (!(onsite >= 1 && onsite <= LIMITS.onsite)) out.onsite = `Use horas inteiras de 1 a ${LIMITS.onsite}.`;
  const warning = whole(v.warning);
  if (!(warning >= MIN_WARNING && warning <= LIMITS.warning)) {
    out.warning = `Use minutos inteiros de ${MIN_WARNING} a ${LIMITS.warning}.`;
  } else if (!out.onsite && warning > onsite * 60 - MIN_WARNING) {
    // O aviso sai "minutos antes do fim": maior que o tempo na loja, ele chegaria antes do técnico.
    out.warning = `Com ${onsite}h na loja, avise no máximo ${onsite * 60 - MIN_WARNING} minutos antes do fim.`;
  }
  return out;
}

/** Regras do atendimento em campo: prazo de chegada e tempo na loja por chamado. */
export function FieldRulesCard({ readOnly = false }: { readOnly?: boolean }) {
  const rules = useQuery({ queryKey: ["settings", "field"], queryFn: () => api.get<FieldRules>("/settings/field") });
  return (
    <Card>
      <CardHeader
        title="Regras do atendimento em campo"
        description="Prazo para o técnico chegar à loja e tempo de técnico incluído em cada chamado."
      />
      {rules.isLoading ? (
        <LoadingBlock rows={2} />
      ) : rules.error ? (
        <div className="flex flex-col items-start gap-3 p-4">
          <ErrorBox message={errorMessage(rules.error)} />
          <Button size="sm" loading={rules.isFetching} onClick={() => rules.refetch()}>
            Tentar de novo
          </Button>
        </div>
      ) : rules.data ? (
        <RulesForm key={JSON.stringify(rules.data)} initial={rules.data} readOnly={readOnly} />
      ) : null}
    </Card>
  );
}

const toValues = (r: FieldRules): Values => ({
  capital: r.arrival_hours_capital?.toString() ?? "",
  interior: r.arrival_hours_interior?.toString() ?? "",
  onsite: String(r.onsite_hours),
  warning: String(r.onsite_warning_minutes),
});

function RulesForm({ initial, readOnly }: { initial: FieldRules; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const id = useId();
  const [start] = useState(() => toValues(initial));
  const [values, setValues] = useState(start);
  const problems = problemsOf(values);
  const invalid = Object.keys(problems).length > 0;
  const dirty = JSON.stringify(values) !== JSON.stringify(start);
  useLeaveGuard(dirty && !readOnly, "As regras de campo alteradas ainda não foram salvas.");
  const set = (key: Key) => (e: React.ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [key]: e.target.value }));
  const optional = (v: string) => (v.trim() === "" ? null : whole(v));

  const save = useMutation({
    mutationFn: () =>
      api.put<FieldRules>("/settings/field", {
        arrival_hours_capital: optional(values.capital),
        arrival_hours_interior: optional(values.interior),
        onsite_hours: whole(values.onsite),
        onsite_warning_minutes: whole(values.warning),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(["settings", "field"], data);
      toast({ title: "Regras de campo salvas", description: "Valem para as próximas OS e chegadas.", tone: "success" });
    },
  });

  const input = (key: Key, props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <>
      <Input
        inputMode="numeric"
        value={values[key]}
        onChange={set(key)}
        disabled={readOnly}
        aria-invalid={problems[key] ? true : undefined}
        aria-describedby={problems[key] ? `${id}-${key}` : undefined}
        {...props}
      />
      {problems[key] ? <FieldError id={`${id}-${key}`}>{problems[key]}</FieldError> : null}
    </>
  );

  return (
    <form
      className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!invalid && dirty) save.mutate();
      }}
    >
      <Field
        label="Chegada nas capitais (horas)"
        hint={problems.capital ? undefined : "Lojas nas 27 capitais (pela cidade e UF do local). Vazio: sem prazo."}
      >
        {input("capital", { placeholder: "Sem prazo" })}
      </Field>
      <Field label="Chegada no interior (horas)" hint={problems.interior ? undefined : "Demais cidades. Vazio: sem prazo."}>
        {input("interior", { placeholder: "Sem prazo" })}
      </Field>
      <Field label="Tempo na loja por chamado (horas)" required hint={problems.onsite ? undefined : "Contado a partir da chegada."}>
        {input("onsite", { required: true })}
      </Field>
      <Field
        label="Avisar antes do fim (minutos)"
        required
        hint={problems.warning ? undefined : "Alerta para o técnico e para a fila antes de acabar o tempo na loja."}
      >
        {input("warning", { required: true })}
      </Field>
      {readOnly ? null : (
        <div className="flex flex-wrap items-center justify-end gap-3 sm:col-span-2 lg:col-span-4">
          {dirty ? <span className="text-xs font-semibold text-ink-muted">Alterações não salvas</span> : null}
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || invalid}>
            <Save className="size-4" />
            Salvar regras
          </Button>
        </div>
      )}
      {save.error ? (
        <div className="sm:col-span-2 lg:col-span-4">
          <ErrorBox message={errorMessage(save.error)} />
        </div>
      ) : null}
    </form>
  );
}
