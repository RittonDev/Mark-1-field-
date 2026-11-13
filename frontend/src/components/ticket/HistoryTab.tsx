"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ArrowRightLeft,
  Hand,
  CirclePlus,
  ClipboardCheck,
  ClipboardList,
  ClipboardX,
  Ban,
  Clock,
  FileCheck2,
  FileSignature,
  FileText,
  FileX2,
  Receipt,
  History,
  MapPin,
  MessageSquare,
  Package,
  Paperclip,
  Pencil,
  ShieldCheck,
  Trash2,
  UserCog,
  Users,
  Wallet,
} from "lucide-react";
import { StatusBadge } from "@/components/badges";
import { EmptyState, ErrorBox, LoadingBlock } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { EVENT_TYPE, LEVEL, PRIORITY, RESPONSIBILITY, STATUS, TICKET_TYPE } from "@/lib/constants";
import { formatDateTime, formatMinutes, formatMoney } from "@/lib/format";
import type { Level, Responsibility, TicketEvent, TicketEventType, TicketPriority, TicketStatus, TicketType, UUID } from "@/lib/types";
import { distance, eventPoint, km } from "./geo";

type Icon = React.ComponentType<{ className?: string }>;

const ICONS: Record<TicketEventType, Icon> = {
  created: CirclePlus,
  updated: Pencil,
  status_changed: ArrowRightLeft,
  assigned: UserCog,
  owner_changed: Hand,
  comment_added: MessageSquare,
  worklog_added: Clock,
  attachment_added: Paperclip,
  attachment_updated: Pencil,
  attachment_removed: Trash2,
  helpers_changed: Users,
  form_added: ClipboardList,
  form_completed: ClipboardCheck,
  form_removed: ClipboardX,
  signature_collected: FileSignature,
  expense_added: Receipt,
  expense_updated: Receipt,
  expense_removed: Receipt,
  unproductive_visit: Ban,
  quote_sent: FileText,
  quote_approved: FileCheck2,
  quote_rejected: FileX2,
  times_corrected: Clock,
  payout_set: Wallet,
  payout_removed: Wallet,
};

/** Eventos que a API grava e o tipo do front ainda não lista (pedido de peça, autorização antiga). */
const EXTRA_ICONS: Record<string, Icon> = {
  part_requested: Package,
  part_request_updated: Package,
  authorization_recorded: ShieldCheck,
};

const EXTRA_LABELS: Record<string, string> = {
  part_requested: "pediu uma peça",
  part_request_updated: "atualizou o pedido de peça",
  authorization_recorded: "registrou a autorização do cliente",
};

const PART_STATUS: Record<string, string> = {
  open: "aberto",
  quoted: "orçado",
  approved: "aprovado",
  rejected: "recusado",
  cancelled: "cancelado",
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
  service_address: "endereço do atendimento",
  service_type_id: "tipo de serviço",
  estimated_minutes: "duração estimada",
  response_violation_reason_id: "motivo da violação (resposta)",
  resolution_violation_reason_id: "motivo da violação (solução)",
  violation_note: "detalhe da violação",
  asset_id: "equipamento",
  requester_name: "solicitante",
  requester_contact: "contato",
  team_id: "grupo",
  scheduled_start: "início da visita",
  scheduled_end: "fim previsto",
  visit_note: "observação da visita",
  tags: "etiquetas",
  project_id: "projeto",
  resolution_notes: "descrição da conclusão",
  client_reference: "nº do chamado do cliente",
  signature_required: "exige assinatura",
};

/** Campos que o histórico mostra com o valor antigo e o novo; os demais (textos longos, ids), só o nome. */
const VALUE_FIELDS = new Set([
  "title",
  "service_address",
  "client_reference",
  "requester_name",
  "requester_contact",
  "priority",
  "type",
  "impact",
  "urgency",
  "scheduled_start",
  "scheduled_end",
  "estimated_minutes",
  "signature_required",
]);

/** Valor antigo ou novo de um campo editado, já legível ("P2", "14/11/2026 10:00", "2h"). */
function fieldValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "vazio";
  if (key === "priority") return PRIORITY[value as TicketPriority]?.code ?? String(value);
  if (key === "type") return TICKET_TYPE[value as TicketType] ?? String(value);
  if (key === "impact" || key === "urgency") return LEVEL[value as Level] ?? String(value);
  if (key === "scheduled_start" || key === "scheduled_end") return formatDateTime(String(value));
  if (key === "estimated_minutes") return formatMinutes(Number(value));
  if (key === "signature_required") return value ? "sim" : "não";
  const text = String(value);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Nome de quem saiu ou entrou na troca de técnico. As OS migradas guardam o nome no próprio valor. */
function personName(name: unknown, value: string | null): string | null {
  return str(name) ?? (value && !UUID_RE.test(value) ? value : null);
}

