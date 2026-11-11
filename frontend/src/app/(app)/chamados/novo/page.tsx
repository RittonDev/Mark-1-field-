"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Save } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { PriorityBadge } from "@/components/badges";
import { useToast } from "@/components/Toaster";
import { Button, Card, CardHeader, ErrorBox, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  ASSET_TYPE,
  computePriority,
  isStaff,
  LEVEL,
  LEVEL_ORDER,
  PRIORITY,
  PRIORITY_ORDER,
  TICKET_SOURCE,
  TICKET_TYPE,
} from "@/lib/constants";
import { fromLocalInput } from "@/lib/format";
import { useAssignable, useCategories, useCustomers, useLocations, useTeams } from "@/lib/queries";
import type {
  Asset,
  Level,
  TicketCreatePayload,
  TicketDetail,
  TicketPriority,
  TicketSource,
  TicketType,
} from "@/lib/types";

interface FormState {
  title: string;
  description: string;
  type: TicketType;
  source: TicketSource;
  category_id: string;
  impact: Level;
  urgency: Level;
  priority: "" | TicketPriority;
  customer_id: string;
  location_id: string;
  asset_id: string;
  requester_name: string;
  requester_contact: string;
  team_id: string;
  assignee_id: string;
  scheduled_start: string;
  scheduled_end: string;
}

const INITIAL: FormState = {
  title: "",
  description: "",
  type: "incident",
  source: "web",
  category_id: "",
  impact: "medium",
  urgency: "medium",
  priority: "",
  customer_id: "",
  location_id: "",
  asset_id: "",
  requester_name: "",
  requester_contact: "",
  team_id: "",
  assignee_id: "",
  scheduled_start: "",
  scheduled_end: "",
};

