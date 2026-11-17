"use client";

import clsx from "clsx";
import { ArrowRight, Building2, CheckCircle2, ChevronDown, CircleAlert, Clock3, HardHat, Info, OctagonAlert, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { TicketLink } from "@/components/ticket/TicketLink";
import { Card, CardHeader, EmptyState, SectionTitle, Skeleton } from "@/components/ui";
import { formatDateTime, formatRelative } from "@/lib/format";
import { targetHref } from "./links";
import { OldBacklog } from "./OldBacklog";
import { intFmt } from "./rules";
import { nameOf, ticketCode } from "./search";
import type { AttentionGroup, AttentionItem, HomeBacklog, Severity } from "./types";

type Icon = React.ComponentType<{ className?: string }>;

/** Gravidade com ícone e texto (nunca só a cor); vermelho e âmbar só para o que é grave. */
const SEVERITY: Record<Severity, { label: string; icon: Icon; className: string }> = {
  critical: {
    label: "Crítico",
    icon: OctagonAlert,
    className: "bg-red-50 text-red-700 ring-red-200 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/25",
  },
  high: {
    label: "Alto",
    icon: TriangleAlert,
    className: "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/25",
  },
  medium: { label: "Médio", icon: CircleAlert, className: "bg-surface-2 text-ink-muted ring-line" },
  low: { label: "Baixo", icon: Info, className: "bg-surface-2 text-ink-muted ring-line" },
};

function SeverityTag({ severity }: { severity: Severity }) {
  const info = SEVERITY[severity] ?? SEVERITY.medium;
  const Icon = info.icon;
  return (
    <span className={clsx("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset", info.className)}>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {info.label}
    </span>
  );
}

function CountPill({ value }: { value: number }) {
  return (
    <span className="rounded-full bg-surface-2 px-1.5 text-[11px] leading-[18px] font-semibold text-ink-muted tabular-nums">{intFmt(value)}</span>
  );
}

function ItemBody({ item, now }: { item: AttentionItem; now: number }) {
  const place = [nameOf(item.customer), nameOf(item.location)].filter(Boolean).join(" · ");
  const technician = nameOf(item.technician);
  return (
    <>
      <span className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink group-hover:text-brand-ink">
          {item.number ? <span className="mr-1.5 font-mono text-xs font-normal text-ink-muted">{ticketCode(item.number)}</span> : null}
          {item.title}
        </span>
        {item.when ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-ink-muted tabular-nums" title={formatDateTime(item.when)}>
            <Clock3 aria-hidden className="size-3.5 text-ink-subtle" />
            {formatRelative(item.when, now)}
          </span>
        ) : null}
      </span>
      <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-muted">
        <span className="font-medium text-ink">{item.reason}</span>
        {place ? (
          <span className="inline-flex min-w-0 items-center gap-1">
            <Building2 aria-hidden className="size-3.5 shrink-0 text-ink-subtle" />
            <span className="truncate">{place}</span>
          </span>
        ) : null}
        {technician ? (
          <span className="inline-flex min-w-0 items-center gap-1">
            <HardHat aria-hidden className="size-3.5 shrink-0 text-ink-subtle" />
            <span className="truncate">{technician}</span>
          </span>
        ) : null}
      </span>
    </>
  );
}

const rowClass =
  "group block px-5 py-2.5 transition-colors duration-150 hover:bg-[var(--row-hover)] focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus";

