"use client";

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, Ban, Clock, ExternalLink, MessageCircle, Navigation, SquarePen, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import { StatusBadge } from "@/components/badges";
import { Tabs } from "@/components/motion";
import { AttachmentsTab } from "@/components/ticket/AttachmentsTab";
import { CommentsTab } from "@/components/ticket/CommentsTab";
import { ExpensesCard } from "@/components/ticket/ExpensesCard";
import { ArrivalChip, OnsiteBar } from "@/components/ticket/FieldClock";
import { FormsCard } from "@/components/ticket/FormsCard";
import { HistoryTab } from "@/components/ticket/HistoryTab";
import { LegacyOrderCard } from "@/components/ticket/LegacyOrderCard";
import { PartRequestsCard } from "@/components/ticket/PartRequestsCard";
import { PayoutsCard } from "@/components/ticket/PayoutsCard";
import { QuotesCard } from "@/components/ticket/QuotesCard";
import { ReportMenu } from "@/components/ticket/ReportMenu";
import { SlaCard } from "@/components/ticket/SlaCard";
import { TicketInfo } from "@/components/ticket/TicketInfo";
import { TimesDialog } from "@/components/ticket/TimesDialog";
import { UNPRODUCTIVE_FROM, UnproductiveDialog } from "@/components/ticket/UnproductiveDialog";
import { WhatsAppShare } from "@/components/ticket/WhatsAppShare";
import { WorklogsTab } from "@/components/ticket/WorklogsTab";
import { Button, Card, SectionTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { STATUS } from "@/lib/constants";
import { formatDateTime, formatMinutes } from "@/lib/format";
import type { TicketDetail, TicketEvent } from "@/lib/types";
import { GENERAL_FORM_ID, GeneralTab } from "./GeneralTab";

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

function km(meters: number) {
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} km`;
}

function distance(a: [number, number], b: [number, number]) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

const GPS_LABEL: Record<string, string> = { en_route: "Saída para o local", in_progress: "Início do atendimento", resolved: "Conclusão" };

/** Loja no mapa e os pontos de GPS registrados pelo técnico (saída, início e conclusão). */
function LocationTab({ ticket }: { ticket: TicketDetail }) {
  const events = useQuery({
    queryKey: ["ticket", ticket.id, "events"],
    queryFn: () => api.get<TicketEvent[]>(`/tickets/${ticket.id}/events`),
  });
  const loc = ticket.location;
  const store: [number, number] | null = loc?.latitude != null && loc?.longitude != null ? [loc.latitude, loc.longitude] : null;
  const points = (events.data ?? [])
    .filter((e) => e.event_type === "status_changed" && typeof e.data?.latitude === "number" && typeof e.data?.longitude === "number")
    .map((e) => ({ id: e.id, to: e.to_value ?? "", at: e.created_at, at2: [e.data!.latitude as number, e.data!.longitude as number] as [number, number] }))
    .sort((a, b) => a.at.localeCompare(b.at));
  const bbox = store ? `${store[1] - 0.012},${store[0] - 0.007},${store[1] + 0.012},${store[0] + 0.007}` : null;
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
          <p className="p-6 text-sm text-ink-muted">A loja não tem coordenadas cadastradas: corrija o endereço no cadastro de locais.</p>
        )}
      </Card>
      <div className="flex flex-col gap-3">
        <Card className="p-4 text-sm">
          <SectionTitle>Loja</SectionTitle>
          <p className="mt-1 font-semibold text-ink">{loc ? [loc.name, loc.code].filter(Boolean).join(" - ") : "Sem loja"}</p>
          {loc ? (
            <p className="mt-0.5 text-ink-muted">
              {[loc.address_line, [loc.city, loc.state].filter(Boolean).join(" - ")].filter(Boolean).join(", ") || "Sem endereço"}
            </p>
          ) : null}
          {ticket.service_address ? <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-300">Atendimento em: {ticket.service_address}</p> : null}
        </Card>
        <Card className="p-4">
          <SectionTitle className="mb-2">GPS do técnico</SectionTitle>
          {points.length === 0 ? (
            <p className="text-sm text-ink-subtle">Nenhum ponto de GPS registrado.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {points.map((p) => (
                <li key={p.id} className="flex items-start gap-2">
                  <Navigation className="mt-0.5 size-3.5 shrink-0 text-brand" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold text-ink">{GPS_LABEL[p.to] ?? STATUS[p.to as keyof typeof STATUS]?.label ?? p.to}</span>
                    <span className="text-xs text-ink-muted">
                      {formatDateTime(p.at)}
                      {store ? ` · a ${km(distance(store, p.at2))} da loja` : ""}
                    </span>
                  </span>
                  <a
                    href={`https://www.google.com/maps?q=${p.at2[0]},${p.at2[1]}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs font-medium text-brand hover:underline"
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
          aside={<span className="rounded-full bg-surface-2 px-1.5 text-xs font-semibold text-ink">{history?.count_30d ?? 0}</span>}
        >
          Outras OS desta loja · 30 dias
        </SectionTitle>
        {history && history.previous.length ? (
          <ul className="flex flex-col gap-1">
            {history.previous.map((p) => (
              <li key={p.id}>
                <Link href={`/chamados/${p.id}`} className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-surface-2">
                  <span className="mt-0.5 font-mono text-[11px] text-ink-subtle">{p.code}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-ink">{p.title}</span>
                    <span className="text-[11px] text-ink-subtle">
                      {STATUS[p.status]?.label ?? p.status} · {formatDateTime(p.created_at)}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-subtle">Nenhuma outra OS na loja nos últimos 30 dias.</p>
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
      <Card className="p-4">
        <SectionTitle>Atendimento em campo</SectionTitle>
        <div className="mt-2 flex flex-col gap-2">
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
        {ticket.arrived_at ? (
          <Button size="sm" className="mt-3" onClick={onFixTimes}>
            <Clock className="size-3.5" />
            Corrigir horários (saída, início, término, tempo)
          </Button>
        ) : null}
      </Card>
      <Card className="p-4 lg:col-span-2">
        <SectionTitle className="mb-2">Apontamentos de horas</SectionTitle>
        <WorklogsTab ticketId={ticket.id} closed={false} />
      </Card>
    </div>
  );
}

/**
 * A OS no formato do "Editar atividade" do Field Control: cabeçalho, abas e rodapé com Salvar e as
 * ações. Tudo editável pela central a qualquer momento, aberta ou fechada.
 */
export function TicketEditor({ ticket, variant, onClose }: { ticket: TicketDetail; variant: "page" | "dialog"; onClose?: () => void }) {
  const [tab, setTab] = useState<TabKey>("geral");
  const [saveState, setSaveState] = useState({ dirty: false, pending: false });
  const onSaveState = useCallback((state: { dirty: boolean; pending: boolean }) => setSaveState(state), []);
  const [sharing, setSharing] = useState(false);
  const [unproductive, setUnproductive] = useState(false);
  const [timesOpen, setTimesOpen] = useState(false);
  const canUnproductive = UNPRODUCTIVE_FROM.includes(ticket.status) && Boolean(ticket.assignee);

  const iconButton =
    "inline-flex size-9 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-40";
  // Na página a OS é o título principal; no painel lateral, o título do diálogo.
  const Heading = variant === "page" ? "h1" : "h2";

  return (
    <div
      className={clsx(
        "flex flex-col overflow-hidden bg-surface",
        // No painel lateral ele ocupa a altura toda (o painel já tem a borda e a sombra).
        variant === "dialog" ? "h-full" : "min-h-[calc(100vh-7rem)] rounded-2xl border border-line shadow-elev-2",
      )}
    >
      {/* Azul forte no escuro: o branco fica em 5,2:1 (no brand, 4,1:1). Texto no mínimo white/90 e, no escuro, hover do link mais
          leve (o sublinhado é que marca o hover): tudo acima de 4,5:1. Foco em branco: o anel padrão é azul e sumiria aqui. */}
      <div className="flex items-center gap-3 bg-brand dark:bg-brand-strong px-5 py-3 text-white">
        {variant === "page" ? (
          <Link
            href="/chamados"
            className="rounded-md p-1 text-white/80 hover:bg-white/10 hover:text-white focus-visible:outline-white"
            aria-label="Voltar para Chamados"
          >
            <ArrowLeft className="size-4" />
          </Link>
        ) : (
          <SquarePen className="size-4 text-white/80" />
        )}
        <div className="min-w-0 flex-1">
          <Heading className="truncate text-[15px] font-bold tracking-[-0.01em]">
            Editar OS <span className="font-mono">#{ticket.number}</span>
            <span className="ml-2 font-normal text-white/90">{ticket.title}</span>
          </Heading>
        </div>
        <span className="rounded-full bg-white/95 px-0.5 py-0.5">
          <StatusBadge status={ticket.status} />
        </span>
        {variant === "dialog" ? (
          <>
            <Link
              href={`/chamados/${ticket.id}`}
              className="hidden rounded-md px-2 py-1 text-xs font-medium text-white hover:bg-white/10 hover:underline focus-visible:outline-white dark:hover:bg-white/5 sm:inline-flex"
            >
              Abrir em página
            </Link>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-white/85 hover:bg-white/10 hover:text-white focus-visible:outline-white"
              aria-label="Fechar"
            >
              <X className="size-5" />
            </button>
          </>
        ) : null}
      </div>

      <div className="overflow-x-auto border-b border-line px-3">
        <Tabs items={TABS} value={tab} onChange={setTab} ariaLabel="Seções da OS" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--canvas,transparent)] px-5 py-5">
        {tab === "geral" ? <GeneralTab key={ticket.version} ticket={ticket} onSaveState={onSaveState} /> : null}
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
              <HistoryTab ticketId={ticket.id} />
            </Card>
            <TicketInfo ticket={ticket} />
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-3 border-t border-line bg-surface-2/60 px-5 py-3">
        {tab === "geral" ? (
          <Button type="submit" form={GENERAL_FORM_ID} variant="primary" disabled={!saveState.dirty} loading={saveState.pending}>
            Salvar
          </Button>
        ) : (
          <span className="text-xs text-ink-muted">O que muda nesta aba é salvo na hora.</span>
        )}
        {tab === "geral" && saveState.dirty ? <span className="text-xs text-amber-700 dark:text-amber-300">Alterações não salvas</span> : null}
        <div className="ml-auto flex items-center gap-0.5">
          <button type="button" className={iconButton} onClick={() => setSharing(true)} title="Mensagens de WhatsApp" aria-label="Mensagens de WhatsApp">
            <MessageCircle className="size-[18px]" />
          </button>
          <ReportMenu ticket={ticket} buttonClassName={iconButton} />
          <button
            type="button"
            className={iconButton}
            onClick={() => setTimesOpen(true)}
            disabled={!ticket.arrived_at}
            title="Corrigir horários"
            aria-label="Corrigir horários"
          >
            <Clock className="size-[18px]" />
          </button>
          {canUnproductive ? (
            <button type="button" className={iconButton} onClick={() => setUnproductive(true)} title="Visita improdutiva" aria-label="Visita improdutiva">
              <Ban className="size-[18px]" />
            </button>
          ) : null}
        </div>
      </div>

      {sharing ? <WhatsAppShare ticket={ticket} onClose={() => setSharing(false)} /> : null}
      {timesOpen ? <TimesDialog ticket={ticket} onClose={() => setTimesOpen(false)} /> : null}
      {unproductive ? <UnproductiveDialog ticket={ticket} onClose={() => setUnproductive(false)} /> : null}
    </div>
  );
}
