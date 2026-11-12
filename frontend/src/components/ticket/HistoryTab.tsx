"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ArrowRightLeft,
  CirclePlus,
  Clock,
  History,
  MapPin,
  MessageSquare,
  Paperclip,
  Pencil,
  UserCog,
} from "lucide-react";
import { StatusBadge } from "@/components/badges";
import { EmptyState, ErrorBox, LoadingBlock } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { EVENT_TYPE, STATUS } from "@/lib/constants";
import { formatDateTime } from "@/lib/format";
import type { TicketEvent, TicketEventType, TicketStatus, UUID } from "@/lib/types";

const ICONS: Record<TicketEventType, React.ComponentType<{ className?: string }>> = {
  created: CirclePlus,
  updated: Pencil,
  status_changed: ArrowRightLeft,
  assigned: UserCog,
  comment_added: MessageSquare,
  worklog_added: Clock,
  attachment_added: Paperclip,
};

const FIELD_LABELS: Record<string, string> = {
  title: "título",
  description: "descrição",
  type: "tipo",
  impact: "impacto",
  urgency: "urgência",
  priority: "prioridade",
  category_id: "categoria",
  customer_id: "cliente",
  location_id: "local",
  asset_id: "equipamento",
  requester_name: "solicitante",
  requester_contact: "contato",
  team_id: "grupo",
  scheduled_start: "início da visita",
  scheduled_end: "fim previsto",
};

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function isStatus(value: string | null): value is TicketStatus {
  return value !== null && value in STATUS;
}

function Detail({ event }: { event: TicketEvent }) {
  const data = event.data ?? {};
  if (event.event_type === "status_changed" && isStatus(event.from_value) && isStatus(event.to_value)) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <StatusBadge status={event.from_value} />
        <span className="text-ink-muted">→</span>
        <StatusBadge status={event.to_value} />
      </span>
    );
  }
  if (event.event_type === "assigned") {
    const to = str(data.to_name) ?? str(data.assignee_name);
    const from = str(data.from_name) ?? str(data.previous_assignee_name);
    if (!event.to_value && !to) return <span className="text-ink-muted">removeu o responsável{from ? ` ${from}` : ""}</span>;
    return (
      <span className="text-ink-muted">
        {from ? `${from} → ` : "para "}
        <span className="font-medium text-ink">{to ?? "outro responsável"}</span>
      </span>
    );
  }
  if (event.event_type === "updated") {
    const changes = data.changes ?? data.fields;
    const keys = Array.isArray(changes)
      ? changes.map(String)
      : changes && typeof changes === "object"
        ? Object.keys(changes as Record<string, unknown>)
        : [];
    if (keys.length) {
      return <span className="text-ink-muted">campos: {keys.map((k) => FIELD_LABELS[k] ?? k).join(", ")}</span>;
    }
  }
  return null;
}

export function HistoryTab({ ticketId }: { ticketId: UUID }) {
  const events = useQuery({
    queryKey: ["ticket", ticketId, "events"],
    queryFn: () => api.get<TicketEvent[]>(`/tickets/${ticketId}/events`),
  });

  if (events.isLoading) return <LoadingBlock />;
  if (events.error) return <ErrorBox message={errorMessage(events.error)} />;
  const items = [...(events.data ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (items.length === 0) return <EmptyState icon={<History className="size-7" />} title="Sem eventos registrados" />;

  return (
    <ol className="relative ml-3 border-l border-line">
      {items.map((event) => {
        const Icon = ICONS[event.event_type] ?? History;
        const lat = typeof event.data?.latitude === "number" ? event.data.latitude : null;
        const lng = typeof event.data?.longitude === "number" ? event.data.longitude : null;
        return (
          <li key={event.id} className="mb-5 ml-5 last:mb-0">
            <span className="absolute -left-3 flex size-6 items-center justify-center rounded-full border border-line bg-surface text-ink-muted">
              <Icon className="size-3.5" />
            </span>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="font-medium text-ink">{event.actor?.name ?? "Sistema"}</span>
              <span className="text-ink-muted">{EVENT_TYPE[event.event_type] ?? event.event_type}</span>
              <Detail event={event} />
            </div>
            <p className="mt-0.5 text-xs text-ink-muted">{formatDateTime(event.created_at)}</p>
            {event.note ? (
              <p className="mt-1.5 rounded-md bg-surface-2 px-2.5 py-1.5 text-sm whitespace-pre-wrap text-ink">
                {event.note}
              </p>
            ) : null}
            {lat !== null && lng !== null ? (
              <a
                href={`https://www.google.com/maps?q=${lat},${lng}`}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-xs text-brand hover:underline"
              >
                <MapPin className="size-3" />
                Localização registrada
              </a>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
