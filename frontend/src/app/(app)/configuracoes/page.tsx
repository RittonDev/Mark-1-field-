"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderTree, Plus, Save } from "lucide-react";
import { useMemo, useState } from "react";
import { PriorityBadge, StatusBadge } from "@/components/badges";
import { CompanyProfileCard } from "@/components/CompanyProfileCard";
import { FieldRulesCard } from "@/components/FieldRulesCard";
import { useToast } from "@/components/Toaster";
import { UnproductiveReasonsCard } from "@/components/UnproductiveReasonsCard";
import { ViolationReasonsCard } from "@/components/ViolationReasonsCard";
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
  PageHeader,
  Select,
  Table,
  Td,
  Textarea,
  Th,
} from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { PRIORITY_ORDER, STATUS, STATUS_ORDER, TRANSITIONS } from "@/lib/constants";
import { formatMinutes } from "@/lib/format";
import { useCategories, useTeams } from "@/lib/queries";
import type { Category, SlaPolicy, TicketPriority } from "@/lib/types";

function SlaRow({ policy, editable }: { policy: SlaPolicy; editable: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [response, setResponse] = useState(String(policy.response_minutes));
  const [resolution, setResolution] = useState(String(policy.resolution_minutes));
  const dirty =
    Number(response) !== policy.response_minutes || Number(resolution) !== policy.resolution_minutes;

  const mutation = useMutation({
    mutationFn: () =>
      api.put<SlaPolicy>(`/sla-policies/${policy.priority}`, {
        response_minutes: Number(response),
        resolution_minutes: Number(resolution),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sla-policies"] });
      toast({ title: "SLA atualizado", description: "Vale para as novas OS e mudanças de prioridade.", tone: "success" });
    },
    onError: (error) => toast({ title: "Não foi possível salvar", description: errorMessage(error), tone: "error" }),
  });

  return (
    <tr>
      <Td>
        <PriorityBadge priority={policy.priority} />
      </Td>
      <Td>
        {editable ? (
          <div className="flex items-center gap-2">
            <Input type="number" min={1} value={response} onChange={(e) => setResponse(e.target.value)} className="w-24" />
            <span className="text-xs text-ink-muted">{formatMinutes(Number(response))}</span>
          </div>
        ) : (
          formatMinutes(policy.response_minutes)
        )}
      </Td>
      <Td>
        {editable ? (
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              className="w-24"
            />
            <span className="text-xs text-ink-muted">{formatMinutes(Number(resolution))}</span>
          </div>
        ) : (
          formatMinutes(policy.resolution_minutes)
        )}
      </Td>
      <Td className="text-right">
        {editable ? (
          <Button
            size="sm"
            variant="primary"
            disabled={!dirty || Number(response) <= 0 || Number(resolution) <= 0}
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            <Save className="size-3.5" />
            Salvar
          </Button>
        ) : null}
      </Td>
    </tr>
  );
}

function CategoryDialog({ categories, onClose }: { categories: Category[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const teams = useTeams();
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [description, setDescription] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      api.post<Category>("/categories", {
        name: name.trim(),
        parent_id: parentId || null,
        default_team_id: teamId || null,
        description: description.trim() || null,
      }),
    onSuccess: (category) => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      toast({ title: `Categoria ${category.full_name} criada`, tone: "success" });
      onClose();
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title="Nova categoria"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" type="submit" form="category-form" loading={mutation.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      <form
        id="category-form"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
        className="flex flex-col gap-4"
      >
        <Field label="Nome" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} placeholder="Ex.: Toner / suprimentos" />
        </Field>
        <Field label="Categoria pai" hint="Deixe vazio para criar uma categoria raiz (ex.: Impressoras)">
          <Select value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">Nenhuma (raiz)</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.full_name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Grupo padrão" hint="OS desta categoria vão para este grupo automaticamente">
          <Select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            <option value="">Nenhum</option>
            {teams.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Descrição">
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {mutation.error ? <ErrorBox message={errorMessage(mutation.error)} /> : null}
      </form>
    </Dialog>
  );
}

export default function SettingsPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isAdmin = user?.role === "admin";
  const [creatingCategory, setCreatingCategory] = useState(false);

  const policies = useQuery({
    queryKey: ["sla-policies"],
    queryFn: () => api.get<SlaPolicy[]>("/sla-policies"),
  });
  const categories = useCategories();

  const sortedPolicies = useMemo(() => {
    const rank = (p: TicketPriority) => PRIORITY_ORDER.indexOf(p);
    return [...(policies.data ?? [])].sort((a, b) => rank(a.priority) - rank(b.priority));
  }, [policies.data]);
  const sortedCategories = useMemo(
    () => [...(categories.data ?? [])].sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [categories.data],
  );

  const toggleCategory = useMutation({
    mutationFn: (c: Category) => api.patch<Category>(`/categories/${c.id}`, { is_active: !c.is_active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["categories"] }),
    onError: (error) => toast({ title: "Não foi possível alterar", description: errorMessage(error), tone: "error" }),
  });

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Configurações" description="Dados da empresa, SLA por prioridade, categorias, motivos e fluxo de status" />

      <div className="flex flex-col gap-4">
        <CompanyProfileCard />
        <FieldRulesCard />

        <Card>
          <CardHeader
            title="Acordos de nível de serviço (SLA)"
            description="Minutos corridos (24x7). O relógio pausa nos status Aguardando cliente e Aguardando fornecedor/peça."
          />
          {policies.isLoading ? (
            <LoadingBlock />
          ) : policies.error ? (
            <div className="p-4">
              <ErrorBox message={errorMessage(policies.error)} />
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Prioridade</Th>
                  <Th>Primeira resposta (min)</Th>
                  <Th>Solução (min)</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {sortedPolicies.map((p) => (
                  <SlaRow
                    key={`${p.priority}-${p.response_minutes}-${p.resolution_minutes}`}
                    policy={p}
                    editable={isAdmin}
                  />
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Categorias"
            description="Árvore de categorias e roteamento automático para grupos técnicos"
            actions={
              <Button size="sm" onClick={() => setCreatingCategory(true)}>
                <Plus className="size-3.5" />
                Nova categoria
              </Button>
            }
          />
          {categories.isLoading ? (
            <LoadingBlock />
          ) : categories.error ? (
            <div className="p-4">
              <ErrorBox message={errorMessage(categories.error)} />
            </div>
          ) : sortedCategories.length === 0 ? (
            <EmptyState icon={<FolderTree className="size-7" />} title="Nenhuma categoria" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Categoria</Th>
                  <Th>Grupo padrão</Th>
                  <Th>Situação</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {sortedCategories.map((c) => (
                  <tr key={c.id} className={c.is_active ? undefined : "opacity-60"}>
                    <Td>
                      <span className={c.parent_id ? "pl-4 text-ink" : "font-medium text-ink"}>
                        {c.parent_id ? `↳ ${c.name}` : c.name}
                      </span>
                      {c.parent_id ? <span className="ml-2 text-xs text-ink-muted">{c.full_name}</span> : null}
                    </Td>
                    <Td>{c.default_team?.name ?? "—"}</Td>
                    <Td className="text-xs">{c.is_active ? "Ativa" : "Inativa"}</Td>
                    <Td className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={toggleCategory.isPending && toggleCategory.variables?.id === c.id}
                        onClick={() => toggleCategory.mutate(c)}
                      >
                        {c.is_active ? "Desativar" : "Ativar"}
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <ViolationReasonsCard />
        <UnproductiveReasonsCard />

        <Card>
          <CardHeader
            title="Fluxo de status"
            description="Transições permitidas (definidas no backend; referência para a equipe)"
          />
          <Table>
            <thead>
              <tr>
                <Th>De</Th>
                <Th>Pode ir para</Th>
              </tr>
            </thead>
            <tbody>
              {STATUS_ORDER.map((s) => (
                <tr key={s}>
                  <Td className="align-top">
                    <StatusBadge status={s} />
                    {STATUS[s].slaPaused ? <p className="mt-1 text-[11px] text-ink-muted">SLA pausado</p> : null}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1.5">
                      {TRANSITIONS[s].length === 0 ? (
                        <span className="text-xs text-ink-muted">Status final</span>
                      ) : (
                        TRANSITIONS[s].map((to) => <StatusBadge key={to} status={to} />)
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>

      {creatingCategory ? (
        <CategoryDialog categories={sortedCategories} onClose={() => setCreatingCategory(false)} />
      ) : null}
    </div>
  );
}
