"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { MultiSelect } from "@/components/MultiSelect";
import { useToast } from "@/components/Toaster";
import { Button, Dialog, ErrorBox, Field, Input, Select, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { moneyInput, parseMoney } from "@/lib/format";
import { PROJECT_STATUS } from "@/lib/projects";
import { useAssignable, useCustomers, useTeams } from "@/lib/queries";
import type { Project, ProjectStatus } from "@/lib/types";

function initialForm(project: Project | null) {
  return {
    name: project?.name ?? "",
    customer_id: project?.customer?.id ?? "",
    description: project?.description ?? "",
    status: (project?.status ?? "active") as ProjectStatus,
    start_date: project?.start_date ?? "",
    end_date: project?.end_date ?? "",
    contract_value: moneyInput(project?.contract_value),
    pricing_notes: project?.pricing_notes ?? "",
    manager_id: project?.manager?.id ?? "",
    team_id: project?.team?.id ?? "",
    member_ids: project?.members.map((m) => m.id) ?? [],
  };
}

/** Valor em reais que o cadastro não aceita: negativo, com mais de 2 casas ou acima de 12 dígitos. */
function invalidMoney(value: number): boolean {
  return !Number.isFinite(value) || value < 0 || value >= 1e10 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-6;
}

function FieldError({ children }: { children: React.ReactNode }) {
  return <span className="text-xs font-medium text-red-600 dark:text-red-400">{children}</span>;
}

export function ProjectDialog({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { toast } = useToast();
  const customers = useCustomers();
  const teams = useTeams();
  // Só a equipe ativa (a base trouxe do Field Control quase mil técnicos inativos).
  const assignable = useAssignable(null);
  const [initial] = useState(() => initialForm(project));
  const [form, setForm] = useState(initial);
  const [tried, setTried] = useState(false);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const people = assignable.data ?? [];
  const managers = people.filter((u) => u.role !== "technician").map((u) => ({ id: u.id, name: u.name }));
  // O responsável atual continua na lista mesmo fora dela (inativo ou administrador), senão o campo apareceria vazio.
  const managerOptions =
    project?.manager && !managers.some((m) => m.id === project.manager?.id) ? [...managers, project.manager] : managers;
  const technicians = people.filter((u) => u.role === "technician").map((u) => ({ value: u.id, label: u.name }));
  const activeIds = new Set(people.map((u) => u.id));
  const technicianOptions = [
    ...technicians,
    ...(project?.members ?? [])
      .filter((m) => !technicians.some((t) => t.value === m.id))
      .map((m) => ({ value: m.id, label: activeIds.has(m.id) ? m.name : `${m.name} (inativo)` })),
  ];

  const value = parseMoney(form.contract_value);
  const errors = {
    name: form.name.trim().length < 3 ? "Dê um nome com pelo menos 3 letras." : null,
    dates:
      form.start_date && form.end_date && form.end_date < form.start_date
        ? "A entrega prevista não pode ser antes do início."
        : null,
    value: value !== null && invalidMoney(value) ? "Valor inválido. Ex.: 12.500,00" : null,
  };
  const invalid = Object.values(errors).some(Boolean);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        customer_id: form.customer_id || null,
        description: form.description.trim() || null,
        status: form.status,
        start_date: form.start_date || null,
        end_date: form.end_date || null,
        contract_value: value === null ? null : value.toFixed(2),
        pricing_notes: form.pricing_notes.trim() || null,
        manager_id: form.manager_id || null,
        team_id: form.team_id || null,
        member_ids: form.member_ids,
      };
      return project ? api.put<Project>(`/projects/${project.id}`, body) : api.post<Project>("/projects", body);
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(["project", saved.id], saved);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast({ title: project ? "Projeto salvo" : `Projeto ${saved.code} criado`, tone: "success" });
      onClose();
      // Projeto novo: já abre a página dele, para marcar as OS e acompanhar.
      if (!project) router.push(`/projetos/${saved.id}`);
    },
  });

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      // Clique fora, Esc ou o X com algo preenchido perguntam antes de descartar; salvando, não fecha.
      dirty={dirty}
      busy={save.isPending}
      title={project ? `Editar ${project.code}` : "Novo projeto"}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form="project-form" loading={save.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      <form
        id="project-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (!invalid) save.mutate();
        }}
        className="grid gap-4 sm:grid-cols-2"
      >
        <Field label="Nome" required className="sm:col-span-2">
          <Input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Ex.: Recabeamento das lojas Zona Sul"
            maxLength={200}
            aria-invalid={tried && errors.name ? true : undefined}
          />
          {tried && errors.name ? <FieldError>{errors.name}</FieldError> : null}
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
          <Input
            type="date"
            value={form.end_date}
            min={form.start_date || undefined}
            onChange={(e) => set("end_date", e.target.value)}
            aria-invalid={errors.dates ? true : undefined}
          />
          {errors.dates ? <FieldError>{errors.dates}</FieldError> : null}
        </Field>
        <Field label="Valor do projeto (R$)">
          <Input
            value={form.contract_value}
            onChange={(e) => set("contract_value", e.target.value)}
            onBlur={() => {
              if (value !== null && !invalidMoney(value)) set("contract_value", moneyInput(value));
            }}
            inputMode="decimal"
            placeholder="0,00"
            maxLength={20}
            aria-invalid={errors.value ? true : undefined}
          />
          {errors.value ? <FieldError>{errors.value}</FieldError> : null}
        </Field>
        <Field label="Responsável interno">
          <Select value={form.manager_id} onChange={(e) => set("manager_id", e.target.value)}>
            <option value="">—</option>
            {managerOptions.map((u) => (
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
        {/* Rótulo em cima, como os outros campos (o MultiSelect não fica dentro de <label>: tem botão e lista). */}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-ink/80">Técnicos do projeto</span>
          <MultiSelect
            label="Técnicos"
            ariaLabel="Técnicos do projeto"
            options={technicianOptions}
            value={form.member_ids}
            onChange={(v) => set("member_ids", v)}
          />
        </div>
        <Field label="Condições e valores" hint="Ex.: R$ 400 por loja; visita extra R$ 150" className="sm:col-span-2">
          <Textarea rows={2} value={form.pricing_notes} onChange={(e) => set("pricing_notes", e.target.value)} maxLength={5000} />
        </Field>
        <Field label="Descrição" className="sm:col-span-2">
          <Textarea rows={3} value={form.description} onChange={(e) => set("description", e.target.value)} maxLength={5000} />
        </Field>
        {save.error ? (
          <div className="sm:col-span-2">
            <ErrorBox message={errorMessage(save.error)} />
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}
