"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Plus } from "lucide-react";
import { useId, useState } from "react";
import { ActiveState, FieldError, fold, NeutralChip, RowEditButton, useDiscardGuard } from "@/components/settings/shared";
import { useToast } from "@/components/Toaster";
import {
  Button,
  Card,
  CardHeader,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  LoadingBlock,
  Select,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { RESPONSIBILITY, VIOLATION_SCOPE } from "@/lib/constants";
import { useViolationReasons } from "@/lib/queries";
import type { Responsibility, ViolationReason, ViolationScope } from "@/lib/types";

function ReasonDialog({
  reason,
  reasons,
  onClose,
}: {
  /** null: motivo novo. */
  reason: ViolationReason | null;
  reasons: ViolationReason[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const nameErrorId = useId();
  const [initial] = useState(() => ({
    name: reason?.name ?? "",
    applies_to: (reason?.applies_to ?? "both") as ViolationScope,
    responsibility: (reason?.responsibility ?? "internal") as Responsibility,
    is_active: reason?.is_active ?? true,
  }));
  const [form, setForm] = useState(initial);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const name = form.name.trim();
  // O nome é único: avisa aqui em vez do "registro duplicado" genérico da API.
  const duplicate = name.length > 0 && reasons.some((r) => r.id !== reason?.id && fold(r.name.trim()) === fold(name));

  const mutation = useMutation({
    mutationFn: () => {
      if (!reason) {
        return api.post<ViolationReason>("/violation-reasons", {
          name,
          applies_to: form.applies_to,
          responsibility: form.responsibility,
        });
      }
      // Só o que mudou.
      const patch: Record<string, unknown> = {};
      if (name !== reason.name) patch.name = name;
      if (form.applies_to !== reason.applies_to) patch.applies_to = form.applies_to;
      if (form.responsibility !== reason.responsibility) patch.responsibility = form.responsibility;
      if (form.is_active !== reason.is_active) patch.is_active = form.is_active;
      return api.patch<ViolationReason>(`/violation-reasons/${reason.id}`, patch);
    },
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["violation-reasons"] });
      toast({ title: reason ? `Motivo “${r.name}” atualizado` : `Motivo “${r.name}” cadastrado`, tone: "success" });
      onClose();
    },
  });
  const requestClose = useDiscardGuard(dirty, onClose);

  return (
    <Dialog
      open
      onClose={requestClose}
      title={reason ? "Editar motivo de violação" : "Novo motivo de violação"}
      footer={
        <>
          <Button onClick={requestClose}>Cancelar</Button>
          <Button
            variant="primary"
            type="submit"
            form="violation-reason-form"
            loading={mutation.isPending}
            disabled={duplicate || (reason !== null && !dirty)}
          >
            Salvar
          </Button>
        </>
      }
    >
      <form
        id="violation-reason-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!duplicate) mutation.mutate();
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
            maxLength={160}
            autoFocus
            aria-invalid={duplicate ? true : undefined}
            aria-describedby={duplicate ? nameErrorId : undefined}
          />
          {duplicate ? <FieldError id={nameErrorId}>Já existe um motivo com este nome.</FieldError> : null}
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
        <Field
          label="Responsabilidade"
          hint={
            reason && form.responsibility !== reason.responsibility
              ? "Vale também para as justificativas que já usaram este motivo."
              : "Separa a falha nossa da causa externa no relatório."
          }
        >
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
        {reason ? (
          <div className="flex flex-col gap-1 sm:col-span-2">
            <Checkbox label="Ativo" checked={form.is_active} onChange={(v) => setForm((f) => ({ ...f, is_active: v }))} />
            <span className="text-xs text-ink-muted">Inativo sai da lista ao justificar; as justificativas antigas continuam.</span>
          </div>
        ) : null}
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
export function ViolationReasonsCard({ readOnly = false }: { readOnly?: boolean }) {
  const reasons = useViolationReasons();
  const [editing, setEditing] = useState<ViolationReason | "new" | null>(null);
  const list = reasons.data ?? [];

  return (
    <Card>
      <CardHeader
        title="Motivos de violação"
        description="Quando um prazo de SLA fura, o sistema pergunta o motivo, e isso vira estatística no dashboard."
        actions={
          readOnly ? null : (
            <Button size="sm" onClick={() => setEditing("new")}>
              <Plus className="size-3.5" />
              Novo motivo
            </Button>
          )
        }
      />
      {reasons.isLoading ? (
        <LoadingBlock />
      ) : reasons.error ? (
        <div className="flex flex-col items-start gap-3 p-4">
          <ErrorBox message={errorMessage(reasons.error)} />
          <Button size="sm" loading={reasons.isFetching} onClick={() => reasons.refetch()}>
            Tentar de novo
          </Button>
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<AlertTriangle />}
          title="Nenhum motivo cadastrado"
          description="Com os motivos, cada prazo violado ganha uma justificativa no dashboard."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Motivo</Th>
              <Th>Prazo</Th>
              <Th>Responsabilidade</Th>
              <Th>Situação</Th>
              {readOnly ? null : <Th className="edit-col">Editar</Th>}
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id} className="transition-colors hover:bg-[var(--row-hover)]">
                <Td className="font-semibold">{r.name}</Td>
                <Td className="text-sm">{VIOLATION_SCOPE[r.applies_to]}</Td>
                <Td>
                  <NeutralChip>{RESPONSIBILITY[r.responsibility].label}</NeutralChip>
                </Td>
                <Td>
                  <ActiveState active={r.is_active} />
                </Td>
                {readOnly ? null : (
                  <Td className="edit-col">
                    <RowEditButton label={`Editar o motivo ${r.name}`} onClick={() => setEditing(r)} />
                  </Td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {editing ? (
        <ReasonDialog reason={editing === "new" ? null : editing} reasons={list} onClose={() => setEditing(null)} />
      ) : null}
    </Card>
  );
}
