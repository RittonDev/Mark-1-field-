"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Search, Timer, TrendingUp, Wand2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
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
import type { ServiceType } from "@/lib/types";

function ServiceTypeDialog({ serviceType, onClose }: { serviceType: ServiceType | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const customers = useCustomers();
  const categories = useCategories();
  const editing = serviceType !== null;
  const [form, setForm] = useState({
    name: serviceType?.name ?? "",
    description: serviceType?.description ?? "",
    estimated_minutes: String(serviceType?.estimated_minutes ?? 60),
    technician_fee: moneyInput(serviceType?.technician_fee),
    customer_id: serviceType?.customer_id ?? "",
    category_id: serviceType?.category_id ?? "",
    is_active: serviceType?.is_active ?? true,
  });
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  const sortedCategories = useMemo(
    () => [...(categories.data ?? [])].sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [categories.data],
  );
  const minutes = Number(form.estimated_minutes);
  // Valor em reais ("120" ou "120,50"); vazio = sem padrão.
  const fee = parseMoney(form.technician_fee);
  const feeInvalid = fee !== null && (!Number.isFinite(fee) || fee < 0);

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
      title={editing ? "Editar tipo de serviço" : "Novo tipo de serviço"}
      description="A duração estimada agenda a visita; a real é medida pelo tempo em atendimento."
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
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
          if (!feeInvalid) mutation.mutate();
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
          />
        </Field>
        <Field
          label="Duração estimada (minutos)"
          required
          hint={Number.isFinite(minutes) && minutes > 0 ? formatMinutes(minutes) : undefined}
        >
          <Input
            type="number"
            min={1}
            max={10080}
            value={form.estimated_minutes}
            onChange={(e) => set("estimated_minutes", e.target.value)}
            required
          />
        </Field>
        <Field
          label="Valor do técnico (R$)"
          hint={feeInvalid ? "Valor inválido" : "Quanto o parceiro recebe por uma OS deste tipo. Vazio = a central define na OS."}
        >
          <Input
            inputMode="decimal"
            value={form.technician_fee}
            onChange={(e) => set("technician_fee", e.target.value)}
            placeholder="Ex.: 120,00"
          />
        </Field>
        <Field label="Cliente" hint={editing ? "Não muda depois de criado" : "Vazio = vale para todos"}>
          <Select value={form.customer_id} onChange={(e) => set("customer_id", e.target.value)} disabled={editing}>
            <option value="">Todos os clientes</option>
            {customers.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Categoria padrão" className="sm:col-span-2" hint="Preenchida na OS quando ela não tiver categoria">
          <Select value={form.category_id} onChange={(e) => set("category_id", e.target.value)}>
            <option value="">Nenhuma</option>
            {sortedCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.full_name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Descrição" className="sm:col-span-2">
          <Textarea rows={2} value={form.description} onChange={(e) => set("description", e.target.value)} />
        </Field>
        {editing ? (
          <div className="sm:col-span-2">
            <Checkbox label="Ativo" checked={form.is_active} onChange={(v) => set("is_active", v)} />
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

function Deviation({ type }: { type: ServiceType }) {
  if (type.observed_median_minutes === null) return <span className="text-xs text-ink-muted">sem dados</span>;
  const ratio = type.observed_median_minutes / type.estimated_minutes;
  const off = ratio >= 1.25 || ratio <= 0.8;
  return (
    <span className={off ? "font-medium text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}>
      {ratio >= 1 ? `${ratio.toFixed(1).replace(".", ",")}×` : `${Math.round(ratio * 100)}%`}
    </span>
  );
}

export default function ServiceTypesPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const canEdit = canManageTickets(user?.role);
  const customers = useCustomers();
  const [customerId, setCustomerId] = useState("");
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<ServiceType | "new" | null>(null);
  const types = useServiceTypes({ customerId: customerId || null, active: showInactive ? undefined : true });

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (types.data ?? []).filter((t) => !q || t.name.toLowerCase().includes(q));
  }, [types.data, search]);
  const pending = rows.filter((t) => t.suggested_minutes !== null).length;

  const apply = useMutation({
    mutationFn: (type: ServiceType) => api.post<ServiceType>(`/service-types/${type.id}/apply-observed`),
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ["service-types"] });
      toast({ title: `${saved.name}: estimativa ajustada para ${formatMinutes(saved.estimated_minutes)}`, tone: "success" });
    },
    onError: (error) => toast({ title: errorMessage(error), tone: "error" }),
  });

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Tipos de serviço"
        description="Duração estimada por tipo, comparada com o que acontece de verdade nas OS concluídas"
        actions={
          canEdit ? (
            <Button variant="primary" onClick={() => setEditing("new")}>
              <Plus className="size-4" />
              Novo tipo
            </Button>
          ) : null
        }
      />

      {pending > 0 ? (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <TrendingUp className="mt-0.5 size-4 shrink-0" />
          <p>
            <strong>{pending} tipo(s)</strong> com estimativa longe do real. A sugestão usa a mediana do tempo em
            atendimento das OS concluídas (mínimo de 3).
          </p>
        </div>
      ) : null}

      <Card className="mb-4 p-3">
        <div className="grid gap-2 md:grid-cols-[2fr_1fr_auto]">
          <div className="relative">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-ink-muted" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar tipo" className="pl-9" />
          </div>
          <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">Todos os catálogos</option>
            {customers.data?.map((c) => (
              <option key={c.id} value={c.id}>
                Gerais + {c.name}
              </option>
            ))}
          </Select>
          <Checkbox label="Mostrar inativos" checked={showInactive} onChange={setShowInactive} />
        </div>
      </Card>

      <Card>
        {types.isLoading ? (
          <LoadingBlock />
        ) : types.error ? (
          <div className="p-4">
            <ErrorBox message={errorMessage(types.error)} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<Timer className="size-8" />} title="Nenhum tipo de serviço" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Tipo de serviço</Th>
                <Th>Cliente</Th>
                <Th className="text-right">Estimada</Th>
                <Th className="text-right">Valor técnico</Th>
                <Th className="text-right">Observada</Th>
                <Th className="text-right">Real ÷ estimada</Th>
                <Th>Sugestão</Th>
                {canEdit ? <Th className="w-10" /> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="hover:bg-surface-2">
                  <Td>
                    <p className="font-medium text-ink">
                      {t.name}
                      {!t.is_active ? <span className="ml-1 text-xs font-normal text-ink-muted">(inativo)</span> : null}
                    </p>
                    {t.description ? <p className="text-xs text-ink-muted">{t.description}</p> : null}
                  </Td>
                  <Td className="text-sm">{t.customer?.name ?? <span className="text-ink-muted">Todos</span>}</Td>
                  <Td className="text-right whitespace-nowrap">{formatMinutes(t.estimated_minutes)}</Td>
                  <Td className="text-right whitespace-nowrap tabular-nums">
                    {t.technician_fee != null ? formatMoney(t.technician_fee) : <span className="text-ink-subtle">—</span>}
                  </Td>
                  <Td className="text-right whitespace-nowrap">
                    {t.observed_median_minutes !== null ? (
                      <Link href={`/chamados?service_type_id=${t.id}`} className="hover:underline">
                        {formatMinutes(t.observed_median_minutes)}
                        <span className="block text-xs text-ink-muted">mediana de {t.observed_count} OS</span>
                      </Link>
                    ) : (
                      <span className="text-ink-muted">—</span>
                    )}
                  </Td>
                  <Td className="text-right">
                    <Deviation type={t} />
                  </Td>
                  <Td>
                    {t.suggested_minutes !== null ? (
                      canEdit ? (
                        <Button size="sm" onClick={() => apply.mutate(t)} loading={apply.isPending && apply.variables?.id === t.id}>
                          <Wand2 className="size-3.5" />
                          Ajustar para {formatMinutes(t.suggested_minutes)}
                        </Button>
                      ) : (
                        <span className="text-xs">{formatMinutes(t.suggested_minutes)}</span>
                      )
                    ) : (
                      <span className="text-xs text-ink-muted">—</span>
                    )}
                  </Td>
                  {canEdit ? (
                    <Td>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(t)} aria-label={`Editar ${t.name}`}>
                        <Pencil className="size-3.5" />
                      </Button>
                    </Td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {editing ? (
        <ServiceTypeDialog serviceType={editing === "new" ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </div>
  );
}
