"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { AlertTriangle, Search, Send, Star, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { searchText } from "@/components/new-ticket/Combobox";
import { offerText } from "@/components/new-ticket/invite";
import { isOpenStatus } from "@/components/operacao/hooks";
import { useToast } from "@/components/Toaster";
import { useNow } from "@/components/useNow";
import { Button, buttonClassName, Dialog, ErrorBox, Field, Input, Pill, SectionTitle, Select, Skeleton, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { OFFER_STATE } from "@/lib/constants";
import { dayKey, formatDateTime, formatMoney, formatTime, fromLocalInput, initials, moneyInput, OPERATION_TZ } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { useCan } from "@/lib/permissions";
import { useAssignable, useServiceTypes } from "@/lib/queries";
import { readDecimal } from "@/lib/quotes";
import type {
  AssignableUser,
  IntakeContext,
  OfferCancelReason,
  OfferCreate,
  OfferState,
  Technician,
  TechnicianSuggestion,
  TicketDetail,
  TicketOffer,
  UUID,
} from "@/lib/types";
import { copyText, GROUP_TEXT_COPIED, groupShareUrl } from "@/lib/whatsapp";

// Oferta de OS com preço: a central manda a OS sem técnico para técnicos escolhidos, com o valor; o
// técnico aceita pelo valor ou recusa no app (sem contraproposta) e quem aceitar primeiro fica com a OS.
// O preço é dado de Pagamentos: ver as ofertas pede a tela em Visualizar; mandar e cancelar, em Editar.

/** Até quantos técnicos uma oferta vai de uma vez (o mesmo da API). */
const MAX_TECHNICIANS = 10;
/** Tamanho máximo do recado (o mesmo da API). */
const NOTE_MAX = 500;
/** Ofertas à vista no bloco da OS antes do "Mostrar todas". */
const LIST_LIMIT = 5;
/** "Até o fim do dia" só com essa folga: perto da meia-noite a oferta já nasceria vencendo. */
const END_OF_DAY_MIN_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

// Etiqueta neutra na linha do técnico (Sem acesso ao app, Já está na OS, Oferta em aberto).
const CHIP =
  "inline-flex items-center rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-ink-muted ring-1 ring-line ring-inset";
// Ocupado no horário: cor só no problema, como nos técnicos indicados da OS.
const BUSY_CHIP =
  "inline-flex items-center rounded-full bg-red-50 px-1.5 py-px text-[11px] font-medium whitespace-nowrap text-red-700 dark:bg-red-500/10 dark:text-red-300";

type DeadlineKey = "none" | "30" | "60" | "120" | "240" | "eod";

/** Prazo para o técnico responder: o horário é calculado na hora de enviar. */
const DEADLINES: { key: DeadlineKey; label: string; minutes?: number }[] = [
  { key: "none", label: "Sem prazo" },
  { key: "30", label: "30 min", minutes: 30 },
  { key: "60", label: "1 hora", minutes: 60 },
  { key: "120", label: "2 horas", minutes: 120 },
  { key: "240", label: "4 horas", minutes: 240 },
  { key: "eod", label: "Até o fim do dia" },
];

/** Hoje às 23:59 no fuso da operação; null quando falta pouco para isso (a oferta já nasceria vencendo). */
function endOfDay(now: number): string | null {
  const iso = fromLocalInput(`${dayKey(now)}T23:59`);
  return iso && Date.parse(iso) - now >= END_OF_DAY_MIN_MS ? iso : null;
}

/** O `expires_at` do prazo escolhido, contado de `now` (null: sem prazo). */
function deadlineAt(key: DeadlineKey, now: number): string | null {
  if (key === "eod") return endOfDay(now);
  const minutes = DEADLINES.find((d) => d.key === key)?.minutes;
  return minutes ? new Date(now + minutes * 60_000).toISOString() : null;
}

const dayMonthFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: OPERATION_TZ, day: "2-digit", month: "2-digit" });

/** "às 15:30" (hoje), "amanhã às 08:00", "ontem às 18:10" ou "em 17/11 às 18:10", no fuso da operação. */
function atText(iso: string, now: number): string {
  const time = `às ${formatTime(iso)}`;
  const day = dayKey(iso);
  if (day === dayKey(now)) return time;
  if (day === dayKey(now + DAY_MS)) return `amanhã ${time}`;
  if (day === dayKey(now - DAY_MS)) return `ontem ${time}`;
  return `em ${dayMonthFmt.format(new Date(iso))} ${time}`;
}

