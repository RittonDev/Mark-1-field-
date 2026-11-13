"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Eye, FileText, Pencil, Plus, SquarePen } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { QUOTE_EDITABLE, QuoteViewer } from "@/components/quotes/QuoteViewer";
import { QuoteEditor, type QuoteTicketRef, ShareDialog } from "@/components/ticket/QuotesCard";
import { useToast } from "@/components/Toaster";
import { Button, Card, Checkbox, Dialog, EmptyState, ErrorBox, Field, Input, LoadingBlock, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets } from "@/lib/constants";
import { formatDate, formatMoney } from "@/lib/format";
import { QUOTE_KIND, QUOTE_STATUS } from "@/lib/quotes";
import type { Quote, QuoteCatalogItem, QuoteItemKind, QuoteListRow, QuoteStatus } from "@/lib/types";

type Tab = "quotes" | "catalog";

export default function QuotesPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>("quotes");
  if (user && !canManageTickets(user.role)) return <ErrorBox message="Orçamentos são da gestão." />;
  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title="Orçamentos" description="Orçamentos enviados aos clientes a partir das OS, e os itens com preço para montá-los." />
      <div className="mb-4 flex gap-1 border-b border-line" role="tablist">
        {(
          [
            ["quotes", "Orçamentos"],
            ["catalog", "Itens e preços"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={clsx(
              "relative px-3 pt-1 pb-2.5 text-sm",
              tab === key ? "font-semibold text-ink" : "font-medium text-ink-muted hover:text-ink",
            )}
          >
            {label}
            {tab === key ? <span className="brand-gradient absolute inset-x-2 -bottom-px h-0.5 rounded-full" /> : null}
          </button>
        ))}
      </div>
      {tab === "quotes" ? <QuoteList /> : <Catalog />}
    </div>
  );
}

/** Botão quadrado das ações da linha (mesmo padrão do lápis das listas de OS). */
function RowAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-brand shadow-elev-1 transition-[border-color,background-color,transform] duration-150 hover:border-brand/40 hover:bg-brand-soft active:translate-y-px"
    >
      {children}
    </button>
  );
}

const ticketOf = (q: QuoteListRow): QuoteTicketRef => ({
  id: q.ticket_id,
  code: q.ticket_code,
  title: q.title,
  customer: q.customer ? { name: q.customer } : null,
});