export default function NewTicketPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const staff = isStaff(user?.role);
  const [form, setForm] = useState<FormState>(INITIAL);

  const categories = useCategories();
  const customers = useCustomers();
  const locations = useLocations(form.customer_id || null);
  const teams = useTeams();
  const assignable = useAssignable(form.team_id || null, staff);
  const assets = useQuery({
    queryKey: ["assets", "for-ticket", form.customer_id, form.location_id],
    queryFn: () =>
      api.get<Asset[]>("/assets", {
        customer_id: form.customer_id,
        location_id: form.location_id || undefined,
      }),
    enabled: Boolean(form.customer_id),
  });

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const computed = computePriority(form.impact, form.urgency);
  const effectivePriority = form.priority || computed;

  const sortedCategories = useMemo(
    () => [...(categories.data ?? [])].filter((c) => c.is_active).sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [categories.data],
  );

  const mutation = useMutation({
    mutationFn: (payload: TicketCreatePayload) => api.post<TicketDetail>("/tickets", payload),
    onSuccess: (ticket) => {
      queryClient.invalidateQueries({ queryKey: ["tickets"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      toast({ title: `${ticket.code} aberta`, description: ticket.title, tone: "success" });
      router.push(`/chamados/${ticket.id}`);
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload: TicketCreatePayload = {
      title: form.title.trim(),
      description: form.description.trim(),
      type: form.type,
      impact: form.impact,
      urgency: form.urgency,
      priority: form.priority || null,
      source: form.source,
      category_id: form.category_id || null,
      customer_id: form.customer_id || null,
      location_id: form.location_id || null,
      asset_id: form.asset_id || null,
      requester_name: form.requester_name.trim() || null,
      requester_contact: form.requester_contact.trim() || null,
    };
    if (staff) {
      payload.team_id = form.team_id || null;
      payload.assignee_id = form.assignee_id || null;
      payload.scheduled_start = fromLocalInput(form.scheduled_start);
      payload.scheduled_end = fromLocalInput(form.scheduled_end);
    }
    mutation.mutate(payload);
  }

  return (
    <div className="mx-auto max-w-5xl">
      <Link href="/chamados" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
        <ArrowLeft className="size-4" />
        Chamados
      </Link>
      <PageHeader title="Nova ordem de serviço" description="Registre o chamado e, se já souber, defina o analista" />

      <form onSubmit={onSubmit} className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="Descrição do problema" />
            <div className="grid gap-4 p-4 md:grid-cols-2">
              <Field label="Título" required className="md:col-span-2">
                <Input
                  value={form.title}
                  onChange={(e) => set("title", e.target.value)}
                  placeholder="Ex.: Impressora do RH atolando papel"
                  minLength={3}
                  maxLength={200}
                  required
                />
              </Field>
              <Field label="Descrição" className="md:col-span-2">
                <Textarea
                  value={form.description}
                  onChange={(e) => set("description", e.target.value)}
                  rows={5}
                  placeholder="Sintomas, mensagens de erro, quando começou, quem é afetado..."
                />
              </Field>
              <Field label="Tipo">
                <Select value={form.type} onChange={(e) => set("type", e.target.value as TicketType)}>
                  {Object.entries(TICKET_TYPE).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Categoria">
                <Select
                  value={form.category_id}
                  onChange={(e) => {
                    const id = e.target.value;
                    const category = sortedCategories.find((c) => c.id === id);
                    setForm((f) => ({
                      ...f,
                      category_id: id,
                      // Roteamento automático: sugere o grupo padrão da categoria.
                      team_id: f.team_id || category?.default_team_id || "",
                    }));
                  }}
                >
                  <option value="">Selecione...</option>
                  {sortedCategories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.full_name}
                    </option>
                  ))}
                </Select>
              </Field>
              {staff ? (
                <Field label="Origem">
                  <Select value={form.source} onChange={(e) => set("source", e.target.value as TicketSource)}>
                    {Object.entries(TICKET_SOURCE).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
            </div>
          </Card>

          <Card>
            <CardHeader title="Cliente, local e equipamento" />
            <div className="grid gap-4 p-4 md:grid-cols-2">
              <Field label="Cliente">
                <Select
                  value={form.customer_id}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, customer_id: e.target.value, location_id: "", asset_id: "" }))
                  }
                >
                  <option value="">Selecione...</option>
                  {customers.data?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Local de atendimento">
                <Select
                  value={form.location_id}
                  disabled={!form.customer_id}
                  onChange={(e) => setForm((f) => ({ ...f, location_id: e.target.value, asset_id: "" }))}
                >
                  <option value="">{form.customer_id ? "Selecione..." : "Escolha o cliente primeiro"}</option>
                  {locations.data?.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                      {l.city ? ` · ${l.city}` : ""}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Equipamento (ativo)" className="md:col-span-2">
                <Select
                  value={form.asset_id}
                  disabled={!form.customer_id}
                  onChange={(e) => set("asset_id", e.target.value)}
                >
                  <option value="">{form.customer_id ? "Nenhum / não identificado" : "Escolha o cliente primeiro"}</option>
                  {assets.data?.map((a) => (
                    <option key={a.id} value={a.id}>
                      {ASSET_TYPE[a.asset_type]} · {a.name}
                      {a.asset_tag ? ` · Pat. ${a.asset_tag}` : ""}
                      {a.serial_number ? ` · S/N ${a.serial_number}` : ""}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Solicitante">
                <Input
                  value={form.requester_name}
                  onChange={(e) => set("requester_name", e.target.value)}
                  placeholder={staff ? "Nome de quem abriu" : user?.name}
                />
              </Field>
              <Field label="Contato do solicitante">
                <Input
                  value={form.requester_contact}
                  onChange={(e) => set("requester_contact", e.target.value)}
                  placeholder="Telefone, ramal ou e-mail"
                />
              </Field>
            </div>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="Prioridade" description="Matriz impacto × urgência (ITIL)" />
            <div className="flex flex-col gap-4 p-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Impacto">
                  <Select value={form.impact} onChange={(e) => set("impact", e.target.value as Level)}>
                    {LEVEL_ORDER.map((l) => (
                      <option key={l} value={l}>
                        {LEVEL[l]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Urgência">
                  <Select value={form.urgency} onChange={(e) => set("urgency", e.target.value as Level)}>
                    {LEVEL_ORDER.map((l) => (
                      <option key={l} value={l}>
                        {LEVEL[l]}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label="Prioridade">
                <Select
                  value={form.priority}
                  onChange={(e) => set("priority", e.target.value as FormState["priority"])}
                >
                  <option value="">
                    Automática ({PRIORITY[computed].code} · {PRIORITY[computed].label})
                  </option>
                  {PRIORITY_ORDER.map((p) => (
                    <option key={p} value={p}>
                      {PRIORITY[p].code} · {PRIORITY[p].label}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2 text-sm">
                <span className="text-ink-muted">Prioridade final</span>
                <PriorityBadge priority={effectivePriority} />
              </div>
            </div>
          </Card>

          {staff ? (
            <Card>
              <CardHeader title="Atribuição e agenda" />
              <div className="flex flex-col gap-4 p-4">
                <Field label="Grupo técnico">
                  <Select
                    value={form.team_id}
                    onChange={(e) => setForm((f) => ({ ...f, team_id: e.target.value, assignee_id: "" }))}
                  >
                    <option value="">Sem grupo</option>
                    {teams.data
                      ?.filter((t) => t.is_active)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                  </Select>
                </Field>
                <Field label="Analista responsável">
                  <Select value={form.assignee_id} onChange={(e) => set("assignee_id", e.target.value)}>
                    <option value="">Deixar na fila</option>
                    {assignable.data?.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name} — {u.open_tickets} em aberto
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Início da visita">
                  <Input
                    type="datetime-local"
                    value={form.scheduled_start}
                    onChange={(e) => set("scheduled_start", e.target.value)}
                  />
                </Field>
                <Field label="Fim previsto">
                  <Input
                    type="datetime-local"
                    value={form.scheduled_end}
                    min={form.scheduled_start || undefined}
                    onChange={(e) => set("scheduled_end", e.target.value)}
                  />
                </Field>
              </div>
            </Card>
          ) : null}

          {mutation.error ? <ErrorBox message={errorMessage(mutation.error)} /> : null}
          <Button type="submit" variant="primary" loading={mutation.isPending} className="w-full">
            {mutation.isPending ? null : <Save className="size-4" />}
            Abrir OS
          </Button>
        </div>
      </form>
    </div>
  );
}
