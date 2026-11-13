"use client";

import { CircleCheckBig, Copy, CopyPlus, Link2, MessageCircle, PanelRightOpen, Plus, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { PriorityBadge } from "@/components/badges";
import { useToast } from "@/components/Toaster";
import { useTicketPanel } from "@/components/ticket/TicketPanel";
import { WhatsAppShare } from "@/components/ticket/WhatsAppShare";
import { Button, Card } from "@/components/ui";
import { useNow } from "@/components/useNow";
import { formatDateTime } from "@/lib/format";
import { copyText } from "@/lib/whatsapp";
import type { TicketDetail } from "@/lib/types";
import { dayTimeLabel } from "./dayTime";

export interface CreatedResult {
  ticket: TicketDetail;
  /** O que não foi salvo depois de abrir a OS (etiquetas, formulários): a OS existe, falta completar. */
  problems: string[];
}

/** Recado para o grupo do cliente: nº da OS, o que foi pedido, a visita e o link de acompanhamento. */
export function clientMessage(t: TicketDetail): string {
  const where = [t.customer?.name, t.location?.name].filter(Boolean).join(" · ");
  return [
    `*${t.code}*${where ? ` · ${where}` : ""}`,
    `Recebemos o chamado: ${t.title.replace(/[\s.!?]+$/, "")}.`,
    t.scheduled_start ? `Visita: ${formatDateTime(t.scheduled_start)}` : "Vamos agendar a visita e avisamos o horário.",
    t.report_link?.url ? `Acompanhe por aqui: ${t.report_link.url}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Depois de abrir a OS: o resumo e o que o analista faz em seguida (avisar o grupo dos técnicos e o do
 * cliente no WhatsApp, abrir a OS no painel ou já abrir a próxima).
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

  // O foco vai para o título: quem usa leitor de tela ouve que a OS foi aberta.
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
  const rows: [string, React.ReactNode][] = [
    ["Cliente e loja", [t.customer?.name, store, town].filter(Boolean).join(" · ") || "Sem loja"],
    ["Visita", t.scheduled_start ? dayTimeLabel(t.scheduled_start, now) : "Sem agenda: fica na fila para agendar"],
    [
      "Técnico",
      t.assignee ? `${t.assignee.name}${t.helpers?.length ? ` + ${t.helpers.length} junto` : ""}` : "Sem técnico",
    ],
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
              <span className="font-mono">{t.code}</span> aberta
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
              <dt className="text-xs font-semibold text-ink/80 sm:pt-0.5">Acompanhamento</dt>
              <dd className="flex min-w-0 items-center gap-2">
                <Link2 aria-hidden className="size-4 shrink-0 text-ink-subtle" />
                <a href={reportUrl} target="_blank" rel="noreferrer" className="truncate font-medium text-brand-ink hover:underline">
                  {reportUrl}
                </a>
                <button
                  type="button"
                  onClick={() => void copy(reportUrl, "Link de acompanhamento copiado")}
                  className="shrink-0 rounded-md p-1 text-ink-subtle hover:bg-surface-2 hover:text-ink"
                  aria-label="Copiar o link de acompanhamento"
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
              A OS foi aberta, mas falta completar na OS:
            </p>
            <ul className="mt-1 list-disc pl-6 text-xs">
              {result.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-col gap-3 border-t border-line bg-surface-2/50 px-5 py-4">
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => (panel ? panel.open(t.id) : router.push(`/chamados/${t.id}`))}>
              <PanelRightOpen aria-hidden className="size-4" />
              Abrir a OS
            </Button>
            <Button onClick={() => setSharing(true)}>
              <MessageCircle aria-hidden className="size-4" />
              Enviar para o grupo dos técnicos
            </Button>
            <Button onClick={() => void copy(clientMessage(t), "Mensagem copiada: cole no grupo do cliente")}>
              <Copy aria-hidden className="size-4" />
              Copiar mensagem para o cliente
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={onNew}>
              <Plus aria-hidden className="size-4" />
              Abrir outra OS
            </Button>
            {t.location ? (
              <Button variant="ghost" onClick={onSameStore}>
                <CopyPlus aria-hidden className="size-4" />
                Outra OS nesta loja
              </Button>
            ) : null}
          </div>
        </div>
      </Card>
      {/* Fora de qualquer formulário: o Ctrl+Enter do texto não pode reenviar nada. */}
      {sharing ? <WhatsAppShare ticket={t} onClose={() => setSharing(false)} /> : null}
    </div>
  );
}
