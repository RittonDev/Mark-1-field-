"use client";

import clsx from "clsx";
import {
  ArrowLeft,
  Building2,
  CalendarDays,
  Check,
  Copy,
  Hourglass,
  Inbox,
  Navigation,
  RotateCcw,
  SquarePen,
  Timer,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { nextDue } from "@/components/badges";
import { fieldClockSummary } from "@/components/ticket/FieldClock";
import { useToast } from "@/components/Toaster";
import { useNow } from "@/components/useNow";
import { PRIORITY } from "@/lib/constants";
import { dayKey, formatMinutes, formatTime, initials, OPERATION_TZ } from "@/lib/format";
import type { TicketDetail, TicketStatus } from "@/lib/types";
import { copyText } from "@/lib/whatsapp";
import { StatusMenu } from "./StatusMenu";

/** Abas que o resumo abre (as chaves são as do editor). */
export type HeaderJump = "geral" | "prazos" | "localizacao";

/** Campos da Geral que o resumo foca, pelo rótulo do formulário. */
const ASSIGNEE_FIELD = "Colaborador";
const DATE_FIELD = "Data do agendamento";

// Chips do resumo no azul da marca: véu branco e contorno, como a situação (branco acima de 4,5:1).
// A largura máxima fica em cada chip (max-w-full) e, no de cliente e loja, também no item da lista
// (22rem): duas classes max-w juntas não se somam, vale a que o CSS gerar por último.
const CHIP =
  "inline-flex h-6 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset " +
  "transition-[background-color,box-shadow,color] duration-150";
const FULL = "max-w-full";
const NEUTRAL = "bg-white/10 text-white ring-white/25";
const NEUTRAL_ACTION = "hover:bg-white/[0.17] hover:ring-white/50";
// Vencido: vermelho cheio com texto branco (4,8:1).
const DANGER = "bg-red-600 text-white ring-red-300/40";
const DANGER_ACTION = "hover:bg-red-700";
// O foco no azul é branco: o anel padrão é azul e sumiria aqui.
const FOCUS = "focus-visible:outline-white";

const dayMonthFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: OPERATION_TZ, day: "2-digit", month: "2-digit" });
const weekdayFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: OPERATION_TZ, weekday: "short" });

/** "18/11 14:00", no fuso da operação. */
const dayTime = (iso: string) => `${dayMonthFmt.format(new Date(iso))} ${formatTime(iso)}`;

/** Primeiro nome e a inicial do último sobrenome ("Nome do Meio Sobrenome" vira "Nome S."). */
function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
}