/** "A", "A e B", "A, B e C" ou "A, B, C e mais 4". */
function listNames(names: string[], max = 3): string {
  if (names.length > max) return `${names.slice(0, max).join(", ")} e mais ${names.length - max}`;
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}` : (names[0] ?? "");
}

/**
 * Estado na tela: a pendente cujo prazo passou já conta como vencida, sem esperar a próxima leitura
 * (a API calcula o "expired" do mesmo jeito, na hora em que responde).
 */
export function offerStateAt(offer: Pick<TicketOffer, "state" | "expires_at">, now: number): OfferState {
  if (offer.state === "pending" && offer.expires_at && Date.parse(offer.expires_at) <= now) return "expired";
  return offer.state;
}

/** Por que a oferta foi cancelada, na linha dela (a etiqueta já diz "Cancelada"). */
const CANCELLED_BECAUSE: Record<OfferCancelReason, string> = {
  central: "Pela central",
  taken: "Outro técnico aceitou",
  assigned: "A OS foi atribuída",
  ticket_closed: "A OS foi encerrada",
  replaced: "Trocada por uma oferta nova",
};

/** A linha de baixo da oferta: leitura e prazo, quando respondeu (e o motivo da recusa) ou por que fechou. */
function offerDetail(offer: TicketOffer, state: OfferState, now: number): string {
  switch (state) {
    case "pending": {
      const seen = offer.viewed_at ? `Vista ${atText(offer.viewed_at, now)}` : "Ainda não abriu";
      return `${seen} · ${offer.expires_at ? `vence ${atText(offer.expires_at, now)}` : "sem prazo"}`;
    }
    case "expired":
      return offer.expires_at ? `Venceu ${atText(offer.expires_at, now)}${offer.viewed_at ? "" : " sem abrir"}` : "Prazo encerrado";
    case "accepted":
      return offer.responded_at ? `Aceitou ${atText(offer.responded_at, now)}` : "Aceitou a oferta";
    case "declined": {
      const when = offer.responded_at ? `Recusou ${atText(offer.responded_at, now)}` : "Recusou";
      return offer.decline_reason ? `${when}: ${offer.decline_reason}` : when;
    }
    case "cancelled":
      return offer.cancel_reason ? CANCELLED_BECAUSE[offer.cancel_reason] : "Cancelada";
  }
}

/**
 * As pendentes do envio mais recente (mesmo valor e prazo): é delas que o texto do grupo fala. A API
 * manda a mais nova primeiro.
 */
function latestBatch(offers: TicketOffer[], now: number): TicketOffer[] {
  const live = offers.filter((o) => offerStateAt(o, now) === "pending");
  const first = live[0];
  if (!first) return [];
  return live.filter((o) => o.amount === first.amount && o.expires_at === first.expires_at);
}

/** Ofertas da OS com os valores (só com Pagamentos). Sob ["ticket", id]: o tempo real e o Salvar já recarregam. */
export function useTicketOffers(ticketId: UUID, enabled = true) {
  return useQuery({
    queryKey: ["ticket", ticketId, "offers"],
    queryFn: ({ signal }) => api.get<TicketOffer[]>(`/tickets/${ticketId}/offers`, undefined, { signal }),
    enabled,
  });
}

interface OfferPlace {
  district: string | null;
  city: string | null;
  state: string | null;
}

/**
 * Bairro, cidade e UF da loja da OS (o que o técnico vê na oferta, nunca a loja nem o endereço). O
 * bairro vem do contexto da loja que a aba Geral já busca (mesma chave: sem pedido a mais).
 */
function useOfferPlace(ticket: TicketDetail, enabled = true): OfferPlace {
  const locationId = ticket.location?.id ?? null;
  const intake = useQuery({
    queryKey: ["intake", locationId, null],
    queryFn: () => api.get<IntakeContext>("/intake/context", { location_id: locationId ?? undefined }),
    enabled: enabled && Boolean(locationId),
    staleTime: 30_000,
  });
  const loc = intake.data?.location ?? null;
  return {
    district: loc?.district ?? null,
    city: loc?.city ?? ticket.location?.city ?? null,
    state: loc?.state ?? ticket.location?.state ?? null,
  };
}

/** Texto da oferta para o grupo de técnicos no WhatsApp (sem cliente, loja nem endereço). */
function groupText(ticket: TicketDetail, place: OfferPlace, offers: TicketOffer[], now: number): string {
  const first = offers[0];
  return offerText({
    code: ticket.code,
    service: ticket.service_type?.name ?? ticket.title,
    district: place.district,
    city: place.city,
    state: place.state,
    startIso: ticket.scheduled_start,
    amount: first?.amount ?? 0,
    expiresAt: first?.expires_at ?? null,
    technicians: offers.map((o) => o.technician.name),
    now,
  });
}

type ToastFn = ReturnType<typeof useToast>["toast"];

/** Copia o texto da oferta e avisa, com o atalho para colar no WhatsApp. */
async function copyGroupText(text: string, toast: ToastFn) {
  if (await copyText(text)) {
    toast({
      title: GROUP_TEXT_COPIED,
      tone: "success",
      action: { label: "Abrir no WhatsApp", onClick: () => void window.open(groupShareUrl(text), "_blank", "noopener,noreferrer") },
    });
  } else {
    toast({ title: "Não deu para copiar o texto", description: "O navegador não liberou a área de transferência. Tente de novo.", tone: "error" });
  }
}

// ------------------------------------------------------------------ escolha dos técnicos

/** Um técnico na lista do diálogo. */
interface Candidate {
  id: UUID;
  name: string;
  /** Linha de baixo: distância, cidade e carga. */
  detail: string;
  favorite?: boolean;
  /** Ocupado no horário da visita (só com a OS agendada). */
  busy?: boolean;
  /** Desativado: não entra no app, então não recebe a oferta. */
  inactive?: boolean;
}

function km(value: number | null): string | null {
  if (value == null) return null;
  return value < 1 ? "menos de 1 km" : `${value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} km`;
}

const cityOf = (city?: string | null, state?: string | null) => [city, state].filter(Boolean).join("-");

function fromSuggestion(t: TechnicianSuggestion, scheduled: boolean): Candidate {
  const load = t.day_load != null ? (t.day_load === 0 ? "sem OS no dia" : `${t.day_load} OS no dia`) : `${t.open_tickets} em aberto`;
  return {
    id: t.id,
    name: t.name,
    detail: [km(t.distance_km), cityOf(t.home_city, t.home_state) || null, load].filter(Boolean).join(" · "),
    favorite: Boolean(t.favorite),
    busy: scheduled && t.busy === true,
  };
}

function fromTechnician(t: Technician): Candidate {
  const region = cityOf(t.base_city, t.base_state) || cityOf(t.home_city, t.home_state) || "Sem região";
  return { id: t.id, name: t.name, detail: `${region} · ${t.open_tickets} em aberto`, inactive: !t.is_active };
}

function fromAssignable(u: AssignableUser): Candidate {
  return { id: u.id, name: u.name, detail: [u.team_name, `${u.open_tickets} em aberto`].filter(Boolean).join(" · ") };
}

const noop = () => undefined;

interface TechnicianSearch {
  /** Busca já aplicada (depois da pausa na digitação). */
  q: string;
  items: Candidate[];
  loading: boolean;
  error: unknown;
  retry: () => void;
}

/**
 * "Incluir outro técnico": com a tela Técnicos, a base inteira (como o "Incluir favorito"; os sem acesso
 * ao app aparecem travados); sem ela, os técnicos ativos da lista de atribuição.
 */
function useTechnicianSearch(term: string): TechnicianSearch {
  const canBase = useCan("base.technicians");
  const typed = term.trim();
  const q = useDebounced(typed, 300);
  const base = useQuery({
    queryKey: ["technicians", "search", q],
    queryFn: ({ signal }) => api.get<Technician[]>("/technicians", { q, limit: 20 }, { signal }),
    enabled: canBase && q.length >= 2,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
  const assignable = useAssignable(null, !canBase);
  // Ainda digitando: a busca anterior não vale para o texto novo.
  const waiting = typed !== q;
  if (q.length < 2) return { q, items: [], loading: waiting && typed.length >= 2, error: null, retry: noop };
  if (canBase) {
    return {
      q,
      items: (base.data ?? []).map(fromTechnician),
      loading: waiting || base.isLoading,
      error: base.error,
      retry: () => void base.refetch(),
    };
  }
  const words = searchText(q).split(/\s+/).filter(Boolean);
  const items = (assignable.data ?? [])
    .filter((u) => u.role === "technician" && words.every((w) => searchText(u.name).includes(w)))
    .slice(0, 20)
    .map(fromAssignable);
  return { q, items, loading: waiting || assignable.isLoading, error: assignable.error, retry: () => void assignable.refetch() };
}

/** Linha com caixa de seleção (técnico indicado ou da busca). */
function PickRow({
  candidate,
  checked,
  disabled,
  chips,
  onToggle,
}: {
  candidate: Candidate;
  checked: boolean;
  disabled: boolean;
  chips: React.ReactNode;
  onToggle: () => void;
}) {
  const locked = disabled && !checked;
  return (
    <li>
      <label
        className={clsx(
          "flex items-start gap-3 rounded-lg border px-3 py-2 transition-colors",
          locked
            ? "cursor-not-allowed border-line bg-surface-2/50"
            : checked
              ? "cursor-pointer border-brand/50 bg-brand-soft/60 dark:bg-brand/10"
              : "cursor-pointer border-line bg-surface hover:border-line-strong",
        )}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={onToggle}
          className="mt-2 size-4 shrink-0 accent-[var(--brand)]"
        />
        <span
          aria-hidden
          className="relative mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[11px] font-semibold text-ink-muted"
        >
          {initials(candidate.name)}
          {candidate.favorite ? (
            <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-brand text-white dark:bg-brand-strong">
              <Star className="size-2.5 fill-current" />
            </span>
          ) : null}
        </span>
        <span className={clsx("min-w-0 flex-1", locked && "opacity-70")}>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="truncate text-sm font-semibold text-ink">{candidate.name}</span>
            {candidate.favorite ? <span className="sr-only">(favorito na cidade da loja)</span> : null}
            {chips}
          </span>
          {candidate.detail ? <span className="block truncate text-xs text-ink-muted">{candidate.detail}</span> : null}
        </span>
      </label>
    </li>
  );
}

/** Erro de um bloco sem campo próprio (a lista de técnicos), no tom e no anúncio do Field. */
function BlockError({ message }: { message?: string | null }) {
  return message ? (
    <span role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
      {message}
    </span>
  ) : null;
}

// ------------------------------------------------------------------ diálogo

/**
 * "Ofertar a OS com preço": de 1 a 10 técnicos (os mais indicados para a OS, com favorito, distância,
 * "ocupado" e cidade, e a busca para incluir outro), o valor para o técnico (começa no valor do tipo de
 * serviço), o prazo para responder e um recado. A OS precisa estar em aberto e sem técnico (a API confere).
 * Serve na aba Geral da OS e no resumo da OS recém-criada.
 */
export function OfferDialog({
  ticket,
  onClose,
  onSent,
}: {
  ticket: TicketDetail;
  onClose: () => void;
  /** As ofertas criadas (depois do aviso "Oferta enviada"). */
  onSent?: (offers: TicketOffer[]) => void;
}) {
  const ids = useId();
  const formId = `${ids}-oferta`;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const now = useNow(30_000);
  const place = useOfferPlace(ticket);
  const offers = useTicketOffers(ticket.id);
  const types = useServiceTypes({ customerId: ticket.customer?.id ?? null, active: true });
  const [picked, setPicked] = useState<{ id: UUID; name: string }[]>([]);
  // null: o campo ainda mostra o valor do tipo de serviço (que pode chegar depois de abrir).
  const [amountText, setAmountText] = useState<string | null>(null);
  const [deadline, setDeadline] = useState<DeadlineKey>("none");
  const [note, setNote] = useState("");
  const [term, setTerm] = useState("");
  const [tried, setTried] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const search = useTechnicianSearch(term);

  // Os mais indicados para a OS (o mesmo ranking da aba Geral, com até 10). A própria OS não conta como
  // "ocupado" para ninguém (exclude_ticket_id).
  const scheduled = Boolean(ticket.scheduled_start);
  const minutes =
    ticket.estimated_minutes && ticket.estimated_minutes > 0 && ticket.estimated_minutes <= 10080 ? ticket.estimated_minutes : null;
  const title = ticket.title.trim().slice(0, 200);
  const suggestions = useQuery({
    queryKey: [
      "technician-suggest",
      "offer",
      ticket.id,
      ticket.location?.id ?? null,
      ticket.service_type?.id ?? null,
      ticket.category?.id ?? null,
      ticket.project?.id ?? null,
      ticket.scheduled_start,
      minutes,
      title,
    ],
    queryFn: ({ signal }) =>
      api.get<TechnicianSuggestion[]>(
        "/technicians/suggest",
        {
          location_id: ticket.location?.id,
          service_type_id: ticket.service_type?.id,
          category_id: ticket.category?.id,
          project_id: ticket.project?.id,
          title: title || undefined,
          start: ticket.scheduled_start ?? undefined,
          estimated_minutes: minutes ?? undefined,
          exclude_ticket_id: ticket.id,
          limit: MAX_TECHNICIANS,
        },
        { signal },
      ),
    staleTime: 30_000,
  });

  const send = useMutation({
    mutationFn: (body: OfferCreate) => api.post<TicketOffer[]>(`/tickets/${ticket.id}/offers`, body),
    onSuccess: (created) => {
      // A lista de ofertas, o histórico e o contador da OS (o cabeçalho troca o "Sem técnico").
      void queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id] });
      const first = created[0];
      if (first) {
        const text = groupText(ticket, place, created, Date.now());
        toast({
          title: "Oferta enviada",
          description: `Para ${created.length === 1 ? first.technician.name : `${created.length} técnicos`} · ${formatMoney(first.amount)}. Quem aceitar primeiro pelo app fica com a OS.`,
          tone: "success",
          action: { label: "Copiar texto para o grupo", onClick: () => void copyGroupText(text, toast) },
        });
      }
      onSent?.(created);
      onClose();
    },
    // O erro fica no fim do diálogo: leva até ele (a lista de técnicos pode ter empurrado para baixo).
    onError: () => requestAnimationFrame(() => errorRef.current?.scrollIntoView({ block: "nearest" })),
  });

  const fee = types.data?.find((t) => t.id === ticket.service_type?.id)?.technician_fee ?? null;
  const amountValue = amountText ?? moneyInput(fee);
  const amount = readDecimal(amountValue, { decimals: 2, allowZero: true, emptyMessage: "Informe o valor para o técnico" });
  const eodAvailable = endOfDay(now) !== null;
  const previewAt = deadlineAt(deadline, now);
  const errors = {
    technicians: picked.length === 0 ? "Escolha pelo menos um técnico" : null,
    amount: amount.error,
    deadline: deadline === "eod" && !eodAvailable ? "O dia está acabando: escolha outro prazo" : null,
  };
  const shown = (key: keyof typeof errors) => (tried ? errors[key] : null);

  // Quem não pode receber (sem acesso ao app, já está na OS) e o que cada um já tem nesta OS.
  const helperIds = new Set((ticket.helpers ?? []).map((h) => h.id));
  const lastState = new Map(
    [...(offers.data ?? [])]
      .reverse()
      .filter((o) => o.cancel_reason !== "replaced")
      .map((o) => [o.technician.id, offerStateAt(o, now)] as const),
  );
  const pickedIds = new Set(picked.map((p) => p.id));
  const full = picked.length >= MAX_TECHNICIANS;
  const isDisabled = (c: Candidate) => Boolean(c.inactive) || helperIds.has(c.id) || (full && !pickedIds.has(c.id));
  const toggle = (c: Candidate) =>
    setPicked((list) =>
      list.some((p) => p.id === c.id)
        ? list.filter((p) => p.id !== c.id)
        : list.length >= MAX_TECHNICIANS
          ? list
          : [...list, { id: c.id, name: c.name }],
    );
  const chipsFor = (c: Candidate) => {
    const before = lastState.get(c.id);
    return (
      <>
        {c.busy ? <span className={BUSY_CHIP}>Ocupado no horário</span> : null}
        {c.inactive ? <span className={CHIP}>Sem acesso ao app</span> : null}
        {helperIds.has(c.id) ? <span className={CHIP}>Já está na OS</span> : null}
        {before === "pending" ? (
          <span className={CHIP} title="Já tem uma oferta em aberto nesta OS: a nova troca a anterior">
            Oferta em aberto
          </span>
        ) : before === "expired" ? (
          <span className={CHIP} title="A oferta anterior venceu: a nova fica no lugar dela">
            Oferta vencida
          </span>
        ) : before === "declined" ? (
          <span className={CHIP}>Recusou antes</span>
        ) : null}
      </>
    );
  };
  const row = (c: Candidate) => (
    <PickRow
      key={c.id}
      candidate={c}
      checked={pickedIds.has(c.id)}
      disabled={isDisabled(c)}
      chips={chipsFor(c)}
      onToggle={() => toggle(c)}
    />
  );
  const suggested = (suggestions.data ?? []).map((t) => fromSuggestion(t, scheduled));

  const service = ticket.service_type?.name ?? ticket.title;
  const placeText = [place.district, [place.city, place.state].filter(Boolean).join(" - ")].filter(Boolean).join(", ");
  const deadlineHint =
    deadline === "none"
      ? "Vale até alguém aceitar ou você cancelar."
      : previewAt
        ? `Vence ${atText(previewAt, now)}.`
        : undefined;
  const dirty = picked.length > 0 || amountText !== null || note.trim() !== "" || deadline !== "none";

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // Aberto da aba Geral (portal no <body>): o envio não pode "subir" até o Salvar da OS.
    e.stopPropagation();
    if (send.isPending) return;
    setTried(true);
    if (errors.technicians || errors.amount || errors.deadline || amount.value === null) return;
    // O prazo conta de agora (do clique), não de quando o diálogo abriu.
    const expiresAt = deadlineAt(deadline, Date.now());
    if (deadline !== "none" && !expiresAt) return;
    send.mutate({
      technician_ids: picked.map((p) => p.id),
      amount: amount.value.toFixed(2),
      expires_at: expiresAt,
      note: note.trim() || null,
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      dirty={dirty && !send.isPending}
      busy={send.isPending}
      title="Ofertar a OS com preço"
      description={
        <>
          <span className="font-semibold text-ink">{ticket.code}</span> · {service} · {placeText || "sem localização"} ·{" "}
          {ticket.scheduled_start ? formatDateTime(ticket.scheduled_start) : "data a combinar"}
          <span className="mt-1 block text-xs">
            No app, o técnico vê o serviço, o escopo, os formulários, o bairro e a cidade, a data e o valor. Cliente, loja e endereço, só
            depois de aceitar.
          </span>
        </>
      }
      footer={
        <>
          <span className="mr-auto hidden text-xs text-ink-muted sm:inline">Quem aceitar primeiro pelo app fica com a OS.</span>
          <Button onClick={onClose} disabled={send.isPending}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={send.isPending}>
            {send.isPending ? null : <Send aria-hidden className="size-4" />}
            {picked.length > 1 ? `Enviar para ${picked.length} técnicos` : "Enviar oferta"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="flex flex-col gap-5">
        {ticket.description?.trim() ? null : (
          <p className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
            <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0" />
            <span>A OS está sem escopo: o técnico vai ver só o serviço. Para ele saber o que fazer, preencha o escopo antes de ofertar.</span>
          </p>
        )}

        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2">
            <span id={`${ids}-tecnicos`} className="text-xs font-semibold text-ink/80">
              Técnicos<span className="text-red-600 dark:text-red-400"> *</span>
            </span>
            <span className="text-xs text-ink-muted tabular-nums">
              {picked.length} de {MAX_TECHNICIANS}
            </span>
          </div>
          {picked.length ? (
            <ul aria-label="Técnicos escolhidos" className="flex flex-wrap gap-1.5">
              {picked.map((p) => (
                <li
                  key={p.id}
                  className="inline-flex animate-pop items-center gap-1 rounded-md bg-brand-soft py-0.5 pr-1 pl-2 text-xs font-medium text-brand-ink"
                >
                  {p.name}
                  <button
                    type="button"
                    onClick={() => setPicked((list) => list.filter((x) => x.id !== p.id))}
                    className="rounded p-0.5 hover:bg-brand/15"
                    aria-label={`Tirar ${p.name} da oferta`}
                  >
                    <X aria-hidden className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <BlockError message={shown("technicians")} />
          {ticket.location ? null : (
            <p className="text-xs text-ink-muted">A OS está sem localização: a lista não leva em conta a distância.</p>
          )}
          <div role="group" aria-labelledby={`${ids}-tecnicos`}>
            {suggestions.isLoading ? (
              <div className="flex flex-col gap-1.5">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : suggestions.error ? (
              <ErrorBox
                message={`Não deu para buscar os técnicos indicados: ${errorMessage(suggestions.error)}`}
                onRetry={() => void suggestions.refetch()}
              />
            ) : suggested.length ? (
              <ul aria-label="Técnicos mais indicados" className="flex max-h-72 flex-col gap-1.5 overflow-y-auto pr-0.5">
                {suggested.map(row)}
              </ul>
            ) : (
              <p className="rounded-lg bg-surface-2 px-3 py-3 text-xs text-ink-muted">Nenhum técnico ativo indicado. Busque pelo nome abaixo.</p>
            )}
          </div>
          {full ? <p className="text-xs text-ink-muted">No máximo {MAX_TECHNICIANS} técnicos por oferta.</p> : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${ids}-busca`} className="text-xs font-semibold text-ink/80">
            Incluir outro técnico
          </label>
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted" />
            <Input
              id={`${ids}-busca`}
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              // Enter na busca não envia a oferta.
              onKeyDown={(e) => {
                if (e.key === "Enter") e.preventDefault();
              }}
              placeholder="Buscar pelo nome"
              autoComplete="off"
              className="pl-9"
            />
          </div>
          {term.trim().length < 2 ? null : search.loading ? (
            <Skeleton className="h-14 w-full" />
          ) : search.error ? (
            <ErrorBox message={errorMessage(search.error)} onRetry={search.retry} />
          ) : search.items.length ? (
            <ul aria-label="Técnicos encontrados" className="flex max-h-60 flex-col gap-1.5 overflow-y-auto pr-0.5">
              {search.items.map(row)}
            </ul>
          ) : (
            <p className="text-xs text-ink-muted">Nenhum técnico com “{search.q}”.</p>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Valor para o técnico"
            required
            error={shown("amount")}
            hint={fee != null ? `Padrão do tipo de serviço: ${formatMoney(fee)}` : "Quanto o técnico recebe pela OS se aceitar."}
          >
            <Input
              inputMode="decimal"
              placeholder="R$ 0,00"
              value={amountValue}
              onChange={(e) => setAmountText(e.target.value)}
              aria-required="true"
              aria-invalid={tried && amount.error ? true : undefined}
            />
          </Field>
          {/* O "fim do dia" pode passar com o diálogo aberto: o aviso aparece na hora, sem esperar o Enviar. */}
          <Field label="Prazo para responder" error={errors.deadline} hint={deadlineHint}>
            <Select
              value={deadline}
              onChange={(e) => setDeadline(e.target.value as DeadlineKey)}
              aria-invalid={errors.deadline ? true : undefined}
            >
              {DEADLINES.map((d) => (
                <option key={d.key} value={d.key} disabled={d.key === "eod" && !eodAvailable && deadline !== "eod"}>
                  {d.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="flex flex-col gap-1">
          <Field
            label="Recado para o técnico (opcional)"
            hint="Aparece na oferta, no app. Sem cliente, loja nem endereço: o técnico só vê isso depois de aceitar."
          >
            <Textarea
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={NOTE_MAX}
              placeholder="Ex.: levar escada e furadeira; atendimento a partir das 8h."
            />
          </Field>
          <span className="self-end text-[11px] text-ink-subtle tabular-nums">
            {note.length.toLocaleString("pt-BR")} / {NOTE_MAX.toLocaleString("pt-BR")}
          </span>
        </div>

        {send.error ? (
          <div ref={errorRef}>
            <ErrorBox title="Não foi possível enviar a oferta" message={errorMessage(send.error)} />
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------ na OS

/** Uma oferta no bloco da OS: técnico, situação, valor e o "Cancelar" da pendente. */
function OfferRow({
  offer,
  now,
  onCancel,
  cancelling,
}: {
  offer: TicketOffer;
  now: number;
  onCancel?: () => void;
  cancelling: boolean;
}) {
  const state = offerStateAt(offer, now);
  const info = OFFER_STATE[state];
  const detail = offerDetail(offer, state, now);
  const sent = `Enviada${offer.created_by ? ` por ${offer.created_by.name}` : ""} em ${formatDateTime(offer.created_at)}`;
  const full = [detail, sent, offer.note ? `Recado: ${offer.note}` : null].filter(Boolean).join(" · ");
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[11px] font-semibold text-ink-muted"
      >
        {initials(offer.technician.name)}
      </span>
      <div className="min-w-[9rem] flex-1">
        <p className="truncate text-sm font-semibold text-ink">{offer.technician.name}</p>
        <p className="truncate text-xs text-ink-muted" title={full}>
          {detail}
        </p>
      </div>
      <span className="text-sm font-semibold text-ink tabular-nums">{formatMoney(offer.amount)}</span>
      <Pill color={info.color}>{info.label}</Pill>
      {onCancel ? (
        <Button size="sm" variant="ghost" loading={cancelling} onClick={onCancel} aria-label={`Cancelar a oferta para ${offer.technician.name}`}>
          Cancelar
        </Button>
      ) : null}
    </li>
  );
}

/**
 * Bloco "Ofertas" da aba Geral (OS sem técnico): as ofertas da OS com o valor e a situação de cada uma
 * ("Vista às 14:41 · vence às 15:30", "Recusou: motivo", "Outro técnico aceitou"...), o "Cancelar" da
 * pendente, o texto para o grupo de técnicos e o "Ofertar com preço". Segue o acesso a Pagamentos: sem a
 * tela, só o contador das que aguardam resposta (sem valores); só com Visualizar, a lista sem as ações.
 * O "Ofertar" trava com alteração não salva na OS (como a Situação): a oferta leva a OS como está salva.
 */
export function OffersBlock({ ticket, locked, className }: { ticket: TicketDetail; locked: boolean; className?: string }) {
  const canView = useCan("commercial.payouts");
  const canEdit = useCan("commercial.payouts", "edit");
  const { toast } = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const now = useNow(30_000);
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const offers = useTicketOffers(ticket.id, canView);
  const place = useOfferPlace(ticket, canView);
  const cancel = useMutation({
    mutationFn: (offer: TicketOffer) => api.post<TicketOffer>(`/tickets/${ticket.id}/offers/${offer.id}/cancel`),
    onSuccess: (updated) => {
      queryClient.setQueryData<TicketOffer[]>(["ticket", ticket.id, "offers"], (list) =>
        list?.map((o) => (o.id === updated.id ? updated : o)),
      );
      toast({ title: `Oferta para ${updated.technician.name} cancelada`, tone: "success" });
    },
    onError: (error) => toast({ title: "Não foi possível cancelar a oferta", description: errorMessage(error), tone: "error" }),
    // O contador da OS (cabeçalho), o histórico e a lista como ficaram (o técnico pode ter respondido antes).
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id] }),
  });

  const offerable = canEdit && ticket.can_assign && !ticket.assignee && isOpenStatus(ticket.status);
  const counted = ticket.open_offers ?? 0;

  if (!canView) {
    if (!counted) return null;
    return (
      <p className={clsx("flex items-center gap-2 rounded-lg border border-line bg-surface-2/60 px-3 py-2 text-sm text-ink", className)}>
        <Send aria-hidden className="size-4 shrink-0 text-ink-subtle" />
        {counted === 1
          ? "Oferta enviada: aguardando o técnico aceitar pelo app."
          : `${counted} ofertas enviadas: aguardando os técnicos aceitarem pelo app.`}
      </p>
    );
  }

  // A trocada por uma oferta nova da mesma OS não aparece (a nova aparece no lugar).
  const list = (offers.data ?? []).filter((o) => o.cancel_reason !== "replaced");
  if (!offerable && !list.length && !counted) return null;
  const waiting = list.filter((o) => offerStateAt(o, now) === "pending").length;
  const batch = latestBatch(list, now);
  const visible = all ? list : list.slice(0, LIST_LIMIT);

  const askCancel = async (offer: TicketOffer) => {
    const ok = await confirm({
      title: `Cancelar a oferta para ${offer.technician.name}?`,
      description: "O técnico vê no app que a central cancelou a oferta e não consegue mais aceitar. As ofertas para os outros técnicos continuam.",
      confirmLabel: "Cancelar oferta",
      cancelLabel: "Voltar",
      tone: "danger",
    });
    if (ok) cancel.mutate(offer);
  };

  return (
    <div className={clsx("rounded-xl border border-line bg-surface-2/40 p-3", className)}>
      <SectionTitle
        wrap
        className="mb-1"
        aside={
          <>
            {batch.length ? (
              <button
                type="button"
                onClick={() => void copyGroupText(groupText(ticket, place, batch, Date.now()), toast)}
                className={buttonClassName("ghost", "sm", "h-7 px-2")}
              >
                Copiar texto para o grupo
              </button>
            ) : null}
            {offerable ? (
              <Button size="sm" onClick={() => setOpen(true)} disabled={locked}>
                <Send aria-hidden className="size-3.5" />
                Ofertar com preço
              </Button>
            ) : null}
          </>
        }
      >
        Ofertas
        {waiting ? <span className="font-medium text-ink-muted"> · {waiting} aguardando resposta</span> : null}
      </SectionTitle>
      {offerable && locked ? <p className="text-xs text-ink-subtle">Salve as alterações da OS para ofertar.</p> : null}

      {offers.isLoading ? (
        <div className="mt-2 flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : offers.error ? (
        <div className="mt-2">
          <ErrorBox message={`Não deu para carregar as ofertas: ${errorMessage(offers.error)}`} onRetry={() => void offers.refetch()} />
        </div>
      ) : list.length ? (
        <ul className="mt-1 divide-y divide-line" aria-label="Ofertas da OS">
          {visible.map((o) => (
            <OfferRow
              key={o.id}
              offer={o}
              now={now}
              onCancel={canEdit && offerStateAt(o, now) === "pending" ? () => void askCancel(o) : undefined}
              cancelling={cancel.isPending && cancel.variables?.id === o.id}
            />
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-ink-muted">
          Mande a OS com o valor para os técnicos escolhidos aceitarem pelo app. Quem aceitar primeiro fica com ela.
        </p>
      )}
      {list.length > LIST_LIMIT ? (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          aria-expanded={all}
          className="mt-1 text-xs font-semibold text-brand-ink hover:underline"
        >
          {all ? "Mostrar menos" : `Mostrar todas (${list.length})`}
        </button>
      ) : null}
      {open ? <OfferDialog ticket={ticket} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

/**
 * Depois de ofertar no resumo da OS recém-criada: para quem foi, o valor e o "Copiar texto para o grupo"
 * (o aviso some sozinho; este fica).
 */
export function OfferSentNote({ ticket, offers }: { ticket: TicketDetail; offers: TicketOffer[] }) {
  const { toast } = useToast();
  const place = useOfferPlace(ticket);
  const first = offers[0];
  if (!first) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink">
      <Send aria-hidden className="size-4 shrink-0 text-ink-subtle" />
      <p className="min-w-0 flex-1">
        Oferta enviada para {listNames(offers.map((o) => o.technician.name))} ·{" "}
        <span className="font-semibold tabular-nums">{formatMoney(first.amount)}</span>. Quem aceitar primeiro pelo app fica com a OS.
      </p>
      <button
        type="button"
        onClick={() => void copyGroupText(groupText(ticket, place, offers, Date.now()), toast)}
        className={buttonClassName("ghost", "sm", "h-7 px-2")}
      >
        Copiar texto para o grupo
      </button>
    </div>
  );
}
