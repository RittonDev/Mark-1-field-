"use client";

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, ClipboardCopy, Copy, ExternalLink, HardHat, MessageCircle, Pencil, Plus, Ticket, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { StatusBadge } from "@/components/badges";
import { ContactList, formatPhone, whatsappLink } from "@/components/ContactList";
import { documentKind, LocationDialog, locationContacts, validCoords } from "@/components/LocationDialog";
import { CountUp } from "@/components/motion";
import { useToast } from "@/components/Toaster";
import { Button, buttonClassName, Card, CardHeader, ErrorBox, LoadingBlock, SectionTitle } from "@/components/ui";
import { TicketLink } from "@/components/ticket/TicketLink";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets } from "@/lib/constants";
import { formatDate, formatDocument, initials } from "@/lib/format";
import type { Location, NearbyResult, Page, TicketListItem } from "@/lib/types";
import { copyText } from "@/lib/whatsapp";

/** Indicador da ficha (o mesmo das fichas de cliente e de projeto). */
function Stat({ label, value, display }: { label: string; value?: number; display?: string }) {
  return (
    <Card className="px-4 py-3">
      <p className="text-xs font-semibold text-ink/80">{label}</p>
      <p className={clsx("mt-1 font-semibold tracking-tight text-ink tabular-nums", display === undefined ? "text-xl" : "text-lg")}>
        {display ?? <CountUp value={value ?? 0} duration={300} />}
      </p>
    </Card>
  );
}

const ICON_ACTION = "rounded-md p-1.5 text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink";

