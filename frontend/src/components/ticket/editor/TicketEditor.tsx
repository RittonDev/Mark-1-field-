"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  ArrowLeft,
  Ban,
  CircleCheck,
  Clock,
  Copy,
  ExternalLink,
  FileText,
  MapPin,
  MessageCircle,
  Navigation,
  RotateCcw,
  SquarePen,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { type TabItem, Tabs } from "@/components/motion";
import { AttachmentsTab, useTicketAttachments } from "@/components/ticket/AttachmentsTab";
import { CommentsTab } from "@/components/ticket/CommentsTab";
import { ExpensesCard } from "@/components/ticket/ExpensesCard";
import { ArrivalChip, OnsiteBar } from "@/components/ticket/FieldClock";
import { FormsCard } from "@/components/ticket/FormsCard";
import { eventPoint, FAR_FROM_STORE_M, km, storeDistance } from "@/components/ticket/geo";
import { HistoryTab } from "@/components/ticket/HistoryTab";
import { LegacyOrderCard } from "@/components/ticket/LegacyOrderCard";
import { PartRequestsCard } from "@/components/ticket/PartRequestsCard";
import { PayoutsCard } from "@/components/ticket/PayoutsCard";
import { QuotesCard } from "@/components/ticket/QuotesCard";
import { previewPath, reportMessage } from "@/components/ticket/ReportLinkCard";
import { ReportMenu } from "@/components/ticket/ReportMenu";
import { SlaCard } from "@/components/ticket/SlaCard";
import { TicketInfo } from "@/components/ticket/TicketInfo";
import { TicketLink } from "@/components/ticket/TicketLink";
import { hasRealTimes, TimesDialog } from "@/components/ticket/TimesDialog";
import { TransitionDialog } from "@/components/ticket/TransitionDialog";
import { UNPRODUCTIVE_FROM, UnproductiveDialog } from "@/components/ticket/UnproductiveDialog";
import { WhatsAppShare } from "@/components/ticket/WhatsAppShare";
import { WorklogsTab } from "@/components/ticket/WorklogsTab";
import { useToast } from "@/components/Toaster";
import { Button, buttonClassName, Card, CardHeader, ErrorBox, isTopLayer, Kbd, SectionTitle, Skeleton } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { STATUS } from "@/lib/constants";
import { formatDateTime, formatMinutes, formatShort } from "@/lib/format";
import { useDocumentTitle } from "@/lib/hooks";
import type { Comment, Quote, ReportLink, TicketDetail, TicketEvent, TicketStatus } from "@/lib/types";
import { copyText, whatsappUrl } from "@/lib/whatsapp";
import { GENERAL_FORM_ID, GeneralTab, type SaveState } from "./GeneralTab";
import { StatusMenu } from "./StatusMenu";
import { useUnsavedGuard } from "./useUnsavedGuard";

type TabKey = "geral" | "prazos" | "localizacao" | "vinculos" | "orcamentos" | "pecas" | "formularios" | "anexos" | "acompanhamentos" | "historico";

const TABS: { key: TabKey; label: string }[] = [
  { key: "geral", label: "Geral" },
  { key: "prazos", label: "Prazos" },
  { key: "localizacao", label: "Localização" },
  { key: "vinculos", label: "Vínculos" },
  { key: "orcamentos", label: "Orçamentos" },
  { key: "pecas", label: "Peças e custos" },
  { key: "formularios", label: "Formulários" },
  { key: "anexos", label: "Anexos" },
  { key: "acompanhamentos", label: "Acompanhamentos" },
  { key: "historico", label: "Histórico" },
];

/** Abas em que se muda algo ali mesmo (salva na hora); Localização, Vínculos e Histórico só mostram. */
const INLINE_TABS: TabKey[] = ["prazos", "orcamentos", "pecas", "formularios", "anexos", "acompanhamentos"];

const GPS_LABEL: Record<string, string> = {
  en_route: "Saída para o local",
  in_progress: "Início do atendimento",
  resolved: "Conclusão",
  unproductive_visit: "Visita improdutiva",
};

