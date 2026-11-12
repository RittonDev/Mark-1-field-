"use client";

import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { ApiError } from "@/lib/api";
import { formatShort, formatTime } from "@/lib/format";
import { useScheduleConflicts } from "@/lib/queries";
import type { ConflictItem, UUID } from "@/lib/types";

/** Conflitos de agenda devolvidos pela API (409 SCHEDULE_CONFLICT), ou null se for outro erro. */
export function scheduleConflicts(error: unknown): ConflictItem[] | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const body = error.body as { code?: string; conflicts?: ConflictItem[] } | null;
  return body?.code === "SCHEDULE_CONFLICT" ? (body.conflicts ?? []) : null;
}

function span(item: ConflictItem): string {
  const sameDay = new Date(item.start).toDateString() === new Date(item.end).toDateString();
  return `${formatShort(item.start)} – ${sameDay ? formatTime(item.end) : formatShort(item.end)}`;
}

/** Lista das OS em choque de horário (aviso amarelo antes de salvar, vermelho quando a API barrou). */
export function ConflictList({
  items,
  tone = "warning",
  title,
}: {
  items: ConflictItem[];
  tone?: "warning" | "error";
  title: string;
}) {
  const box =
    tone === "error"
      ? "border-red-200 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
      : "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200";
  return (
    <div className={`rounded-lg border px-3 py-2 text-sm ${box}`} role={tone === "error" ? "alert" : "status"}>
      <p className="flex items-center gap-1.5 font-medium">
        <AlertTriangle className="size-4 shrink-0" />
        {title}
      </p>
      <ul className="mt-1.5 space-y-1">
        {items.map((c) => (
          <li key={`${c.who ?? ""}-${c.id}`} className="text-xs">
            {c.who ? <span className="font-medium">{c.who}: </span> : null}
            <Link href={`/chamados/${c.id}`} className="font-mono font-medium underline-offset-2 hover:underline">
              {c.code}
            </Link>{" "}
            · {span(c)} · {[c.customer, c.location].filter(Boolean).join(" · ") || c.title}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Aviso ao vivo enquanto se escolhe técnico e horário. */
export function ConflictHint({
  assigneeId,
  assigneeName,
  start,
  end,
  estimatedMinutes,
  excludeId,
}: {
  assigneeId: UUID | null | undefined;
  assigneeName?: string | null;
  start: string | null;
  end?: string | null;
  estimatedMinutes?: number | null;
  excludeId?: UUID;
}) {
  const { data } = useScheduleConflicts({ assigneeId, start, end, estimatedMinutes, excludeId });
  if (!data || data.length === 0) return null;
  const who = assigneeName ?? "O técnico";
  return (
    <ConflictList
      items={data}
      title={`${who} já tem ${data.length === 1 ? "uma OS" : `${data.length} OS`} neste horário`}
    />
  );
}