function QuoteList() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [status, setStatus] = useState<QuoteStatus | "">("");
  const [opened, setOpened] = useState<QuoteListRow | null>(null);
  const [editing, setEditing] = useState<QuoteListRow | null>(null);
  const [sharing, setSharing] = useState<QuoteListRow | null>(null);
  const quotes = useQuery({
    queryKey: ["quotes", status],
    queryFn: () => api.get<QuoteListRow[]>("/quotes", { status: status || undefined }),
  });
  const refresh = (ticketId: string) => {
    queryClient.invalidateQueries({ queryKey: ["quotes"] });
    queryClient.invalidateQueries({ queryKey: ["ticket", ticketId, "quotes"] });
  };
  // Enviar (ou gerar o link de um enviado sem link) e já abrir o compartilhamento.
  const send = useMutation({
    mutationFn: (q: QuoteListRow) => api.post<Quote>(`/quotes/${q.id}/send`),
    onSuccess: (saved, q) => {
      refresh(q.ticket_id);
      setOpened(null);
      setSharing({ ...q, ...saved });
    },
    onError: (e) => toast({ title: "Não foi possível enviar", description: errorMessage(e), tone: "error" }),
  });
  const totals = useMemo(() => {
    const rows = quotes.data ?? [];
    const sum = (s: QuoteStatus) => rows.filter((r) => r.status === s).reduce((t, r) => t + r.total, 0);
    return { sent: sum("sent"), approved: sum("approved") };
  }, [quotes.data]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-full sm:w-56">
          <Select value={status} onChange={(e) => setStatus(e.target.value as QuoteStatus | "")} aria-label="Situação">
            <option value="">Todas as situações</option>
            {Object.entries(QUOTE_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
        </div>
        <span className="text-sm text-ink-muted">
          Aguardando cliente: <strong className="text-ink tabular-nums">{formatMoney(totals.sent)}</strong>
          {" · "}Aprovados: <strong className="text-emerald-700 tabular-nums dark:text-emerald-300">{formatMoney(totals.approved)}</strong>
        </span>
      </div>
      <Card>
        {quotes.isLoading ? (
          <LoadingBlock />
        ) : (quotes.data ?? []).length === 0 ? (
          <EmptyState icon={<FileText className="size-6" />} title="Nenhum orçamento" description="Crie orçamentos dentro da OS, no quadro Orçamentos." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Orçamento</Th>
                <Th>OS / cliente</Th>
                <Th className="text-right">Total</Th>
                <Th className="hidden xl:table-cell">Validade</Th>
                <Th>Situação</Th>
                <Th className="edit-col">Ações</Th>
              </tr>
            </thead>
            <tbody>
              {(quotes.data ?? []).map((q) => (
                <tr key={q.id}>
                  <Td>
                    <button type="button" onClick={() => setOpened(q)} className="block text-left">
                      <span className="block font-mono text-xs text-ink-muted">{q.code}</span>
                      <span className="block max-w-[15rem] truncate font-semibold text-ink hover:text-brand xl:max-w-72">{q.title}</span>
                    </button>
                  </Td>
                  <Td>
                    <Link href={`/chamados/${q.ticket_id}`} className="font-mono text-xs text-brand hover:underline">
                      {q.ticket_code}
                    </Link>
                    <span className="block max-w-44 truncate text-xs text-ink-muted xl:max-w-56">{q.customer ?? "—"}</span>
                  </Td>
                  <Td className="text-right font-medium tabular-nums">{formatMoney(q.total)}</Td>
                  <Td className="hidden text-xs text-ink-muted xl:table-cell">{q.valid_until ? formatDate(q.valid_until) : "—"}</Td>
                  <Td>
                    <span className={clsx("rounded-full px-2 py-0.5 text-[11px] font-medium", QUOTE_STATUS[q.status].className)}>
                      {QUOTE_STATUS[q.status].label}
                    </span>
                  </Td>
                  <Td className="edit-col">
                    <span className="inline-flex items-center gap-1.5">
                      <RowAction label={`Ver o orçamento ${q.code}`} onClick={() => setOpened(q)}>
                        <Eye className="size-4" />
                      </RowAction>
                      {QUOTE_EDITABLE.includes(q.status) ? (
                        <RowAction label={`Editar o orçamento ${q.code}`} onClick={() => setEditing(q)}>
                          <SquarePen className="size-4" />
                        </RowAction>
                      ) : (
                        <span className="size-8" aria-hidden />
                      )}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {opened ? (
        <QuoteViewer
          quote={opened}
          ticket={{ id: opened.ticket_id, code: opened.ticket_code, customer: opened.customer }}
          onClose={() => setOpened(null)}
          onEdit={() => {
            setOpened(null);
            setEditing(opened);
          }}
          onSend={() => send.mutate(opened)}
          sending={send.isPending}
          onShare={() => {
            setOpened(null);
            setSharing(opened);
          }}
        />
      ) : null}
      {editing ? (
        <QuoteEditor
          ticket={ticketOf(editing)}
          quote={editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            refresh(editing.ticket_id);
            toast({
              title: `${saved.code} salvo`,
              description: editing.status === "sent" ? "Envie de novo para o cliente responder a versão nova." : undefined,
              tone: "success",
            });
            // Volta para a visualização: dali já dá para enviar ao cliente.
            setOpened({ ...editing, ...saved });
          }}
        />
      ) : null}
      {sharing ? (
        <ShareDialog
          ticket={{ code: sharing.ticket_code }}
          quote={sharing}
          onClose={() => setSharing(null)}
          onRotated={() => refresh(sharing.ticket_id)}
        />
      ) : null}
    </>
  );
}

function Catalog() {
  const [editing, setEditing] = useState<QuoteCatalogItem | "new" | null>(null);
  const items = useQuery({ queryKey: ["quote-items"], queryFn: () => api.get<QuoteCatalogItem[]>("/quote-items") });
  return (
    <Card>
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span className="text-sm text-ink-muted">Material e serviços com preço de referência (dá para mudar no orçamento)</span>
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus className="size-4" />
          Novo item
        </Button>
      </div>
      {items.isLoading ? (
        <LoadingBlock />
      ) : (items.data ?? []).length === 0 ? (
        <EmptyState title="Nenhum item" description="Ex.: Velcro 3 m, Conector RJ45, Hora técnica." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Item</Th>
              <Th>Tipo</Th>
              <Th>Unidade</Th>
              <Th className="text-right">Preço</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {(items.data ?? []).map((i) => (
              <tr key={i.id} className={i.is_active ? undefined : "opacity-60"}>
                <Td className="font-semibold">{i.name}</Td>
                <Td className="text-ink-muted">{QUOTE_KIND[i.kind ?? "product"].label}</Td>
                <Td>{i.unit}</Td>
                <Td className="text-right tabular-nums">{formatMoney(i.price)}</Td>
                <Td className="text-right">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(i)}>
                    <Pencil className="size-3.5" />
                    Editar
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {editing ? <ItemDialog item={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}

function ItemDialog({ item, onClose }: { item: QuoteCatalogItem | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(item?.name ?? "");
  const [unit, setUnit] = useState(item?.unit ?? "un");
  const [kind, setKind] = useState<QuoteItemKind>(item?.kind ?? "product");
  const [price, setPrice] = useState(item ? item.price.toFixed(2).replace(".", ",") : "");
  const [active, setActive] = useState(item?.is_active ?? true);
  const save = useMutation({
    mutationFn: () => {
      const body = { name, kind, unit, price: price.replace(",", ".") || "0", is_active: active };
      return item ? api.put(`/quote-items/${item.id}`, body) : api.post("/quote-items", body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["quote-items"] });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={item ? "Editar item" : "Novo item"}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Nome" required className="sm:col-span-3">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Velcro 3 m" />
        </Field>
        <Field label="Tipo">
          <Select value={kind} onChange={(e) => setKind(e.target.value as QuoteItemKind)}>
            {(Object.keys(QUOTE_KIND) as QuoteItemKind[]).map((k) => (
              <option key={k} value={k}>
                {QUOTE_KIND[k].label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Unidade (medida)">
          <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="un, m, rolo, h" />
        </Field>
        <Field label="Preço (R$)">
          <Input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="0,00" />
        </Field>
        <div className="sm:col-span-3">
          <Checkbox label="Ativo" checked={active} onChange={setActive} />
        </div>
        {save.error ? (
          <div className="sm:col-span-3">
            <ErrorBox message={errorMessage(save.error)} />
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