/** Pontos que provam a presença na loja (não a saída): longe dela, ficam marcados. */
const PRESENCE = new Set(["in_progress", "resolved", "unproductive_visit"]);

/** Situações que a OS explica no topo (quando, quem e o motivo), sem precisar cavar o Histórico. */
const STATUS_NOTICE: Partial<Record<TicketStatus, { verb: string; icon: typeof Ban }>> = {
  cancelled: { verb: "Cancelada", icon: Ban },
  closed: { verb: "Fechada", icon: CircleCheck },
  reopened: { verb: "Reaberta", icon: RotateCcw },
};

const eventsQuery = (ticketId: string) => ({
  queryKey: ["ticket", ticketId, "events"],
  queryFn: () => api.get<TicketEvent[]>(`/tickets/${ticketId}/events`),
});

/** A loja no mapa, quando o cadastro tem as coordenadas. */
function storeOf(ticket: TicketDetail): [number, number] | null {
  const loc = ticket.location;
  return loc?.latitude != null && loc?.longitude != null ? [loc.latitude, loc.longitude] : null;
}

/**
 * Loja no mapa e os pontos de GPS que o técnico registrou no app (saída, início, conclusão, visita
 * improdutiva), com a distância até a loja, como no histórico do Field Control. Mudança de situação
 * feita pela central não tem ponto: quem prova presença é o técnico, no local.
 */