/** Quantia gravada no evento: número ("120.00") ou já em reais ("R$ 120,00"). */
function money(value: unknown): string | null {
  if (typeof value === "number") return formatMoney(value);
  if (typeof value !== "string" || !value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? formatMoney(n) : value;
}

/** Horários corrigidos pela central (evento times_corrected). */
const TIME_LABELS: Record<string, string> = {
  en_route_at: "saída",
  arrived_at: "início",
  resolved_at: "término",
  work_minutes: "tempo",
};

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function isStatus(value: string | null): value is TicketStatus {
  return value !== null && value in STATUS;
}

/** A troca tirou o técnico da OS (sem ninguém no lugar). */
function technicianRemoved(event: TicketEvent) {
  return !event.to_value && !str(event.data?.to_name) && !str(event.data?.assignee_name);
}

/** Texto do evento; anexos dizem se foi foto, arquivo ou assinatura. */
function label(event: TicketEvent): string {
  const data = event.data ?? {};
  const kind = str(data.kind);
  switch (event.event_type) {
    case "attachment_added":
      if (kind === "photo") return "anexou uma foto";
      if (kind === "signature") return "anexou a assinatura";
      break;
    case "attachment_removed":
      if (kind === "photo") return "excluiu a foto";
      break;
    case "assigned":
      if (technicianRemoved(event)) return "tirou o técnico";
      return event.from_value || str(data.from_name) ? "trocou o técnico" : "definiu o técnico";
    case "unproductive_visit":
      return "registrou visita improdutiva";
    case "quote_approved":
      return "aprovou o orçamento";
    case "quote_rejected":
      return "recusou o orçamento";
    case "signature_collected":
      if (!event.to_value) return "colheu a assinatura";
      break;
  }
  return EXTRA_LABELS[event.event_type] ?? EVENT_TYPE[event.event_type] ?? event.event_type;
}

/** Quem fez: o usuário; no orçamento, quem aprovou pelo link; nas OS migradas, o Field Control. */
function actorName(event: TicketEvent): string {
  if (event.actor) return event.actor.name;
  const data = event.data ?? {};
  if (event.event_type === "quote_approved" || event.event_type === "quote_rejected") {
    const by = str(data.by);
    return by ? `${by} (cliente)` : "Cliente";
  }
  return str(data.source) === "fieldcontrol" ? "Field Control" : "Sistema";
}

/** "Valor principal · detalhe · detalhe": o primeiro em destaque. */
function Joined({ parts }: { parts: (string | null | undefined)[] }) {
  const [first, ...rest] = parts.filter((p): p is string => Boolean(p));
  if (!first) return null;
  return (
    <span className="min-w-0 text-ink-muted">
      <span className="font-medium text-ink">{first}</span>
      {rest.length ? ` · ${rest.join(" · ")}` : null}
    </span>
  );
}

function Detail({ event }: { event: TicketEvent }) {
  const data = event.data ?? {};
  switch (event.event_type) {
    case "status_changed": {
      const to = isStatus(event.to_value) ? event.to_value : null;
      if (!to) return null;
      const from = isStatus(event.from_value) ? event.from_value : null;
      const when = to === "scheduled" ? str(data.scheduled_start) : null;
      return (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {from ? (
            <>
              <StatusBadge status={from} />
              <span className="text-ink-muted">→</span>
            </>
          ) : (
            <span className="text-ink-muted">para</span>
          )}
          <StatusBadge status={to} />
          {when ? <span className="text-ink-muted">para {formatDateTime(when)}</span> : null}
        </span>
      );
    }
    case "assigned": {
      const to = personName(data.to_name ?? data.assignee_name, event.to_value);
      const from = personName(data.from_name ?? data.previous_assignee_name, event.from_value);
      if (technicianRemoved(event)) return from ? <Joined parts={[from]} /> : null;
      return (
        <span className="text-ink-muted">
          {from ? `${from} → ` : null}
          <span className="font-medium text-ink">{to ?? "outro técnico"}</span>
        </span>
      );
    }
    case "owner_changed":
      return (
        <span className="text-ink-muted">
          {str(data.from_name) ?? "sem analista"} → <span className="font-medium text-ink">{str(data.to_name) ?? "sem analista"}</span>
        </span>
      );
    case "unproductive_visit": {
      const responsibility = RESPONSIBILITY[str(data.responsibility) as Responsibility];
      return <Joined parts={[event.to_value, responsibility ? `responsabilidade: ${responsibility.label}` : null]} />;
    }
    case "signature_collected":
    case "form_added":
    case "form_completed":
      return <Joined parts={[event.to_value]} />;
    case "form_removed":
      return <Joined parts={[event.from_value]} />;
    case "quote_sent":
    case "quote_approved":
    case "quote_rejected":
      return <Joined parts={[event.to_value, money(data.total)]} />;
    case "expense_added":
    case "expense_updated":
    case "expense_removed":
      return <Joined parts={[str(data.description), money(data.total)]} />;
    case "payout_set":
    case "payout_removed":
      return <Joined parts={[str(data.technician), money(data.amount)]} />;
    case "worklog_added":
      return typeof data.minutes === "number" ? <Joined parts={[formatMinutes(data.minutes)]} /> : null;
  }
  // Tipos que a API grava e o tipo do front não lista: comparados como texto.
  const type: string = event.event_type;
  if (type === "part_requested" || type === "part_request_updated") {
    const quantity = [str(data.quantity), str(data.unit)].filter(Boolean).join(" ");
    const status = type === "part_request_updated" && event.to_value ? PART_STATUS[event.to_value] : null;
    return <Joined parts={[str(data.description), quantity, status]} />;
  }
  if (type === "authorization_recorded") return <Joined parts={[str(data.by_name), str(data.channel)]} />;
  if (
    event.event_type === "attachment_added" ||
    event.event_type === "attachment_updated" ||
    event.event_type === "attachment_removed"
  ) {
    const name = str(data.filename);
    return name ? (
      <span className="max-w-xs truncate font-medium text-ink" title={name}>
        {name}
      </span>
    ) : null;
  }
  if (event.event_type === "helpers_changed" || (event.event_type === "created" && Array.isArray(data.helpers))) {
    const names = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);
    const added = names(event.event_type === "created" ? data.helpers : data.added);
    const removed = names(data.removed);
    return (
      <span className="text-ink-muted">
        {added.length ? (
          <>
            {event.event_type === "created" ? "com " : "+ "}
            <span className="font-medium text-ink">{added.join(", ")}</span>
          </>
        ) : null}
        {added.length && removed.length ? " · " : null}
        {removed.length ? (
          <>
            − <span className="font-medium text-ink line-through decoration-ink-subtle">{removed.join(", ")}</span>
          </>
        ) : null}
      </span>
    );
  }
  if (event.event_type === "times_corrected") {
    const changes = (data.changes ?? {}) as Record<string, [unknown, unknown]>;
    const at = (v: unknown) => (typeof v === "string" ? formatDateTime(v) : "—");
    const parts = Object.entries(changes).map(([key, [from, to]]) => {
      const name = TIME_LABELS[key] ?? key;
      const text = key === "work_minutes" ? `${formatMinutes(Number(from))} → ${formatMinutes(Number(to))}` : `${at(from)} → ${at(to)}`;
      return `${name} ${text}`;
    });
    return parts.length ? <span className="text-ink-muted">{parts.join(" · ")}</span> : null;
  }
  if (event.event_type === "updated") {
    const changes = data.changes ?? data.fields;
    if (Array.isArray(changes)) {
      return changes.length ? <span className="text-ink-muted">campos: {changes.map((k) => FIELD_LABELS[String(k)] ?? String(k)).join(", ")}</span> : null;
    }
    if (changes && typeof changes === "object") {
      const parts = Object.entries(changes as Record<string, unknown>).map(([key, change]) => {
        const name = FIELD_LABELS[key] ?? key;
        if (!VALUE_FIELDS.has(key) || !Array.isArray(change) || change.length !== 2) return name;
        return `${name}: ${fieldValue(key, change[0])} → ${fieldValue(key, change[1])}`;
      });
      return parts.length ? <span className="min-w-0 text-ink-muted">{parts.join(" · ")}</span> : null;
    }
  }
  return null;
}

