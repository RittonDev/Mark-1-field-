"use client";

import { CalendarClock, ExternalLink, History, MapPin, MessageCircle, Phone, RotateCcw, Star, StickyNote, Store, Timer } from "lucide-react";
import Link from "next/link";
import { TagChips } from "@/components/TagChips";
import { TicketLink } from "@/components/ticket/TicketLink";
import { Button, ErrorBox, SectionTitle, Skeleton } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { whatsappUrl } from "@/lib/whatsapp";
import type { IntakeContext } from "@/lib/types";

const num = (n: number) => n.toLocaleString("pt-BR");

/** Número do histórico. Âmbar só a partir de `warnFrom` (ex.: OS aberta na mesma loja, reincidência). */
function Metric({ value, label, warnFrom }: { value: number; label: string; warnFrom?: number }) {
  const warn = warnFrom != null && value >= warnFrom;
  return (
    <div className="flex flex-col gap-0.5 rounded-lg bg-surface-2 px-2.5 py-2">
      <span className={warn ? "text-base font-semibold text-amber-700 tabular-nums dark:text-amber-300" : "text-base font-semibold text-ink tabular-nums"}>
        {num(value)}
      </span>
      <span className="text-[11px] leading-tight text-ink-muted">{label}</span>
    </div>
  );
}

/** Observação do cadastro (cliente ou loja), no mesmo estilo para os dois. */
function Note({ children }: { children: string }) {
  return (
    <p className="flex gap-1.5 rounded-lg bg-surface-2 px-2.5 py-2 text-xs text-ink-muted">
      <StickyNote aria-hidden className="mt-px size-3.5 shrink-0 text-ink-subtle" />
      <span className="line-clamp-3 whitespace-pre-line" title={children}>
        {children}
      </span>
    </p>
  );
}

function Stars({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} className={i <= Math.round(value) ? "size-3.5 fill-amber-400 text-amber-400" : "size-3.5 text-line-strong"} />
      ))}
    </span>
  );
}

/** Cliente e loja da OS que está sendo aberta: quem é, como anda e o que esperar da visita. */
export function IntakePanel({
  context,
  loading,
  error,
  onRetry,
}: {
  context: IntakeContext | undefined;
  loading: boolean;
  /** Falha ao buscar o cliente e a loja (com a loja já escolhida, não é "escolha a loja"). */
  error?: unknown;
  onRetry?: () => void;
}) {
  return (
    <div>
      <div className="border-b border-line px-4 py-3">
        <SectionTitle>Cliente e loja</SectionTitle>
      </div>
      <IntakeBody context={context} loading={loading} error={error} onRetry={onRetry} />
    </div>
  );
}