function LocationTab({ ticket }: { ticket: TicketDetail }) {
  const events = useQuery(eventsQuery(ticket.id));
  const loc = ticket.location;
  const store = storeOf(ticket);
  const points = (events.data ?? [])
    .filter((e) => e.actor?.role === "technician" && (e.event_type === "status_changed" || e.event_type === "unproductive_visit"))
    .flatMap((e) => {
      const point = eventPoint(e.data);
      if (!point) return [];
      const kind = e.event_type === "unproductive_visit" ? e.event_type : (e.to_value ?? "");
      const meters = storeDistance(e.data, store);
      return [
        {
          id: e.id,
          label: GPS_LABEL[kind] ?? STATUS[kind as TicketStatus]?.label ?? kind,
          at: e.created_at,
          point,
          meters,
          far: PRESENCE.has(kind) && meters !== null && meters > FAR_FROM_STORE_M,
        },
      ];
    })
    .sort((a, b) => a.at.localeCompare(b.at));
  const bbox = store ? `${store[1] - 0.012},${store[0] - 0.007},${store[1] + 0.012},${store[0] + 0.007}` : null;
  const address = loc ? [loc.address_line, [loc.city, loc.state].filter(Boolean).join(" - ")].filter(Boolean).join(", ") : "";
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Card className="overflow-hidden">
        {store && bbox ? (
          <iframe
            title="Mapa da loja"
            src={`https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${store[0]},${store[1]}`}
            className="h-80 w-full border-0"
            loading="lazy"
          />
        ) : (
          <div className="flex flex-col items-start gap-3 p-6 text-sm text-ink-muted">
            <p>
              {loc
                ? "A loja não tem coordenadas no cadastro: sem elas não há mapa nem a distância do técnico até a loja."
                : "OS sem loja: escolha a loja na aba Geral."}
            </p>
            {loc ? (
              <Link href={`/locais/${loc.id}`} className={buttonClassName("secondary", "sm")}>
                <MapPin className="size-3.5" />
                Corrigir no cadastro do local
              </Link>
            ) : null}
          </div>
        )}
      </Card>
      <div className="flex flex-col gap-3">
        <Card className="p-4 text-sm">
          <SectionTitle>Loja</SectionTitle>
          <p className="mt-1 font-semibold text-ink">{loc ? [loc.name, loc.code].filter(Boolean).join(" - ") : "Sem loja"}</p>
          {loc ? <p className="mt-0.5 text-ink-muted">{address || "Sem endereço"}</p> : null}
          {ticket.service_address ? (
            <p className="mt-1.5 flex items-start gap-1 text-xs text-ink-muted">
              <MapPin className="mt-px size-3.5 shrink-0" />
              <span>
                Atendimento em: <span className="font-medium text-ink">{ticket.service_address}</span>
              </span>
            </p>
          ) : null}
        </Card>
        <Card className="p-4">
          <SectionTitle className="mb-2">GPS do técnico</SectionTitle>
          {events.isLoading ? (
            <div className="flex flex-col gap-2" role="status">
              <span className="sr-only">Carregando os pontos de GPS...</span>
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ) : events.error ? (
            <ErrorBox message={errorMessage(events.error)} onRetry={() => void events.refetch()} />
          ) : points.length === 0 ? (
            <p className="text-sm text-ink-muted">Nenhum ponto registrado pelo app do técnico.</p>
          ) : (
            <ul className="space-y-2.5 text-sm">
              {points.map((p) => (
                <li key={p.id} className="flex items-start gap-2">
                  <Navigation aria-hidden className="mt-0.5 size-3.5 shrink-0 text-ink-subtle" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold text-ink">{p.label}</span>
                    <span className="text-xs text-ink-muted">
                      {formatDateTime(p.at)}
                      {p.meters !== null ? ` · a ${km(p.meters)} da loja` : ""}
                      {p.far ? <span className="font-semibold text-red-700 dark:text-red-300"> · longe da loja</span> : null}
                    </span>
                  </span>
                  <a
                    href={`https://www.google.com/maps?q=${p.point[0]},${p.point[1]}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs font-medium text-brand hover:underline"
                    aria-label={`Ver no mapa: ${p.label}, ${formatDateTime(p.at)}`}
                  >
                    Ver
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

/** Ligações da OS: projeto, outras OS da loja (30 dias) e os dados de origem do Field Control. */
function LinksTab({ ticket }: { ticket: TicketDetail }) {
  const history = ticket.recurrence;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="p-4">
        <SectionTitle>Projeto</SectionTitle>
        {ticket.project ? (
          <Link href={`/projetos/${ticket.project.id}`} className="mt-1 inline-flex items-center gap-1 text-sm font-semibold text-brand hover:underline">
            {ticket.project.code} · {ticket.project.name}
            <ExternalLink className="size-3.5" />
          </Link>
        ) : (
          <p className="mt-1 text-sm text-ink-muted">OS avulsa (sem projeto). Troque na aba Geral.</p>
        )}
      </Card>
      <Card className="p-4">
        <SectionTitle
          className="mb-2"
          aside={
            history?.count_30d ? (
              <span className="rounded-full bg-surface-2 px-1.5 text-xs font-semibold text-ink tabular-nums">{history.count_30d}</span>
            ) : null
          }
        >
          Outras OS desta loja · 30 dias
        </SectionTitle>
        {history && history.previous.length ? (
          <ul className="flex flex-col gap-1">
            {history.previous.map((p) => (
              <li key={p.id}>
                {/* Abre no painel (no lugar desta OS); Ctrl+clique abre a página em outra aba. */}
                <TicketLink ticketId={p.id} className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-surface-2">
                  <span className="mt-0.5 font-mono text-[11px] text-ink-subtle">{p.code}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-ink">{p.title}</span>
                    <span className="text-[11px] text-ink-subtle">
                      {STATUS[p.status]?.label ?? p.status} · {formatDateTime(p.created_at)}
                    </span>
                  </span>
                </TicketLink>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-muted">Nenhuma outra OS na loja nos últimos 30 dias.</p>
        )}
      </Card>
      <div className="lg:col-span-2">
        <LegacyOrderCard ticket={ticket} />
      </div>
    </div>
  );
}

/** Prazos de SLA, chegada e tempo na loja, horários reais e apontamentos de horas. */
function DeadlinesTab({ ticket, onFixTimes }: { ticket: TicketDetail; onFixTimes: () => void }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <SlaCard ticket={ticket} />
      <Card>
        <CardHeader
          title="Atendimento em campo"
          actions={
            hasRealTimes(ticket) ? (
              <Button size="sm" variant="ghost" onClick={onFixTimes}>
                <Clock className="size-3.5" />
                Corrigir horários
              </Button>
            ) : null
          }
        />
        <div className="p-4">
          <div className="flex flex-col gap-2">
            <ArrivalChip ticket={ticket} />
            <OnsiteBar ticket={ticket} />
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-ink-muted">Início do atendimento</dt>
            <dd className="text-ink">{formatDateTime(ticket.arrived_at)}</dd>
            <dt className="text-ink-muted">Conclusão</dt>
            <dd className="text-ink">{formatDateTime(ticket.resolved_at)}</dd>
            <dt className="text-ink-muted">Tempo de atendimento</dt>
            <dd className="text-ink">{ticket.actual_minutes ? formatMinutes(ticket.actual_minutes) : "—"}</dd>
            <dt className="text-ink-muted">Duração estimada</dt>
            <dd className="text-ink">{ticket.estimated_minutes ? formatMinutes(ticket.estimated_minutes) : "—"}</dd>
          </dl>
        </div>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader title="Apontamentos de horas" description="Horas da central nesta OS (o tempo do técnico corre do início à conclusão)." />
        <div className="p-4">
          <WorklogsTab ticketId={ticket.id} closed={false} />
        </div>
      </Card>
    </div>
  );
}

/**
 * "Link do relatório da atividade" sempre à mão no topo da Geral: a central manda pelo WhatsApp o
 * dia todo. Antes da conclusão o relatório mostra o andamento; depois, o resultado.
 */
function ReportStrip({ ticket }: { ticket: TicketDetail }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const create = useMutation({
    mutationFn: () => api.post<ReportLink>(`/tickets/${ticket.id}/report-link`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id], exact: true });
      toast({ title: "Link do relatório criado", tone: "success" });
    },
    onError: (error) => toast({ title: "Não foi possível criar o link do relatório", description: errorMessage(error), tone: "error" }),
  });
  if (!ticket.can_assign) return null;
  const link = ticket.report_link ?? null;
  const shows =
    ticket.status === "cancelled"
      ? "mostra o cancelamento"
      : ticket.status === "resolved" || ticket.status === "closed"
        ? "mostra o resultado"
        : "mostra o andamento";
  const views = link?.views
    ? `aberto ${link.views}×${link.last_viewed_at ? `, último ${formatShort(link.last_viewed_at)}` : ""}`
    : "ainda não aberto pelo cliente";
  const copy = async () => {
    if (!link) return;
    toast(
      (await copyText(link.url))
        ? { title: "Link do relatório copiado", description: "Cole na conversa com o cliente.", tone: "success" }
        : { title: "Não foi possível copiar", description: "No rodapé, em Relatório > Gerenciar link, dá para selecionar o link.", tone: "error" },
    );
  };
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-surface px-4 py-2.5 shadow-elev-1">
      <FileText aria-hidden className="size-4 shrink-0 text-ink-subtle" />
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-sm font-semibold text-ink">Relatório do cliente</p>
        <p className="text-xs text-ink-muted">{link ? `Link ativo: ${shows} · ${views}` : "Link desativado: o cliente não abre o relatório."}</p>
      </div>
      {link ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" onClick={() => void copy()}>
            <Copy className="size-3.5" />
            Copiar link
          </Button>
          <a href={whatsappUrl(null, reportMessage(ticket, link.url))} target="_blank" rel="noreferrer" className={buttonClassName("secondary", "sm")}>
            <MessageCircle className="size-3.5" />
            WhatsApp
          </a>
          <a
            href={previewPath(link)}
            target="_blank"
            rel="noreferrer"
            className={buttonClassName("ghost", "sm")}
            aria-label="Ver o relatório como o cliente (abre em outra aba)"
          >
            <ExternalLink className="size-3.5" />
            Ver
          </a>
        </div>
      ) : (
        <Button size="sm" variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
          Criar link
        </Button>
      )}
    </div>
  );
}

/** Por que a OS está assim (cancelada, fechada, reaberta) e as visitas improdutivas, no topo de todas as abas. */
function StatusNotice({ ticket }: { ticket: TicketDetail }) {
  const notice = STATUS_NOTICE[ticket.status];
  const events = useQuery({ ...eventsQuery(ticket.id), enabled: Boolean(notice) });
  const last = notice
    ? (events.data ?? [])
        .filter((e) => e.event_type === "status_changed" && e.to_value === ticket.status)
        .reduce<TicketEvent | null>((latest, e) => (!latest || e.created_at > latest.created_at ? e : latest), null)
    : null;
  const unproductive = ticket.unproductive_count;
  if (!(notice && last) && !unproductive) return null;
  const Icon = notice?.icon ?? Ban;
  return (
    <div className="mb-4 flex flex-wrap items-start gap-2">
      {notice && last ? (
        <p className="flex min-w-0 flex-1 basis-72 items-start gap-2 rounded-xl border border-line bg-surface px-4 py-2.5 text-sm text-ink-muted shadow-elev-1">
          <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-subtle" />
          <span className="min-w-0">
            <span className="font-semibold text-ink">
              {notice.verb} em {formatDateTime(last.created_at)}
            </span>{" "}
            por {last.actor?.name ?? "Sistema"}
            {last.note ? (
              <>
                : <span className="whitespace-pre-wrap text-ink">{last.note}</span>
              </>
            ) : null}
          </span>
        </p>
      ) : null}
      {unproductive ? (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink-muted">
          <Ban aria-hidden className="size-3.5" />
          {unproductive === 1 ? "1 visita improdutiva" : `${unproductive} visitas improdutivas`}
          {ticket.last_unproductive_at ? ` · última ${formatShort(ticket.last_unproductive_at)}` : ""}
        </span>
      ) : null}
    </div>
  );
}

/** O editor está por cima de tudo (nenhum diálogo ou menu aberto sobre ele): os atalhos valem. */
function editorOnTop(root: HTMLElement) {
  const modal = root.closest('[aria-modal="true"]');
  return modal ? isTopLayer(modal) : !document.querySelector('[aria-modal="true"], [role="menu"]');
}

// Ações do rodapé: só o ícone no celular; com o nome ao lado em telas largas (o title não aparece no toque).
const footerAction =
  "inline-flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-lg px-2 text-ink-muted transition-colors hover:bg-surface-3 " +
  "hover:text-ink focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40";

/**
 * A OS no formato do "Editar atividade" do Field Control: cabeçalho, abas e rodapé com Salvar e as
 * ações. Tudo editável pela central a qualquer momento, aberta ou fechada.
 */
export function TicketEditor({
  ticket,
  variant,
  onClose,
  onDirtyChange,
}: {
  ticket: TicketDetail;
  variant: "page" | "dialog";
  /** Fechar o painel (no painel lateral: ele pergunta antes se há alteração não salva). */
  onClose?: () => void;
  /** Avisa quem abriu quando a aba Geral passa a ter (ou deixa de ter) alteração não salva. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [tab, setTab] = useState<TabKey>("geral");
  const [saveState, setSaveState] = useState<SaveState>({ dirty: false, pending: false, conflict: false });
  const onSaveState = useCallback((state: SaveState) => setSaveState(state), []);
  const [transition, setTransition] = useState<TicketStatus | null>(null);
  const [sharing, setSharing] = useState(false);
  const [unproductive, setUnproductive] = useState(false);
  const [timesOpen, setTimesOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // Onde a Geral estava: ao voltar para ela, a rolagem continua dali; as outras abas abrem no topo.
  const generalTop = useRef(0);
  // Ids próprios: a página da OS e o painel por cima dela podem estar abertos juntos.
  const uid = useId();
  const formId = `${GENERAL_FORM_ID}-${uid}`;
  const tabsId = `os-${uid}`;
  const dirty = saveState.dirty;
  const canUnproductive = UNPRODUCTIVE_FROM.includes(ticket.status) && Boolean(ticket.assignee);
  const canFixTimes = hasRealTimes(ticket);
  const reopenable = (ticket.status === "closed" || ticket.status === "cancelled") && ticket.allowed_transitions.includes("reopened");

  useUnsavedGuard(dirty);
  useDocumentTitle(`${ticket.code} · ${ticket.title}`);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // Contadores das abas, como o "Anexos (6)" do Field Control (a consulta já adianta a aba).
  const attachments = useTicketAttachments(ticket.id);
  const comments = useQuery({
    queryKey: ["ticket", ticket.id, "comments"],
    queryFn: () => api.get<Comment[]>(`/tickets/${ticket.id}/comments`),
  });
  const quotes = useQuery({
    queryKey: ["ticket", ticket.id, "quotes"],
    queryFn: () => api.get<Quote[]>(`/tickets/${ticket.id}/quotes`),
  });
  const pendingForms = ticket.forms.filter((f) => f.required && f.status !== "completed").length;
  const counts: Partial<Record<TabKey, number>> = {
    orcamentos: quotes.data?.length,
    pecas: (ticket.part_requests?.length ?? 0) + ticket.expenses.length,
    formularios: ticket.forms.length,
    anexos: attachments.data?.length,
    acompanhamentos: comments.data?.length,
  };
  const tabs: TabItem<TabKey>[] = TABS.map((t) => ({
    key: t.key,
    label:
      t.key === "formularios" && pendingForms ? (
        <>
          {t.label}
          <span className="sr-only">
            , {pendingForms} {pendingForms === 1 ? "obrigatório pendente" : "obrigatórios pendentes"}
          </span>
        </>
      ) : (
        t.label
      ),
    count: counts[t.key] || null,
  }));

  const changeTab = (next: TabKey) => {
    if (tab === "geral" && scroller.current) generalTop.current = scroller.current.scrollTop;
    setTab(next);
  };
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = tab === "geral" ? generalTop.current : 0;
  }, [tab]);

  // Salvar de outra aba: volta para a Geral antes (os erros aparecem nos campos) e envia o formulário.
  const saveGeneral = () => {
    if (tab !== "geral") flushSync(() => changeTab("geral"));
    (document.getElementById(formId) as HTMLFormElement | null)?.requestSubmit();
  };

  // Ctrl+S (e Ctrl+Enter num campo da Geral) salva; o Ctrl+S nunca abre o "salvar página" do navegador.
  const onShortcut = useEffectEvent((e: KeyboardEvent) => {
    if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const key = e.key.toLowerCase();
    if (key !== "s" && key !== "enter") return;
    const node = root.current;
    if (!node || !editorOnTop(node)) return;
    if (key === "enter" && !document.getElementById(formId)?.contains(document.activeElement)) return;
    e.preventDefault();
    if (saveState.dirty && !saveState.pending) saveGeneral();
  });
  useEffect(() => {
    const listener = (e: KeyboardEvent) => onShortcut(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // Na página a OS é o título principal; no painel lateral, o título do diálogo.
  const Heading = variant === "page" ? "h1" : "h2";
  const saveLabel = saveState.conflict ? (
    "Salvar mesmo assim"
  ) : tab === "geral" ? (
    "Salvar"
  ) : (
    <>
      <span className="sm:hidden">Salvar (Geral)</span>
      <span className="hidden sm:inline">Salvar alterações (Geral)</span>
    </>
  );

  return (
    <div
      ref={root}
      className={clsx(
        "flex flex-col overflow-hidden bg-surface",
        // No painel lateral ocupa a altura toda (o painel já tem a borda e a sombra). Na página, a altura
        // da tela: as abas rolam por dentro e o Salvar fica sempre à vista, como no painel.
        variant === "dialog" ? "h-full" : "h-[calc(100dvh-8rem)] min-h-[32rem] rounded-2xl border border-line shadow-elev-2",
      )}
    >
      {/* Azul forte no escuro: o branco fica em 5,2:1 (no brand, 4,1:1). Texto no mínimo white/90 e, no escuro, hover do link mais
          leve (o sublinhado é que marca o hover): tudo acima de 4,5:1. Foco em branco: o anel padrão é azul e sumiria aqui. */}
      <div className="flex items-center gap-3 bg-brand px-5 py-3 text-white dark:bg-brand-strong">
        {variant === "page" ? (
          <Link
            href="/chamados"
            className="rounded-md p-1 text-white/80 hover:bg-white/10 hover:text-white focus-visible:outline-white"
            aria-label="Voltar para Chamados"
          >
            <ArrowLeft className="size-4" />
          </Link>
        ) : (
          <SquarePen aria-hidden className="size-4 shrink-0 text-white/80" />
        )}
        <Heading className="min-w-0 flex-1 truncate text-[15px] font-bold tracking-[-0.01em]" title={`${ticket.code} · ${ticket.title}`}>
          <span className="font-mono">{ticket.code}</span>
          <span className="ml-2 font-normal text-white/90">{ticket.title}</span>
        </Heading>
        {reopenable && !dirty ? (
          <button
            type="button"
            onClick={() => setTransition("reopened")}
            className="hidden h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold text-white ring-1 ring-white/40 ring-inset transition-colors hover:bg-white/10 focus-visible:outline-white sm:inline-flex"
          >
            <RotateCcw aria-hidden className="size-3.5" />
            Reabrir
          </button>
        ) : null}
        <div className="shrink-0">
          <StatusMenu status={ticket.status} targets={ticket.allowed_transitions} locked={dirty} onPick={setTransition} />
        </div>
        {variant === "dialog" ? (
          <>
            <Link
              href={`/chamados/${ticket.id}`}
              className="hidden shrink-0 rounded-md px-2 py-1 text-xs font-medium text-white hover:bg-white/10 hover:underline focus-visible:outline-white sm:inline-flex dark:hover:bg-white/5"
            >
              Abrir em página
            </Link>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-md p-1 text-white/85 hover:bg-white/10 hover:text-white focus-visible:outline-white"
              aria-label="Fechar"
            >
              <X className="size-5" />
            </button>
          </>
        ) : null}
      </div>

      <div className="border-b border-line px-3">
        <Tabs items={tabs} value={tab} onChange={changeTab} ariaLabel="Seções da OS" idPrefix={tabsId} />
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto bg-[var(--canvas,transparent)] px-5 py-5">
        <StatusNotice ticket={ticket} />
        {/* A Geral fica montada (escondida) nas outras abas: o que se digitou não se perde ao trocar de aba. */}
        <div role="tabpanel" id={`${tabsId}-panel-geral`} aria-labelledby={`${tabsId}-tab-geral`} hidden={tab !== "geral"}>
          <ReportStrip ticket={ticket} />
          <GeneralTab ticket={ticket} formId={formId} onSaveState={onSaveState} onTransition={setTransition} />
        </div>
        {tab !== "geral" ? (
          <div role="tabpanel" id={`${tabsId}-panel-${tab}`} aria-labelledby={`${tabsId}-tab-${tab}`}>
            {tab === "prazos" ? <DeadlinesTab ticket={ticket} onFixTimes={() => setTimesOpen(true)} /> : null}
            {tab === "localizacao" ? <LocationTab ticket={ticket} /> : null}
            {tab === "vinculos" ? <LinksTab ticket={ticket} /> : null}
            {tab === "orcamentos" ? <QuotesCard ticket={ticket} /> : null}
            {tab === "pecas" ? (
              <div className="flex flex-col gap-4">
                <PartRequestsCard ticket={ticket} />
                <PayoutsCard ticket={ticket} />
                <ExpensesCard ticket={ticket} />
              </div>
            ) : null}
            {tab === "formularios" ? <FormsCard ticket={ticket} /> : null}
            {tab === "anexos" ? <AttachmentsTab ticketId={ticket.id} closed={false} canManage signatureId={ticket.signature_attachment_id} /> : null}
            {tab === "acompanhamentos" ? <CommentsTab ticketId={ticket.id} /> : null}
            {tab === "historico" ? (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
                <Card className="p-4">
                  <HistoryTab ticketId={ticket.id} store={storeOf(ticket)} />
                </Card>
                <div className="flex flex-col gap-4">
                  <TicketInfo ticket={ticket} />
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line bg-surface-2/60 px-5 py-3">
        {tab === "geral" || dirty ? (
          <div className="flex items-center gap-3">
            {/* Na Geral é o envio do formulário (Enter num campo também salva); nas outras abas, volta para ela e salva. */}
            <Button
              type={tab === "geral" ? "submit" : "button"}
              form={tab === "geral" ? formId : undefined}
              onClick={tab === "geral" ? undefined : saveGeneral}
              variant="primary"
              disabled={!dirty}
              loading={saveState.pending}
              aria-keyshortcuts="Control+S"
              className="relative"
            >
              {saveLabel}
              {dirty ? <span aria-hidden className="absolute -top-1 -right-1 size-2.5 rounded-full bg-amber-500 ring-2 ring-surface sm:hidden" /> : null}
            </Button>
            {dirty ? <span className="sr-only text-xs font-medium text-amber-700 sm:not-sr-only dark:text-amber-300">Alterações não salvas</span> : null}
            <span aria-hidden className="hidden items-center gap-1 text-[11px] text-ink-subtle lg:inline-flex">
              <Kbd>Ctrl</Kbd>
              <Kbd>S</Kbd>
            </span>
          </div>
        ) : INLINE_TABS.includes(tab) ? (
          <span className="text-xs text-ink-muted">O que muda nesta aba é salvo na hora.</span>
        ) : null}
        <div className="ml-auto flex items-center gap-0.5">
          <button type="button" className={footerAction} onClick={() => setSharing(true)} title="Mensagens de WhatsApp" aria-label="Mensagens de WhatsApp">
            <MessageCircle aria-hidden className="size-[18px]" />
            <span className="hidden text-xs font-medium lg:inline">WhatsApp</span>
          </button>
          {/* O nome ao lado do ícone (telas largas) vem do CSS: o menu do relatório só desenha o ícone. */}
          <ReportMenu ticket={ticket} buttonClassName={clsx(footerAction, "lg:after:text-xs lg:after:font-medium lg:after:content-['Relatório']")} />
          <button
            type="button"
            className={footerAction}
            onClick={() => setTimesOpen(true)}
            disabled={!canFixTimes}
            title={canFixTimes ? "Corrigir horários" : "Corrigir horários: o técnico ainda não saiu para o local"}
            aria-label="Corrigir horários"
          >
            <Clock aria-hidden className="size-[18px]" />
            <span className="hidden text-xs font-medium lg:inline">Horários</span>
          </button>
          {canUnproductive ? (
            <button type="button" className={footerAction} onClick={() => setUnproductive(true)} title="Visita improdutiva" aria-label="Visita improdutiva">
              <Ban aria-hidden className="size-[18px]" />
              <span className="hidden text-xs font-medium lg:inline">Improdutiva</span>
            </button>
          ) : null}
        </div>
      </div>

      {transition ? (
        <TransitionDialog
          key={transition}
          ticket={ticket}
          to={transition}
          onClose={() => setTransition(null)}
          onOpenForms={() => {
            setTransition(null);
            changeTab("formularios");
          }}
        />
      ) : null}
      {sharing ? <WhatsAppShare ticket={ticket} onClose={() => setSharing(false)} /> : null}
      {timesOpen ? <TimesDialog ticket={ticket} onClose={() => setTimesOpen(false)} /> : null}
      {unproductive ? (
        <UnproductiveDialog
          ticket={ticket}
          onClose={() => setUnproductive(false)}
          // A OS volta para Atribuído sem agenda: o próximo passo é marcar a nova visita.
          onDone={(updated) => {
            if (updated.allowed_transitions.includes("scheduled")) setTransition("scheduled");
          }}
        />
      ) : null}
    </div>
  );
}
