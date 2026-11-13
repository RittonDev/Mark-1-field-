"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save, Timer } from "lucide-react";
import { useState } from "react";
import { useToast } from "@/components/Toaster";
import { Button, Card, CardHeader, ErrorBox, Field, Input, LoadingBlock } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import type { FieldRules } from "@/lib/types";

/** Regras do atendimento em campo: prazo de chegada e tempo na loja por chamado. */
export function FieldRulesCard() {
  const rules = useQuery({ queryKey: ["settings", "field"], queryFn: () => api.get<FieldRules>("/settings/field") });
  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Timer className="size-4 text-ink-subtle" />
            Regras do atendimento em campo
          </span>
        }
        description="Prazo para o técnico chegar à loja e tempo de técnico incluído em cada chamado."
      />
      {rules.isLoading ? (
        <LoadingBlock rows={2} />
      ) : rules.error ? (
        <div className="p-4">
          <ErrorBox message={errorMessage(rules.error)} />
        </div>
      ) : rules.data ? (
        <RulesForm key={JSON.stringify(rules.data)} initial={rules.data} />
      ) : null}
    </Card>
  );
}

const toNumber = (v: string) => (v.trim() === "" ? null : Number(v));

function RulesForm({ initial }: { initial: FieldRules }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [capital, setCapital] = useState(initial.arrival_hours_capital?.toString() ?? "");
  const [interior, setInterior] = useState(initial.arrival_hours_interior?.toString() ?? "");
  const [onsite, setOnsite] = useState(String(initial.onsite_hours));
  const [warning, setWarning] = useState(String(initial.onsite_warning_minutes));
  const save = useMutation({
    mutationFn: () =>
      api.put<FieldRules>("/settings/field", {
        arrival_hours_capital: toNumber(capital),
        arrival_hours_interior: toNumber(interior),
        onsite_hours: Number(onsite) || 4,
        onsite_warning_minutes: Number(warning) || 30,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(["settings", "field"], data);
      toast({ title: "Regras de campo salvas", description: "Valem para as próximas OS e chegadas.", tone: "success" });
    },
  });
  return (
    <form
      className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field label="Chegada nas capitais (horas)" hint="Da solicitação até o técnico chegar">
        <Input type="number" min={1} max={72} value={capital} onChange={(e) => setCapital(e.target.value)} placeholder="Sem prazo" />
      </Field>
      <Field label="Chegada no interior (horas)" hint="Vazio: sem prazo de chegada">
        <Input type="number" min={1} max={168} value={interior} onChange={(e) => setInterior(e.target.value)} placeholder="Sem prazo" />
      </Field>
      <Field label="Tempo na loja por chamado (horas)" hint="Contado a partir da chegada">
        <Input type="number" min={1} max={24} value={onsite} onChange={(e) => setOnsite(e.target.value)} required />
      </Field>
      <Field label="Avisar antes do fim (minutos)" hint="Alerta para o técnico e para a fila">
        <Input type="number" min={5} max={120} value={warning} onChange={(e) => setWarning(e.target.value)} required />
      </Field>
      <div className="flex justify-end sm:col-span-2 lg:col-span-4">
        <Button type="submit" variant="primary" loading={save.isPending}>
          <Save className="size-4" />
          Salvar regras
        </Button>
      </div>
      {save.error ? (
        <div className="sm:col-span-2 lg:col-span-4">
          <ErrorBox message={errorMessage(save.error)} />
        </div>
      ) : null}
    </form>
  );
}
