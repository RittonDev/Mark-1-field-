"use client";

import { CircleCheckBig, Copy, CopyPlus, Link2, List, MessageCircle, PanelRightOpen, Plus, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { PriorityBadge } from "@/components/badges";
import { TagChips } from "@/components/TagChips";
import { useToast } from "@/components/Toaster";
import { CopyGroupTextButton, GroupTextsMenu } from "@/components/ticket/MessagesPanel";
import { useTicketPanel } from "@/components/ticket/TicketPanel";
import { WhatsAppShare } from "@/components/ticket/WhatsAppShare";
import { Button, buttonClassName, Card } from "@/components/ui";
import { useNow } from "@/components/useNow";
import { copyText } from "@/lib/whatsapp";
import type { TicketDetail } from "@/lib/types";
import { dayTimeLabel } from "./dayTime";

export interface CreatedResult {
  ticket: TicketDetail;
  /** O que não foi salvo depois de criar a OS (formulários): a OS existe, falta completar nela. */
  problems: string[];
  /**
   * A OS ficou sem analista e quem a criou só vê a própria fila: abrir a OS e os textos dela dariam
   * "OS de outra fila", então o resumo não os oferece.
   */
  hidden?: boolean;
}

/**
 * Depois de criar a OS: o resumo e o que o analista faz em seguida (abrir a OS no painel, copiar o
 * texto "Atividade confirmada" para o grupo do cliente no WhatsApp, mandar o resumo aos técnicos ou já
 * criar a próxima). Os textos do grupo são sempre os modelos de Textos do WhatsApp (os que a gestão
 * edita), nunca um texto fixo daqui.
 */
export function CreatedTicket({
  result,
  onNew,
  onSameStore,
}: {
  result: CreatedResult;
  onNew: () => void;
  onSameStore: () => void;
}) {
  const t = result.ticket;
  const panel = useTicketPanel();
  const router = useRouter();
  const { toast } = useToast();
  const now = useNow(60_000);
  const [sharing, setSharing] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);

  // O foco vai para o título: quem usa leitor de tela ouve que a OS foi criada.
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const copy = async (text: string, done: string) => {
    const ok = await copyText(text);
    toast(ok ? { title: done, tone: "success" } : { title: "Não deu para copiar", description: "Selecione o texto e copie à mão.", tone: "error" });
  };
  const reportUrl = t.report_link?.url ?? null;
  const store = t.location ? [t.location.code, t.location.name].filter(Boolean).join(" · ") : null;
  const town = t.location?.city ? `${t.location.city}${t.location.state ? `/${t.location.state}` : ""}` : null;
  // "Atividade confirmada" só faz sentido com o técnico e o horário combinados.
  const confirmed = Boolean(t.assignee && t.scheduled_start);
  const rows: [string, React.ReactNode][] = [
    ["Cliente e localização", [t.customer?.name, store, town].filter(Boolean).join(" · ") || "—"],
    ["Tipo de OS", t.service_type?.name ?? "—"],
    ["Agendamento", t.scheduled_start ? dayTimeLabel(t.scheduled_start, now) : "Sem agendamento: fica na fila para agendar"],
    ["Colaborador", t.assignee ? `${t.assignee.name}${t.helpers?.length ? ` + ${t.helpers.length} junto` : ""}` : "Sem colaborador: fica na fila"],
    ["Etiquetas", t.tags?.length ? <TagChips key="etiquetas" tags={t.tags} max={10} /> : "Sem etiquetas"],
    ["Analista", t.owner?.name ?? "Sem analista"],
    [
      "Prazo de solução",
      <span key="prazo" className="inline-flex items-center gap-1.5">
        <PriorityBadge priority={t.priority} compact />
        {t.resolution_due_at ? `até ${dayTimeLabel(t.resolution_due_at, now, true)}` : "—"}
      </span>,
    ],
  ];

  return (
    <div className="mx-auto max-w-3xl">
      <Card className="animate-enter overflow-hidden">
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <span aria-hidden className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-ink">
            <CircleCheckBig className="size-5" />
          </span>
          <div className="min-w-0">
            <h2 ref={titleRef} tabIndex={-1} className="text-lg leading-6 font-bold tracking-[-0.01em] text-ink outline-none">
              OS <span className="tabular-nums">{t.number}</span> criada
            </h2>
            <p className="mt-0.5 text-sm text-ink-muted">{t.title}</p>
          </div>
        </div>

        <dl className="grid gap-x-4 gap-y-2.5 px-5 py-4 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-xs font-semibold text-ink/80 sm:pt-0.5">{label}</dt>
              <dd className="min-w-0 text-ink">{value}</dd>
            </div>
          ))}
          {reportUrl ? (
            <div className="contents">
              <dt className="text-xs font-semibold text-ink/80 sm:pt-0.5">Relatório do cliente</dt>
              <dd className="flex min-w-0 items-center gap-2">
                <Link2 aria-hidden className="size-4 shrink-0 text-ink-subtle" />
                <a href={reportUrl} target="_blank" rel="noreferrer" className="truncate font-medium text-brand-ink hover:underline">
                  {reportUrl}
                  <span className="sr-only"> (abre em outra aba)</span>
                </a>
                <button
                  type="button"
                  onClick={() => void copy(reportUrl, "Link do relatório copiado")}
                  className="shrink-0 rounded-md p-1 text-ink-subtle hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
                  aria-label="Copiar o link do relatório do cliente"
                  title="Copiar o link"
                >
                  <Copy aria-hidden className="size-4" />
                </button>
              </dd>
            </div>
          ) : null}
        </dl>

        {result.problems.length ? (
          <div className="mx-5 mb-4 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200" role="alert">
            <p className="flex items-center gap-1.5 font-semibold">
              <TriangleAlert aria-hidden className="size-4 shrink-0" />
              A OS foi criada, mas falta completar nela:
            </p>
            <ul className="mt-1 list-disc pl-6 text-xs">
              {result.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-col gap-3 border-t border-line bg-surface-2/50 px-5 py-4">
          {result.hidden ? (
            <p className="text-sm text-ink-muted">A OS ficou sem analista e saiu da sua fila.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => (panel ? panel.open(t.id) : router.push(`/chamados/${t.id}`))}>
                <PanelRightOpen aria-hidden className="size-4" />
                Abrir OS
              </Button>
              {confirmed ? (
                <CopyGroupTextButton ticketId={t.id} templateKey="agendamento" label="Copiar texto: Atividade confirmada" size="md" />
              ) : (
                // Sem técnico ou sem horário, "Atividade confirmada" não serve: os outros modelos ficam à mão.
                <GroupTextsMenu ticketId={t.id} />
              )}
              <Button onClick={() => setSharing(true)}>
                <MessageCircle aria-hidden className="size-4" />
                Resumo para os técnicos
              </Button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={onNew}>
              <Plus aria-hidden className="size-4" />
              Criar outra OS
            </Button>
            {t.location ? (
              <Button variant="ghost" onClick={onSameStore}>
                <CopyPlus aria-hidden className="size-4" />
                Outra OS nesta localização
              </Button>
            ) : null}
            <Link href="/chamados" className={buttonClassName("ghost")}>
              <List aria-hidden className="size-4" />
              Ver chamados
            </Link>
          </div>
        </div>
      </Card>
      {/* Fora de qualquer formulário: o Ctrl+Enter do texto não pode reenviar nada. */}
      {sharing && !result.hidden ? <WhatsAppShare ticket={t} onClose={() => setSharing(false)} /> : null}
    </div>
  );
}
