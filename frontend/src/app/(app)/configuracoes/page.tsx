"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ChevronRight, FolderTree, Lock, Plus, Save } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useMemo, useState } from "react";
import { PriorityBadge, StatusBadge } from "@/components/badges";
import { CompanyProfileCard } from "@/components/CompanyProfileCard";
import { FieldRulesCard } from "@/components/FieldRulesCard";
import { ActiveState, FieldError, fold, RowEditButton, useDiscardGuard } from "@/components/settings/shared";
import { useToast } from "@/components/Toaster";
import { UnproductiveReasonsCard } from "@/components/UnproductiveReasonsCard";
import { ViolationReasonsCard } from "@/components/ViolationReasonsCard";
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
  PageHeader,
  Select,
  Table,
  Td,
  Textarea,
  Th,
} from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { isManager, PRIORITY, PRIORITY_ORDER, STATUS, STATUS_ORDER, TRANSITIONS } from "@/lib/constants";
import { formatMinutes, formatMoney } from "@/lib/format";
import { useCategories, useTeams } from "@/lib/queries";
import type { Category, SlaPolicy, TicketPriority } from "@/lib/types";

// Limites de backend/app/schemas/catalog.py (SlaPolicyUpdate): 60 e 120 dias.
const MAX_RESPONSE = 60 * 24 * 60;
const MAX_RESOLUTION = 60 * 24 * 120;

const SECTIONS = [
  { id: "empresa", label: "Empresa" },
  { id: "campo", label: "Campo" },
  { id: "sla", label: "SLA" },
  { id: "categorias", label: "Categorias" },
  { id: "motivos", label: "Motivos" },
  { id: "status", label: "Status" },
];

/** Número inteiro digitado (vazio, com vírgula ou ponto vira NaN). */
const whole = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : Number.NaN);

function slaProblems(response: number, resolution: number): { response?: string; resolution?: string } {
  const out: { response?: string; resolution?: string } = {};
  if (!(response >= 1)) out.response = "Use minutos inteiros, maiores que zero.";
  else if (response > MAX_RESPONSE) out.response = `No máximo ${MAX_RESPONSE.toLocaleString("pt-BR")} min (${formatMinutes(MAX_RESPONSE)}).`;
  if (!(resolution >= 1)) out.resolution = "Use minutos inteiros, maiores que zero.";
  else if (resolution > MAX_RESOLUTION) {
    out.resolution = `No máximo ${MAX_RESOLUTION.toLocaleString("pt-BR")} min (${formatMinutes(MAX_RESOLUTION)}).`;
  } else if (!out.response && resolution < response) out.resolution = "Não pode ser menor que a primeira resposta.";
  return out;
}

