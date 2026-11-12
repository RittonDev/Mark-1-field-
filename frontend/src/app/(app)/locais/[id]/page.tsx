"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, HardHat, MapPin, Pencil, Ticket, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { StatusBadge } from "@/components/badges";
import { ContactList } from "@/components/ContactList";
import { LocationDialog } from "@/components/LocationDialog";
import { CountUp } from "@/components/motion";
import { Button, Card, CardHeader, ErrorBox, LoadingBlock } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { formatDate, formatDocument, initials } from "@/lib/format";
import type { Location, NearbyResult, Page, TicketListItem } from "@/lib/types";

/** Ficha da loja: endereço completo, todos os contatos, histórico de OS e quem já atendeu. */
export default function LocationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [editing, setEditing] = useState(false);
  const loc = useQuery({ queryKey: ["location", id], queryFn: () => api.get<Location>(`/locations/${id}`) });
  const recent = useQuery({
    queryKey: ["tickets", "location", id],
    queryFn: () => api.get<Page<TicketListItem>>("/tickets", { location_id: id, page_size: 10, order_by: "-created_at" }),
  });
  // Quem já atendeu esta loja (e quem está mais perto), pelo mesmo cálculo da busca por proximidade.
  const nearby = useQuery({
    queryKey: ["technicians", "nearby", { location_id: id }, true],
    queryFn: () => api.get<NearbyResult>("/technicians/nearby", { location_id: id, include_inactive: true, limit: 8 }),
    retry: false,
  });

  if (loc.isLoading) return <LoadingBlock rows={4} />;
  if (loc.error || !loc.data) return <ErrorBox message={errorMessage(loc.error)} />;
  const l = loc.data;
  const address = [l.address_line, l.district, [l.city, l.state].filter(Boolean).join("-"), l.zip_code].filter(Boolean).join(", ");
  const hasCoords = l.latitude != null && l.longitude != null;
  const mapUrl = hasCoords
    ? `https://www.google.com/maps/search/?api=1&query=${l.latitude},${l.longitude}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address || l.name)}`;
  const contacts =
    l.contacts?.length
      ? l.contacts
      : l.contact_phone
        ? [{ kind: "phone" as const, value: l.contact_phone, name: l.contact_name, label: null, primary: true }]
        : [];
  const attended = (nearby.data?.technicians ?? []).filter((t) => t.visits_at_location > 0);

  return (
    <div className="mx-auto max-w-7xl">
      <Link href="/locais" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
        <ArrowLeft className="size-4" />
        Locais
      </Link>

      <Card className="mb-5 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-medium text-ink-subtle">
              <Link href={`/clientes/${l.customer_id}`} className="hover:text-brand hover:underline">
                {l.customer.name}
              </Link>
            </p>
            <h1 className="mt-1 text-[22px] leading-tight font-semibold tracking-[-0.015em] text-ink">
              {l.code ? <span className="mr-2 rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-base text-ink-muted">{l.code}</span> : null}
              {l.name}
            </h1>
            <p className="mt-1 text-sm text-ink-muted">
              {l.document ? `CNPJ ${formatDocument(l.document)} · ` : ""}
              {[l.city, l.state].filter(Boolean).join("-")}
              {l.is_active ? "" : " · inativa"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href={`/chamados?location_id=${l.id}`}>
              <Button>
                <Ticket className="size-4" />
                OS desta loja ({l.total_tickets})
              </Button>
            </Link>
            <Button onClick={() => setEditing(true)}>
              <Pencil className="size-4" />
              Editar
            </Button>
          </div>
        </div>
      </Card>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="stagger grid grid-cols-3 gap-3">
            {[
              { label: "OS no total", value: l.total_tickets },
              { label: "Em aberto", value: l.open_tickets },
            ].map((s) => (
              <div key={s.label} className="rounded-xl border border-line bg-surface px-4 py-3 shadow-elev-1">
                <p className="text-xs text-ink-muted">{s.label}</p>
                <p className="mt-1 text-xl font-semibold text-ink">
                  <CountUp value={s.value} />
                </p>
              </div>
            ))}
            <div className="rounded-xl border border-line bg-surface px-4 py-3 shadow-elev-1">
              <p className="text-xs text-ink-muted">Última OS</p>
              <p className="mt-1 text-xl font-semibold text-ink">{formatDate(l.last_ticket_at)}</p>
            </div>
          </div>

          <Card className="overflow-hidden">
            <CardHeader
              title="Técnicos que já atenderam esta loja"
              description="Pelo histórico de OS; quem tem mais visitas aparece primeiro."
              actions={
                <Link href="/tecnicos" className="text-xs text-ink-muted hover:text-brand">
                  Buscar mais próximos
                </Link>
              }
            />
            {nearby.isLoading ? (
              <LoadingBlock rows={2} />
            ) : nearby.error ? (
              <p className="px-5 py-4 text-sm text-ink-subtle">{errorMessage(nearby.error)}</p>
            ) : attended.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-subtle">Nenhum técnico com visita registrada nesta loja.</p>
            ) : (
              <ul className="divide-y divide-line">
                {attended
                  .sort((a, b) => b.visits_at_location - a.visits_at_location)
                  .map((t) => (
                    <li key={t.id} className="flex items-center gap-3 px-5 py-2.5">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[11px] font-semibold text-brand-ink">
                        {initials(t.name)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink">{t.name}</span>
                        <span className="block truncate text-xs text-ink-subtle">
                          {t.base_city ? `${t.base_city}-${t.base_state}` : "Região não informada"}
                          {t.is_active ? "" : " · sem acesso ao app"}
                        </span>
                      </span>
                      <span className="text-right text-xs text-ink-muted">
                        <span className="block font-semibold text-ink tabular-nums">{t.visits_at_location}x aqui</span>
                        {t.last_visit_at_location ? `última ${formatDate(t.last_visit_at_location)}` : null}
                      </span>
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
              <p className="px-5 py-4 text-sm text-ink-subtle">Nenhuma OS nesta loja.</p>
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
                          {t.assignee?.name ?? "Sem técnico"} · {formatDate(t.created_at)}
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
            <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
              <MapPin className="size-4 text-ink-subtle" />
              Endereço
            </p>
            <p className="text-sm text-ink-muted">{address || "Sem endereço cadastrado."}</p>
            {!hasCoords ? (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                Sem coordenadas: a distância dos técnicos usa o centro da cidade. Ajuste em Editar.
              </p>
            ) : null}
            <a href={mapUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-brand hover:underline">
              Abrir no mapa
              <ExternalLink className="size-3" />
            </a>
          </Card>

          <Card className="p-5">
            <p className="mb-3 text-sm font-semibold text-ink">Contatos da loja</p>
            <ContactList contacts={contacts} />
          </Card>

          {l.notes ? (
            <Card className="p-5">
              <p className="mb-2 text-sm font-semibold text-ink">Observações</p>
              <p className="text-sm whitespace-pre-wrap text-ink-muted">{l.notes}</p>
            </Card>
          ) : null}

          {l.legacy ? (
            <p className="flex items-center gap-1.5 px-1 text-xs text-ink-subtle">
              <HardHat className="size-3.5" />
              Importada do Field Control
              {l.legacy.created_at ? ` · cadastrada lá em ${formatDate(l.legacy.created_at)}` : ""}
              {l.legacy.territories?.length ? ` · território ${l.legacy.territories.join(", ")}` : ""}
            </p>
          ) : null}
        </aside>
      </div>

      {editing ? <LocationDialog location={l} onClose={() => setEditing(false)} /> : null}
    </div>
  );
}
