"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Camera, PackageSearch, Pencil, Plus, Search, SquarePen, TriangleAlert, X } from "lucide-react";
import { useId, useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { LocationPicker } from "@/components/LocationPicker";
import { useToast } from "@/components/Toaster";
import { isPlainClick, TicketLink } from "@/components/ticket/TicketLink";
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
  Pill,
  SectionTitle,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "@/components/ui";
import { absoluteApiUrl, api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets } from "@/lib/constants";
import { formatDate, formatDateTime, formatMoney, moneyInput, parseMoney } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { useCustomers } from "@/lib/queries";
import { daysAgo, REPAIR_FLOW, REPAIR_OPEN_EXTRA, REPAIR_REASON_REQUIRED, REPAIR_STATUS, repairWhere } from "@/lib/repairs";
import type { Location, Page, Repair, RepairStatus, TicketListItem, UUID } from "@/lib/types";

type RepairSummary = { by_status: Record<RepairStatus, number>; open_total: number; overdue: number };

/** Cartões de etapa: o fluxo normal e, depois, o "sem conserto" (ainda em aberto: precisa voltar ao cliente). */
const STAGE_CARDS: RepairStatus[] = [...REPAIR_FLOW, ...REPAIR_OPEN_EXTRA];

const EDIT_BUTTON =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-brand shadow-elev-1 transition-[border-color,background-color,transform] duration-150 hover:border-brand/40 hover:bg-brand-soft active:translate-y-px";

const equipmentName = (r: Pick<Repair, "equipment_type" | "brand" | "model">) =>
  [r.equipment_type, r.brand, r.model].filter(Boolean).join(" · ");

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function StageChip({ status }: { status: RepairStatus }) {
  const s = REPAIR_STATUS[status];
  return (
    <Pill color={s.color}>
      <span className="size-1.5 rounded-full" style={{ background: s.color }} />
      {s.label}
    </Pill>
  );
}

export default function RepairsPage() {
  const { user } = useAuth();
  const [status, setStatus] = useState<RepairStatus | "">("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [openOnly, setOpenOnly] = useState(true);
  const [qInput, setQInput] = useState("");
  const q = useDebounced(qInput.trim());
  const [opened, setOpened] = useState<string | null>(null);
  const [editing, setEditing] = useState<Repair | "new" | null>(null);
  const summary = useQuery({
    queryKey: ["repairs", "summary"],
    queryFn: () => api.get<RepairSummary>("/repairs/summary"),
  });
  const list = useQuery({
    queryKey: ["repairs", status, openOnly, q],
    queryFn: () => api.get<Repair[]>("/repairs", { status: status || undefined, open_only: openOnly || undefined, q: q || undefined }),
    placeholderData: (previous) => previous,
  });
  if (user && !canManageTickets(user.role)) return <ErrorBox message="A assistência externa é controlada pela gestão." />;

  const all = list.data ?? [];
  // "Retorno atrasado" filtra aqui mesmo: a lista vem inteira (até 500 registros) e já traz o atraso calculado.
  const rows = overdueOnly ? all.filter((r) => r.overdue) : all;
  const vendors = [...new Set(all.map((r) => r.vendor_name?.trim() ?? "").filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  const overdue = summary.data?.overdue ?? 0;
  const pickStage = (s: RepairStatus) => {
    setOverdueOnly(false);
    setStatus(status === s ? "" : s);
  };

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

      <div className="mb-4 flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Filtrar por etapa">
        {STAGE_CARDS.map((s) => {
          const active = status === s;
          return (
            <button
              key={s}
              type="button"
              aria-pressed={active}
              onClick={() => pickStage(s)}
              className={clsx(
                "flex min-w-36 shrink-0 flex-col rounded-lg border px-3 py-2 text-left transition-colors",
                active ? "border-brand bg-nav-active" : "border-line bg-surface hover:border-brand/50",
              )}
            >
              {/* A cor da etapa fica no ponto; o número em tinta neutra (zero colorido parecia alerta). */}
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-ink-muted">
                <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: REPAIR_STATUS[s].color }} />
                {REPAIR_STATUS[s].label}
              </span>
              <span className="text-lg font-semibold text-ink tabular-nums">{summary.data?.by_status[s] ?? 0}</span>
            </button>
          );
        })}
        {overdue || overdueOnly ? (
          <button
            type="button"
            aria-pressed={overdueOnly}
            onClick={() => {
              setStatus("");
              setOverdueOnly((v) => !v);
            }}
            className={clsx(
              "flex min-w-36 shrink-0 flex-col rounded-lg border px-3 py-2 text-left transition-colors",
              overdueOnly
                ? "border-red-500 bg-red-50 dark:border-red-500/70 dark:bg-red-950/50"
                : "border-red-200 bg-red-50/70 hover:border-red-400 dark:border-red-900/60 dark:bg-red-950/30",
            )}
          >
            <span className="flex items-center gap-1 text-[11px] font-medium text-red-700 dark:text-red-300">
              <TriangleAlert className="size-3" /> Retorno atrasado
            </span>
            <span className="text-lg font-semibold text-red-700 tabular-nums dark:text-red-300">{overdue}</span>
          </button>
        ) : null}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted" />
          <Input
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="Nº de série, modelo, marca, patrimônio ou protocolo"
            className="pl-9"
            aria-label="Buscar equipamentos"
          />
        </div>
        <Checkbox label="Só em aberto" checked={openOnly} onChange={setOpenOnly} />
      </div>

      <Card>
        {list.isLoading ? (
          <LoadingBlock />
        ) : list.error && !list.data ? (
          <div className="p-4">
            <ErrorBox message={errorMessage(list.error)} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<PackageSearch className="size-6" />}
            title={overdueOnly ? "Nenhum retorno atrasado" : q || status ? "Nada encontrado" : "Nada por aqui"}
            description={
              overdueOnly || q || status
                ? "Mude a busca ou o filtro de etapa."
                : "Registre a retirada quando o técnico trouxer um equipamento do cliente."
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Equipamento</Th>
                <Th className="hidden md:table-cell">Cliente / loja</Th>
                <Th className="hidden lg:table-cell">Com quem está</Th>
                <Th>Etapa</Th>
                <Th className="hidden sm:table-cell">Retorno</Th>
                <Th className="edit-col">Editar</Th>
              </tr>
            </thead>
            {/* Linhas sem entrada animada; trocando o filtro, a lista anterior fica esmaecida até a nova chegar. */}
            <tbody className={clsx("transition-opacity duration-150", list.isPlaceholderData && "opacity-60")}>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="cursor-pointer transition-colors hover:bg-[var(--row-hover)]"
                  onClick={(e) => {
                    // Só o clique na própria linha (não o que vem de uma janela aberta a partir dela).
                    if (e.currentTarget.contains(e.target as Node)) setOpened(r.id);
                  }}
                >
                  <Td>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpened(r.id);
                      }}
                      className="block rounded text-left focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none"
                    >
                      <span className="block font-mono text-xs text-ink-muted">{r.code}</span>
                      <span className="block font-semibold text-ink">{equipmentName(r)}</span>
                    </button>
                    {r.serial_number ? <span className="block text-xs text-ink-muted">S/N {r.serial_number}</span> : null}
                  </Td>
                  <Td className="hidden md:table-cell">
                    <span className="block text-ink">{r.customer?.name ?? "—"}</span>
                    <span className="block text-xs text-ink-muted">{r.location?.name ?? ""}</span>
                  </Td>
                  <Td className="hidden lg:table-cell">
                    <span className="block text-ink">{repairWhere(r)}</span>
                    <span className="block text-xs text-ink-muted">
                      Retirado em {formatDate(r.created_at)} · {plural(r.days_open, "dia", "dias")} no total
                      {r.vendor_protocol ? ` · prot. ${r.vendor_protocol}` : ""}
                    </span>
                  </Td>
                  <Td>
                    <StageChip status={r.status} />
                    <span className="mt-0.5 block text-[11px] text-ink-muted">{daysAgo(r.days_in_status)}</span>
                  </Td>
                  <Td
                    className={clsx(
                      "hidden text-xs whitespace-nowrap sm:table-cell",
                      r.overdue ? "font-medium text-red-600 dark:text-red-400" : "text-ink-muted",
                    )}
                  >
                    {r.expected_return_date ? formatDate(r.expected_return_date) : "—"}
                    {r.overdue ? " · atrasado" : ""}
                  </Td>
                  <Td className="edit-col">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing(r);
                      }}
                      className={EDIT_BUTTON}
                      aria-label={`Editar ${r.code}`}
                      title={`Editar ${r.code}`}
                    >
                      <SquarePen className="size-4" />
                    </button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {opened ? <RepairDetail id={opened} onEdit={(r) => setEditing(r)} onClose={() => setOpened(null)} /> : null}
      {editing ? <RepairForm repair={editing === "new" ? null : editing} vendors={vendors} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

/** O que a API recusa, avisado antes de enviar (o iPhone grava HEIC, que não é aceito). */
function photoProblem(file: File): string | null {
  const okType = file.type ? PHOTO_TYPES.includes(file.type) : /\.(jpe?g|png|webp)$/i.test(file.name);
  if (!okType) return "Envie uma foto JPG, PNG ou WebP. A foto do iPhone (HEIC) precisa ser convertida antes.";
  if (file.size > MAX_PHOTO_BYTES) return "Foto maior que 5 MB: tire outra com menos resolução ou reduza o arquivo.";
  return null;
}

/** Valor em reais que o cadastro não aceita: negativo, com mais de 2 casas ou acima de 12 dígitos. */
function invalidMoney(value: number): boolean {
  return !Number.isFinite(value) || value < 0 || value >= 1e10 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-6;
}

/** Etapas em que se informa (ou corrige) a previsão de volta do equipamento. */
const RETURN_DATE_STAGES: RepairStatus[] = ["sent_to_vendor", "vendor_quote", "in_repair"];

function RepairDetail({ id, onEdit, onClose }: { id: string; onEdit: (r: Repair) => void; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const repair = useQuery({ queryKey: ["repairs", "detail", id], queryFn: () => api.get<Repair>(`/repairs/${id}`) });
  const [next, setNext] = useState<RepairStatus | null>(null);
  const [note, setNote] = useState("");
  const [quoteValue, setQuoteValue] = useState("");
  const [returnDate, setReturnDate] = useState("");
  const [photoError, setPhotoError] = useState<string | null>(null);
  const refresh = (r: Repair) => {
    queryClient.setQueryData(["repairs", "detail", id], r);
    void queryClient.invalidateQueries({ queryKey: ["repairs"] });
  };
  const quote = next === "vendor_quote" ? parseMoney(quoteValue) : null;
  const quoteError = quote !== null && invalidMoney(quote) ? "Valor inválido. Ex.: 350,00" : null;
  const reasonRequired = next !== null && REPAIR_REASON_REQUIRED.includes(next);
  const reasonMissing = reasonRequired && note.trim().length < 3;
  const move = useMutation({
    mutationFn: (to: RepairStatus) =>
      api.post<Repair>(`/repairs/${id}/status`, {
        to_status: to,
        note: note.trim() || null,
        vendor_quote_value: quote === null ? null : quote.toFixed(2),
        expected_return_date: RETURN_DATE_STAGES.includes(to) ? returnDate || null : null,
      }),
    onSuccess: (r) => {
      refresh(r);
      toast({ title: `${r.code}: ${REPAIR_STATUS[r.status].label}`, tone: "success" });
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
    onSuccess: (r) => {
      refresh(r);
      toast({ title: "Foto adicionada", tone: "success" });
    },
  });
  const r = repair.data;
  const photoMessage = photoError ?? (photo.error ? errorMessage(photo.error) : null);

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={r ? `${r.code} · ${equipmentName(r)}` : "Assistência externa"}
      description={r ? <StageChip status={r.status} /> : undefined}
      footer={
        <>
          {r ? (
            <Button variant="ghost" onClick={() => onEdit(r)}>
              <Pencil className="size-4" />
              Editar dados
            </Button>
          ) : null}
          <Button onClick={onClose}>Fechar</Button>
        </>
      }
    >
      {repair.isLoading ? (
        <LoadingBlock />
      ) : !r ? (
        <ErrorBox message={errorMessage(repair.error)} />
      ) : (
        <div className="flex flex-col gap-5 text-sm">
          <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            <Info label="Cliente / loja">{[r.customer?.name, r.location?.name].filter(Boolean).join(" · ") || "—"}</Info>
            <Info label="OS de origem">
              {r.ticket ? (
                // A OS abre no painel lateral; esta janela fecha antes, para não ficar por cima dele.
                <span
                  onClickCapture={(e) => {
                    if (isPlainClick(e)) onClose();
                  }}
                >
                  <TicketLink ticketId={r.ticket.id} className="font-mono text-brand hover:underline">
                    {r.ticket.name}
                  </TicketLink>
                </span>
              ) : (
                "—"
              )}
            </Info>
            <Info label="Com quem está">{repairWhere(r)}</Info>
            <Info label="Retirada">
              {formatDate(r.created_at)} · {plural(r.days_open, "dia", "dias")} no total
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
              <span className="whitespace-pre-wrap">{r.problem}</span>
            </Info>
            {r.accessories ? (
              <Info label="Acompanha" wide>
                {r.accessories}
              </Info>
            ) : null}
            {r.notes ? (
              <Info label="Observações internas" wide>
                <span className="whitespace-pre-wrap">{r.notes}</span>
              </Info>
            ) : null}
          </div>

          {r.allowed_next.length ? (
            <div className="rounded-lg border border-line p-3">
              <p id={`next-${id}`} className="mb-2 text-xs font-bold tracking-wide text-ink-muted uppercase">
                Próxima etapa
              </p>
              <div className="flex flex-wrap gap-2" role="group" aria-labelledby={`next-${id}`}>
                {r.allowed_next.map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={next === s}
                    onClick={() => setNext(next === s ? null : s)}
                    className={clsx(
                      "rounded-lg border px-3 py-1.5 text-sm transition-colors",
                      next === s ? "border-brand bg-brand text-white dark:bg-brand-strong" : "border-line text-ink hover:border-brand",
                    )}
                  >
                    {REPAIR_STATUS[s].label}
                  </button>
                ))}
              </div>
              {next ? (
                <form
                  className="mt-3 grid gap-3 sm:grid-cols-2"
                  noValidate
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!reasonMissing && !quoteError) move.mutate(next);
                  }}
                >
                  {next === "vendor_quote" ? (
                    <Field label="Valor do orçamento (R$)">
                      <Input
                        value={quoteValue}
                        onChange={(e) => setQuoteValue(e.target.value)}
                        onBlur={() => {
                          if (quote !== null && !quoteError) setQuoteValue(moneyInput(quote));
                        }}
                        inputMode="decimal"
                        placeholder="0,00"
                        maxLength={20}
                        aria-invalid={quoteError ? true : undefined}
                      />
                      {quoteError ? <span className="text-xs font-medium text-red-600 dark:text-red-400">{quoteError}</span> : null}
                    </Field>
                  ) : null}
                  {RETURN_DATE_STAGES.includes(next) ? (
                    <Field label="Previsão de retorno">
                      <Input type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} />
                    </Field>
                  ) : null}
                  <Field
                    label={reasonRequired ? "Motivo" : "Observação"}
                    required={reasonRequired}
                    hint={reasonRequired ? "Obrigatório para cancelar ou marcar sem conserto." : undefined}
                    className="sm:col-span-2"
                  >
                    <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
                  </Field>
                  {move.error ? (
                    <div className="sm:col-span-2">
                      <ErrorBox message={errorMessage(move.error)} />
                    </div>
                  ) : null}
                  <Button
                    type="submit"
                    variant="primary"
                    className="sm:col-span-2 sm:justify-self-start"
                    loading={move.isPending}
                    disabled={reasonMissing || Boolean(quoteError)}
                  >
                    Mover para “{REPAIR_STATUS[next].label}”
                  </Button>
                </form>
              ) : null}
            </div>
          ) : null}

          <div>
            <p className="mb-2 text-xs font-bold tracking-wide text-ink-muted uppercase">Fotos</p>
            <div className="flex flex-wrap gap-2">
              {r.photos.map((p) => (
                <a key={p.id} href={absoluteApiUrl(p.url) ?? undefined} target="_blank" rel="noreferrer" title={p.caption ?? undefined}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- link assinado da API */}
                  <img src={absoluteApiUrl(p.url) ?? undefined} alt={p.caption ?? "Foto do equipamento"} className="size-20 rounded-lg border border-line object-cover" />
                </a>
              ))}
              <label className="flex size-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line text-xs text-ink-muted focus-within:ring-2 focus-within:ring-brand/45 hover:border-brand hover:text-brand">
                {photo.isPending ? <Spinner className="size-5" /> : <Camera className="size-5" />}
                {photo.isPending ? "Enviando..." : "Adicionar"}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="sr-only"
                  disabled={photo.isPending}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    const problem = photoProblem(file);
                    setPhotoError(problem);
                    if (!problem) photo.mutate(file);
                  }}
                />
              </label>
            </div>
            {photoMessage ? (
              <div className="mt-2">
                <ErrorBox message={photoMessage} />
              </div>
            ) : null}
          </div>

          <div>
            <p className="mb-2 text-xs font-bold tracking-wide text-ink-muted uppercase">Linha do tempo</p>
            <ol className="relative border-l border-line pl-4">
              {r.events.map((e) => (
                <li key={e.id} className="mb-3 last:mb-0">
                  <span className="absolute -left-1.5 mt-1 size-3 rounded-full border-2 border-surface" style={{ background: REPAIR_STATUS[e.to_status].color }} />
                  <p className="font-semibold text-ink">{REPAIR_STATUS[e.to_status].label}</p>
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
      <p className="text-xs font-semibold text-ink/80">{label}</p>
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
