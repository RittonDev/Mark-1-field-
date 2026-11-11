"use client";

import { ExternalLink, MapPin } from "lucide-react";
import { Card, CardHeader } from "@/components/ui";
import { ASSET_TYPE, LEVEL, TICKET_SOURCE, TICKET_TYPE } from "@/lib/constants";
import { formatDateTime, formatMinutes } from "@/lib/format";
import type { TicketDetail } from "@/lib/types";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-2 py-1.5 text-sm">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="min-w-0 break-words text-ink">{children ?? "—"}</dd>
    </div>
  );
}

export function TicketInfo({ ticket }: { ticket: TicketDetail }) {
  const loc = ticket.location;
  const hasGeo = loc && loc.latitude !== null && loc.longitude !== null;
  const mapsUrl = hasGeo
    ? `https://www.google.com/maps?q=${loc.latitude},${loc.longitude}`
    : loc && (loc.address_line || loc.city)
      ? `https://www.google.com/maps/search/${encodeURIComponent(
          [loc.address_line, loc.city, loc.state].filter(Boolean).join(", "),
        )}`
      : null;

  return (
    <>
      <Card>
        <CardHeader title="Cliente e local" />
        <dl className="px-4 py-2">
          <Row label="Cliente">{ticket.customer?.name}</Row>
          <Row label="Local">
            {loc ? (
              <div>
                <p>{loc.name}</p>
                {loc.address_line ? <p className="text-xs text-ink-muted">{loc.address_line}</p> : null}
                {loc.city ? (
                  <p className="text-xs text-ink-muted">
                    {loc.city}
                    {loc.state ? `/${loc.state}` : ""}
                  </p>
                ) : null}
                {mapsUrl ? (
                  <a
                    href={mapsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
                  >
                    <MapPin className="size-3" />
                    Abrir no mapa
                    <ExternalLink className="size-3" />
                  </a>
                ) : null}
              </div>
            ) : null}
          </Row>
          {loc?.contact_name || loc?.contact_phone ? (
            <Row label="Contato local">
              {loc.contact_name}
              {loc.contact_phone ? <span className="block text-xs text-ink-muted">{loc.contact_phone}</span> : null}
            </Row>
          ) : null}
          <Row label="Solicitante">
            {ticket.requester?.name ?? ticket.requester_name}
            {ticket.requester_contact ? (
              <span className="block text-xs text-ink-muted">{ticket.requester_contact}</span>
            ) : null}
          </Row>
        </dl>
      </Card>

      {ticket.asset ? (
        <Card>
          <CardHeader title="Equipamento" />
          <dl className="px-4 py-2">
            <Row label="Nome">{ticket.asset.name}</Row>
            <Row label="Tipo">{ASSET_TYPE[ticket.asset.asset_type]}</Row>
            {ticket.asset.brand || ticket.asset.model ? (
              <Row label="Marca/modelo">{[ticket.asset.brand, ticket.asset.model].filter(Boolean).join(" ")}</Row>
            ) : null}
            {ticket.asset.serial_number ? <Row label="Nº de série">{ticket.asset.serial_number}</Row> : null}
            {ticket.asset.asset_tag ? <Row label="Patrimônio">{ticket.asset.asset_tag}</Row> : null}
            {ticket.asset.ip_address ? (
              <Row label="IP">
                <span className="font-mono text-xs">{ticket.asset.ip_address}</span>
              </Row>
            ) : null}
          </dl>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Classificação e datas" />
        <dl className="px-4 py-2">
          <Row label="Tipo">{TICKET_TYPE[ticket.type]}</Row>
          <Row label="Categoria">{ticket.category?.full_name}</Row>
          <Row label="Impacto/urgência">
            {LEVEL[ticket.impact]} / {LEVEL[ticket.urgency]}
          </Row>
          <Row label="Origem">{TICKET_SOURCE[ticket.source]}</Row>
          <Row label="Aberta em">{formatDateTime(ticket.created_at)}</Row>
          {ticket.created_by ? <Row label="Aberta por">{ticket.created_by.name}</Row> : null}
          <Row label="Visita">
            {ticket.scheduled_start ? (
              <>
                {formatDateTime(ticket.scheduled_start)}
                {ticket.scheduled_end ? (
                  <span className="block text-xs text-ink-muted">até {formatDateTime(ticket.scheduled_end)}</span>
                ) : null}
              </>
            ) : null}
          </Row>
          <Row label="1ª resposta">{formatDateTime(ticket.first_response_at)}</Row>
          <Row label="Resolvida em">{formatDateTime(ticket.resolved_at)}</Row>
          {ticket.closed_at ? <Row label="Fechada em">{formatDateTime(ticket.closed_at)}</Row> : null}
          {ticket.cancelled_at ? <Row label="Cancelada em">{formatDateTime(ticket.cancelled_at)}</Row> : null}
          {ticket.sla_paused_seconds > 0 ? (
            <Row label="SLA pausado">{formatMinutes(ticket.sla_paused_seconds / 60)}</Row>
          ) : null}
          {ticket.reopen_count > 0 ? <Row label="Reaberturas">{ticket.reopen_count}</Row> : null}
          <Row label="Atualizada">{formatDateTime(ticket.updated_at)}</Row>
        </dl>
      </Card>
    </>
  );
}