/**
 * Linha do tempo da OS. O ponto de GPS só aparece quando foi o técnico que registrou no app (é a
 * prova de presença); com a loja no mapa, diz a que distância ele estava, como no Field Control.
 */
export function HistoryTab({ ticketId, store = null }: { ticketId: UUID; store?: [number, number] | null }) {
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
        const Icon = ICONS[event.event_type] ?? EXTRA_ICONS[event.event_type] ?? History;
        const point = event.actor?.role === "technician" ? eventPoint(event.data) : null;
        return (
          <li key={event.id} className="mb-5 ml-5 last:mb-0">
            <span className="absolute -left-3 flex size-6 items-center justify-center rounded-full border border-line bg-surface text-ink-muted">
              <Icon className="size-3.5" />
            </span>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="font-semibold text-ink">{actorName(event)}</span>
              <span className="text-ink-muted">{label(event)}</span>
              <Detail event={event} />
            </div>
            <p className="mt-0.5 text-xs text-ink-muted">{formatDateTime(event.created_at)}</p>
            {event.note ? (
              <p className="mt-1.5 rounded-md bg-surface-2 px-2.5 py-1.5 text-sm whitespace-pre-wrap text-ink">
                {event.note}
              </p>
            ) : null}
            {point ? (
              <a
                href={`https://www.google.com/maps?q=${point[0]},${point[1]}`}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-xs text-brand hover:underline"
              >
                <MapPin className="size-3" />
                Localização registrada{store ? ` · a ${km(distance(store, point))} da loja` : ""}
              </a>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
