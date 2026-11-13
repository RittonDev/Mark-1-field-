"use client";

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, ExternalLink, FileText, MapPin, Pencil, Plus, Star, Ticket } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { StatusBadge } from "@/components/badges";
import { ContactList } from "@/components/ContactList";
import { documentKind, LocationDialog } from "@/components/LocationDialog";
import { CountUp } from "@/components/motion";
import { TagChips } from "@/components/TagChips";
import { Button, buttonClassName, Card, CardHeader, ErrorBox, LoadingBlock, SectionTitle } from "@/components/ui";
import { TicketLink } from "@/components/ticket/TicketLink";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets } from "@/lib/constants";
import { formatDate, formatDocument, initials } from "@/lib/format";
import type { Customer, Location, Page, TicketListItem } from "@/lib/types";
import { CustomerDialog, customerContacts } from "../CustomerDialog";

/** Estrelas da avaliação: só desenho (a nota vem escrita ao lado). */
function Stars({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} className={n <= Math.round(value) ? "size-4 fill-amber-400 text-amber-400" : "size-4 text-line-strong"} />
      ))}
    </span>
  );
}

/** Indicador da ficha (o mesmo das fichas de loja e de projeto). */
function Stat({ label, value, display, hint }: { label: string; value?: number; display?: string; hint?: string }) {
  return (
    <Card className="px-4 py-3">
      <p className="text-xs font-semibold text-ink/80">{label}</p>
      <p className={clsx("mt-1 font-semibold tracking-tight text-ink tabular-nums", display === undefined ? "text-xl" : "text-lg")}>
        {display ?? <CountUp value={value ?? 0} duration={300} />}
      </p>
      {hint ? <p className="mt-0.5 text-xs text-ink-muted">{hint}</p> : null}
    </Card>
  );
}

