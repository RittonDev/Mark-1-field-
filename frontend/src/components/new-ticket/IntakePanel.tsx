"use client";

import { CalendarClock, ExternalLink, History, MapPin, Phone, Star, StickyNote, Store, Timer } from "lucide-react";
import Link from "next/link";
import { TagChips } from "@/components/TagChips";
import { Skeleton } from "@/components/ui";
import { formatDate } from "@/lib/format";
import type { IntakeContext } from "@/lib/types";

const num = (n: number) => n.toLocaleString("pt-BR");

function Metric({ value, label, tone }: { value: number; label: string; tone?: "warn" }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg bg-surface-2 px-2.5 py-2">
      <span className={tone === "warn" && value > 0 ? "text-base font-semibold text-amber-700 tabular-nums dark:text-amber-300" : "text-base font-semibold text-ink tabular-nums"}>
        {num(value)}
      </span>
      <span className="text-[11px] leading-tight text-ink-muted">{label}</span>
    </div>
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
export function IntakePanel({ context, loading }: { context: IntakeContext | undefined; loading: boolean }) {
  if (loading && !context) {
    return (
      <div className="flex flex-col gap-2 p-4">
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
          <Store className="size-5" />
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
      {customer ? (
        <section className="flex flex-col gap-2.5 p-4" aria-label="Cliente">
          <div className="flex items-start justify-between gap-2">
            <Link href={`/clientes/${customer.id}`} target="_blank" className="min-w-0 text-sm font-semibold text-ink hover:text-brand">
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
          {customer.notes ? (
            <p className="flex gap-1.5 rounded-lg border border-amber-200/70 bg-amber-50/60 px-2.5 py-2 text-xs text-amber-900 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
              <StickyNote className="mt-px size-3.5 shrink-0" />
              <span className="line-clamp-3 whitespace-pre-line">{customer.notes}</span>
            </p>
          ) : null}
        </section>
      ) : null}

      {location ? (
        <section className="flex flex-col gap-2.5 p-4" aria-label="Loja">
          <div className="min-w-0">
            <Link href={`/locais/${location.id}`} target="_blank" className="text-sm font-semibold text-ink hover:text-brand">
              {location.code ? <span className="mr-1 font-mono text-xs text-ink-subtle">{location.code}</span> : null}
              {location.name}
            </Link>
            {address ? (
              <p className="mt-1 flex gap-1.5 text-xs text-ink-muted">
                <MapPin className="mt-px size-3.5 shrink-0 text-ink-subtle" />
                <span>
                  {address}
                  {mapsUrl ? (
                    <a href={mapsUrl} target="_blank" rel="noreferrer" className="ml-1.5 inline-flex items-center gap-0.5 text-brand hover:underline">
                      mapa <ExternalLink className="size-3" />
                    </a>
                  ) : null}
                </span>
              </p>
            ) : (
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Loja sem endereço no cadastro.</p>
            )}
            {location.contact_name || location.contact_phone ? (
              <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-muted">
                <Phone className="size-3.5 shrink-0 text-ink-subtle" />
                {[location.contact_name, location.contact_phone].filter(Boolean).join(" · ")}
              </p>
            ) : null}
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <Metric value={location.total_tickets} label="OS na loja" />
            <Metric value={location.open_tickets} label="em aberto" tone="warn" />
            <Metric value={location.tickets_30d} label="em 30 dias" tone="warn" />
          </div>
          {location.last_visit ? (
            <p className="flex gap-1.5 text-xs text-ink-muted">
              <History className="mt-px size-3.5 shrink-0 text-ink-subtle" />
              <span>
                Última visita em {formatDate(location.last_visit.at)}
                {location.last_visit.technician ? ` com ${location.last_visit.technician}` : ""} ·{" "}
                <Link href={`/chamados/${location.last_visit.ticket_id}`} target="_blank" className="font-mono text-brand hover:underline">
                  {location.last_visit.code}
                </Link>
              </span>
            </p>
          ) : (
            <p className="flex items-center gap-1.5 text-xs text-ink-muted">
              <CalendarClock className="size-3.5 text-ink-subtle" />
              Nenhuma visita concluída nesta loja ainda.
            </p>
          )}
          {location.arrival_hours ? (
            <p className="flex items-center gap-1.5 text-xs text-ink-muted">
              <Timer className="size-3.5 text-ink-subtle" />
              Chegada em até <span className="font-medium text-ink">{location.arrival_hours}h</span>
              ({location.is_capital ? "capital" : "interior"})
            </p>
          ) : null}
          {location.notes ? (
            <p className="line-clamp-3 rounded-lg bg-surface-2 px-2.5 py-2 text-xs whitespace-pre-line text-ink-muted">{location.notes}</p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
