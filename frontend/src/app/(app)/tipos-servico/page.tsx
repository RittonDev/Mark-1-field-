"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Timer, TrendingUp } from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useRef, useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { FieldError, fold, InactiveChip, plural, RowEditButton, SearchField } from "@/components/settings/shared";
import { useToast } from "@/components/Toaster";
import {
  Button,
  Card,
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
import { canManageTickets } from "@/lib/constants";
import { formatMinutes, formatMoney, moneyInput, parseMoney } from "@/lib/format";
import { useCategories, useCustomers, useServiceTypes } from "@/lib/queries";
import type { FormTemplate, ServiceType } from "@/lib/types";

// Regras da sugestão de duração (backend/app/services/durations.py): só com 3 OS concluídas ou
// mais e quando a mediana passa 25% acima ou 20% abaixo da estimativa.
const MIN_SAMPLES = 3;
const LOWER_RATIO = 0.8;
const UPPER_RATIO = 1.25;
// Limites de backend/app/schemas/catalog.py.
const MAX_MINUTES = 60 * 24 * 7;
const MAX_FEE = 9_999_999_999.99;

/** Problema no valor do técnico (vazio = sem valor padrão), com os limites da API: até 2 casas. */
function feeProblem(fee: number | null): string | undefined {
  if (fee === null) return undefined;
  if (!Number.isFinite(fee) || fee < 0) return "Valor inválido. Ex.: 120,00";
  if (Math.abs(Math.round(fee * 100) - fee * 100) > 1e-6) return "Use até 2 casas decimais (milhar com ponto e centavos com vírgula: 1.234,50).";
  if (fee > MAX_FEE) return "Valor alto demais.";
  return undefined;
}

/** Formulários ativos sugeridos em cada tipo de serviço (a ligação fica no formulário). */
function useLinkedForms() {
  const templates = useQuery({
    queryKey: ["form-templates", "active"],
    queryFn: () => api.get<FormTemplate[]>("/form-templates", { active: true }),
  });
  const byType = useMemo(() => {
    const map = new Map<string, FormTemplate[]>();
    for (const t of templates.data ?? []) {
      for (const id of t.service_type_ids) map.set(id, [...(map.get(id) ?? []), t]);
    }
    return map;
  }, [templates.data]);
  return { byType, loaded: templates.isSuccess };
}

function ServiceTypeDialog({
  serviceType,
  linkedForms,
  onClose,
}: {
  serviceType: ServiceType | null;
  /** Formulários sugeridos neste tipo (null: ainda carregando). */
  linkedForms: FormTemplate[] | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const customers = useCustomers();
  const categories = useCategories();
  const editing = serviceType !== null;
  const [initial] = useState(() => ({
    name: serviceType?.name ?? "",
    description: serviceType?.description ?? "",
    estimated_minutes: String(serviceType?.estimated_minutes ?? 60),
    technician_fee: moneyInput(serviceType?.technician_fee),
    customer_id: serviceType?.customer_id ?? "",
    category_id: serviceType?.category_id ?? "",
    is_active: serviceType?.is_active ?? true,
  }));
  const [form, setForm] = useState(initial);
  const [showFeeError, setShowFeeError] = useState(false);
  const feeInput = useRef<HTMLInputElement>(null);
  const feeErrorId = useId();
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  // Só os ativos, mais o que já estava escolhido (para não sumir da tela).
  const categoryOptions = useMemo(
    () =>
      [...(categories.data ?? [])]
        .filter((c) => c.is_active || c.id === initial.category_id)
        .sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [categories.data, initial.category_id],
  );
  const customerOptions = useMemo(
    () => (customers.data ?? []).filter((c) => c.is_active || c.id === initial.customer_id),
    [customers.data, initial.customer_id],
  );
  const minutes = Number(form.estimated_minutes);
  // Valor em reais ("120", "120,50" ou "1.234,50"); vazio = sem padrão.
  const fee = parseMoney(form.technician_fee);
  const feeError = feeProblem(fee);
  // O erro aparece ao sair do campo ou ao salvar (não a cada tecla enquanto ainda digita).
  const showFee = Boolean(feeError) && showFeeError;
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const observed = serviceType?.observed_median_minutes ?? null;
  const suggested = serviceType?.suggested_minutes ?? null;

  const mutation = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        estimated_minutes: minutes,
        technician_fee: fee,
        category_id: form.category_id || null,
      };
      return editing
        ? api.patch<ServiceType>(`/service-types/${serviceType.id}`, { ...body, is_active: form.is_active })
        : api.post<ServiceType>("/service-types", { ...body, customer_id: form.customer_id || null });
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ["service-types"] });
      toast({ title: `${saved.name} ${editing ? "atualizado" : "cadastrado"}`, tone: "success" });
      onClose();
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      dirty={dirty}
      busy={mutation.isPending}
      size="lg"
      title={editing ? "Editar tipo de serviço" : "Novo tipo de serviço"}
      description="A duração estimada agenda a visita; a real é medida pelo tempo em atendimento."
      footer={
        <>
          <Button onClick={onClose} disabled={mutation.isPending}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form="service-type-form" loading={mutation.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      <form
        id="service-type-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (feeError) {
            setShowFeeError(true);
            feeInput.current?.focus();
            return;
          }
          mutation.mutate();
        }}
        className="grid gap-4 sm:grid-cols-2"
      >
        <Field label="Nome" required className="sm:col-span-2">
          <Input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Ex.: Impressora A4 - Instalação"
            required
            minLength={2}
            maxLength={160}
          />
        </Field>
        <Field
          label="Duração estimada (minutos)"
          required
          hint={Number.isInteger(minutes) && minutes > 0 ? formatMinutes(minutes) : "Em minutos: 90 = 1h 30min"}
        >
          <Input
            type="number"
            min={1}
            max={MAX_MINUTES}
            step={1}
            value={form.estimated_minutes}
            onChange={(e) => set("estimated_minutes", e.target.value)}
            required
          />
        </Field>
        <Field label="Valor do técnico (R$)" hint={showFee ? undefined : "Quanto o parceiro recebe por uma OS deste tipo. Vazio: a central define na OS."}>
          <Input
            ref={feeInput}
            inputMode="decimal"
            value={form.technician_fee}
            onChange={(e) => set("technician_fee", e.target.value)}
            onBlur={() => setShowFeeError(Boolean(feeError))}
            placeholder="Ex.: 120,00"
            aria-invalid={showFee ? true : undefined}
            aria-describedby={showFee ? feeErrorId : undefined}
          />
          {showFee ? <FieldError id={feeErrorId}>{feeError}</FieldError> : null}
        </Field>
        {editing && observed !== null ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-sm sm:col-span-2">
            <p className="text-ink">
              Real nas OS concluídas: <strong className="font-semibold">{formatMinutes(observed)}</strong>{" "}
              <span className="text-ink-muted">
                (mediana de {serviceType.observed_count.toLocaleString("pt-BR")} OS
                {serviceType.observed_count < MIN_SAMPLES ? "; poucos dados para sugerir" : ""})
              </span>
            </p>
            {suggested !== null && suggested !== minutes ? (
              <Button size="sm" variant="ghost" onClick={() => set("estimated_minutes", String(suggested))}>
                Usar {formatMinutes(suggested)}
              </Button>
            ) : null}
          </div>
        ) : null}
        <Field label="Cliente" hint={editing ? "Não muda depois de criado" : "Vazio: vale para todos os clientes"}>
          <Select value={form.customer_id} onChange={(e) => set("customer_id", e.target.value)} disabled={editing}>
            <option value="">Todos os clientes</option>
            {customerOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.is_active ? c.name : `${c.name} (inativo)`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Categoria padrão" hint="Preenchida na OS quando ela não tiver categoria">
          <Select value={form.category_id} onChange={(e) => set("category_id", e.target.value)}>
            <option value="">Nenhuma</option>
            {categoryOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.is_active ? c.full_name : `${c.full_name} (inativa)`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Descrição" className="sm:col-span-2">
          <Textarea rows={2} value={form.description} onChange={(e) => set("description", e.target.value)} />
        </Field>
        {editing ? (
          <div className="flex flex-col gap-1 sm:col-span-2">
            <Checkbox label="Ativo" checked={form.is_active} onChange={(v) => set("is_active", v)} />
            <span className="text-xs text-ink-muted">Inativo não aparece para novas OS; as OS antigas continuam com ele.</span>
          </div>
        ) : null}
        {editing ? (
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="text-xs font-semibold text-ink/80">Formulários sugeridos nas OS deste tipo</span>
            {linkedForms === null ? (
              <span className="text-xs text-ink-muted">Carregando...</span>
            ) : linkedForms.length ? (
              <ul className="flex flex-wrap gap-1.5">
                {linkedForms.map((f) => (
                  <li key={f.id}>
                    <Link
                      href={`/formularios?editar=${f.id}`}
                      className="inline-flex rounded-full border border-line px-2.5 py-0.5 text-xs font-medium text-ink hover:border-brand/40 hover:text-brand focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none"
                    >
                      {f.name}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-xs text-ink-muted">
                Nenhum. A ligação é feita no próprio formulário, em{" "}
                <Link href="/formularios" className="font-medium text-brand hover:underline">
                  Formulários
                </Link>
                .
              </span>
            )}
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

/** Real ÷ estimada. Vermelho só quando a diferença conta (passa da tolerância com 3 OS ou mais). */
function Deviation({ type }: { type: ServiceType }) {
  if (type.observed_median_minutes === null) return <span className="text-xs text-ink-muted">sem dados</span>;
  const ratio = type.observed_median_minutes / type.estimated_minutes;
  const few = type.observed_count < MIN_SAMPLES;
  const off = !few && (ratio >= UPPER_RATIO || ratio <= LOWER_RATIO);
  return (
    <span className="whitespace-nowrap">
      <span className={off ? "font-semibold text-red-600 tabular-nums dark:text-red-400" : "text-ink tabular-nums"}>
        {ratio.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}×
      </span>
      {few ? <span className="block text-xs text-ink-muted">poucos dados</span> : null}
    </span>
  );
}

export default function ServiceTypesPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const canEdit = canManageTickets(user?.role);
  const customers = useCustomers();
  const [customerId, setCustomerId] = useState("");
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [onlySuggested, setOnlySuggested] = useState(false);
  const [editing, setEditing] = useState<ServiceType | "new" | null>(null);
  // Ajuste em lote em andamento (um tipo por vez, com o progresso na tela).
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const types = useServiceTypes({ customerId: customerId || null, active: showInactive ? undefined : true });
  const linked = useLinkedForms();

  const query = search.trim();
  const matching = useMemo(() => {
    const q = fold(query);
    return (types.data ?? []).filter(
      (t) => !q || fold(`${t.name} ${t.description ?? ""} ${t.customer?.name ?? ""}`).includes(q),
    );
  }, [types.data, query]);
  const withSuggestion = useMemo(() => matching.filter((t) => t.suggested_minutes !== null), [matching]);
  const rows = onlySuggested ? withSuggestion : matching;
  const catalogOptions = (customers.data ?? []).filter((c) => c.is_active || c.id === customerId);
  const filtered = Boolean(query || customerId || onlySuggested);

  const apply = useMutation({
    mutationFn: (type: ServiceType) => api.post<ServiceType>(`/service-types/${type.id}/apply-observed`),
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ["service-types"] });
      toast({ title: `${saved.name}: estimativa ajustada para ${formatMinutes(saved.estimated_minutes)}`, tone: "success" });
    },
    onError: (error) => toast({ title: "Não foi possível ajustar", description: errorMessage(error), tone: "error" }),
  });
  const busy = apply.isPending || batch !== null;

  const applyAll = async () => {
    const list = withSuggestion;
    if (!list.length) return;
    const ok = await confirm({
      title: `Ajustar ${plural(list.length, "tipo", "tipos")} para o tempo real?`,
      description: (
        <div className="flex flex-col gap-2">
          <p>A estimativa de cada um passa a ser a mediana das OS concluídas, arredondada a 5 minutos:</p>
          <ul className="max-h-60 overflow-y-auto rounded-lg border border-line text-xs">
            {list.map((t) => (
              <li key={t.id} className="flex justify-between gap-3 border-b border-line px-3 py-1.5 last:border-b-0">
                <span className="min-w-0 truncate text-ink">{t.name}</span>
                <span className="shrink-0 tabular-nums">
                  {formatMinutes(t.estimated_minutes)} → <strong className="font-semibold text-ink">{formatMinutes(t.suggested_minutes)}</strong>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ),
      confirmLabel: `Ajustar ${list.length}`,
      cancelLabel: "Voltar",
    });
    if (!ok) return;
    const failed: string[] = [];
    setBatch({ done: 0, total: list.length });
    for (const [i, t] of list.entries()) {
      try {
        await api.post<ServiceType>(`/service-types/${t.id}/apply-observed`);
      } catch {
        failed.push(t.name);
      }
      setBatch({ done: i + 1, total: list.length });
    }
    setBatch(null);
    queryClient.invalidateQueries({ queryKey: ["service-types"] });
    const applied = list.length - failed.length;
    if (failed.length) {
      toast({
        title: `Ajustados ${applied} de ${list.length}`,
        description: `Não foi possível ajustar: ${failed.slice(0, 5).join(", ")}${failed.length > 5 ? " e outros" : ""}.`,
        tone: "error",
      });
    } else {
      toast({
        title: `${plural(applied, "tipo ajustado", "tipos ajustados")}`,
        description: "A estimativa agora segue o tempo real das OS concluídas.",
        tone: "success",
      });
    }
  };

  const clearFilters = () => {
    setSearch("");
    setCustomerId("");
    setOnlySuggested(false);
  };

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Tipos de serviço"
        description="Duração estimada e valor do técnico por tipo, comparados com o que acontece de verdade nas OS concluídas."
        actions={
          canEdit ? (
            <Button variant="primary" onClick={() => setEditing("new")}>
              <Plus className="size-4" />
              Novo tipo
            </Button>
          ) : null
        }
      />

      {withSuggestion.length > 0 ? (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <TrendingUp className="size-4 shrink-0" />
          <p className="min-w-0 flex-1">
            <strong className="font-semibold">{plural(withSuggestion.length, "tipo", "tipos")}</strong> com estimativa longe do
            real. A sugestão usa a mediana do tempo em atendimento das OS concluídas (mínimo de {MIN_SAMPLES}).
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" aria-pressed={onlySuggested} onClick={() => setOnlySuggested((v) => !v)}>
              {onlySuggested ? "Mostrar todos" : "Ver só esses"}
            </Button>
            {canEdit ? (
              <Button size="sm" onClick={applyAll} loading={batch !== null} disabled={busy}>
                {batch ? `Ajustando ${batch.done} de ${batch.total}` : `Ajustar todos (${withSuggestion.length})`}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      <Card className="mb-4 p-3">
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-[2fr_1fr_auto_auto] xl:items-center">
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder="Buscar tipo, descrição ou cliente"
            label="Buscar tipo de serviço"
          />
          <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)} aria-label="Catálogo do cliente">
            <option value="">Todos os catálogos</option>
            {catalogOptions.map((c) => (
              <option key={c.id} value={c.id}>
                Gerais + {c.name}
              </option>
            ))}
          </Select>
          <Checkbox label="Mostrar inativos" checked={showInactive} onChange={setShowInactive} />
          <Checkbox label={`Só com sugestão (${withSuggestion.length})`} checked={onlySuggested} onChange={setOnlySuggested} />
        </div>
      </Card>

      <Card>
        {types.isLoading ? (
          <LoadingBlock />
        ) : types.error ? (
          <div className="flex flex-col items-start gap-3 p-4">
            <ErrorBox message={errorMessage(types.error)} />
            <Button size="sm" loading={types.isFetching} onClick={() => types.refetch()}>
              Tentar de novo
            </Button>
          </div>
        ) : rows.length === 0 ? (
          filtered ? (
            <EmptyState
              icon={<Timer />}
              title={onlySuggested && !query ? "Nenhum tipo com ajuste sugerido" : "Nenhum tipo encontrado"}
              description={onlySuggested && !query ? "As estimativas estão perto do tempo real." : "Confira a busca e os filtros."}
              action={
                <Button size="sm" onClick={clearFilters}>
                  Limpar filtros
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<Timer />}
              title="Nenhum tipo cadastrado"
              description="Cadastre os tipos de serviço com a duração estimada de cada um."
              action={
                canEdit ? (
                  <Button size="sm" variant="primary" onClick={() => setEditing("new")}>
                    <Plus className="size-3.5" />
                    Novo tipo
                  </Button>
                ) : undefined
              }
            />
          )
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Tipo de serviço</Th>
                <Th>Cliente</Th>
                <Th className="text-right">Estimada</Th>
                <Th className="text-right">Valor técnico</Th>
                <Th className="text-right">Real (mediana)</Th>
                <Th className="text-right">Real ÷ estimada</Th>
                <Th>Sugestão</Th>
                <Th className="text-right">Formulários</Th>
                {canEdit ? <Th className="edit-col">Editar</Th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const forms = linked.byType.get(t.id) ?? [];
                return (
                  <tr key={t.id} className="transition-colors hover:bg-[var(--row-hover)]">
                    <Td className="min-w-48">
                      <p className="font-semibold text-ink">
                        {t.name}
                        {!t.is_active ? (
                          <span className="ml-2 align-middle">
                            <InactiveChip />
                          </span>
                        ) : null}
                      </p>
                      {t.description ? <p className="line-clamp-2 text-xs text-ink-muted">{t.description}</p> : null}
                    </Td>
                    <Td className="text-sm">{t.customer?.name ?? <span className="text-ink-muted">Todos</span>}</Td>
                    <Td className="text-right whitespace-nowrap tabular-nums">{formatMinutes(t.estimated_minutes)}</Td>
                    <Td className="text-right whitespace-nowrap tabular-nums">
                      {t.technician_fee != null ? formatMoney(t.technician_fee) : <span className="text-ink-subtle">—</span>}
                    </Td>
                    <Td className="text-right whitespace-nowrap">
                      {t.observed_median_minutes !== null ? (
                        <Link
                          href={`/chamados?service_type_id=${t.id}&status=resolved&status=closed`}
                          className="rounded tabular-nums hover:underline focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none"
                          title="Ver as OS concluídas deste tipo"
                        >
                          {formatMinutes(t.observed_median_minutes)}
                          <span className="block text-xs text-ink-muted">
                            de {t.observed_count.toLocaleString("pt-BR")} OS
                          </span>
                        </Link>
                      ) : (
                        <span className="text-ink-subtle">—</span>
                      )}
                    </Td>
                    <Td className="text-right">
                      <Deviation type={t} />
                    </Td>
                    <Td>
                      {t.suggested_minutes !== null ? (
                        canEdit ? (
                          <Button
                            size="sm"
                            onClick={() => apply.mutate(t)}
                            loading={apply.isPending && apply.variables?.id === t.id}
                            disabled={busy}
                            aria-label={`Ajustar ${t.name} para ${formatMinutes(t.suggested_minutes)}`}
                          >
                            Ajustar para {formatMinutes(t.suggested_minutes)}
                          </Button>
                        ) : (
                          <span className="text-xs whitespace-nowrap">{formatMinutes(t.suggested_minutes)}</span>
                        )
                      ) : (
                        <span className="text-xs text-ink-subtle">—</span>
                      )}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {forms.length ? (
                        <span title={forms.map((f) => f.name).join(", ")}>{forms.length}</span>
                      ) : (
                        <span className="text-ink-subtle">—</span>
                      )}
                    </Td>
                    {canEdit ? (
                      <Td className="edit-col">
                        <RowEditButton label={`Editar ${t.name}`} onClick={() => setEditing(t)} />
                      </Td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      {editing ? (
        <ServiceTypeDialog
          serviceType={editing === "new" ? null : editing}
          linkedForms={editing === "new" ? [] : linked.loaded ? (linked.byType.get(editing.id) ?? []) : null}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}
