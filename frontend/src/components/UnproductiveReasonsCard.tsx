"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, Plus } from "lucide-react";
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
  Textarea,
  Th,
} from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { RESPONSIBILITY } from "@/lib/constants";
import { useUnproductiveReasons } from "@/lib/queries";
import type { Responsibility, UnproductiveReason } from "@/lib/types";

// A orientação aparece no app embaixo do motivo: curta, para caber na tela do celular.
const MAX_HINT = 300;

/** Motivos de visita improdutiva (o técnico escolhe no app quando não consegue atender). */
export function UnproductiveReasonsCard() {
  const reasons = useUnproductiveReasons();
  const [editing, setEditing] = useState<UnproductiveReason | "new" | null>(null);
  const list = reasons.data ?? [];

  return (
    <Card>
      <CardHeader
        title="Motivos de visita improdutiva"
        description="O técnico foi ao local e não conseguiu atender: ele escolhe o motivo no app e a OS volta para reagendar."
        actions={
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="size-3.5" />
            Novo motivo
          </Button>
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
          icon={<Ban />}
          title="Nenhum motivo cadastrado"
          description="O técnico escolhe um destes motivos no app quando não consegue atender."
          action={
            <Button size="sm" onClick={() => setEditing("new")}>
              <Plus className="size-3.5" />
              Novo motivo
            </Button>
          }
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Motivo</Th>
              <Th>Responsabilidade</Th>
              <Th>Situação</Th>
              <Th className="edit-col">Editar</Th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id} className="transition-colors hover:bg-[var(--row-hover)]">
                <Td className="min-w-56">
                  <p className="font-semibold text-ink">{r.name}</p>
                  {r.description ? <p className="line-clamp-2 text-xs text-ink-muted">{r.description}</p> : null}
                </Td>
                <Td>
                  <NeutralChip>{RESPONSIBILITY[r.responsibility].label}</NeutralChip>
                </Td>
                <Td>
                  <ActiveState active={r.is_active} />
                </Td>
                <Td className="edit-col">
                  <RowEditButton label={`Editar o motivo ${r.name}`} onClick={() => setEditing(r)} />
                </Td>
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

function ReasonDialog({
  reason,
  reasons,
  onClose,
}: {
  /** null: motivo novo. */
  reason: UnproductiveReason | null;
  reasons: UnproductiveReason[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const nameErrorId = useId();
  const [initial] = useState(() => ({
    name: reason?.name ?? "",
    description: reason?.description ?? "",
    responsibility: (reason?.responsibility ?? "customer") as Responsibility,
    is_active: reason?.is_active ?? true,
  }));
  const [form, setForm] = useState(initial);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const name = form.name.trim();
  // O nome é único: avisa aqui em vez do "registro duplicado" genérico da API.
  const duplicate = name.length > 0 && reasons.some((r) => r.id !== reason?.id && fold(r.name.trim()) === fold(name));

  const save = useMutation({
    mutationFn: () => {
      const description = form.description.trim() || null;
      if (!reason) {
        return api.post<UnproductiveReason>("/unproductive-reasons", { name, description, responsibility: form.responsibility });
      }
      // Só o que mudou.
      const patch: Record<string, unknown> = {};
      if (name !== reason.name) patch.name = name;
      if (description !== reason.description) patch.description = description;
      if (form.responsibility !== reason.responsibility) patch.responsibility = form.responsibility;
      if (form.is_active !== reason.is_active) patch.is_active = form.is_active;
      return api.patch<UnproductiveReason>(`/unproductive-reasons/${reason.id}`, patch);
    },
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["unproductive-reasons"] });
      toast({
        title: reason ? `Motivo “${r.name}” atualizado` : `Motivo “${r.name}” cadastrado`,
        description: "O app dos técnicos recebe na próxima sincronização.",
        tone: "success",
      });
      onClose();
    },
  });
  const requestClose = useDiscardGuard(dirty, onClose);

  return (
    <Dialog
      open
      onClose={requestClose}
      title={reason ? "Editar motivo de visita improdutiva" : "Novo motivo de visita improdutiva"}
      footer={
        <>
          <Button onClick={requestClose}>Cancelar</Button>
          <Button
            variant="primary"
            type="submit"
            form="unproductive-reason-form"
            loading={save.isPending}
            disabled={duplicate || (reason !== null && !dirty)}
          >
            Salvar
          </Button>
        </>
      }
    >
      <form
        id="unproductive-reason-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!duplicate) save.mutate();
        }}
        className="flex flex-col gap-4"
      >
        <Field
          label="Motivo"
          required
          hint={
            reason && !duplicate && name && name !== reason.name
              ? "As visitas já registradas continuam com o nome antigo no relatório."
              : undefined
          }
        >
          <Input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Ex.: Loja em inventário"
            required
            minLength={2}
            maxLength={160}
            autoFocus
            aria-invalid={duplicate ? true : undefined}
            aria-describedby={duplicate ? nameErrorId : undefined}
          />
          {duplicate ? <FieldError id={nameErrorId}>Já existe um motivo com este nome.</FieldError> : null}
        </Field>
        <Field
          label="Responsabilidade"
          hint={
            reason && form.responsibility !== reason.responsibility
              ? "Vale para as próximas visitas; as já registradas guardam a da época."
              : "Separa no relatório o que é do cliente, nosso ou de terceiro."
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
        <Field label="Orientação para o técnico" hint="Opcional. Aparece no app embaixo do motivo.">
          <Textarea
            rows={2}
            value={form.description}
            maxLength={MAX_HINT}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            placeholder="Ex.: Fotografe a porta da loja fechada antes de sair."
          />
        </Field>
        {reason ? (
          <div className="flex flex-col gap-1">
            <Checkbox label="Ativo" checked={form.is_active} onChange={(v) => setForm((f) => ({ ...f, is_active: v }))} />
            <span className="text-xs text-ink-muted">Inativo sai da lista do app; as visitas antigas continuam com ele.</span>
          </div>
        ) : null}
        {save.error ? <ErrorBox message={errorMessage(save.error)} /> : null}
      </form>
    </Dialog>
  );
}