function ItemList({ group, now, href }: { group: AttentionGroup; now: number; href: string | null }) {
  return (
    <ul className="divide-y divide-line">
      {group.items.map((item, i) => (
        <li key={item.ticket_id ?? `${group.key}-${i}`}>
          {item.ticket_id ? (
            // O clique abre a OS no painel lateral; Ctrl+clique ou o botão do meio abrem a página.
            <TicketLink ticketId={item.ticket_id} className={rowClass}>
              <ItemBody item={item} now={now} />
            </TicketLink>
          ) : href ? (
            <Link href={href} className={rowClass}>
              <ItemBody item={item} now={now} />
            </Link>
          ) : (
            <div className="px-5 py-2.5">
              <ItemBody item={item} now={now} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function SeeAll({ group, href }: { group: AttentionGroup; href: string }) {
  const count = intFmt(group.count);
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 text-xs font-semibold text-brand-ink underline-offset-2 hover:underline"
      aria-label={`Ver todas (${count}): ${group.title}`}
    >
      Ver todas ({count})
      <ArrowRight aria-hidden className="size-3.5" />
    </Link>
  );
}

/**
 * Um grupo de pontos de atenção. Em "Agora" vem aberto, com as OS e o motivo de cada uma; em "Rotina"
 * vem recolhido, com os exemplos atrás de um botão. "Ver todas (N)" só quando a lista reproduz o
 * número; sem ela, "e mais N".
 */
function GroupCard({ group, now, collapsed }: { group: AttentionGroup; now: number; collapsed: boolean }) {
  const href = targetHref(group);
  const [open, setOpen] = useState(false);
  const listId = useId();
  const items = group.items.length;
  const more = !href && items > 0 && group.count > items ? group.count - items : 0;
  const moreNote = more ? <p className="border-t border-line px-5 py-2.5 text-xs text-ink-muted tabular-nums">e mais {intFmt(more)}</p> : null;
  return (
    <Card className="overflow-hidden">
      <CardHeader
        as="h4"
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            {group.title}
            <CountPill value={group.count} />
          </span>
        }
        description={group.hint}
        actions={<SeverityTag severity={group.severity} />}
      />
      {collapsed ? (
        <>
          {items || href ? (
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-2.5">
              {items ? (
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={listId}
                  onClick={() => setOpen((v) => !v)}
                  className="-mx-1 inline-flex items-center gap-1 rounded-md px-1 text-xs font-semibold text-ink-muted transition-colors hover:text-ink"
                >
                  Exemplos ({intFmt(items)})
                  <ChevronDown aria-hidden className={clsx("size-3.5 transition-transform duration-150", open && "rotate-180")} />
                </button>
              ) : (
                <span />
              )}
              {href ? <SeeAll group={group} href={href} /> : null}
            </div>
          ) : null}
          {items ? (
            <div id={listId} hidden={!open} className="border-t border-line">
              <ItemList group={group} now={now} href={href} />
              {moreNote}
            </div>
          ) : null}
        </>
      ) : (
        <>
          {items ? <ItemList group={group} now={now} href={href} /> : null}
          {href ? (
            <div className={clsx("px-5 py-2.5", items && "border-t border-line")}>
              <SeeAll group={group} href={href} />
            </div>
          ) : (
            moreNote
          )}
        </>
      )}
    </Card>
  );
}

/** Os cartões de uma camada, cada um alvo das fichas do topo (id ponto-{key}, foco visível). */
function Groups({ groups, now, collapsed }: { groups: AttentionGroup[]; now: number; collapsed: boolean }) {
  return (
    <div className="stagger flex flex-col gap-4">
      {groups.map((group, i) => (
        <div
          key={group.key}
          id={`ponto-${group.key}`}
          tabIndex={-1}
          className="scroll-mt-20 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-focus"
          style={{ ["--i" as string]: i }}
        >
          <GroupCard group={group} now={now} collapsed={collapsed} />
        </div>
      ))}
    </div>
  );
}

/**
 * Pontos de atenção em duas camadas, na ordem da API (gravidade, depois quantidade): "Agora" (o que
 * entra no número do topo, aberto) e "Rotina" (recolhido). Por último, a fila antiga, que não entra
 * em nenhuma das duas.
 */
export function AttentionList({
  groups,
  now,
  focusTotal,
  backlog,
  windowFrom,
}: {
  groups: AttentionGroup[] | null;
  now: number;
  focusTotal: number | null;
  backlog: HomeBacklog | null;
  windowFrom: string | null;
}) {
  if (groups === null) {
    return (
      <div className="flex flex-col gap-4" role="status" aria-label="Carregando os pontos de atenção">
        {[0, 1, 2].map((i) => (
          <Card key={i} className="p-5">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="mt-2 h-3 w-1/2" />
            <Skeleton className="mt-5 h-3.5 w-4/5" />
            <Skeleton className="mt-2.5 h-3.5 w-3/5" />
          </Card>
        ))}
      </div>
    );
  }
  const nowGroups = groups.filter((g) => g.tier === "now");
  const routine = groups.filter((g) => g.tier !== "now");
  const old = backlog && windowFrom ? <OldBacklog backlog={backlog} windowFrom={windowFrom} /> : null;
  if (groups.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <Card>
          <EmptyState icon={<CheckCircle2 />} title="Nada pedindo atenção agora" />
        </Card>
        {old}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      {nowGroups.length ? (
        <section id="pontos-agora" tabIndex={-1} aria-labelledby="pontos-agora-titulo" className="scroll-mt-20 rounded-xl outline-none">
          <SectionTitle
            as="h3"
            className="mb-3"
            aside={focusTotal !== null ? <span className="text-xs text-ink-muted tabular-nums">{intFmt(focusTotal)} OS</span> : null}
          >
            <span id="pontos-agora-titulo">Agora</span>
          </SectionTitle>
          <Groups groups={nowGroups} now={now} collapsed={false} />
        </section>
      ) : null}
      {routine.length ? (
        <section aria-labelledby="pontos-rotina-titulo">
          <SectionTitle as="h3" className="mb-3">
            <span id="pontos-rotina-titulo">Rotina</span>
          </SectionTitle>
          <Groups groups={routine} now={now} collapsed />
        </section>
      ) : null}
      {old}
    </div>
  );
}
