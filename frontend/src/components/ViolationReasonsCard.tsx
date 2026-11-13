"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Plus } from "lucide-react";
import { useState } from "react";
import { useToast } from "@/components/Toaster";
import {
  Button,
  Card,
  CardHeader,
  Dialog,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  LoadingBlock,
  Pill,
  Select,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { RESPONSIBILITY, VIOLATION_SCOPE } from "@/lib/constants";
import { useViolationReasons } from "@/lib/queries";
import type { Responsibility, ViolationReason, ViolationScope } from "@/lib/types";

function NewReasonDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState<{ name: string; applies_to: ViolationScope; responsibility: Responsibility }>({
    name: "",
    applies_to: "both",
    responsibility: "internal",
  });
  const mutation = useMutation({
    mutationFn: () => api.post<ViolationReason>("/violation-reasons", { ...form, name: form.name.trim() }),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["violation-reasons"] });
      toast({ title: `Motivo "${r.name}" cadastrado`, tone: "success" });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Novo motivo de violação"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" type="submit" form="reason-form" loading={mutation.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      <form
        id="reason-form"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
        className="grid gap-4 sm:grid-cols-2"
      >
        <Field label="Motivo" required className="sm:col-span-2">
          <Input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Ex.: Cliente ausente ou local fechado"
            required
            minLength={2}
          />
        </Field>
        <Field label="Vale para o prazo de">
          <Select
            value={form.applies_to}
            onChange={(e) => setForm((f) => ({ ...f, applies_to: e.target.value as ViolationScope }))}
          >
            {Object.entries(VIOLATION_SCOPE).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Responsabilidade" hint="É o que separa falha nossa de causa externa no relatório">
          <Select
            value={form.responsibility}
            onChange={(e) => setForm((f) => ({ ...f, responsibility: e.target.value as Responsibility }))}
          >
            {Object.entries(RESPONSIBILITY).map(([value, info]) => (
              <option key={value} value={value}>
                {info.label}
              </option>
            ))}
          </Select>
        </Field>
        {mutation.error ? (
          <div className="sm:col-span-2">
            <ErrorBox message={errorMessage(mutation.error)} />
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}

/** Cadastro dos motivos de violação de SLA (a tela "Motivos de violação" do Field Control). */
export function ViolationReasonsCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const reasons = useViolationReasons();
  const [creating, setCreating] = useState(false);
  const toggle = useMutation({
    mutationFn: (r: ViolationReason) => api.patch<ViolationReason>(`/violation-reasons/${r.id}`, { is_active: !r.is_active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["violation-reasons"] }),
    onError: (error) => toast({ title: "Não foi possível alterar", description: errorMessage(error), tone: "error" }),
  });

  return (
    <Card>
      <CardHeader
        title="Motivos de violação"
        description="Quando um prazo de SLA fura, o sistema pergunta o motivo — e isso vira estatística no dashboard"
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" />
            Novo motivo
          </Button>
        }
      />
      {reasons.isLoading ? (
        <LoadingBlock />
      ) : reasons.error ? (
        <div className="p-4">
          <ErrorBox message={errorMessage(reasons.error)} />
        </div>
      ) : (reasons.data ?? []).length === 0 ? (
        <EmptyState icon={<AlertTriangle className="size-7" />} title="Nenhum motivo cadastrado" />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Motivo</Th>
              <Th>Prazo</Th>
              <Th>Responsabilidade</Th>
              <Th>Situação</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {reasons.data?.map((r) => (
              <tr key={r.id} className={r.is_active ? undefined : "opacity-60"}>
                <Td className="font-semibold">{r.name}</Td>
                <Td className="text-sm">{VIOLATION_SCOPE[r.applies_to]}</Td>
                <Td>
                  <Pill color={RESPONSIBILITY[r.responsibility].color}>{RESPONSIBILITY[r.responsibility].label}</Pill>
                </Td>
                <Td className="text-xs">{r.is_active ? "Ativo" : "Inativo"}</Td>
                <Td className="text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={toggle.isPending && toggle.variables?.id === r.id}
                    onClick={() => toggle.mutate(r)}
                  >
                    {r.is_active ? "Desativar" : "Ativar"}
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {creating ? <NewReasonDialog onClose={() => setCreating(false)} /> : null}
    </Card>
  );
}
