"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, Plus } from "lucide-react";
import { useState } from "react";
import { useToast } from "@/components/Toaster";
import { Button, Card, CardHeader, Dialog, EmptyState, ErrorBox, Field, Input, LoadingBlock, Pill, Select, Table, Td, Th } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { RESPONSIBILITY } from "@/lib/constants";
import { useUnproductiveReasons } from "@/lib/queries";
import type { Responsibility, UnproductiveReason } from "@/lib/types";

/** Motivos de visita improdutiva (o técnico escolhe no app quando não consegue atender). */
export function UnproductiveReasonsCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const reasons = useUnproductiveReasons();
  const [creating, setCreating] = useState(false);
  const toggle = useMutation({
    mutationFn: (r: UnproductiveReason) => api.patch(`/unproductive-reasons/${r.id}`, { is_active: !r.is_active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["unproductive-reasons"] }),
    onError: (e) => toast({ title: "Não foi possível alterar", description: errorMessage(e), tone: "error" }),
  });

  return (
    <Card>
      <CardHeader
        title="Motivos de visita improdutiva"
        description="O técnico foi ao local e não conseguiu atender: ele escolhe o motivo e a OS volta para reagendar"
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" />
            Novo motivo
          </Button>
        }
      />
      {reasons.isLoading ? (
        <LoadingBlock />
      ) : (reasons.data ?? []).length === 0 ? (
        <EmptyState icon={<Ban className="size-7" />} title="Nenhum motivo cadastrado" />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Motivo</Th>
              <Th>Responsabilidade</Th>
              <Th>Situação</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {reasons.data?.map((r) => (
              <tr key={r.id} className={r.is_active ? undefined : "opacity-60"}>
                <Td className="font-medium">{r.name}</Td>
                <Td>
                  <Pill color={RESPONSIBILITY[r.responsibility].color}>{RESPONSIBILITY[r.responsibility].label}</Pill>
                </Td>
                <Td className="text-xs">{r.is_active ? "Ativo" : "Inativo"}</Td>
                <Td className="text-right">
                  <Button size="sm" variant="ghost" loading={toggle.isPending && toggle.variables?.id === r.id} onClick={() => toggle.mutate(r)}>
                    {r.is_active ? "Desativar" : "Ativar"}
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {creating ? <NewReason onClose={() => setCreating(false)} /> : null}
    </Card>
  );
}

function NewReason({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [responsibility, setResponsibility] = useState<Responsibility>("customer");
  const save = useMutation({
    mutationFn: () => api.post("/unproductive-reasons", { name: name.trim(), responsibility }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["unproductive-reasons"] });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Novo motivo de visita improdutiva"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={save.isPending} disabled={name.trim().length < 2} onClick={() => save.mutate()}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Motivo" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Loja em inventário" autoFocus />
        </Field>
        <Field label="Responsabilidade" hint="Separa no relatório o que é do cliente, nosso ou de terceiro">
          <Select value={responsibility} onChange={(e) => setResponsibility(e.target.value as Responsibility)}>
            {Object.entries(RESPONSIBILITY).map(([value, info]) => (
              <option key={value} value={value}>
                {info.label}
              </option>
            ))}
          </Select>
        </Field>
        {save.error ? <ErrorBox message={errorMessage(save.error)} /> : null}
      </div>
    </Dialog>
  );
}
