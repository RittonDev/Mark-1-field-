"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Building2, ExternalLink, FileText, MapPin, Star, Ticket } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { StatusBadge } from "@/components/badges";
import { ContactList } from "@/components/ContactList";
import { CountUp } from "@/components/motion";
import { TagChips } from "@/components/TagChips";
import { Button, Card, CardHeader, ErrorBox, LoadingBlock } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { formatDate, formatDocument, initials } from "@/lib/format";
import type { Customer, Location, Page, TicketListItem } from "@/lib/types";

function Stars({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${value.toFixed(1)} de 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} className={n <= Math.round(value) ? "size-4 fill-amber-400 text-amber-400" : "size-4 text-line-strong"} />
      ))}
    </span>
  );
}

function Stat({ label, value, display }: { label: string; value?: number; display?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3 shadow-elev-1">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold tracking-tight text-ink">
        {display ?? <CountUp value={value ?? 0} />}
      </p>
    </div>
  );
}

/** Ficha completa do cliente: contatos, matriz, indicadores, lojas e histórico (inclusive o que veio do Field Control). */
export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const customer = useQuery({ queryKey: ["customer", id], queryFn: () => api.get<Customer>(`/customers/${id}`) });
  const locations = useQuery({
    queryKey: ["customer", id, "locations"],
    queryFn: () => api.get<Location[]>(`/customers/${id}/locations`),
  });
  const recent = useQuery({
    queryKey: ["tickets", "customer", id],
    queryFn: () => api.get<Page<TicketListItem>>("/tickets", { customer_id: id, page_size: 8, order_by: "-created_at" }),
  });

  if (customer.isLoading) return <LoadingBlock rows={4} />;
  if (customer.error || !customer.data) return <ErrorBox message={errorMessage(customer.error)} />;
  const c = customer.data;
  const legacy = c.legacy;
  const address = [c.address_line, c.district, [c.city, c.state].filter(Boolean).join("-"), c.zip_code].filter(Boolean).join(", ");
  // Lojas com mais OS primeiro (as mais movimentadas do cliente).
  const stores = [...(locations.data ?? [])].sort((a, b) => b.total_tickets - a.total_tickets);
  const since = legacy?.created_at ?? c.created_at;

  return (
    <div className="mx-auto max-w-7xl">
      <Link href="/clientes" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
        <ArrowLeft className="size-4" />
        Clientes
      </Link>

      <Card className="mb-5 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <span className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-line bg-white text-lg font-semibold text-brand-ink">
              {c.logo_url ? (
                // eslint-disable-next-line @next/next/no-img-element -- logo ainda no armazenamento do Field Control
                <img src={c.logo_url} alt="" className="size-full object-contain p-1.5" />
              ) : (
                initials(c.name)
              )}
            </span>
            <div className="min-w-0">
              <h1 className="text-[22px] leading-tight font-semibold tracking-[-0.015em] text-ink">{c.name}</h1>
              <p className="mt-1 text-sm text-ink-muted">
                {c.document ? `CNPJ/CPF ${formatDocument(c.document)} · ` : ""}cliente desde {formatDate(since)}
                {c.is_active ? "" : " · inativo"}
              </p>
              <TagChips tags={c.tags} max={6} className="mt-2 flex" />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href={`/chamados?customer_id=${c.id}`}>
              <Button>
                <Ticket className="size-4" />
                Ver OS do cliente
              </Button>
            </Link>
            <Link href={`/locais?customer_id=${c.id}`}>
              <Button>
                <MapPin className="size-4" />
                Lojas ({c.locations_count ?? stores.length})
              </Button>
            </Link>
          </div>
        </div>
      </Card>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="stagger grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="OS no total" value={c.total_tickets} />
            <Stat label="Em aberto agora" value={c.open_tickets} />
            <Stat label="Primeiro atendimento" display={formatDate(legacy?.service?.first_at ?? null)} />
            <Stat label="Último atendimento" display={formatDate(c.last_ticket_at ?? legacy?.service?.last_at ?? null)} />
          </div>

          {legacy?.rating && legacy.rating.average > 0 ? (
            <Card className="p-4">
              <p className="text-xs text-ink-muted">Avaliação dos atendimentos (Field Control)</p>
              <div className="mt-1 flex items-center gap-3">
                <span className="text-2xl font-semibold text-ink">{legacy.rating.average.toFixed(1)}</span>
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
              description={`${c.locations_count ?? stores.length} loja(s) cadastrada(s)`}
              actions={
                <Link href={`/locais?customer_id=${c.id}`} className="text-xs text-ink-muted hover:text-brand">
                  Ver todas
                </Link>
              }
            />
            {locations.isLoading ? (
              <LoadingBlock rows={3} />
            ) : stores.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-subtle">Nenhuma loja.</p>
            ) : (
              <ul className="divide-y divide-line">
                {stores.slice(0, 8).map((l) => (
                  <li key={l.id}>
                    <Link href={`/locais/${l.id}`} className="flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-[var(--row-hover)]">
                      <MapPin className="size-4 shrink-0 text-ink-subtle" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink">
                          {l.code ? <span className="mr-1.5 font-mono text-xs text-ink-subtle">{l.code}</span> : null}
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
            ) : (recent.data?.items ?? []).length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-subtle">Nenhuma OS.</p>
            ) : (
              <ul className="divide-y divide-line">
                {(recent.data?.items ?? []).map((t) => (
                  <li key={t.id}>
                    <Link href={`/chamados/${t.id}`} className="flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-[var(--row-hover)]">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink">
                          <span className="mr-1.5 font-mono text-xs text-ink-subtle">{t.code}</span>
                          {t.title}
                        </span>
                        <span className="block truncate text-xs text-ink-subtle">
                          {t.location?.name ?? "—"} · {formatDate(t.created_at)}
                        </span>
                      </span>
                      <StatusBadge status={t.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <aside className="flex flex-col gap-5">
          <Card className="p-5">
            <p className="mb-3 text-sm font-semibold text-ink">Contatos</p>
            <ContactList
              contacts={
                c.contacts?.length
                  ? c.contacts
                  : [
                      ...(c.email ? [{ kind: "email" as const, value: c.email, name: null, label: null, primary: true }] : []),
                      ...(c.phone ? [{ kind: "phone" as const, value: c.phone, name: null, label: null, primary: true }] : []),
                    ]
              }
            />
          </Card>

          <Card className="p-5">
            <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
              <Building2 className="size-4 text-ink-subtle" />
              Endereço da matriz
            </p>
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
              <p className="mb-2 text-sm font-semibold text-ink">Observações</p>
              <p className="text-sm whitespace-pre-wrap text-ink-muted">{c.notes}</p>
            </Card>
          ) : null}

          {legacy?.attachments?.length ? (
            <Card className="p-5">
              <p className="mb-2 text-sm font-semibold text-ink">Arquivos</p>
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
    </div>
  );
}
