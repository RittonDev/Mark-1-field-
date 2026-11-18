"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  Ban,
  CircleCheck,
  ClipboardList,
  Clock,
  Copy,
  ExternalLink,
  FileText,
  History,
  LayoutList,
  Link2,
  type LucideIcon,
  MapPin,
  MapPinOff,
  MessageCircle,
  MessagesSquare,
  Navigation,
  Package,
  Paperclip,
  RotateCcw,
  Timer,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { nextDue } from "@/components/badges";
import { AttachmentsTab, useTicketAttachments } from "@/components/ticket/AttachmentsTab";
import { CommentsTab } from "@/components/ticket/CommentsTab";
import { ExpensesCard } from "@/components/ticket/ExpensesCard";
import { ArrivalChip, OnsiteBar } from "@/components/ticket/FieldClock";
import { FormsCard } from "@/components/ticket/FormsCard";
import { eventPoint, FAR_FROM_STORE_M, km, storeDistance } from "@/components/ticket/geo";
import { HistoryTab } from "@/components/ticket/HistoryTab";
import { LegacyOrderCard } from "@/components/ticket/LegacyOrderCard";
import { GroupTextsMenu } from "@/components/ticket/MessagesPanel";
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
import { Button, buttonClassName, Card, CardHeader, EmptyState, ErrorBox, Kbd, SectionTitle, Skeleton } from "@/components/ui";
import { useNow } from "@/components/useNow";
import { api, errorMessage } from "@/lib/api";
import { STATUS } from "@/lib/constants";
import { formatDateTime, formatMinutes, formatShort } from "@/lib/format";
import { useDocumentTitle } from "@/lib/hooks";
import { useCan } from "@/lib/permissions";
import type { Comment, Quote, ReportLink, TicketDetail, TicketEvent, TicketStatus } from "@/lib/types";
import { copyText, type GroupText, groupTextsQuery, whatsappUrl } from "@/lib/whatsapp";
import { GENERAL_FORM_ID, GeneralTab, GeneralView, type SaveState } from "./GeneralTab";
import { type HeaderJump, slaView, TicketHeader } from "./TicketHeader";
import { type TicketTabAlert, type TicketTabItem, TicketTabs } from "./TicketTabs";
import { useUnsavedGuard } from "./useUnsavedGuard";

type TabKey = "geral" | "prazos" | "localizacao" | "vinculos" | "orcamentos" | "pecas" | "formularios" | "anexos" | "acompanhamentos" | "historico";

/** Na ordem do "Editar atividade" do Field Control. Orçamentos e Formulários com o ícone do menu. */
const TABS: { key: TabKey; label: string; icon: LucideIcon }[] = [
  { key: "geral", label: "Geral", icon: LayoutList },
  { key: "prazos", label: "Prazos", icon: Timer },
  { key: "localizacao", label: "Localização", icon: MapPin },
  { key: "vinculos", label: "Vínculos", icon: Link2 },
  { key: "orcamentos", label: "Orçamentos", icon: FileText },
  { key: "pecas", label: "Peças e custos", icon: Package },
  { key: "formularios", label: "Formulários", icon: ClipboardList },
  { key: "anexos", label: "Anexos", icon: Paperclip },
  { key: "acompanhamentos", label: "Acompanhamentos", icon: MessagesSquare },
  { key: "historico", label: "Histórico", icon: History },
];

/** Abas em que se muda algo ali mesmo (salva na hora); Localização, Vínculos e Histórico só mostram. */
const INLINE_TABS: TabKey[] = ["prazos", "orcamentos", "pecas", "formularios", "anexos", "acompanhamentos"];

