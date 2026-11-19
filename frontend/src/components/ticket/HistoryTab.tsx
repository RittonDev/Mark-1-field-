"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ArrowRightLeft,
  Hand,
  Handshake,
  CircleOff,
  CirclePlus,
  ClipboardCheck,
  ClipboardList,
  ClipboardX,
  Ban,
  BellRing,
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
  Send,
  ShieldCheck,
  ThumbsDown,
  Trash2,
  UserCog,
  Users,
  Wallet,
} from "lucide-react";
import { StatusBadge } from "@/components/badges";
import { EmptyState, ErrorBox, Skeleton } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { EVENT_TYPE, LEVEL, PRIORITY, RESPONSIBILITY, STATUS, TICKET_TYPE } from "@/lib/constants";
import { dayKey, formatDateTime, formatMinutes, formatMoney, formatTime, OPERATION_TZ } from "@/lib/format";
import type {
  Level,
  OfferCancelReason,
  Responsibility,
  TicketEvent,
  TicketEventType,
  TicketPriority,
  TicketStatus,
  TicketType,
  UUID,
} from "@/lib/types";
import { eventPoint, km, storeDistance } from "./geo";

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
  quote_reminded: BellRing,
  times_corrected: Clock,
  payout_set: Wallet,
  payout_removed: Wallet,
  offer_sent: Send,
  offer_accepted: Handshake,
  offer_declined: ThumbsDown,
  offer_cancelled: CircleOff,
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

/** O técnico entrou na OS aceitando a oferta com preço (o `assigned` do aceite traz `data.via = "offer"`). */
const viaOffer = (event: TicketEvent) => event.event_type === "assigned" && event.data?.via === "offer";

/** Ícone do evento: a atribuição pela oferta leva o do aceite. */
function iconOf(event: TicketEvent): Icon {
  if (viaOffer(event)) return Handshake;
  return ICONS[event.event_type] ?? EXTRA_ICONS[event.event_type] ?? History;
}

/**
 * Oferta encerrada sem a resposta do técnico, pelo motivo (`data.reason`). O "outro técnico aceitou" não
 * tem autor (sai como "Sistema"): o motivo vai no texto para não parecer que alguém cancelou.
 */
const OFFER_CLOSED: Partial<Record<OfferCancelReason, string>> = {
  central: "cancelou a oferta",
  taken: "encerrou a oferta: outro técnico aceitou a OS",
  assigned: "encerrou a oferta ao definir o técnico da OS",
};

/** "OS cancelada" fica como está; "A OS foi encerrada" vira "a OS foi encerrada" (meio da frase). */
function lowerFirst(text: string): string {
  return /^[A-ZÀ-Ý][a-zà-ÿ\s]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

/**
 * Notas da API que dizem mais que o motivo: o técnico da oferta entrou na visita (motivo "assigned") ou
 * ficou sem acesso ao app, desativado ou fora do papel de técnico (motivo "central").
 */
const OFFER_CLOSED_BY_NOTE = new Map<string, string>([
  ["A central incluiu o técnico na visita", "encerrou a oferta ao incluir o técnico na visita"],
  ["Técnico sem acesso ao app", "encerrou a oferta: técnico sem acesso ao app"],
]);

/** Texto do offer_cancelled pelo motivo; a OS encerrada usa a nota ("OS cancelada", "OS resolvida"...). */
function offerClosedLabel(event: TicketEvent): string {
  const reason = str(event.data?.reason) ?? event.to_value;
  const why = str(event.note);
  if (reason === "ticket_closed") return `encerrou a oferta: ${why ? lowerFirst(why) : "a OS foi encerrada"}`;
  const byNote = why ? OFFER_CLOSED_BY_NOTE.get(why) : undefined;
  if (byNote) return byNote;
  return (reason && OFFER_CLOSED[reason as OfferCancelReason]) || EVENT_TYPE.offer_cancelled;
}

/** Técnicos (e o valor de cada um) das ofertas do evento: o offer_sent e o offer_cancelled trazem a lista. */
function offerPeople(value: unknown): { name: string; amount: string | null }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const name = str(row.technician);
    return name ? [{ name, amount: money(row.amount) }] : [];
  });
}

