"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { MultiSelect } from "@/components/MultiSelect";
import { Button, Dialog, ErrorBox, Field, Input, Select, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { PROJECT_STATUS } from "@/lib/projects";
import { useAssignable, useCustomers, useTeams, useUsers } from "@/lib/queries";
import type { Project, ProjectStatus } from "@/lib/types";

export function ProjectDialog({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const customers = useCustomers();
  const teams = useTeams();
  const technicians = useUsers({ role: "technician" });
  const managers = useAssignable(null);
  const [form, setForm] = useState({
    name: project?.name ?? "",
    customer_id: project?.customer?.id ?? "",
    description: project?.description ?? "",
    status: (project?.status ?? "active") as ProjectStatus,
    start_date: project?.start_date ?? "",
    end_date: project?.end_date ?? "",
    contract_value: project?.contract_value != null ? project.contract_value.toFixed(2).replace(".", ",") : "",
    pricing_notes: project?.pricing_notes ?? "",
    manager_id: project?.manager?.id ?? "",
    team_id: project?.team?.id ?? "",
    member_ids: project?.members.map((m) => m.id) ?? [],
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...form,
        customer_id: form.customer_id || null,
        description: form.description || null,
        start_date: form.start_date || null,
        end_date: form.end_date || null,
        contract_value: form.contract_value ? form.contract_value.replace(/\./g, "").replace(",", ".") : null,
        pricing_notes: form.pricing_notes || null,
        manager_id: form.manager_id || null,
        team_id: form.team_id || null,
      };
      return project ? api.put<Project>(`/projects/${project.id}`, body) : api.post<Project>("/projects", body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["project"] });
      onClose();
    },
  });

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={project ? `Editar ${project.code}` : "Novo projeto"}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nome" required className="sm:col-span-2">
          <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Ex.: Recabeamento das lojas Zona Sul" />
        </Field>
        <Field label="Cliente">
          <Select value={form.customer_id} onChange={(e) => set("customer_id", e.target.value)}>
            <option value="">Sem cliente</option>
            {(customers.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Situação">
          <Select value={form.status} onChange={(e) => set("status", e.target.value as ProjectStatus)}>
            {Object.entries(PROJECT_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Início">
          <Input type="date" value={form.start_date} onChange={(e) => set("start_date", e.target.value)} />
        </Field>
        <Field label="Entrega prevista">
          <Input type="date" value={form.end_date} onChange={(e) => set("end_date", e.target.value)} />
        </Field>
        <Field label="Valor do projeto (R$)">
          <Input value={form.contract_value} onChange={(e) => set("contract_value", e.target.value)} inputMode="decimal" placeholder="0,00" />
        </Field>
        <Field label="Responsável interno">
          <Select value={form.manager_id} onChange={(e) => set("manager_id", e.target.value)}>
            <option value="">—</option>
            {(managers.data ?? [])
              .filter((u) => u.role !== "technician")
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Grupo técnico">
          <Select value={form.team_id} onChange={(e) => set("team_id", e.target.value)}>
            <option value="">—</option>
            {(teams.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <div>
          <MultiSelect
            label="Técnicos do projeto"
            options={(technicians.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
            value={form.member_ids}
            onChange={(v) => set("member_ids", v)}
          />
        </div>
        <Field label="Condições e valores" hint="Ex.: R$ 400 por loja; visita extra R$ 150" className="sm:col-span-2">
          <Textarea rows={2} value={form.pricing_notes} onChange={(e) => set("pricing_notes", e.target.value)} />
        </Field>
        <Field label="Descrição" className="sm:col-span-2">
          <Textarea rows={3} value={form.description} onChange={(e) => set("description", e.target.value)} />
        </Field>
        {save.error ? (
          <div className="sm:col-span-2">
            <ErrorBox message={errorMessage(save.error)} />
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
