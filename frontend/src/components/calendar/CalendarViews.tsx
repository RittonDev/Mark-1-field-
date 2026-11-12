"use client";

import clsx from "clsx";
import { AlertTriangle } from "lucide-react";
import { useEffect, useRef } from "react";
import { useNow } from "@/components/useNow";
import {
  type Placed,
  eventsOnDay,
  hhmm,
  layoutDay,
  sameDay,
  UNASSIGNED_COLOR,
  WEEKDAYS_SHORT,
} from "@/lib/calendar";
import { STATUS } from "@/lib/constants";
import type { CalendarEvent } from "@/lib/types";

export interface ViewProps {
  events: CalendarEvent[];
  colors: Map<string, string>;
  onOpen: (event: CalendarEvent) => void;
}

const colorOf = (event: CalendarEvent, colors: Map<string, string>) =>
  (event.assignee && colors.get(event.assignee.id)) || UNASSIGNED_COLOR;

const isDone = (event: CalendarEvent) => STATUS[event.status]?.group === "done" || STATUS[event.status]?.final;

function label(event: CalendarEvent): string {
  const who = event.assignee?.name ?? "Sem responsável";
  const where = [event.customer?.name, event.location?.name].filter(Boolean).join(" · ");
  const conflict = event.conflict_with.length ? " · CONFLITO DE HORÁRIO" : "";
  return `${event.code} · ${hhmm(new Date(event.start))}–${hhmm(new Date(event.end))} · ${who}${where ? ` · ${where}` : ""}${conflict}`;
}

// ------------------------------------------------------------------------- mês