/** "Hoje 14:00", "Amanhã 09:00", "Ter 18/11 09:00" (de outro ano, com o ano) ou "Sem agenda". */
function agendaText(iso: string | null, now: number): string {
  if (!iso) return "Sem agenda";
  const day = dayKey(iso);
  const today = dayKey(now);
  const time = formatTime(iso);
  if (day === today) return `Hoje ${time}`;
  if (day === dayKey(now + 86_400_000)) return `Amanhã ${time}`;
  const date = new Date(iso);
  const weekday = weekdayFmt.format(date).replace(".", "");
  const year = day.slice(0, 4) === today.slice(0, 4) ? "" : `/${day.slice(0, 4)}`;
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} ${dayMonthFmt.format(date)}${year} ${time}`;
}

/** Parte do prazo já consumida, sem o tempo pausado (como o backend calcula o "em risco"). */
function elapsedRatio(createdAt: string, due: number, pausedSeconds: number, moment: number): number {
  const created = new Date(createdAt).getTime();
  const total = due - created - pausedSeconds * 1000;
  if (total <= 0) return 1;
  return Math.min(1, Math.max(0, (moment - created - pausedSeconds * 1000) / total));
}

interface SlaView {
  text: string;
  /** Cor só no problema: âmbar em risco, vermelho vencido. */
  tone: "neutral" | "risk" | "late";
  due: string | null;
  /** Fração do prazo já decorrida (a barra fina); null sem barra. */
  ratio: number | null;
}

/** O próximo prazo de SLA da OS, contado ao vivo (resposta enquanto não houve; depois, solução). */
function slaView(ticket: TicketDetail, now: number): SlaView {
  if (ticket.status === "cancelled") return { text: "Sem prazo", tone: "neutral", due: null, ratio: null };
  const due = nextDue(ticket);
  if (!due) {
    if (ticket.sla_status === "met") return { text: "Cumprido", tone: "neutral", due: null, ratio: null };
    if (ticket.sla_status === "breached") return { text: "Fora do prazo", tone: "late", due: ticket.resolution_due_at, ratio: null };
    return { text: "Sem prazo", tone: "neutral", due: null, ratio: null };
  }
  const at = new Date(due.at).getTime();
  const paused = ticket.sla_paused_at ? new Date(ticket.sla_paused_at).getTime() : null;
  if (paused !== null) {
    // Pausado (aguardando cliente ou peça): a barra para onde estava.
    if (paused > at) return { text: `${due.label} vencida · pausado`, tone: "late", due: due.at, ratio: 1 };
    const frozen = elapsedRatio(ticket.created_at, at, ticket.sla_paused_seconds, paused);
    return { text: "Pausado", tone: "neutral", due: due.at, ratio: frozen };
  }
  const minutes = (at - now) / 60_000;
  if (minutes < 0) {
    return { text: `${due.label} vencida há ${formatMinutes(Math.max(1, -minutes))}`, tone: "late", due: due.at, ratio: 1 };
  }
  const ratio = elapsedRatio(ticket.created_at, at, ticket.sla_paused_seconds, now);
  if (minutes < 1) return { text: `${due.label} vence agora`, tone: "risk", due: due.at, ratio };
  return {
    text: `${due.label} em ${formatMinutes(minutes)}`,
    tone: ticket.sla_status === "at_risk" ? "risk" : "neutral",
    due: due.at,
    ratio,
  };
}

/** O nº da OS: o clique copia (o ícone aparece no hover e no foco e vira um "ok" por 1,5 s). */
function CopyCode({ code }: { code: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(id);
  }, [copied]);
  const copy = async () => {
    if (await copyText(code)) {
      setCopied(true);
      toast({ title: `${code} copiada`, tone: "success" });
    } else {
      toast({ title: "Não foi possível copiar", description: code, tone: "error" });
    }
  };
  const Icon = copied ? Check : Copy;
  return (
    // O texto do botão é o nº: o título da OS continua "OS-000123 Título" para o leitor de tela.
    <button
      type="button"
      onClick={() => void copy()}
      title={`Copiar ${code}`}
      className={clsx(
        "group/copy -mx-1 inline-flex shrink-0 items-center gap-1 rounded-md px-1 font-mono transition-colors duration-150 hover:bg-white/10",
        FOCUS,
      )}
    >
      {code}
      {/* No toque não há hover: o toque copia e o aviso confirma. */}
      <Icon
        aria-hidden
        className={clsx(
          "size-3.5 transition-opacity duration-150 [@media(hover:none)]:hidden",
          copied ? "opacity-100" : "opacity-0 group-hover/copy:opacity-100 group-focus-visible/copy:opacity-100",
        )}
      />
    </button>
  );
}

/** Ponto âmbar de aviso (em risco, técnico sem acesso): o âmbar claro aparece bem no azul. */
const WarnDot = () => <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-amber-300" />;

/**
 * Cabeçalho da OS em duas linhas, no azul da marca. Em cima: nº (copiar), título, Reabrir, situação e,
 * no painel, "Abrir em página" e Fechar. Embaixo, o resumo: prioridade, SLA em contagem regressiva,
 * relógio de campo, técnico, cliente e loja, agenda e fila; cada chip leva à aba ou ao campo que o
 * detalha. Tudo vem da OS já carregada (nenhuma chamada nova). No celular o resumo fica com prioridade,
 * SLA e técnico, e recolhe quando o conteúdo rola.
 */
export function TicketHeader({
  ticket,
  variant,
  dirty,
  reopenable,
  collapsed = false,
  onTransition,
  onClose,
  onJump,
}: {
  ticket: TicketDetail;
  variant: "page" | "dialog";
  /** A Geral tem alteração não salva: a situação fica travada (é preciso salvar antes). */
  dirty: boolean;
  reopenable: boolean;
  /** O conteúdo rolou (celular): o resumo recolhe. */
  collapsed?: boolean;
  onTransition: (to: TicketStatus) => void;
  onClose?: () => void;
  /** Abre a aba e, na Geral, foca o campo com este rótulo. */
  onJump: (tab: HeaderJump, field?: string) => void;
}) {
  const now = useNow(30_000);
  // Na página a OS é o título principal; no painel lateral, o título do diálogo.
  const Heading = variant === "page" ? "h1" : "h2";
  const priority = PRIORITY[ticket.priority];
  const urgent = ticket.priority === "critical" || ticket.priority === "high";
  const sla = slaView(ticket, now);
  const field = fieldClockSummary(ticket, now);
  const tech = ticket.assignee;
  const loc = ticket.location;
  const place = [ticket.customer?.name, loc?.name].filter(Boolean).join(" · ");
  const address =
    ticket.service_address?.trim() ||
    (loc ? [loc.address_line, [loc.city, loc.state].filter(Boolean).join(" - ")].filter(Boolean).join(", ") : "");
  // Agendar pelo resumo segue a regra do menu da situação: com alteração pendente, só pela Geral.
  const canSchedule = ticket.allowed_transitions.includes("scheduled") && !dirty;

  return (
    <div className="shrink-0 bg-brand text-white dark:bg-brand-strong">
      {/* Azul forte no escuro: o branco fica em 5,2:1 (no brand, 4,1:1). Texto no mínimo white/90. */}
      <div className="flex h-12 items-center gap-2.5 px-4 sm:gap-3 sm:px-5">
        {variant === "page" ? (
          <Link
            href="/chamados"
            className={clsx("-ml-1 shrink-0 rounded-md p-1 text-white/80 transition-colors duration-150 hover:bg-white/10 hover:text-white", FOCUS)}
            aria-label="Voltar para Chamados"
          >
            <ArrowLeft className="size-4" />
          </Link>
        ) : (
          <SquarePen aria-hidden className="size-4 shrink-0 text-white/80" />
        )}
        <Heading
          className="flex min-w-0 flex-1 items-center gap-2 text-[15px] font-bold tracking-[-0.01em]"
          title={`${ticket.code} · ${ticket.title}`}
        >
          <CopyCode code={ticket.code} />
          <span className="min-w-0 truncate font-normal text-white/90">{ticket.title}</span>
        </Heading>
        {reopenable && !dirty ? (
          <button
            type="button"
            onClick={() => onTransition("reopened")}
            className={clsx(
              "hidden h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold text-white ring-1 ring-white/40 ring-inset transition-colors duration-150 hover:bg-white/10 sm:inline-flex",
              FOCUS,
            )}
          >
            <RotateCcw aria-hidden className="size-3.5" />
            Reabrir
          </button>
        ) : null}
        <div className="shrink-0">
          <StatusMenu status={ticket.status} targets={ticket.allowed_transitions} locked={dirty} onPick={onTransition} />
        </div>
        {variant === "dialog" ? (
          <>
            <Link
              href={`/chamados/${ticket.id}`}
              className={clsx(
                "hidden shrink-0 rounded-md px-2 py-1 text-xs font-medium text-white transition-colors duration-150 hover:bg-white/10 hover:underline sm:inline-flex dark:hover:bg-white/5",
                FOCUS,
              )}
            >
              Abrir em página
            </Link>
            <button
              type="button"
              onClick={onClose}
              className={clsx("-mr-1 shrink-0 rounded-md p-1 text-white/85 transition-colors duration-150 hover:bg-white/10 hover:text-white", FOCUS)}
              aria-label="Fechar"
            >
              <X className="size-5" />
            </button>
          </>
        ) : null}
      </div>

      {/* O resumo recolhe no celular quando o conteúdo rola (altura e opacidade; sem animação em "reduzir movimento"). */}
      <div
        className={clsx(
          // Container sem padding: a consulta de largura vê o cabeçalho inteiro.
          "@container overflow-hidden transition-[max-height,opacity,visibility] duration-200 ease-out-expo motion-reduce:transition-none",
          collapsed ? "max-sm:invisible max-sm:max-h-0 max-sm:opacity-0" : "max-sm:max-h-[4.5rem]",
        )}
      >
        <ul aria-label="Resumo da OS" className="flex flex-wrap items-center gap-1.5 border-t border-white/15 px-4 py-2 sm:px-5">
          <li className="flex min-w-0">
            <span className={clsx(CHIP, FULL, NEUTRAL)} title="Prioridade: o contrato de prazo da OS, que define os prazos de resposta e de solução">
              {/* Cor só nas urgentes (P1 e P2). */}
              <span
                aria-hidden
                className={clsx("size-1.5 shrink-0 rounded-full", urgent ? "ring-1 ring-white/70" : "bg-white/60")}
                style={urgent ? { backgroundColor: priority.color } : undefined}
              />
              <span className="sr-only">Prioridade </span>
              <span>
                <span className="font-semibold">{priority.code}</span> · {priority.label}
              </span>
            </span>
          </li>

          <li className="flex min-w-0">
            <button
              type="button"
              onClick={() => onJump("prazos")}
              title={sla.due ? `Prazo: ${dayTime(sla.due)}` : "Prazos de SLA da OS"}
              className={clsx(CHIP, FULL, FOCUS, sla.tone === "late" ? clsx(DANGER, DANGER_ACTION) : clsx(NEUTRAL, NEUTRAL_ACTION))}
            >
              <Timer aria-hidden className="size-3.5 shrink-0 opacity-80" />
              <span className="sr-only">SLA: </span>
              <span className="flex min-w-0 flex-col gap-[3px]">
                <span className="flex items-center gap-1.5 leading-none">
                  {sla.tone === "risk" ? <WarnDot /> : null}
                  <span className="truncate">{sla.text}</span>
                </span>
                {sla.ratio !== null ? (
                  <span aria-hidden className="block h-0.5 overflow-hidden rounded-full bg-white/25">
                    <span
                      className={clsx(
                        "block h-full rounded-full transition-[width] duration-200 ease-out-expo",
                        sla.tone === "risk" ? "bg-amber-300" : sla.tone === "late" ? "bg-white" : "bg-white/75",
                      )}
                      style={{ width: `${Math.max(4, sla.ratio * 100)}%` }}
                    />
                  </span>
                ) : null}
              </span>
            </button>
          </li>

          {/* Até 2 linhas em qualquer largura: abaixo de 40rem só prioridade, SLA e técnico (o resto está na
              Geral); abaixo de 55rem, com a OS em campo, o relógio de campo fica no lugar da agenda. */}
          {field ? (
            <li className="hidden min-w-0 @min-[40rem]:flex">
              <button
                type="button"
                onClick={() => onJump("prazos")}
                title={field.title}
                className={clsx(CHIP, FULL, FOCUS, field.tone === "danger" ? clsx(DANGER, DANGER_ACTION) : clsx(NEUTRAL, NEUTRAL_ACTION))}
              >
                {field.kind === "route" ? (
                  <Navigation aria-hidden className="size-3.5 shrink-0 opacity-80" />
                ) : (
                  <Hourglass aria-hidden className="size-3.5 shrink-0 opacity-80" />
                )}
                {field.tone === "warning" ? <WarnDot /> : null}
                <span className="truncate">{field.text}</span>
              </button>
            </li>
          ) : null}

          <li className="flex min-w-0">
            {tech ? (
              <button
                type="button"
                onClick={() => onJump("geral", ASSIGNEE_FIELD)}
                title={`Técnico: ${tech.name}${tech.is_active === false ? " (sem acesso ao app)" : ""}`}
                className={clsx(CHIP, FULL, NEUTRAL, NEUTRAL_ACTION, FOCUS, "pl-1")}
              >
                <span aria-hidden className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-white/20 text-[9px] font-bold tracking-tight">
                  {initials(tech.name)}
                </span>
                <span className="sr-only">Técnico: </span>
                <span className="truncate">{shortName(tech.name)}</span>
                {tech.is_active === false ? (
                  <>
                    <WarnDot />
                    <span>sem acesso</span>
                  </>
                ) : null}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onJump("geral", ASSIGNEE_FIELD)}
                title="Escolher o técnico na aba Geral"
                className={clsx(CHIP, FULL, FOCUS, "bg-amber-300 font-semibold text-amber-950 ring-amber-200/60 hover:bg-amber-200")}
              >
                Sem técnico
              </button>
            )}
          </li>

          {/* O limite de 22rem fica no item da lista: é ele que conta na quebra da linha. */}
          <li className="hidden max-w-[22rem] min-w-0 @min-[40rem]:flex">
            <button
              type="button"
              onClick={() => onJump("localizacao")}
              title={address || undefined}
              className={clsx(CHIP, FULL, NEUTRAL, NEUTRAL_ACTION, FOCUS)}
            >
              <Building2 aria-hidden className="size-3.5 shrink-0 opacity-80" />
              <span className="sr-only">Cliente e loja: </span>
              <span className="truncate">{place || "Sem loja"}</span>
            </button>
          </li>

          <li className={clsx("hidden min-w-0", field ? "@min-[55rem]:flex" : "@min-[40rem]:flex")}>
            <button
              type="button"
              onClick={() => (canSchedule ? onTransition("scheduled") : onJump("geral", DATE_FIELD))}
              title={ticket.scheduled_start ? `Visita marcada para ${dayTime(ticket.scheduled_start)}` : "Sem visita marcada"}
              className={clsx(CHIP, FULL, NEUTRAL, NEUTRAL_ACTION, FOCUS)}
            >
              <CalendarDays aria-hidden className="size-3.5 shrink-0 opacity-80" />
              <span className="sr-only">Agenda: </span>
              {agendaText(ticket.scheduled_start, now)}
            </button>
          </li>

          {/* Só com o cabeçalho largo (painel de 56rem, página em tela grande); a fila também está na Geral. */}
          <li className="hidden min-w-0 @min-[55rem]:flex">
            <span
              className={clsx(CHIP, FULL, NEUTRAL)}
              title={ticket.owner ? `Analista responsável: ${ticket.owner.name}` : "Sem analista responsável: a OS está na fila geral"}
            >
              <Inbox aria-hidden className="size-3.5 shrink-0 opacity-80" />
              <span className="truncate">{ticket.owner ? `Fila de ${shortName(ticket.owner.name)}` : "Sem analista"}</span>
            </span>
          </li>
        </ul>
      </div>
    </div>
  );
}