/** Altura máxima do resumo do cabeçalho no celular (max-sm:max-h-[4.5rem] do TicketHeader), em px. */
const SUMMARY_MAX_PX = 72;

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
  // "Corrigir no cadastro" leva a Locais: só para quem altera locais.
  const canFixLocation = useCan("base.locations", "edit");
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
          <EmptyState
            icon={<MapPinOff />}
            title={loc ? "Loja sem coordenadas" : "OS sem loja"}
            description={loc ? "Sem elas não há mapa nem a distância do técnico até a loja." : "Escolha a loja na aba Geral."}
            action={
              loc && canFixLocation ? (
                <Link href={`/locais/${loc.id}`} className={buttonClassName("secondary", "sm")}>
                  <MapPin className="size-3.5" />
                  Corrigir no cadastro do local
                </Link>
              ) : null
            }
          />
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
            // O formato da lista de pontos (ícone, o que foi e quando), no lugar do "Carregando...".
            <div className="flex flex-col gap-3" role="status">
              <span className="sr-only">Carregando os pontos de GPS...</span>
              {[0, 1].map((i) => (
                <div key={i} className="flex items-start gap-2" style={{ opacity: 1 - i * 0.25 }}>
                  <Skeleton className="mt-0.5 size-3.5 shrink-0 rounded-full" />
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Skeleton className="h-3.5 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : events.error ? (
            <ErrorBox message={errorMessage(events.error)} onRetry={() => void events.refetch()} />
          ) : points.length === 0 ? (
            <EmptyState size="sm" icon={<Navigation />} title="Nenhum ponto de GPS" description="O app do técnico marca a saída, o início e a conclusão." />
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
                    className="text-xs font-medium text-brand-ink hover:underline"
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
  // O projeto vira link só para quem abre Projetos (sem acesso, a tela seria "Sem acesso").
  const canProjects = useCan("commercial.projects");
  const history = ticket.recurrence;
  if (!ticket.project && !history?.previous.length && !ticket.legacy) {
    return (
      <Card>
        <EmptyState
          icon={<Link2 />}
          title="Nenhum vínculo"
          description="OS avulsa (o projeto se escolhe na aba Geral) e sem outras OS nesta loja nos últimos 30 dias."
        />
      </Card>
    );
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="p-4">
        <SectionTitle>Projeto</SectionTitle>
        {ticket.project && canProjects ? (
          <Link href={`/projetos/${ticket.project.id}`} className="mt-1 inline-flex items-center gap-1 text-sm font-semibold text-brand-ink hover:underline">
            {ticket.project.code} · {ticket.project.name}
            <ExternalLink className="size-3.5" />
          </Link>
        ) : ticket.project ? (
          <p className="mt-1 text-sm font-semibold text-ink">
            {ticket.project.code} · {ticket.project.name}
          </p>
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

/** Antes de o técnico sair para o local: o texto da vez é a confirmação da atividade (como na API). */
const BEFORE_FIELD: TicketStatus[] = ["new", "triage", "assigned", "scheduled", "reopened"];

/** Nomes dos modelos padrão, para o aviso ao leitor de tela enquanto os textos não foram lidos. */
const GROUP_TEXT_NAMES: Record<string, string> = {
  agendamento: "Atividade confirmada",
  deslocamento: "Técnico em deslocamento",
  chegada: "Técnico chegou",
  atraso: "Atraso na chegada",
  fechamento: "Atividade encerrada",
  improdutiva: "Visita improdutiva",
};

/**
 * O texto do momento da OS (a chave do modelo), pela mesma regra com que a API marca o sugerido, com
 * os dados que a tela já tem (sem buscar os textos). Só decide o destaque do botão: quem marca o texto
 * no menu continua sendo a API.
 */
function groupMoment(t: TicketDetail, now: number): string | null {
  switch (t.status) {
    case "cancelled":
      return null;
    case "resolved":
    case "closed":
      return "fechamento";
    case "in_progress":
      return "chegada";
    case "en_route":
      return t.arrival_due_at && Date.parse(t.arrival_due_at) < now ? "atraso" : "deslocamento";
  }
  // A última ida a campo terminou em visita improdutiva e a OS ainda não foi remarcada.
  if (t.last_unproductive_at && !t.scheduled_start) return "improdutiva";
  return BEFORE_FIELD.includes(t.status) && t.assignee && t.scheduled_start ? "agendamento" : null;
}

/**
 * O modelo que o menu vai marcar, quando os textos já foram lidos: a gestão pode ter tirado um modelo
 * em Textos (sem o de atraso, vale o de deslocamento, como na API).
 */
function availableMoment(moment: string | null, list: GroupText[] | undefined): string | null {
  if (!moment || !list) return moment;
  const keys = moment === "atraso" ? ["atraso", "deslocamento"] : [moment];
  return keys.find((k) => list.some((m) => m.key === k)) ?? null;
}

/**
 * "Textos para o grupo" no rodapé, sempre à vista: atividade confirmada, técnico em deslocamento,
 * atividade encerrada com o link do relatório... Quando a OS muda de momento com ela aberta (ex.: o
 * técnico saiu para o local), o botão ganha um destaque e o leitor de tela avisa, até a pessoa abrir o
 * menu.
 *
 * Os textos só são buscados ao abrir o menu: a API cria o link do relatório da OS sem link ao montar
 * os textos, e só ver a OS não pode criar (nem trazer de volta um link desativado). O destaque vem da
 * situação da OS que a tela já tem.
 */
function GroupTexts({ ticket, synced }: { ticket: TicketDetail; synced: boolean }) {
  const queryClient = useQueryClient();
  // O atraso depende da hora: passou o prazo de chegada, o texto da vez muda.
  const now = useNow(30_000);
  // Só lê o que o menu (ou outra tela) já buscou: desligada, esta leitura nunca busca nem relê.
  const texts = useQuery({ ...groupTextsQuery(ticket.id), enabled: false });
  const current = availableMoment(groupMoment(ticket, now), texts.data);
  // O momento que a pessoa já viu (ao abrir a OS ou o menu). Só vale a OS lida do servidor depois que a
  // tela abriu: a guardada de antes pode ser antiga, e o que mudou com ela fechada não é novidade aqui.
  const [seen, setSeen] = useState<string | null | undefined>(undefined);
  if (seen === undefined && synced) setSeen(current);
  const fresh = seen !== undefined && current !== null && current !== seen;
  const name = current ? (texts.data ? texts.data.find((m) => m.key === current)?.name : GROUP_TEXT_NAMES[current]) : undefined;

  // Os textos trazem o link do relatório, e a API acabou de criá-lo se a OS estava sem: relê a OS para o
  // topo da Geral e o menu do relatório mostrarem o link que agora existe.
  const handled = useRef(texts.dataUpdatedAt);
  const syncLink = useEffectEvent((updatedAt: number) => {
    if (updatedAt <= handled.current) return;
    handled.current = updatedAt;
    if (!ticket.report_link) void queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id], exact: true });
  });
  useEffect(() => {
    syncLink(texts.dataUpdatedAt);
  }, [texts.dataUpdatedAt]);

  const markSeen = () => setSeen(current);
  return (
    // Na captura: o botão do menu para o clique (para não abrir a OS numa linha de lista). As setas
    // também abrem o menu, sem clique; Enter e Espaço chegam como clique.
    <span
      className="relative mr-1 inline-flex"
      onClickCapture={markSeen}
      onKeyDownCapture={(e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") markSeen();
      }}
    >
      <GroupTextsMenu ticketId={ticket.id} size="sm" className={fresh ? "ring-2 ring-brand/40" : undefined} />
      {fresh ? <span aria-hidden className="pointer-events-none absolute -top-1 -right-1 size-2.5 rounded-full bg-brand ring-2 ring-surface" /> : null}
      <span role="status" className="sr-only">
        {fresh ? `Novo texto sugerido para o grupo${name ? `: ${name}` : ""}` : ""}
      </span>
    </span>
  );
}

/** O menu é do editor: está dentro dele ou é aberto por um botão dele (os textos para o grupo vão no <body>). */
function ownMenu(root: HTMLElement, menu: Element) {
  return root.contains(menu) || (!!menu.id && !!root.querySelector(`[aria-controls="${CSS.escape(menu.id)}"]`));
}

/**
 * O editor está por cima de tudo (nenhum diálogo, nem menu de fora, aberto sobre ele): os atalhos valem.
 * Os menus do próprio editor (situação, "Mais", relatório, textos para o grupo) não contam: com eles
 * abertos, o Ctrl+S ainda salva, em vez de abrir o "Salvar página" do navegador.
 */
function editorOnTop(root: HTMLElement) {
  const layers = Array.from(document.querySelectorAll('[aria-modal="true"], [role="menu"]')).filter(
    (el) => el.getAttribute("role") !== "menu" || !ownMenu(root, el),
  );
  const modal = root.closest('[aria-modal="true"]');
  return modal ? layers[layers.length - 1] === modal : layers.length === 0;
}

// Ações do rodapé: só o ícone no celular; com o nome ao lado em telas largas (o title não aparece no toque).
const footerAction =
  "inline-flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-lg px-2 text-ink-muted transition-colors hover:bg-surface-3 " +
  "hover:text-ink focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40";

const FINISHED: TicketStatus[] = ["resolved", "closed", "cancelled"];

/**
 * Alerta da aba Prazos, contado ao vivo como o resumo do cabeçalho: vencido (SLA, chegada ou tempo na
 * loja) em vermelho; em risco em âmbar. A situação que a API mandou vale também (ex.: resolvida fora do prazo).
 */
function deadlineAlert(t: TicketDetail, now: number): TicketTabAlert | null {
  const due = nextDue(t);
  // O SLA com a mesma conta ao vivo do chip do cabeçalho (em risco a 75% do prazo, sem esperar a releitura).
  const sla = slaView(t, now);
  const arrivalDue = !t.arrived_at && !FINISHED.includes(t.status) && t.arrival_due_at ? Date.parse(t.arrival_due_at) : null;
  const onsiteDue = t.status === "in_progress" && t.onsite_due_at ? Date.parse(t.onsite_due_at) : null;
  const late =
    t.sla_status === "breached" ||
    sla.tone === "late" ||
    (due !== null && !t.sla_paused_at && Date.parse(due.at) < now) ||
    t.arrival_status === "late" ||
    (arrivalDue !== null && arrivalDue < now) ||
    t.onsite_status === "over" ||
    (onsiteDue !== null && onsiteDue < now);
  if (late) return { tone: "danger", label: "prazo vencido" };
  const risk =
    t.sla_status === "at_risk" ||
    sla.tone === "risk" ||
    t.arrival_status === "at_risk" ||
    (arrivalDue !== null && arrivalDue - now <= 60 * 60_000) ||
    t.onsite_status === "warning";
  return risk ? { tone: "warning", label: "prazo em risco" } : null;
}

/** A barra de abas com o alerta de prazo ao vivo: só ela redesenha a cada 30 s (a Geral, não). */
function EditorTabs({
  ticket,
  items,
  value,
  onChange,
  idPrefix,
}: {
  ticket: TicketDetail;
  items: TicketTabItem<TabKey>[];
  value: TabKey;
  onChange: (key: TabKey) => void;
  idPrefix: string;
}) {
  const now = useNow(30_000);
  const alert = deadlineAlert(ticket, now);
  return (
    <TicketTabs
      items={alert ? items.map((item) => (item.key === "prazos" ? { ...item, alert } : item)) : items}
      value={value}
      onChange={onChange}
      idPrefix={idPrefix}
      ariaLabel="Seções da OS"
    />
  );
}

/**
 * Leva ao campo da Geral pelo rótulo (o resumo do cabeçalho abre o Colaborador e a data): rola até ele e
 * foca o campo. Na Geral só de leitura, só rola até o dado.
 */
function focusGeneralField(panel: HTMLElement | null, label: string) {
  if (!panel) return;
  const target = Array.from(panel.querySelectorAll<HTMLElement>("label, dt")).find(
    (el) => (el.tagName === "LABEL" ? el.firstElementChild?.textContent : el.textContent)?.trim() === label,
  );
  if (!target) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  target.querySelector<HTMLElement>("input, select, textarea, button")?.focus({ preventScroll: true });
}

/**
 * A OS no formato do "Editar atividade" do Field Control: cabeçalho, abas e rodapé com Salvar e as
 * ações. Tudo editável pela central a qualquer momento, aberta ou fechada.
 */
export function TicketEditor({
  ticket,
  variant,
  synced = true,
  onClose,
  onDirtyChange,
}: {
  ticket: TicketDetail;
  variant: "page" | "dialog";
  /**
   * A OS em tela veio do servidor depois que a tela abriu (ou tinha acabado de vir). Falso enquanto se
   * mostra a OS guardada de antes e a releitura não chegou.
   */
  synced?: boolean;
  /** Fechar o painel (no painel lateral: ele pergunta antes se há alteração não salva). */
  onClose?: () => void;
  /** Avisa quem abriu quando a aba Geral passa a ter (ou deixa de ter) alteração não salva. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [tab, setTab] = useState<TabKey>("geral");
  // Já trocou de aba: a Geral passa a entrar com a mesma animação das outras ao voltar (não ao abrir a OS).
  const [switched, setSwitched] = useState(false);
  // Conteúdo rolado: a borda das abas vira sombra (> 4 px) e, no celular, o resumo do cabeçalho recolhe (> 24 px).
  const [scroll, setScroll] = useState({ shadow: false, collapsed: false });
  const [saveState, setSaveState] = useState<SaveState>({ dirty: false, pending: false, conflict: false });
  const onSaveState = useCallback((state: SaveState) => setSaveState(state), []);
  const [transition, setTransition] = useState<TicketStatus | null>(null);
  const [sharing, setSharing] = useState(false);
  const [unproductive, setUnproductive] = useState(false);
  // Depois da visita improdutiva: o "Agendar visita" abre quando a OS nova (sem a agenda antiga) chegar aqui.
  const [rescheduleAt, setRescheduleAt] = useState<number | null>(null);
  if (rescheduleAt !== null && ticket.version >= rescheduleAt) {
    setRescheduleAt(null);
    if (ticket.allowed_transitions.includes("scheduled")) setTransition("scheduled");
  }
  const [timesOpen, setTimesOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // Onde a Geral estava: ao voltar para ela, a rolagem continua dali; as outras abas abrem no topo.
  const generalTop = useRef(0);
  // Ids próprios: a página da OS e o painel por cima dela podem estar abertos juntos.
  const uid = useId();
  const formId = `${GENERAL_FORM_ID}-${uid}`;
  const tabsId = `os-${uid}`;
  // Quem não edita a OS vê a Geral só para leitura (sem Salvar nem alteração pendente).
  const editable = ticket.can_edit;
  const dirty = editable && saveState.dirty;
  const canUnproductive = UNPRODUCTIVE_FROM.includes(ticket.status) && Boolean(ticket.assignee);
  const reopenable = (ticket.status === "closed" || ticket.status === "cancelled") && ticket.allowed_transitions.includes("reopened");

  useUnsavedGuard(dirty);
  useDocumentTitle(`${ticket.code} · ${ticket.title}`);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // Perfil de acesso: a aba Orçamentos e os blocos de pagamento e de custos seguem as telas do Comercial
  // (a API também esvazia o que a pessoa não vê).
  const canQuotes = useCan("commercial.quotes");
  const canPayouts = useCan("commercial.payouts");
  const canExpenses = useCan("commercial.expenses");

  // Contadores das abas, como o "Anexos (6)" do Field Control (a consulta já adianta a aba).
  const attachments = useTicketAttachments(ticket.id);
  const comments = useQuery({
    queryKey: ["ticket", ticket.id, "comments"],
    queryFn: () => api.get<Comment[]>(`/tickets/${ticket.id}/comments`),
  });
  const quotes = useQuery({
    queryKey: ["ticket", ticket.id, "quotes"],
    queryFn: () => api.get<Quote[]>(`/tickets/${ticket.id}/quotes`),
    enabled: canQuotes,
  });
  // Obrigatório pendente vira alerta (na OS cancelada, não trava mais nada).
  const pendingForms =
    ticket.status === "cancelled" ? 0 : ticket.forms.filter((f) => f.required && f.status !== "completed").length;
  const openParts = (ticket.part_requests ?? []).filter((p) => p.status === "open").length;
  const counts: Partial<Record<TabKey, number>> = {
    orcamentos: quotes.data?.length,
    // Só o que aparece na aba: pedidos de peça sempre; custos com acesso a Custos extras.
    pecas: (ticket.part_requests?.length ?? 0) + (canExpenses ? ticket.expenses.length : 0),
    formularios: pendingForms || ticket.forms.length,
    anexos: attachments.data?.length,
    acompanhamentos: comments.data?.length,
  };
  const alerts: Partial<Record<TabKey, TicketTabAlert>> = {
    // O contador passa a ser o de pendentes: "Formulários 2, obrigatórios pendentes".
    formularios: pendingForms
      ? { tone: "warning", label: pendingForms === 1 ? "obrigatório pendente" : "obrigatórios pendentes" }
      : undefined,
    pecas: openParts
      ? { tone: "warning", label: openParts === 1 ? "pedido de peça aberto" : `${openParts} pedidos de peça abertos` }
      : undefined,
  };
  const tabs: TicketTabItem<TabKey>[] = TABS.filter((t) => t.key !== "orcamentos" || canQuotes).map((t) => ({
    ...t,
    count: counts[t.key] || null,
    alert: alerts[t.key] ?? null,
  }));
  // O acesso mudou com a OS aberta e a aba aberta sumiu: volta para a Geral.
  if (!tabs.some((t) => t.key === tab)) setTab("geral");

  const changeTab = (next: TabKey) => {
    if (tab === "geral" && scroller.current) generalTop.current = scroller.current.scrollTop;
    setSwitched(true);
    setTab(next);
  };
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = tab === "geral" ? generalTop.current : 0;
  }, [tab]);

  // Abas e resumo do cabeçalho conforme a rolagem do conteúdo (ouvinte passivo, lido uma vez por quadro).
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const top = el.scrollTop;
      const room = el.scrollHeight - el.clientHeight;
      setScroll((prev) => {
        // Recolhido, só reabre perto do topo. Aberto, só recolhe se, depois de recolher (a área cresce até a
        // altura do resumo), ainda sobrar rolagem acima de 24 px: senão o navegador corta a rolagem, o
        // resumo reabre e o conteúdo fica pulando.
        const collapsed = prev.collapsed ? top > 4 : top > 24 && room > 24 + SUMMARY_MAX_PX;
        return prev.shadow === top > 4 && prev.collapsed === collapsed ? prev : { shadow: top > 4, collapsed };
      });
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  // O resumo do cabeçalho leva à aba (e, na Geral, ao campo): Prazos, Localização, Colaborador, data.
  const jump = (next: HeaderJump, field?: string) => {
    if (next !== tab) flushSync(() => changeTab(next));
    if (field) focusGeneralField(document.getElementById(`${tabsId}-panel-geral`), field);
  };

  // Salvar de outra aba: volta para a Geral antes (os erros aparecem nos campos) e envia o formulário.
  const saveGeneral = () => {
    if (tab !== "geral") flushSync(() => changeTab("geral"));
    (document.getElementById(formId) as HTMLFormElement | null)?.requestSubmit();
  };

  // Ctrl+S (e Ctrl+Enter num campo da Geral) salva; o Ctrl+S nunca abre o "salvar página" do navegador.
  const onShortcut = useEffectEvent((e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const key = e.key.toLowerCase();
    if (key !== "s" && key !== "enter") return;
    const node = root.current;
    if (!node) return;
    if (!editorOnTop(node)) {
      // Diálogo por cima (mudar situação, horários, WhatsApp, confirmação): não salva por trás dele, mas o
      // navegador também não abre o "Salvar página". Com outro editor por cima (o painel sobre a página da
      // OS), quem trata é ele.
      const other = Array.from(document.querySelectorAll<HTMLElement>("[data-ticket-editor]")).some(
        (el) => el !== node && editorOnTop(el),
      );
      if (key === "s" && !other) e.preventDefault();
      return;
    }
    if (e.defaultPrevented) return;
    if (key === "enter" && !document.getElementById(formId)?.contains(document.activeElement)) return;
    e.preventDefault();
    if (saveState.dirty && !saveState.pending) saveGeneral();
  });
  useEffect(() => {
    const listener = (e: KeyboardEvent) => onShortcut(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

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
      data-ticket-editor
      className={clsx(
        "flex flex-col overflow-hidden bg-surface",
        // No painel lateral ocupa a altura toda (o painel já tem a borda e a sombra). Na página, a altura
        // da tela: as abas rolam por dentro e o Salvar fica sempre à vista, como no painel.
        variant === "dialog" ? "h-full" : "h-[calc(100dvh-8rem)] min-h-[32rem] rounded-2xl border border-line shadow-elev-2",
      )}
    >
      <TicketHeader
        ticket={ticket}
        variant={variant}
        dirty={dirty}
        reopenable={reopenable}
        collapsed={scroll.collapsed}
        onTransition={setTransition}
        onClose={onClose}
        onJump={jump}
      />

      {/* As abas ficam fora da área que rola (sempre à vista); com o conteúdo rolado, a borda vira sombra. */}
      <div
        className={clsx(
          "relative z-20 shrink-0 border-b border-line bg-surface px-3 transition-shadow duration-150",
          scroll.shadow && "shadow-scroll",
        )}
      >
        <EditorTabs ticket={ticket} items={tabs} value={tab} onChange={changeTab} idPrefix={tabsId} />
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto bg-[var(--canvas,transparent)] px-4 py-5 sm:px-5">
        <StatusNotice ticket={ticket} />
        {/* A Geral fica montada (escondida) nas outras abas: o que se digitou não se perde ao trocar de aba.
            Ao voltar para ela, a animação de entrada recomeça (o hidden a desliga). */}
        <div
          role="tabpanel"
          id={`${tabsId}-panel-geral`}
          aria-labelledby={`${tabsId}-tab-geral`}
          hidden={tab !== "geral"}
          className={switched ? "animate-enter" : undefined}
        >
          <ReportStrip ticket={ticket} />
          {editable ? (
            <GeneralTab ticket={ticket} formId={formId} onSaveState={onSaveState} onTransition={setTransition} />
          ) : (
            <GeneralView ticket={ticket} />
          )}
        </div>
        {tab !== "geral" ? (
          <div key={tab} role="tabpanel" id={`${tabsId}-panel-${tab}`} aria-labelledby={`${tabsId}-tab-${tab}`} className="animate-enter">
            {tab === "prazos" ? <DeadlinesTab ticket={ticket} onFixTimes={() => setTimesOpen(true)} /> : null}
            {tab === "localizacao" ? <LocationTab ticket={ticket} /> : null}
            {tab === "vinculos" ? <LinksTab ticket={ticket} /> : null}
            {tab === "orcamentos" && canQuotes ? <QuotesCard ticket={ticket} /> : null}
            {tab === "pecas" ? (
              <div className="flex flex-col gap-4">
                <PartRequestsCard ticket={ticket} />
                {canPayouts ? <PayoutsCard ticket={ticket} /> : null}
                {canExpenses ? <ExpensesCard ticket={ticket} /> : null}
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
        {editable && (tab === "geral" || dirty) ? (
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
        {/* Numa tela estreita as ações quebram a linha (alinhadas à direita) em vez de sair do painel; no
            celular, o menu do relatório se prende a este grupo (e não ao botão) para caber na tela. */}
        <div className="relative ml-auto flex flex-wrap items-center justify-end gap-x-0.5 gap-y-1.5">
          {/* Os textos para o grupo junto do link do relatório (o "Atividade encerrada" já leva o link). */}
          {ticket.can_assign ? <GroupTexts key={ticket.id} ticket={ticket} synced={synced} /> : null}
          {/* O nome ao lado do ícone (telas largas) vem do CSS: o menu do relatório só desenha o ícone. */}
          <ReportMenu ticket={ticket} buttonClassName={clsx(footerAction, "lg:after:text-xs lg:after:font-medium lg:after:content-['Relatório']")} />
          <button type="button" className={footerAction} onClick={() => setSharing(true)} title="Mensagens de WhatsApp" aria-label="Mensagens de WhatsApp">
            <MessageCircle aria-hidden className="size-[18px]" />
            <span className="hidden text-xs font-medium lg:inline">WhatsApp</span>
          </button>
          {/* Sempre clicável: antes da saída para o local, a janela explica que não há horário para corrigir
              (desabilitado, o motivo ficaria num title que o toque e o teclado não alcançam). */}
          <button
            type="button"
            className={footerAction}
            onClick={() => setTimesOpen(true)}
            title="Corrigir horários"
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
          onDone={(updated) => setRescheduleAt(updated.version)}
        />
      ) : null}
    </div>
  );
}