function IntakeBody({
  context,
  loading,
  error,
  onRetry,
}: {
  context: IntakeContext | undefined;
  loading: boolean;
  error?: unknown;
  onRetry?: () => void;
}) {
  if (error && !context) {
    return (
      <div className="flex flex-col items-start gap-2 p-4">
        <ErrorBox message={`Não deu para carregar o histórico: ${errorMessage(error)}`} />
        {onRetry ? (
          <Button size="sm" onClick={onRetry}>
            Tentar de novo
          </Button>
        ) : null}
      </div>
    );
  }
  if (loading && !context) {
    return (
      <div className="flex flex-col gap-2 p-4" role="status" aria-label="Carregando cliente e loja">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-3 w-3/4" />
      </div>
    );
  }
  const customer = context?.customer ?? null;
  const location = context?.location ?? null;
  if (!customer && !location) {
    return (
      <div className="flex flex-col items-center gap-2 px-5 py-8 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-brand-soft text-brand">
          <Store aria-hidden className="size-5" />
        </span>
        <p className="text-sm font-bold text-ink">Escolha a loja</p>
        <p className="text-xs text-ink-muted">Aqui aparecem o histórico, a avaliação do cliente, o contato e o prazo de chegada.</p>
      </div>
    );
  }

  const address = location
    ? [location.address_line, location.district, [location.city, location.state].filter(Boolean).join("-"), location.zip_code]
        .filter(Boolean)
        .join(", ")
    : "";
  const mapsUrl =
    location?.latitude != null && location.longitude != null
      ? `https://www.google.com/maps?q=${location.latitude},${location.longitude}`
      : address
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
        : null;

  return (
    <div className="flex animate-fade flex-col divide-y divide-line">
      {error ? (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-xs text-red-700 dark:text-red-300">
          Não deu para atualizar: {errorMessage(error)}
          {onRetry ? (
            <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 font-semibold underline-offset-2 hover:underline">
              <RotateCcw aria-hidden className="size-3" />
              Tentar de novo
            </button>
          ) : null}
        </div>
      ) : null}
      {customer ? (
        <section className="flex flex-col gap-2.5 p-4" aria-label="Cliente">
          <div className="flex items-start justify-between gap-2">
            <Link
              href={`/clientes/${customer.id}`}
              target="_blank"
              className="min-w-0 text-sm font-semibold text-ink hover:text-brand-ink"
              title="Abre a ficha do cliente em outra aba"
            >
              {customer.name}
            </Link>
            {customer.rating_average ? (
              <span className="flex shrink-0 flex-col items-end gap-0.5" title="Avaliação dos atendimentos (histórico do Field Control)">
                <Stars value={customer.rating_average} />
                <span className="text-[11px] text-ink-subtle tabular-nums">
                  {customer.rating_average.toLocaleString("pt-BR")} média
                  {customer.rating_last ? ` · última ${customer.rating_last}` : ""}
                </span>
              </span>
            ) : null}
          </div>
          <TagChips tags={customer.tags} max={4} />
          <div className="grid grid-cols-3 gap-1.5">
            <Metric value={customer.total_tickets} label="OS no total" />
            <Metric value={customer.open_tickets} label="em aberto" />
            <Metric value={customer.upcoming} label={`agendadas em ${context?.upcoming_days ?? 7} dias`} />
          </div>
          {customer.notes ? <Note>{customer.notes}</Note> : null}
        </section>
      ) : null}

      {location ? (
        <section className="flex flex-col gap-2.5 p-4" aria-label="Loja">
          <div className="min-w-0">
            <Link
              href={`/locais/${location.id}`}
              target="_blank"
              className="text-sm font-semibold text-ink hover:text-brand-ink"
              title="Abre a ficha da loja em outra aba"
            >
              {location.code ? <span className="mr-1 font-mono text-xs text-ink-subtle">{location.code}</span> : null}
              {location.name}
            </Link>
            {address ? (
              <p className="mt-1 flex gap-1.5 text-xs text-ink-muted">
                <MapPin aria-hidden className="mt-px size-3.5 shrink-0 text-ink-subtle" />
                <span>
                  {address}
                  {mapsUrl ? (
                    <a href={mapsUrl} target="_blank" rel="noreferrer" className="ml-1.5 inline-flex items-center gap-0.5 font-medium text-brand-ink hover:underline">
                      mapa <ExternalLink aria-hidden className="size-3" />
                    </a>
                  ) : null}
                </span>
              </p>
            ) : (
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Loja sem endereço no cadastro.</p>
            )}
            {location.contact_name || location.contact_phone ? (
              <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-ink-muted">
                <Phone aria-hidden className="size-3.5 shrink-0 text-ink-subtle" />
                {location.contact_name ? <span>{location.contact_name}</span> : null}
                {location.contact_name && location.contact_phone ? <span aria-hidden>·</span> : null}
                {location.contact_phone ? (
                  <>
                    <a href={`tel:${location.contact_phone.replace(/[^\d+]/g, "")}`} className="font-medium text-brand-ink hover:underline">
                      {location.contact_phone}
                    </a>
                    <a
                      href={whatsappUrl(location.contact_phone, "")}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-0.5 font-medium text-brand-ink hover:underline"
                      aria-label={`Abrir conversa no WhatsApp com ${location.contact_name ?? location.contact_phone}`}
                    >
                      <MessageCircle aria-hidden className="size-3" />
                      WhatsApp
                    </a>
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <Metric value={location.total_tickets} label="OS na loja" />
            <Metric value={location.open_tickets} label="em aberto" warnFrom={1} />
            {/* Uma OS no mês é o normal da loja; reincidência é a partir de duas. */}
            <Metric value={location.tickets_30d} label="em 30 dias" warnFrom={2} />
          </div>
          {location.last_visit ? (
            <p className="flex gap-1.5 text-xs text-ink-muted">
              <History aria-hidden className="mt-px size-3.5 shrink-0 text-ink-subtle" />
              <span>
                Última visita em {formatDate(location.last_visit.at)}
                {location.last_visit.technician ? ` com ${location.last_visit.technician}` : ""} ·{" "}
                <TicketLink
                  ticketId={location.last_visit.ticket_id}
                  className="font-mono font-medium text-brand-ink hover:underline"
                  title={`${location.last_visit.title} (abre no painel; Ctrl+clique abre outra aba)`}
                >
                  {location.last_visit.code}
                </TicketLink>
              </span>
            </p>
          ) : (
            <p className="flex items-center gap-1.5 text-xs text-ink-muted">
              <CalendarClock aria-hidden className="size-3.5 text-ink-subtle" />
              Nenhuma visita concluída nesta loja ainda.
            </p>
          )}
          {location.arrival_hours ? (
            <p className="flex items-center gap-1.5 text-xs text-ink-muted">
              <Timer aria-hidden className="size-3.5 text-ink-subtle" />
              Chegada em até <span className="font-medium text-ink">{location.arrival_hours}h</span>
              ({location.is_capital ? "capital" : "interior"})
            </p>
          ) : null}
          {location.notes ? <Note>{location.notes}</Note> : null}
        </section>
      ) : null}
    </div>
  );
}
