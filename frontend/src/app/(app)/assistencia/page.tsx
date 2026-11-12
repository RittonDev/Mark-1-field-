"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { AlertTriangle, Camera, PackageSearch, Pencil, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button, Card, Checkbox, Dialog, EmptyState, ErrorBox, Field, Input, LoadingBlock, PageHeader, Select, Table, Td, Textarea, Th } from "@/components/ui";
import { absoluteApiUrl, api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets } from "@/lib/constants";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { useCustomers, useLocations } from "@/lib/queries";
import { REPAIR_FLOW, REPAIR_STATUS } from "@/lib/repairs";
import type { Page, Repair, RepairStatus, TicketListItem } from "@/lib/types";

function StageChip({ status }: { status: RepairStatus }) {
  const s = REPAIR_STATUS[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap"
      style={{ color: s.color, borderColor: `${s.color}55`, backgroundColor: `${s.color}12` }}
    >
      <span className="size-1.5 rounded-full" style={{ background: s.color }} />
      {s.label}
    </span>
  );
}

export default function RepairsPage() {
  const { user } = useAuth();
  const [status, setStatus] = useState<RepairStatus | "">("");
  const [openOnly, setOpenOnly] = useState(true);
  const [qInput, setQInput] = useState("");
  const q = useDebounced(qInput.trim());
  const [opened, setOpened] = useState<string | null>(null);
  const [editing, setEditing] = useState<Repair | "new" | null>(null);
  const summary = useQuery({
    queryKey: ["repairs", "summary"],
    queryFn: () => api.get<{ by_status: Record<RepairStatus, number>; open_total: number; overdue: number }>("/repairs/summary"),
  });
  const list = useQuery({
    queryKey: ["repairs", status, openOnly, q],
    queryFn: () => api.get<Repair[]>("/repairs", { status: status || undefined, open_only: openOnly || undefined, q: q || undefined }),
    placeholderData: (previous) => previous,
  });
  if (user && !canManageTickets(user.role)) return <ErrorBox message="A assistência externa é controlada pela gestão." />;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Assistência externa"
        description="Impressoras e equipamentos retirados dos clientes para conserto em assistência de terceiros, da retirada à devolução."
        actions={
          <Button variant="primary" onClick={() => setEditing("new")}>
            <Plus className="size-4" />
            Registrar retirada
          </Button>
        }
      />

      <div className="mb-4 flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Etapas">
        {REPAIR_FLOW.map((s) => {
          const active = status === s;
          return (
            <button
              key={s}
              type="button"
              aria-pressed={active}
              onClick={() => setStatus(active ? "" : s)}
              className={clsx(
                "flex min-w-36 shrink-0 flex-col rounded-lg border px-3 py-2 text-left transition-colors",
                active ? "border-brand bg-nav-active" : "border-line bg-surface hover:border-brand/50",
              )}
            >
              <span className="text-[11px] text-ink-muted">{REPAIR_STATUS[s].label}</span>
              <span className="text-lg font-semibold tabular-nums" style={{ color: REPAIR_STATUS[s].color }}>
                {summary.data?.by_status[s] ?? 0}
              </span>
            </button>
          );
        })}
        {summary.data?.overdue ? (
          <div className="flex min-w-36 shrink-0 flex-col justify-center rounded-lg border border-red-200 bg-red-50 px-3 py-2 dark:border-red-900/60 dark:bg-red-950/40">
            <span className="flex items-center gap-1 text-[11px] text-red-700 dark:text-red-300">
              <AlertTriangle className="size-3" /> Retorno atrasado
            </span>
            <span className="text-lg font-semibold text-red-700 tabular-nums dark:text-red-300">{summary.data.overdue}</span>
          </div>
        ) : null}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted" />
          <Input value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Nº de série, modelo, patrimônio ou protocolo" className="pl-9" aria-label="Buscar" />
        </div>
        <Checkbox label="Só em aberto" checked={openOnly} onChange={setOpenOnly} />
      </div>

      <Card>
        {list.isLoading ? (
          <LoadingBlock />
        ) : (list.data ?? []).length === 0 ? (
          <EmptyState icon={<PackageSearch className="size-6" />} title="Nada por aqui" description="Registre a retirada quando o técnico trouxer um equipamento do cliente." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Equipamento</Th>
                <Th className="hidden md:table-cell">Cliente</Th>
                <Th className="hidden lg:table-cell">Assistência</Th>
                <Th>Etapa</Th>
                <Th className="hidden sm:table-cell">Retorno</Th>
              </tr>
            </thead>
            <tbody>
              {(list.data ?? []).map((r) => (
                <tr key={r.id} className="cursor-pointer hover:bg-surface-2" onClick={() => setOpened(r.id)}>
                  <Td>
                    <span className="block font-mono text-xs text-ink-muted">{r.code}</span>
                    <span className="block text-ink">{[r.equipment_type, r.brand, r.model].filter(Boolean).join(" · ")}</span>
                    {r.serial_number ? <span className="block text-xs text-ink-muted">S/N {r.serial_number}</span> : null}
                  </Td>
                  <Td className="hidden md:table-cell">
                    <span className="block text-ink">{r.customer?.name ?? "—"}</span>
                    <span className="block text-xs text-ink-muted">{r.location?.name ?? ""}</span>
                  </Td>
                  <Td className="hidden lg:table-cell">
                    <span className="block text-ink">{r.vendor_name ?? "—"}</span>
                    {r.vendor_protocol ? <span className="block text-xs text-ink-muted">Prot. {r.vendor_protocol}</span> : null}
                  </Td>
                  <Td>
                    <StageChip status={r.status} />
                    <span className="mt-0.5 block text-[11px] text-ink-muted">há {r.days_in_status} dia(s) nesta etapa</span>
                  </Td>
                  <Td className={clsx("hidden text-xs sm:table-cell", r.overdue ? "font-medium text-red-600 dark:text-red-400" : "text-ink-muted")}>
                    {r.expected_return_date ? formatDate(r.expected_return_date) : "—"}
                    {r.overdue ? " · atrasado" : ""}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {opened ? <RepairDetail id={opened} onEdit={(r) => setEditing(r)} onClose={() => setOpened(null)} /> : null}
      {editing ? <RepairForm repair={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function RepairDetail({ id, onEdit, onClose }: { id: string; onEdit: (r: Repair) => void; onClose: () => void }) {
  const queryClient = useQueryClient();
  const repair = useQuery({ queryKey: ["repairs", "detail", id], queryFn: () => api.get<Repair>(`/repairs/${id}`) });
  const [next, setNext] = useState<RepairStatus | null>(null);
  const [note, setNote] = useState("");
  const [quoteValue, setQuoteValue] = useState("");
  const [returnDate, setReturnDate] = useState("");
  const refresh = (r: Repair) => {
    queryClient.setQueryData(["repairs", "detail", id], r);
    queryClient.invalidateQueries({ queryKey: ["repairs"] });
  };
  const move = useMutation({
    mutationFn: () =>
      api.post<Repair>(`/repairs/${id}/status`, {
        to_status: next,
        note: note || null,
        vendor_quote_value: quoteValue ? quoteValue.replace(",", ".") : null,
        expected_return_date: returnDate || null,
      }),
    onSuccess: (r) => {
      refresh(r);
      setNext(null);
      setNote("");
      setQuoteValue("");
      setReturnDate("");
    },
  });
  const photo = useMutation({
    mutationFn: (file: File) => {
      const body = new FormData();
      body.append("file", file);
      return api.upload<Repair>(`/repairs/${id}/photos`, body);
    },
    onSuccess: refresh,
  });
  const r = repair.data;

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={r ? `${r.code} · ${[r.equipment_type, r.brand, r.model].filter(Boolean).join(" ")}` : "Assistência externa"}
      description={r ? <StageChip status={r.status} /> : undefined}
      footer={
        r ? (
          <>
            <Button variant="ghost" onClick={() => onEdit(r)}>
              <Pencil className="size-4" />
              Editar dados
            </Button>
            <Button onClick={onClose}>Fechar</Button>
          </>
        ) : undefined
      }
    >
      {!r ? (
        <LoadingBlock />
      ) : (
        <div className="flex flex-col gap-5 text-sm">
          <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            <Info label="Cliente">{[r.customer?.name, r.location?.name].filter(Boolean).join(" · ") || "—"}</Info>
            <Info label="OS de origem">
              {r.ticket ? (
                <Link href={`/chamados/${r.ticket.id}`} className="font-mono text-brand hover:underline">
                  {r.ticket.name}
                </Link>
              ) : (
                "—"
              )}
            </Info>
            <Info label="Nº de série / patrimônio">{[r.serial_number, r.asset_tag && `Pat. ${r.asset_tag}`].filter(Boolean).join(" · ") || "—"}</Info>
            <Info label="Assistência">{[r.vendor_name, r.vendor_protocol && `prot. ${r.vendor_protocol}`, r.vendor_contact].filter(Boolean).join(" · ") || "—"}</Info>
            <Info label="Orçamento da assistência">{r.vendor_quote_value != null ? formatMoney(r.vendor_quote_value) : "—"}</Info>
            <Info label="Previsão de retorno">
              <span className={r.overdue ? "font-medium text-red-600 dark:text-red-400" : undefined}>
                {r.expected_return_date ? formatDate(r.expected_return_date) : "—"}
                {r.overdue ? " (atrasado)" : ""}
              </span>
            </Info>
            <Info label="Defeito" wide>
              {r.problem}
            </Info>
            {r.accessories ? (
              <Info label="Acompanha" wide>
                {r.accessories}
              </Info>
            ) : null}
          </div>

          {r.allowed_next.length ? (
            <div className="rounded-lg border border-line p-3">
              <p className="mb-2 text-xs font-semibold tracking-wide text-ink-muted uppercase">Próxima etapa</p>
              <div className="flex flex-wrap gap-2">
                {r.allowed_next.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setNext(next === s ? null : s)}
                    className={clsx(
                      "rounded-lg border px-3 py-1.5 text-sm",
                      next === s ? "border-brand bg-brand text-white" : "border-line text-ink hover:border-brand",
                    )}
                  >
                    {REPAIR_STATUS[s].label}
                  </button>
                ))}
              </div>
              {next ? (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {next === "vendor_quote" ? (
                    <Field label="Valor do orçamento (R$)">
                      <Input value={quoteValue} onChange={(e) => setQuoteValue(e.target.value)} inputMode="decimal" />
                    </Field>
                  ) : null}
                  {["sent_to_vendor", "vendor_quote", "in_repair"].includes(next) ? (
                    <Field label="Previsão de retorno">
                      <Input type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} />
                    </Field>
                  ) : null}
                  <Field label="Observação" className="sm:col-span-2">
                    <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
                  </Field>
                  {move.error ? (
                    <div className="sm:col-span-2">
                      <ErrorBox message={errorMessage(move.error)} />
                    </div>
                  ) : null}
                  <Button variant="primary" className="sm:col-span-2 sm:justify-self-start" loading={move.isPending} onClick={() => move.mutate()}>
                    Mover para “{REPAIR_STATUS[next].label}”
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          <div>
            <p className="mb-2 text-xs font-semibold tracking-wide text-ink-muted uppercase">Fotos</p>
            <div className="flex flex-wrap gap-2">
              {r.photos.map((p) => (
                <a key={p.id} href={absoluteApiUrl(p.url) ?? undefined} target="_blank" rel="noreferrer" title={p.caption ?? undefined}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- link assinado da API */}
                  <img src={absoluteApiUrl(p.url) ?? undefined} alt={p.caption ?? "Foto do equipamento"} className="size-20 rounded-lg border border-line object-cover" />
                </a>
              ))}
              <label className="flex size-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line text-xs text-ink-muted hover:border-brand hover:text-brand">
                <Camera className="size-5" />
                {photo.isPending ? "Enviando..." : "Adicionar"}
                <input
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) photo.mutate(file);
                  }}
                />
              </label>
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold tracking-wide text-ink-muted uppercase">Linha do tempo</p>
            <ol className="relative border-l border-line pl-4">
              {r.events.map((e) => (
                <li key={e.id} className="mb-3 last:mb-0">
                  <span className="absolute -left-1.5 mt-1 size-3 rounded-full border-2 border-surface" style={{ background: REPAIR_STATUS[e.to_status].color }} />
                  <p className="text-ink">{REPAIR_STATUS[e.to_status].label}</p>
                  <p className="text-xs text-ink-muted">
                    {formatDateTime(e.created_at)}
                    {e.actor ? ` · ${e.actor.name}` : ""}
                  </p>
                  {e.note ? <p className="text-xs text-ink-muted">“{e.note}”</p> : null}
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function Info({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <p className="text-xs text-ink-muted">{label}</p>
      <div className="text-ink">{children}</div>
    </div>
  );
}

function RepairForm({ repair, onClose }: { repair: Repair | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const customers = useCustomers();
  const [form, setForm] = useState({
    customer_id: repair?.customer?.id ?? "",
    location_id: repair?.location?.id ?? "",
    ticket_id: repair?.ticket?.id ?? "",
    equipment_type: repair?.equipment_type ?? "Impressora",
    brand: repair?.brand ?? "",
    model: repair?.model ?? "",
    serial_number: repair?.serial_number ?? "",
    asset_tag: repair?.asset_tag ?? "",
    problem: repair?.problem ?? "",
    accessories: repair?.accessories ?? "",
    vendor_name: repair?.vendor_name ?? "",
    vendor_contact: repair?.vendor_contact ?? "",
    vendor_protocol: repair?.vendor_protocol ?? "",
    expected_return_date: repair?.expected_return_date ?? "",
    notes: repair?.notes ?? "",
  });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const locations = useLocations(form.customer_id || null);
  const tickets = useQuery({
    queryKey: ["tickets", "for-repair", form.customer_id],
    queryFn: () => api.get<Page<TicketListItem>>("/tickets", { customer_id: form.customer_id, page_size: 50, order_by: "-created_at" }),
    enabled: Boolean(form.customer_id),
  });
  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...form,
        customer_id: form.customer_id || null,
        location_id: form.location_id || null,
        ticket_id: form.ticket_id || null,
        expected_return_date: form.expected_return_date || null,
        vendor_quote_value: repair?.vendor_quote_value ?? null,
      };
      return repair ? api.put(`/repairs/${repair.id}`, body) : api.post("/repairs", body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["repairs"] });
      onClose();
    },
  });

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={repair ? `Editar ${repair.code}` : "Registrar retirada de equipamento"}
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
        <Field label="Cliente">
          <Select value={form.customer_id} onChange={(e) => setForm((f) => ({ ...f, customer_id: e.target.value, location_id: "", ticket_id: "" }))}>
            <option value="">—</option>
            {(customers.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Local">
          <Select value={form.location_id} onChange={(e) => set("location_id", e.target.value)} disabled={!form.customer_id}>
            <option value="">—</option>
            {(locations.data ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="OS de origem" className="sm:col-span-2">
          <Select value={form.ticket_id} onChange={(e) => set("ticket_id", e.target.value)} disabled={!form.customer_id}>
            <option value="">Sem OS</option>
            {(tickets.data?.items ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.code} · {t.title}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Equipamento">
          <Input value={form.equipment_type} onChange={(e) => set("equipment_type", e.target.value)} />
        </Field>
        <Field label="Marca">
          <Input value={form.brand} onChange={(e) => set("brand", e.target.value)} placeholder="Ex.: HP, Brother, Ricoh" />
        </Field>
        <Field label="Modelo">
          <Input value={form.model} onChange={(e) => set("model", e.target.value)} />
        </Field>
        <Field label="Nº de série">
          <Input value={form.serial_number} onChange={(e) => set("serial_number", e.target.value)} />
        </Field>
        <Field label="Patrimônio do cliente">
          <Input value={form.asset_tag} onChange={(e) => set("asset_tag", e.target.value)} />
        </Field>
        <Field label="Previsão de retorno">
          <Input type="date" value={form.expected_return_date} onChange={(e) => set("expected_return_date", e.target.value)} />
        </Field>
        <Field label="Defeito" required className="sm:col-span-2">
          <Textarea rows={2} value={form.problem} onChange={(e) => set("problem", e.target.value)} />
        </Field>
        <Field label="Acompanha" hint="Cabos, toner, bandejas..." className="sm:col-span-2">
          <Input value={form.accessories} onChange={(e) => set("accessories", e.target.value)} />
        </Field>
        <Field label="Assistência técnica">
          <Input value={form.vendor_name} onChange={(e) => set("vendor_name", e.target.value)} />
        </Field>
        <Field label="Protocolo na assistência">
          <Input value={form.vendor_protocol} onChange={(e) => set("vendor_protocol", e.target.value)} />
        </Field>
        <Field label="Contato da assistência" className="sm:col-span-2">
          <Input value={form.vendor_contact} onChange={(e) => set("vendor_contact", e.target.value)} />
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
