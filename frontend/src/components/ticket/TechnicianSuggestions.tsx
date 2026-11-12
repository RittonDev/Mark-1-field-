"use client";

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { MapPin, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { initials } from "@/lib/format";
import type { TechnicianSuggestion, TicketDetail } from "@/lib/types";

/** Os 5 técnicos mais indicados para a OS, com o motivo de cada sugestão. */
export function TechnicianSuggestions({
  ticket,
  onPick,
  picking,
}: {
  ticket: TicketDetail;
  onPick: (id: string) => void;
  picking: string | null;
}) {
  const suggestions = useQuery({
    queryKey: ["ticket", ticket.id, "suggestions", ticket.scheduled_start, ticket.location?.id],
    queryFn: () => api.get<TechnicianSuggestion[]>(`/tickets/${ticket.id}/technician-suggestions`),
    staleTime: 30_000,
  });
  const list = (suggestions.data ?? []).filter((s) => s.id !== ticket.assignee?.id);
  if (!list.length) return null;
  const where = [ticket.location?.city, ticket.location?.state].filter(Boolean).join("-");

  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-ink-muted">
        <Sparkles className="size-3.5 text-brand" />
        Sugeridos{where ? ` para ${where}` : ""}
      </p>
      <ul className="flex flex-col gap-1.5">
        {list.map((s, i) => (
          <li key={s.id} className={clsx("rounded-lg border px-2.5 py-2", i === 0 ? "border-brand/40 bg-sidebar-active/60" : "border-line")}>
            <div className="flex items-center gap-2">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand/10 text-[11px] font-semibold text-brand">
                {initials(s.name)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{s.name}</p>
                <p className="flex items-center gap-1 truncate text-[11px] text-ink-muted">
                  <MapPin className="size-3 shrink-0" />
                  {[s.home_city, s.home_state].filter(Boolean).join("-") || "cidade não informada"}
                  {s.on_shift ? " · em jornada" : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onPick(s.id)}
                disabled={picking !== null}
                className="shrink-0 rounded-md border border-line px-2 py-1 text-xs font-medium text-ink hover:border-brand hover:text-brand disabled:opacity-50"
              >
                {picking === s.id ? "..." : "Atribuir"}
              </button>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {s.reasons.map((r) => (
                <span
                  key={r}
                  className={clsx(
                    "rounded-full px-1.5 py-0.5 text-[10px]",
                    r.startsWith("Ocupado") ? "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300" : "bg-surface-2 text-ink-muted",
                  )}
                >
                  {r}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