/** "A", "A e B", "A, B e C". */
function joinNames(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}` : (names[0] ?? "");
}

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

const dayMonthFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: OPERATION_TZ, day: "2-digit", month: "2-digit" });

/**
 * Quando o técnico abriu o escopo, ao lado do aceite: "escopo lido às 14:45"; lido noutro dia (oferta sem prazo),
 * "escopo lido em 18/11 às 18:10". Sem a leitura (app antigo) ou com data malformada, nada.
 */
function scopeReadText(value: unknown, acceptedAt: string): string | null {
  const iso = str(value);
  const day = iso ? dayKey(iso) : "";
  if (!iso || !day) return null;
  const time = `às ${formatTime(iso)}`;
  return `escopo lido ${day === dayKey(acceptedAt) ? time : `em ${dayMonthFmt.format(new Date(iso))} ${time}`}`;
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
      if (viaOffer(event)) return "assumiu a OS pela oferta";
      if (technicianRemoved(event)) return "tirou o técnico";
      return event.from_value || str(data.from_name) ? "trocou o técnico" : "definiu o técnico";
    case "offer_cancelled":
      return offerClosedLabel(event);
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
  // Aceite e recusa são do técnico da oferta (o nome também vem nos dados).
  if (event.event_type === "offer_accepted" || event.event_type === "offer_declined") return str(data.technician) ?? "Técnico";
  return str(data.source) === "fieldcontrol" ? "Field Control" : "Sistema";
}

/**
 * A nota embaixo do evento. Na oferta, o recado (no envio) e o motivo (na recusa) ganham o nome; o
 * motivo do encerramento já está no texto, e o "Aceitou a oferta" da atribuição também.
 */
function noteOf(event: TicketEvent): string | null {
  const note = event.note?.trim() ? event.note : null;
  if (!note || viaOffer(event) || event.event_type === "offer_cancelled") return null;
  if (event.event_type === "offer_sent") return `Recado: ${note}`;
  if (event.event_type === "offer_declined") return `Motivo: ${note}`;
  return note;
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
      // Pela oferta: quem assumiu é o próprio autor (o texto já diz).
      if (viaOffer(event)) return null;
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
    case "quote_reminded":
    case "quote_approved":
    case "quote_rejected":
      return <Joined parts={[event.to_value, money(data.total)]} />;
    case "expense_added":
    case "expense_updated":
    case "expense_removed":
      return <Joined parts={[str(data.description), money(data.total)]} />;
    case "payout_set": {
      // Pagamento registrado: a chave PIX dele naquele momento, mascarada ("PIX CPF ***.456.789-**").
      const pix = str(data.pix);
      return <Joined parts={[str(data.technician), money(data.amount), pix ? `PIX ${pix}` : null]} />;
    }
    case "payout_removed":
      return <Joined parts={[str(data.technician), money(data.amount)]} />;
    case "offer_sent": {
      // "R$ 90,00 · para Ana, Bruno e Carla · responder até 18/11/2026 15:30"
      const people = offerPeople(data.offers).map((p) => p.name);
      const expires = str(data.expires_at);
      const replaced = Array.isArray(data.replaced) ? data.replaced.map(String) : [];
      return (
        <Joined
          parts={[
            money(data.amount) ?? money(event.to_value),
            people.length ? `para ${joinNames(people)}` : null,
            expires ? `responder até ${formatDateTime(expires)}` : "sem prazo",
            replaced.length ? `no lugar da oferta anterior de ${joinNames(replaced)}` : null,
          ]}
        />
      );
    }
    case "offer_accepted":
      // O técnico é o autor; aqui, o valor e quando ele abriu o escopo no app.
      return <Joined parts={[money(data.amount) ?? money(event.to_value), scopeReadText(data.scope_read_at, event.created_at)]} />;
    case "offer_declined":
      // O técnico é o autor; aqui, o valor.
      return <Joined parts={[money(data.amount) ?? money(event.to_value)]} />;
    case "offer_cancelled": {
      // De quem eram as ofertas e o valor (um só quando todas tinham o mesmo).
      const people = offerPeople(data.offers);
      const amounts = new Set(people.map((p) => p.amount).filter(Boolean));
      if (amounts.size > 1) return <Joined parts={people.map((p) => (p.amount ? `${p.name} (${p.amount})` : p.name))} />;
      return <Joined parts={[joinNames(people.map((p) => p.name)) || null, people[0]?.amount]} />;
    }
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

/** O formato da linha do tempo enquanto carrega: o traço, os ícones e as linhas de cada evento. */
function HistorySkeleton() {
  return (
    <div role="status">
      <span className="sr-only">Carregando o histórico...</span>
      <ol aria-hidden className="relative ml-3 border-l border-line">
        {[64, 48, 56].map((width, i) => (
          <li key={i} className="mb-5 ml-5 last:mb-0" style={{ opacity: 1 - i * 0.22 }}>
            <Skeleton className="absolute -left-3 size-6 rounded-full border border-line" />
            <Skeleton className="h-3.5" style={{ width: `${width}%` }} />
            <Skeleton className="mt-1.5 h-2.5 w-28" />
          </li>
        ))}
      </ol>
    </div>
  );
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

  if (events.isLoading) return <HistorySkeleton />;
  if (events.error) return <ErrorBox message={errorMessage(events.error)} onRetry={() => void events.refetch()} />;
  const items = [...(events.data ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (items.length === 0) return <EmptyState icon={<History />} title="Sem eventos registrados" />;

  return (
    <ol className="relative ml-3 border-l border-line">
      {items.map((event) => {
        const Icon = iconOf(event);
        const note = noteOf(event);
        const point = event.actor?.role === "technician" ? eventPoint(event.data) : null;
        const meters = point ? storeDistance(event.data, store) : null;
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
            {note ? (
              <p className="mt-1.5 rounded-md bg-surface-2 px-2.5 py-1.5 text-sm whitespace-pre-wrap text-ink">
                {note}
              </p>
            ) : null}
            {point ? (
              <a
                href={`https://www.google.com/maps?q=${point[0]},${point[1]}`}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-xs text-brand-ink hover:underline"
              >
                <MapPin className="size-3" />
                Localização registrada{meters !== null ? ` · a ${km(meters)} da loja` : ""}
              </a>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