export function MonthView({
  days,
  month,
  onDay,
  ...props
}: ViewProps & { days: Date[]; month: number; onDay: (day: Date) => void }) {
  const today = new Date();
  return (
    <div className="flex h-full flex-col">
      <div className="grid grid-cols-7 border-b border-line text-center text-xs font-medium tracking-wide text-ink-muted uppercase">
        {WEEKDAYS_SHORT.map((d) => (
          <div key={d} className="py-2">
            {d}
          </div>
        ))}
      </div>
      <div className="grid flex-1 auto-rows-fr grid-cols-7">
        {days.map((day) => {
          const list = eventsOnDay(props.events, day).sort((a, b) => a.start.localeCompare(b.start));
          const shown = list.slice(0, 3);
          const outside = day.getMonth() !== month;
          const clashes = list.filter((e) => e.conflict_with.length > 0).length;
          return (
            <div
              key={day.toISOString()}
              className={clsx(
                "flex min-h-24 min-w-0 flex-col gap-0.5 border-r border-b border-line p-1 last:border-r-0 [&:nth-child(7n)]:border-r-0",
                outside && "bg-surface-2/50",
              )}
            >
              <button
                type="button"
                onClick={() => onDay(day)}
                className="flex items-center justify-between rounded px-1 text-xs hover:bg-surface-2"
                aria-label={`Ver o dia ${day.toLocaleDateString("pt-BR")} por técnico`}
              >
                <span
                  className={clsx(
                    "flex size-6 items-center justify-center rounded-full tabular-nums",
                    sameDay(day, today) ? "bg-brand font-semibold text-white" : outside ? "text-ink-muted" : "text-ink",
                  )}
                >
                  {day.getDate()}
                </span>
                {clashes ? (
                  <span className="inline-flex items-center gap-0.5 font-medium text-red-600 dark:text-red-400">
                    <AlertTriangle className="size-3" />
                    {clashes}
                  </span>
                ) : null}
              </button>
              {shown.map((event) => (
                <EventChip key={event.id} event={event} {...props} />
              ))}
              {list.length > shown.length ? (
                <button
                  type="button"
                  onClick={() => onDay(day)}
                  className="rounded px-1 text-left text-xs font-medium text-ink-muted hover:bg-surface-2 hover:text-ink"
                >
                  +{list.length - shown.length} mais
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EventChip({ event, colors, onOpen }: ViewProps & { event: CalendarEvent }) {
  const color = colorOf(event, colors);
  const conflict = event.conflict_with.length > 0;
  return (
    <button
      type="button"
      onClick={() => onOpen(event)}
      title={label(event)}
      aria-label={label(event)}
      className={clsx(
        "flex min-w-0 items-center gap-1 rounded border-l-[3px] px-1 py-0.5 text-left text-[11px] leading-tight",
        conflict ? "bg-red-50 text-red-900 ring-1 ring-red-400 dark:bg-red-500/15 dark:text-red-100" : "text-ink",
        isDone(event) && "opacity-60",
      )}
      style={{ borderLeftColor: color, backgroundColor: conflict ? undefined : `${color}1a` }}
    >
      {conflict ? <AlertTriangle className="size-3 shrink-0 text-red-600 dark:text-red-400" /> : null}
      <span className="shrink-0 font-medium tabular-nums">{hhmm(new Date(event.start))}</span>
      <span className="truncate">
        {event.code.replace("OS-", "")} · {event.assignee?.name.split(" ")[0] ?? "—"}
      </span>
    </button>
  );
}

// ------------------------------------------------------- grade de horários

const HOUR_PX = 48;

export interface GridColumn {
  key: string;
  header: React.ReactNode;
  day: Date;
  events: CalendarEvent[];
}

/** Semana (uma coluna por dia) ou dia por técnico (uma coluna por técnico). */
export function TimeGrid({ columns, colors, onOpen }: Omit<ViewProps, "events"> & { columns: GridColumn[] }) {
  const now = useNow(60_000);
  const scrollRef = useRef<HTMLDivElement>(null);
  const laid = columns.map((c) => layoutDay(c.events, c.day));
  const first = laid.flat().reduce((min, p) => Math.min(min, p.start.getHours()), 7);

  // Abre já no horário de trabalho (ou na primeira visita, se for antes).
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = Math.max(0, first - 1) * HOUR_PX;
  }, [first]);

  const hours = Array.from({ length: 24 }, (_, h) => h);
  const nowDate = new Date(now);
  const nowTop = (nowDate.getHours() + nowDate.getMinutes() / 60) * HOUR_PX;
  const minWidth = columns.length > 7 ? `${64 + columns.length * 150}px` : undefined;

  return (
    <div ref={scrollRef} className="h-full overflow-auto">
      <div style={{ minWidth }}>
        <div className="sticky top-0 z-20 flex border-b border-line bg-surface">
          <div className="w-14 shrink-0" />
          {columns.map((c) => (
            <div key={c.key} className="min-w-0 flex-1 border-l border-line px-2 py-2 text-center">
              {c.header}
            </div>
          ))}
        </div>
        <div className="relative flex">
          <div className="w-14 shrink-0">
            {hours.map((h) => (
              <div key={h} className="relative text-right text-[11px] text-ink-muted" style={{ height: HOUR_PX }}>
                <span className="absolute -top-2 right-2 tabular-nums">{h === 0 ? "" : `${String(h).padStart(2, "0")}:00`}</span>
              </div>
            ))}
          </div>
          {columns.map((c, i) => (
            <div key={c.key} className="relative min-w-0 flex-1 border-l border-line">
              {hours.map((h) => (
                <div key={h} className="border-b border-line/70" style={{ height: HOUR_PX }} />
              ))}
              {sameDay(c.day, nowDate) ? (
                <div className="pointer-events-none absolute inset-x-0 z-10 flex items-center" style={{ top: nowTop }}>
                  <span className="-ml-1 size-2 rounded-full bg-red-500" />
                  <span className="h-px flex-1 bg-red-500" />
                </div>
              ) : null}
              {laid[i].map((p) => (
                <GridEvent key={p.event.id} placed={p} colors={colors} onOpen={onOpen} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function GridEvent({ placed, colors, onOpen }: Omit<ViewProps, "events"> & { placed: Placed }) {
  const { event, start, end, lane, lanes } = placed;
  const color = colorOf(event, colors);
  const conflict = event.conflict_with.length > 0;
  const top = (start.getHours() + start.getMinutes() / 60) * HOUR_PX;
  const height = Math.max(22, ((end.getTime() - start.getTime()) / 3_600_000) * HOUR_PX - 2);
  const width = 100 / lanes;
  return (
    <button
      type="button"
      onClick={() => onOpen(event)}
      title={label(event)}
      aria-label={label(event)}
      className={clsx(
        "absolute z-[5] overflow-hidden rounded-md border-l-[3px] px-1.5 py-1 text-left text-[11px] leading-tight shadow-xs transition-shadow hover:z-10 hover:shadow-md",
        conflict ? "bg-red-50 text-red-900 ring-2 ring-red-500 dark:bg-red-950/70 dark:text-red-100" : "text-ink",
        isDone(event) && "opacity-60",
      )}
      style={{
        top,
        height,
        left: `calc(${lane * width}% + 2px)`,
        width: `calc(${width}% - 4px)`,
        borderLeftColor: color,
        backgroundColor: conflict ? undefined : `color-mix(in srgb, ${color} 14%, var(--surface))`,
      }}
    >
      <span className="flex items-center gap-1 font-semibold">
        {conflict ? <AlertTriangle className="size-3 shrink-0 text-red-600 dark:text-red-400" /> : null}
        <span className="truncate">
          {hhmm(new Date(event.start))} {event.code}
        </span>
      </span>
      {height > 34 ? <span className="block truncate">{event.assignee?.name ?? "Sem responsável"}</span> : null}
      {height > 50 ? (
        <span className="block truncate text-ink-muted">
          {[event.customer?.name, event.location?.name].filter(Boolean).join(" · ") || event.title}
        </span>
      ) : null}
    </button>
  );
}