/** Logo do cliente (ainda no armazenamento do Field Control); se não carregar, as iniciais. */
function CustomerLogo({ customer }: { customer: Customer }) {
  const [failed, setFailed] = useState(false);
  const url = customer.logo_url && !failed ? customer.logo_url : null;
  return (
    <span
      className={clsx(
        "flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-line text-lg font-semibold text-brand-ink",
        url ? "bg-white" : "bg-brand-soft",
      )}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- logo em endereço externo (Field Control)
        <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="size-full object-contain p-1.5" />
      ) : (
        initials(customer.name)
      )}
    </span>
  );
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("pt-BR")} ${n === 1 ? one : many}`;

/** Ficha completa do cliente: contatos, matriz, indicadores, lojas e histórico (inclusive o que veio do Field Control). */
export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const canEdit = canManageTickets(user?.role);
  const [editing, setEditing] = useState(false);
  const [newStore, setNewStore] = useState(false);
  const customer = useQuery({ queryKey: ["customer", id], queryFn: () => api.get<Customer>(`/customers/${id}`) });
  const locations = useQuery({
    queryKey: ["customer", id, "locations"],
    queryFn: () => api.get<Location[]>(`/customers/${id}/locations`),
  });
  const recent = useQuery({
    queryKey: ["tickets", "customer", id],
    queryFn: () => api.get<Page<TicketListItem>>("/tickets", { customer_id: id, page_size: 8, order_by: "-created_at" }),
  });

  const back = (
    <Link href="/clientes" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
      <ArrowLeft className="size-4" />
      Clientes
    </Link>
  );
  if (customer.isLoading) return <LoadingBlock rows={4} />;
  if (customer.error || !customer.data) {
    return (
      <div className="mx-auto max-w-7xl">
        {back}
        <ErrorBox message={errorMessage(customer.error)} onRetry={() => void customer.refetch()} />
      </div>
    );
  }
  const c = customer.data;
  const legacy = c.legacy;
  const address = [c.address_line, c.district, [c.city, c.state].filter(Boolean).join("-"), c.zip_code].filter(Boolean).join(", ");
  // Lojas com mais OS primeiro (as mais movimentadas do cliente).
  const stores = [...(locations.data ?? [])].sort((a, b) => b.total_tickets - a.total_tickets);
  const storeCount = c.locations_count ?? stores.length;
  const since = legacy?.created_at ?? c.created_at;

  return (
    <div className="mx-auto max-w-7xl">
      {back}

      <Card className="mb-5 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <CustomerLogo customer={c} />
            <div className="min-w-0">
              <h1 className="text-[22px] leading-tight font-bold tracking-[-0.02em] text-ink">{c.name}</h1>
              <span aria-hidden className="brand-gradient mt-2 block h-[3px] w-10 rounded-full" />
              <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-ink-muted">
                {c.document ? (
                  <span>
                    {documentKind(c.document)} {formatDocument(c.document)} ·
                  </span>
                ) : null}
                <span>cliente desde {formatDate(since)}</span>
                {c.is_active ? null : (
                  <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-ink-muted ring-1 ring-line ring-inset">
                    Inativo
                  </span>
                )}
              </p>
              <TagChips tags={c.tags} max={6} className="mt-2 flex" />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href={`/chamados?customer_id=${c.id}`} className={buttonClassName()}>
              <Ticket className="size-4" />
              Ver OS do cliente
            </Link>
            <Link href={`/locais?customer_id=${c.id}`} className={buttonClassName()}>
              <MapPin className="size-4" />
              Lojas ({storeCount.toLocaleString("pt-BR")})
            </Link>
            {canEdit ? (
              <Button onClick={() => setEditing(true)}>
                <Pencil className="size-4" />
                Editar
              </Button>
            ) : null}
            {/* A Nova OS vem com o cliente escolhido (a loja se busca entre as dele). */}
            {canEdit && c.is_active ? (
              <Link href={`/chamados/novo?customer_id=${c.id}`} className={buttonClassName("primary")}>
                <Plus className="size-4" />
                Nova OS
              </Link>
            ) : null}
          </div>
        </div>
      </Card>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="stagger grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="OS no total" value={c.total_tickets} />
            <Stat label="Em aberto agora" value={c.open_tickets} />
            <Stat label="Primeira visita" display={formatDate(legacy?.service?.first_at ?? null)} hint="registrada no Field Control" />
            <Stat label="Última OS aberta" display={formatDate(c.last_ticket_at)} />
          </div>

          {legacy?.rating && legacy.rating.average > 0 ? (
            <Card className="p-4">
              <p className="text-xs font-semibold text-ink/80">Avaliação dos atendimentos (Field Control)</p>
              <div className="mt-1 flex items-center gap-3">
                <span className="text-2xl font-semibold text-ink">
                  {legacy.rating.average.toFixed(1).replace(".", ",")}
                  <span className="sr-only"> de 5</span>
                </span>
                <Stars value={legacy.rating.average} />
              </div>
              {legacy.rating.last_comment ? (
                <p className="mt-2 text-sm text-ink-muted italic">“{legacy.rating.last_comment}”</p>
              ) : null}
            </Card>
          ) : null}

          <Card className="overflow-hidden">
            <CardHeader
              title="Lojas"
              description={`${plural(storeCount, "loja cadastrada", "lojas cadastradas")} · as com mais OS primeiro`}
              actions={
                <>
                  {canEdit ? (
                    <Button size="sm" variant="ghost" onClick={() => setNewStore(true)}>
                      <Plus className="size-3.5" />
                      Nova loja
                    </Button>
                  ) : null}
                  <Link href={`/locais?customer_id=${c.id}`} className="text-xs text-ink-muted hover:text-brand">
                    Ver todas
                  </Link>
                </>
              }
            />
            {locations.isLoading ? (
              <LoadingBlock rows={3} />
            ) : locations.error ? (
              <div className="p-4">
                <ErrorBox message={errorMessage(locations.error)} onRetry={() => void locations.refetch()} />
              </div>
            ) : stores.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-subtle">Nenhuma loja cadastrada.</p>
            ) : (
              <ul className="divide-y divide-line">
                {stores.slice(0, 8).map((l) => (
                  <li key={l.id}>
                    <Link href={`/locais/${l.id}`} className="flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-[var(--row-hover)]">
                      <MapPin className="size-4 shrink-0 text-ink-subtle" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-ink">
                          {l.code ? <span className="mr-1.5 font-mono text-xs font-normal text-ink-subtle">{l.code}</span> : null}
                          {l.name}
                        </span>
                        <span className="block truncate text-xs text-ink-subtle">{[l.city, l.state].filter(Boolean).join("-")}</span>
                      </span>
                      <span className="text-xs text-ink-muted tabular-nums">{l.total_tickets} OS</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="OS recentes" />
            {recent.isLoading ? (
              <LoadingBlock rows={3} />
            ) : recent.error ? (
              <div className="p-4">
                <ErrorBox message={errorMessage(recent.error)} onRetry={() => void recent.refetch()} />
              </div>
            ) : (recent.data?.items ?? []).length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-subtle">Nenhuma OS deste cliente.</p>
            ) : (
              <ul className="divide-y divide-line">
                {(recent.data?.items ?? []).map((t) => (
                  <li key={t.id}>
                    <TicketLink ticketId={t.id} className="flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-[var(--row-hover)]">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-ink">
                          <span className="mr-1.5 font-mono text-xs font-normal text-ink-subtle">{t.code}</span>
                          {t.title}
                        </span>
                        <span className="block truncate text-xs text-ink-subtle">
                          {t.location?.name ?? "—"} · {formatDate(t.created_at)}
                        </span>
                      </span>
                      <StatusBadge status={t.status} />
                    </TicketLink>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <aside className="flex flex-col gap-5">
          <Card className="p-5">
            <SectionTitle as="h2" className="mb-3">Contatos</SectionTitle>
            <ContactList contacts={customerContacts(c)} />
          </Card>

          <Card className="p-5">
            <SectionTitle as="h2" className="mb-2">Endereço da matriz</SectionTitle>
            {address ? (
              <>
                <p className="text-sm text-ink-muted">{address}</p>
                <a
                  href={
                    c.latitude != null && c.longitude != null
                      ? `https://www.google.com/maps/search/?api=1&query=${c.latitude},${c.longitude}`
                      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
                  }
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-1 text-xs text-brand hover:underline"
                >
                  Abrir no mapa
                  <ExternalLink className="size-3" />
                </a>
              </>
            ) : (
              <p className="text-sm text-ink-subtle">Sem endereço cadastrado.</p>
            )}
          </Card>

          {c.notes ? (
            <Card className="p-5">
              <SectionTitle as="h2" className="mb-2">Observações</SectionTitle>
              <p className="text-sm whitespace-pre-wrap text-ink-muted">{c.notes}</p>
            </Card>
          ) : null}

          {legacy?.attachments?.length ? (
            <Card className="p-5">
              <SectionTitle as="h2" className="mb-2">Arquivos</SectionTitle>
              <ul className="flex flex-col gap-1">
                {legacy.attachments.map((a, i) => (
                  <li key={i}>
                    <a href={a.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-brand hover:underline">
                      <FileText className="size-4" />
                      {a.title ?? "Arquivo"}
                    </a>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {legacy ? (
            <p className="px-1 text-xs text-ink-subtle">
              Importado do Field Control{legacy.id ? ` · ID ${legacy.id}` : ""}
              {legacy.created_at ? ` · cadastrado lá em ${formatDate(legacy.created_at)}` : ""}
            </p>
          ) : null}
        </aside>
      </div>

      {editing ? <CustomerDialog customer={c} onClose={() => setEditing(false)} /> : null}
      {newStore ? <LocationDialog location={null} customerId={c.id} onClose={() => setNewStore(false)} /> : null}
    </div>
  );
}