/** Atalhos para as seções (a página é longa); marca a seção que está na tela. */
function SectionNav() {
  const [active, setActive] = useState(SECTIONS[0].id);
  useEffect(() => {
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        const first = SECTIONS.find((s) => visible.has(s.id));
        if (first) setActive(first.id);
      },
      // Faixa logo abaixo da barra do topo e destes atalhos.
      { rootMargin: "-120px 0px -55% 0px" },
    );
    for (const s of SECTIONS) {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);
  return (
    <nav aria-label="Seções das configurações" className="sticky top-16 z-20 mb-4">
      <ul className="inline-flex max-w-full gap-1 overflow-x-auto rounded-xl border border-line bg-surface/95 p-1 shadow-elev-1 backdrop-blur-sm">
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              aria-current={active === s.id ? "location" : undefined}
              className={clsx(
                "block rounded-lg px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none",
                active === s.id ? "bg-nav-active text-brand-ink" : "text-ink-muted hover:bg-surface-2 hover:text-ink",
              )}
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function SlaRow({ policy, editable }: { policy: SlaPolicy; editable: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const id = useId();
  const [response, setResponse] = useState(String(policy.response_minutes));
  const [resolution, setResolution] = useState(String(policy.resolution_minutes));
  const r = whole(response);
  const s = whole(resolution);
  const dirty = r !== policy.response_minutes || s !== policy.resolution_minutes;
  const problems = slaProblems(r, s);
  const invalid = Boolean(problems.response || problems.resolution);
  const label = PRIORITY[policy.priority].label;

  const mutation = useMutation({
    mutationFn: () =>
      api.put<SlaPolicy>(`/sla-policies/${policy.priority}`, { response_minutes: r, resolution_minutes: s }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sla-policies"] });
      toast({ title: `SLA da prioridade ${label} atualizado`, description: "Vale para as novas OS e mudanças de prioridade.", tone: "success" });
    },
    onError: (error) => toast({ title: "Não foi possível salvar o SLA", description: errorMessage(error), tone: "error" }),
  });
  const submit = () => {
    if (dirty && !invalid) mutation.mutate();
  };
  // Enter no campo salva a linha (como num formulário).
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };

  const cell = (
    value: string,
    setValue: (v: string) => void,
    minutes: number,
    problem: string | undefined,
    name: string,
    key: string,
  ) => (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Input
          inputMode="numeric"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          className="w-24 tabular-nums"
          aria-label={`${name} em minutos, prioridade ${label}`}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${id}-${key}` : undefined}
        />
        <span className="text-xs text-ink-muted">{Number.isFinite(minutes) && minutes > 0 ? formatMinutes(minutes) : ""}</span>
      </div>
      {problem ? <FieldError id={`${id}-${key}`}>{problem}</FieldError> : null}
    </div>
  );

  return (
    <tr>
      <Td className="align-top">
        <PriorityBadge priority={policy.priority} />
      </Td>
      <Td className="align-top">
        {editable ? cell(response, setResponse, r, problems.response, "Primeira resposta", "resposta") : formatMinutes(policy.response_minutes)}
      </Td>
      <Td className="align-top">
        {editable ? cell(resolution, setResolution, s, problems.resolution, "Solução", "solucao") : formatMinutes(policy.resolution_minutes)}
      </Td>
      <Td className="text-right align-top">
        {editable ? (
          <Button size="sm" variant="primary" disabled={!dirty || invalid} loading={mutation.isPending} onClick={submit}>
            <Save className="size-3.5" />
            Salvar
          </Button>
        ) : null}
      </Td>
    </tr>
  );
}

function SlaCard({ editable }: { editable: boolean }) {
  const policies = useQuery({
    queryKey: ["sla-policies"],
    queryFn: () => api.get<SlaPolicy[]>("/sla-policies"),
  });
  const sorted = useMemo(() => {
    const rank = (p: TicketPriority) => PRIORITY_ORDER.indexOf(p);
    return [...(policies.data ?? [])].sort((a, b) => rank(a.priority) - rank(b.priority));
  }, [policies.data]);
  return (
    <Card>
      <CardHeader
        title="Acordos de nível de serviço (SLA)"
        description={`Minutos corridos (24x7). O relógio pausa nos status Aguardando cliente e Aguardando fornecedor/peça.${
          editable ? "" : " Só o administrador altera o SLA."
        }`}
      />
      {policies.isLoading ? (
        <LoadingBlock />
      ) : policies.error ? (
        <div className="flex flex-col items-start gap-3 p-4">
          <ErrorBox message={errorMessage(policies.error)} />
          <Button size="sm" loading={policies.isFetching} onClick={() => policies.refetch()}>
            Tentar de novo
          </Button>
        </div>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Prioridade</Th>
              <Th>Primeira resposta (min)</Th>
              <Th>Solução (min)</Th>
              {editable ? <Th className="text-right">Salvar</Th> : <Th />}
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => (
              <SlaRow key={`${p.priority}-${p.response_minutes}-${p.resolution_minutes}`} policy={p} editable={editable} />
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function CategoryDialog({
  category,
  categories,
  onClose,
}: {
  /** null: categoria nova. */
  category: Category | null;
  categories: Category[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const teams = useTeams();
  const nameErrorId = useId();
  const [initial] = useState(() => ({
    name: category?.name ?? "",
    parent_id: category?.parent_id ?? "",
    default_team_id: category?.default_team_id ?? "",
    description: category?.description ?? "",
    is_active: category?.is_active ?? true,
  }));
  const [form, setForm] = useState(initial);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const name = form.name.trim();

  // Pai: nem a própria categoria nem as que estão abaixo dela (viraria um ciclo); só as ativas,
  // mais a que já era a pai.
  const initialParent = initial.parent_id;
  const parentOptions = useMemo(() => {
    const blocked = new Set<string>();
    if (category) {
      const children = new Map<string, string[]>();
      for (const c of categories) {
        if (c.parent_id) children.set(c.parent_id, [...(children.get(c.parent_id) ?? []), c.id]);
      }
      const stack = [category.id];
      for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
        if (blocked.has(id)) continue;
        blocked.add(id);
        stack.push(...(children.get(id) ?? []));
      }
    }
    return categories.filter((c) => !blocked.has(c.id) && (c.is_active || c.id === initialParent));
  }, [categories, category, initialParent]);
  const teamOptions = (teams.data ?? []).filter((t) => t.is_active || t.id === initial.default_team_id);
  // Mesmo nome no mesmo nível confunde a escolha na OS (e a API recusa o nome repetido sob o mesmo pai).
  const duplicate =
    name.length > 0 &&
    categories.some((c) => c.id !== category?.id && (c.parent_id ?? "") === form.parent_id && fold(c.name.trim()) === fold(name));

  const mutation = useMutation({
    mutationFn: () => {
      const body = {
        name,
        parent_id: form.parent_id || null,
        default_team_id: form.default_team_id || null,
        description: form.description.trim() || null,
      };
      if (!category) return api.post<Category>("/categories", body);
      // Só o que mudou (a API aplica cada campo enviado).
      const patch: Record<string, unknown> = {};
      if (body.name !== category.name) patch.name = body.name;
      if (body.parent_id !== category.parent_id) patch.parent_id = body.parent_id;
      if (body.default_team_id !== category.default_team_id) patch.default_team_id = body.default_team_id;
      if (body.description !== category.description) patch.description = body.description;
      if (form.is_active !== category.is_active) patch.is_active = form.is_active;
      return api.patch<Category>(`/categories/${category.id}`, patch);
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      toast({ title: `Categoria ${saved.full_name} ${category ? "atualizada" : "criada"}`, tone: "success" });
      onClose();
    },
  });
  const requestClose = useDiscardGuard(dirty, onClose);

  return (
    <Dialog
      open
      onClose={requestClose}
      title={category ? `Editar ${category.full_name}` : "Nova categoria"}
      footer={
        <>
          <Button onClick={requestClose}>Cancelar</Button>
          <Button
            variant="primary"
            type="submit"
            form="category-form"
            loading={mutation.isPending}
            disabled={duplicate || (category !== null && !dirty)}
          >
            Salvar
          </Button>
        </>
      }
    >
      <form
        id="category-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!duplicate) mutation.mutate();
        }}
        className="flex flex-col gap-4"
      >
        <Field label="Nome" required>
          <Input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            required
            minLength={2}
            maxLength={120}
            placeholder="Ex.: Toner / suprimentos"
            aria-invalid={duplicate ? true : undefined}
            aria-describedby={duplicate ? nameErrorId : undefined}
          />
          {duplicate ? <FieldError id={nameErrorId}>Já existe uma categoria com este nome neste nível.</FieldError> : null}
        </Field>
        <Field label="Categoria pai" hint="Vazio: categoria raiz (ex.: Impressoras).">
          <Select value={form.parent_id} onChange={(e) => set("parent_id", e.target.value)}>
            <option value="">Nenhuma (raiz)</option>
            {parentOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.is_active ? c.full_name : `${c.full_name} (inativa)`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Grupo padrão" hint="As OS desta categoria vão para este grupo automaticamente.">
          <Select value={form.default_team_id} onChange={(e) => set("default_team_id", e.target.value)}>
            <option value="">Nenhum</option>
            {teamOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.is_active ? t.name : `${t.name} (inativo)`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Descrição">
          <Textarea rows={2} value={form.description} onChange={(e) => set("description", e.target.value)} />
        </Field>
        {category ? (
          <div className="flex flex-col gap-1">
            <Checkbox label="Ativa" checked={form.is_active} onChange={(v) => set("is_active", v)} />
            <span className="text-xs text-ink-muted">Inativa não aparece para escolher nas OS novas; as que já têm a categoria continuam com ela.</span>
          </div>
        ) : null}
        {mutation.error ? <ErrorBox message={errorMessage(mutation.error)} /> : null}
      </form>
    </Dialog>
  );
}

function CategoriesCard({ canEdit }: { canEdit: boolean }) {
  const categories = useCategories();
  const [editing, setEditing] = useState<Category | "new" | null>(null);
  const sorted = useMemo(
    () => [...(categories.data ?? [])].sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [categories.data],
  );
  // Nível de cada categoria na árvore (para o recuo na lista).
  const depth = useMemo(() => {
    const byId = new Map(sorted.map((c) => [c.id, c]));
    const out = new Map<string, number>();
    for (const c of sorted) {
      let level = 0;
      for (let p = c.parent_id ? byId.get(c.parent_id) : undefined; p && level < 6; p = p.parent_id ? byId.get(p.parent_id) : undefined) {
        level += 1;
      }
      out.set(c.id, level);
    }
    return out;
  }, [sorted]);

  return (
    <Card>
      <CardHeader
        title="Categorias"
        description="Árvore de categorias e roteamento automático para os grupos técnicos."
        actions={
          canEdit ? (
            <Button size="sm" onClick={() => setEditing("new")}>
              <Plus className="size-3.5" />
              Nova categoria
            </Button>
          ) : null
        }
      />
      {categories.isLoading ? (
        <LoadingBlock />
      ) : categories.error ? (
        <div className="flex flex-col items-start gap-3 p-4">
          <ErrorBox message={errorMessage(categories.error)} />
          <Button size="sm" loading={categories.isFetching} onClick={() => categories.refetch()}>
            Tentar de novo
          </Button>
        </div>
      ) : sorted.length === 0 ? (
        <EmptyState
          icon={<FolderTree />}
          title="Nenhuma categoria"
          description="Categorias organizam as OS e mandam cada uma para o grupo certo."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Categoria</Th>
              <Th>Grupo padrão</Th>
              <Th>Situação</Th>
              {canEdit ? <Th className="edit-col">Editar</Th> : null}
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => {
              const level = depth.get(c.id) ?? 0;
              return (
                <tr key={c.id} className="transition-colors hover:bg-[var(--row-hover)]">
                  <Td>
                    <span className="block" style={{ paddingLeft: `${level}rem` }}>
                      <span className={level ? "font-semibold text-ink" : "font-bold text-ink"}>
                        {level ? `↳ ${c.name}` : c.name}
                      </span>
                      {level ? <span className="ml-2 text-xs text-ink-muted">{c.full_name}</span> : null}
                    </span>
                  </Td>
                  <Td>{c.default_team?.name ?? <span className="text-ink-subtle">—</span>}</Td>
                  <Td>
                    <ActiveState active={c.is_active} feminine />
                  </Td>
                  {canEdit ? (
                    <Td className="edit-col">
                      <RowEditButton label={`Editar a categoria ${c.full_name}`} onClick={() => setEditing(c)} />
                    </Td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {editing ? (
        <CategoryDialog category={editing === "new" ? null : editing} categories={sorted} onClose={() => setEditing(null)} />
      ) : null}
    </Card>
  );
}

/** Valor do km fica em Custos extras; aqui só o lembrete de onde mudar. */
function KmRateNote() {
  const settings = useQuery({
    queryKey: ["settings", "expenses"],
    queryFn: () => api.get<{ km_rate: number }>("/settings/expenses"),
  });
  return (
    <p className="px-1 text-xs text-ink-muted">
      Valor do km rodado{settings.data ? `: ${formatMoney(settings.data.km_rate)}` : ""}. Muda em{" "}
      <Link href="/custos" className="font-medium text-brand hover:underline">
        Custos extras
      </Link>
      .
    </p>
  );
}

function StatusFlowCard() {
  return (
    <Card>
      <details className="group">
        <summary className="flex cursor-pointer list-none items-start justify-between gap-3 rounded-xl px-5 py-3.5 focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
          <span className="flex min-w-0 gap-2.5">
            <span aria-hidden className="mt-[3px] h-3.5 w-[3px] shrink-0 rounded-full bg-linear-to-b from-brand to-brand-cyan" />
            <span className="min-w-0">
              <h2 className="text-[15px] leading-5 font-bold tracking-[-0.01em] text-ink">Fluxo de status</h2>
              <span className="mt-0.5 block text-xs text-ink-muted">
                Para onde cada status pode ir (regra do sistema; referência para a equipe).
              </span>
            </span>
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-ink-muted">
            <span className="group-open:hidden">Ver fluxo</span>
            <span className="hidden group-open:inline">Esconder</span>
            <ChevronRight className="size-4 transition-transform duration-150 group-open:rotate-90" />
          </span>
        </summary>
        <div className="border-t border-line">
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
        </div>
      </details>
    </Card>
  );
}

export default function SettingsPage() {
  const { user } = useAuth();
  // Escrita: supervisores e administradores (o SLA, só o administrador). O analista lê e cuida dos
  // motivos de visita improdutiva.
  const canEdit = isManager(user?.role);
  const isAdmin = user?.role === "admin";

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Configurações"
        description="Dados da empresa, regras de campo, SLA, categorias, motivos e fluxo de status."
      />
      {user && !canEdit ? (
        <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink-muted shadow-elev-1">
          <Lock className="mt-0.5 size-4 shrink-0" />
          <p>
            Somente leitura: supervisores e administradores alteram as configurações. Os motivos de visita improdutiva
            você também cadastra e edita.
          </p>
        </div>
      ) : null}
      <SectionNav />

      <div className="flex flex-col gap-4">
        <section id="empresa" className="scroll-mt-28">
          <CompanyProfileCard readOnly={!canEdit} />
        </section>
        <section id="campo" className="flex scroll-mt-28 flex-col gap-2">
          <FieldRulesCard readOnly={!canEdit} />
          <KmRateNote />
        </section>
        <section id="sla" className="scroll-mt-28">
          <SlaCard editable={isAdmin} />
        </section>
        <section id="categorias" className="scroll-mt-28">
          <CategoriesCard canEdit={canEdit} />
        </section>
        <section id="motivos" className="flex scroll-mt-28 flex-col gap-4">
          <ViolationReasonsCard readOnly={!canEdit} />
          <UnproductiveReasonsCard />
        </section>
        <section id="status" className="scroll-mt-28">
          <StatusFlowCard />
        </section>
      </div>
    </div>
  );
}