/** Ficha da loja: endereço completo, todos os contatos, histórico de OS e quem já atendeu. */
export default function LocationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const { toast } = useToast();
  const canEdit = canManageTickets(user?.role);
  const [editing, setEditing] = useState(false);
  const loc = useQuery({ queryKey: ["location", id], queryFn: () => api.get<Location>(`/locations/${id}`) });
  const recent = useQuery({
    queryKey: ["tickets", "location", id],
    queryFn: () => api.get<Page<TicketListItem>>("/tickets", { location_id: id, page_size: 10, order_by: "-created_at" }),
  });
  // Quem já atendeu esta loja, pelo cálculo da busca por proximidade: pede o máximo (50) para quem visita
  // com frequência não ficar de fora quando a distância é medida do centro da cidade.
  const nearby = useQuery({
    queryKey: ["technicians", "nearby", { location_id: id, limit: 50 }, true],
    queryFn: () => api.get<NearbyResult>("/technicians/nearby", { location_id: id, include_inactive: true, limit: 50 }),
    retry: false,
  });

  const back = (
    <Link href="/locais" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
      <ArrowLeft className="size-4" />
      Locais
    </Link>
  );
  if (loc.isLoading) return <LoadingBlock rows={4} />;
  if (loc.error || !loc.data) {
    return (
      <div className="mx-auto max-w-7xl">
        {back}
        <ErrorBox message={errorMessage(loc.error)} />
      </div>
    );
  }
  const l = loc.data;
  const cityState = [l.city, l.state].filter(Boolean).join("-");
  const address = [l.address_line, l.district, cityState, l.zip_code].filter(Boolean).join(", ");
  const hasPoint = l.latitude != null && l.longitude != null;
  const hasCoords = validCoords(l.latitude, l.longitude);
  const mapUrl = hasCoords
    ? `https://www.google.com/maps/search/?api=1&query=${l.latitude},${l.longitude}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address || l.name)}`;
  const contacts = locationContacts(l);
  const attended = (nearby.data?.technicians ?? [])
    .filter((t) => t.visits_at_location > 0)
    .sort((a, b) => b.visits_at_location - a.visits_at_location);

  // O endereço como o analista cola no grupo do WhatsApp do técnico.
  const copyAddress = async () => {
    const phone = contacts.find((c) => c.kind === "phone" && c.primary) ?? contacts.find((c) => c.kind === "phone");
    const text = [
      [l.code, l.name].filter(Boolean).join(" · "),
      [l.address_line, l.district].filter(Boolean).join(", "),
      [cityState, l.zip_code ? `CEP ${l.zip_code}` : null].filter(Boolean).join(" · "),
      phone ? `Contato: ${[phone.name, formatPhone(phone.value)].filter(Boolean).join(" · ")}` : null,
      mapUrl,
    ]
      .filter(Boolean)
      .join("\n");
    const copied = await copyText(text);
    toast(
      copied
        ? { title: "Endereço copiado", description: "Pronto para colar no WhatsApp.", tone: "success" }
        : { title: "Não foi possível copiar", description: "Selecione o endereço e copie com Ctrl+C.", tone: "error" },
    );
  };

  const copyTechnician = async (name: string, phone: string) => {
    const copied = await copyText(`${name} · ${formatPhone(phone)}`);
    toast(copied ? { title: "Contato copiado", description: name, tone: "success" } : { title: "Não foi possível copiar", tone: "error" });
  };

  return (
    <div className="mx-auto max-w-7xl">
      {back}

      <Card className="mb-5 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-medium text-ink-subtle">
              <Link href={`/clientes/${l.customer_id}`} className="hover:text-brand hover:underline">
                {l.customer.name}
              </Link>
            </p>
            <h1 className="mt-1 text-[22px] leading-tight font-bold tracking-[-0.02em] text-ink">
              {l.code ? <span className="mr-2 rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-base font-semibold text-ink-muted">{l.code}</span> : null}
              {l.name}
            </h1>
            <span aria-hidden className="brand-gradient mt-2 block h-[3px] w-10 rounded-full" />
            <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-ink-muted">
              {l.document ? (
                <span>
                  {documentKind(l.document)} {formatDocument(l.document)}
                  {cityState ? " ·" : ""}
                </span>
              ) : null}
              {cityState ? <span>{cityState}</span> : null}
              {l.is_active ? null : (
                <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-ink-muted ring-1 ring-line ring-inset">
                  Inativa
                </span>
              )}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href={`/chamados?location_id=${l.id}`} className={buttonClassName()}>
              <Ticket className="size-4" />
              OS desta loja ({l.total_tickets.toLocaleString("pt-BR")})
            </Link>
            {canEdit ? (
              <Button onClick={() => setEditing(true)}>
                <Pencil className="size-4" />
                Editar
              </Button>
            ) : null}
            {/* O pedido chegou no WhatsApp e a loja já está aberta: a Nova OS vem com ela escolhida. */}
            {canEdit && l.is_active ? (
              <Link href={`/chamados/novo?location_id=${l.id}`} className={buttonClassName("primary")}>
                <Plus className="size-4" />
                Nova OS
              </Link>
            ) : null}
          </div>
        </div>
      </Card>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="stagger grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label="OS no total" value={l.total_tickets} />
            <Stat label="Em aberto" value={l.open_tickets} />
            <Stat label="Última OS" display={formatDate(l.last_ticket_at)} />
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
              <p className="px-5 py-4 text-sm text-ink-muted">
                Não deu para calcular quem atende perto desta loja ({errorMessage(nearby.error)}). Complete o endereço ou as
                coordenadas em Editar.
              </p>
            ) : attended.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-subtle">Nenhum técnico com visita registrada nesta loja.</p>
            ) : (
              <ul className="divide-y divide-line">
                {attended.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 px-5 py-2.5">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[11px] font-semibold text-brand-ink">
                      {initials(t.name)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-ink">{t.name}</span>
                      <span className="block truncate text-xs text-ink-subtle">
                        {[t.base_city, t.base_state].filter(Boolean).join("-") || "Região não informada"}
                        {t.is_active ? "" : " · sem acesso ao app"}
                      </span>
                    </span>
                    <span className="text-right text-xs text-ink-muted">
                      <span className="block font-semibold text-ink tabular-nums">{t.visits_at_location}x aqui</span>
                      {t.last_visit_at_location ? `última ${formatDate(t.last_visit_at_location)}` : null}
                    </span>
                    {t.phone ? (
                      <span className="flex shrink-0 items-center">
                        <a
                          href={whatsappLink(t.phone)}
                          target="_blank"
                          rel="noreferrer"
                          className={ICON_ACTION}
                          aria-label={`WhatsApp de ${t.name}`}
                          title="WhatsApp"
                        >
                          <MessageCircle className="size-4" />
                        </a>
                        <button
                          type="button"
                          onClick={() => void copyTechnician(t.name, t.phone ?? "")}
                          className={ICON_ACTION}
                          aria-label={`Copiar o contato de ${t.name}`}
                          title="Copiar contato"
                        >
                          <Copy className="size-4" />
                        </button>
                      </span>
                    ) : null}
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
                <ErrorBox message={errorMessage(recent.error)} />
              </div>
            ) : (recent.data?.items ?? []).length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-subtle">Nenhuma OS nesta loja.</p>
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
                          {t.assignee?.name ?? "Sem técnico"} · {formatDate(t.created_at)}
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
            <SectionTitle
              as="h2"
              className="mb-2"
              aside={
                <Button size="sm" variant="ghost" onClick={() => void copyAddress()} title="Nome, endereço, contato e link do mapa">
                  <ClipboardCopy className="size-3.5" />
                  Copiar endereço
                </Button>
              }
            >
              Endereço
            </SectionTitle>
            <p className="text-sm text-ink-muted">{address || "Sem endereço cadastrado."}</p>
            {!hasCoords ? (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                {hasPoint
                  ? "Coordenadas fora do Brasil ou invertidas: a distância dos técnicos usa o centro da cidade. Corrija em Editar."
                  : "Sem coordenadas: a distância dos técnicos usa o centro da cidade. Ajuste em Editar."}
              </p>
            ) : null}
            <a href={mapUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-brand hover:underline">
              Abrir no mapa
              <ExternalLink className="size-3" />
            </a>
          </Card>

          <Card className="p-5">
            <SectionTitle as="h2" className="mb-3">Contatos da loja</SectionTitle>
            <ContactList contacts={contacts} />
          </Card>

          {l.notes ? (
            <Card className="p-5">
              <SectionTitle as="h2" className="mb-2">Observações</SectionTitle>
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
