"use client";

import clsx from "clsx";
import { Check, MapPinned, Plus, Sparkles, UserPlus, X } from "lucide-react";
import { Skeleton } from "@/components/ui";
import { formatDate, initials } from "@/lib/format";
import type { TechnicianSuggestion, UUID } from "@/lib/types";

// Motivos que já aparecem nos números do cartão (não repetir como etiqueta).
const SHOWN_AS_NUMBERS = [/^Livre no horário$/, /^Ocupado no horário$/, /OS no dia$/, /^Sem OS no dia$/, /OS em aberto$/];

function km(value: number | null) {
  if (value == null) return null;
  return value < 1 ? "menos de 1 km" : `${value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} km`;
}

/** Técnicos mais indicados para a loja (distância, histórico, skill, agenda do dia). Um clique
 *  põe como responsável; "Junto" inclui como outro técnico da visita. */
export function SuggestedTechnicians({
  items,
  loading,
  hasPlace,
  scheduled,
  assigneeId,
  helperIds,
  onAssign,
  onToggleHelper,
}: {
  items: TechnicianSuggestion[] | undefined;
  loading: boolean;
  hasPlace: boolean;
  scheduled: boolean;
  assigneeId: UUID | "";
  helperIds: UUID[];
  onAssign: (t: TechnicianSuggestion | null) => void;
  onToggleHelper: (t: TechnicianSuggestion) => void;
}) {
  if (!hasPlace) {
    return (
      <p className="flex items-center gap-2 rounded-lg border border-dashed border-line-strong px-3 py-3 text-xs text-ink-muted">
        <MapPinned className="size-4 shrink-0 text-ink-subtle" />
        Escolha a loja para ver os técnicos mais indicados para ela.
      </p>
    );
  }
  if (loading && !items) {
    return (
      <div className="flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }
  if (!items?.length) {
    return <p className="rounded-lg bg-surface-2 px-3 py-3 text-xs text-ink-muted">Nenhum técnico ativo encontrado para esta região.</p>;
  }

  return (
    <ul className="stagger flex flex-col gap-2" aria-label="Técnicos sugeridos">
      {items.map((t, i) => {
        const isAssignee = assigneeId === t.id;
        const isHelper = helperIds.includes(t.id);
        const extra = t.reasons.filter((r) => !SHOWN_AS_NUMBERS.some((re) => re.test(r))).slice(0, 3);
        const facts = [
          km(t.distance_km),
          t.visits_at_location ? `${t.visits_at_location} ${t.visits_at_location === 1 ? "visita" : "visitas"} nesta loja` : null,
          t.day_load != null ? (t.day_load === 0 ? "sem OS no dia" : `${t.day_load} OS no dia`) : `${t.open_tickets} em aberto`,
        ].filter(Boolean);
        return (
          <li
            key={t.id}
            style={{ ["--i" as string]: i }}
            className={clsx(
              "group flex items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors",
              isAssignee
                ? "border-brand/50 bg-brand-soft/60 dark:bg-brand/10"
                : isHelper
                  ? "border-emerald-300/70 bg-emerald-50/60 dark:border-emerald-500/30 dark:bg-emerald-500/10"
                  : "border-line bg-surface hover:border-line-strong",
            )}
          >
            <span className="relative mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-3 text-xs font-semibold text-ink-muted">
              {initials(t.name)}
              {i === 0 && !isAssignee ? (
                <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-brand text-white" title="Mais indicado">
                  <Sparkles className="size-2.5" />
                </span>
              ) : null}
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="truncate text-sm font-semibold text-ink">{t.name}</span>
                {scheduled && t.busy != null ? (
                  <span
                    className={clsx(
                      "rounded-full px-1.5 py-px text-[11px] font-medium",
                      t.busy
                        ? "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300"
                        : "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
                    )}
                  >
                    {t.busy ? "Ocupado no horário" : "Livre no horário"}
                  </span>
                ) : null}
                {t.on_shift ? <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400">● em turno</span> : null}
              </p>
              <p className="mt-0.5 text-xs text-ink-muted">
                {facts.join(" · ")}
                {t.last_visit_at_location ? ` · última aqui em ${formatDate(t.last_visit_at_location)}` : ""}
              </p>
              {extra.length ? (
                <p className="mt-1 flex flex-wrap gap-1">
                  {extra.map((r) => (
                    <span key={r} className="rounded-md bg-surface-2 px-1.5 py-px text-[11px] text-ink-muted">
                      {r}
                    </span>
                  ))}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-col items-stretch gap-1 sm:flex-row sm:items-center">
              <button
                type="button"
                onClick={() => onAssign(isAssignee ? null : t)}
                aria-pressed={isAssignee}
                className={clsx(
                  "inline-flex h-7 items-center justify-center gap-1 rounded-lg px-2.5 text-xs font-medium transition-colors",
                  isAssignee ? "bg-brand text-white hover:bg-brand-ink" : "border border-line bg-surface text-ink hover:border-brand hover:text-brand",
                )}
                title={isAssignee ? "Tirar como responsável" : "Definir como técnico responsável"}
              >
                {isAssignee ? <Check className="size-3.5" /> : null}
                Responsável
              </button>
              {!isAssignee ? (
                <button
                  type="button"
                  onClick={() => onToggleHelper(t)}
                  aria-pressed={isHelper}
                  className={clsx(
                    "inline-flex h-7 items-center justify-center gap-1 rounded-lg px-2.5 text-xs font-medium transition-colors",
                    isHelper
                      ? "bg-emerald-600 text-white hover:bg-emerald-700"
                      : "border border-line bg-surface text-ink-muted hover:border-emerald-500 hover:text-emerald-700 dark:hover:text-emerald-300",
                  )}
                  title={isHelper ? "Tirar da visita" : "Incluir como outro técnico da visita"}
                >
                  {isHelper ? <X className="size-3.5" /> : <Plus className="size-3.5" />}
                  Junto
                </button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Outros técnicos da visita: etiquetas removíveis e um seletor para incluir mais. */
export function HelpersField({
  options,
  assigneeId,
  helperIds,
  names,
  onChange,
}: {
  options: { id: UUID; name: string; detail?: string }[];
  assigneeId: UUID | "";
  helperIds: UUID[];
  names: Record<UUID, string>;
  onChange: (ids: UUID[]) => void;
}) {
  const available = options.filter((o) => o.id !== assigneeId && !helperIds.includes(o.id));
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-ink">Outros técnicos da visita</span>
      <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1.5">
        {helperIds.map((id) => (
          <span key={id} className="inline-flex animate-pop items-center gap-1 rounded-md bg-emerald-50 py-0.5 pr-1 pl-2 text-xs font-medium text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200">
            {names[id] ?? "Técnico"}
            <button
              type="button"
              onClick={() => onChange(helperIds.filter((h) => h !== id))}
              className="rounded p-0.5 hover:bg-emerald-100 dark:hover:bg-emerald-500/20"
              aria-label={`Tirar ${names[id] ?? "técnico"} da visita`}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <span className="relative inline-flex min-w-40 flex-1 items-center">
          <UserPlus className="pointer-events-none absolute left-1.5 size-3.5 text-ink-subtle" />
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) onChange([...helperIds, e.target.value]);
            }}
            disabled={helperIds.length >= 6}
            className="h-7 w-full rounded-md bg-transparent pr-6 pl-6 text-xs text-ink-muted outline-none hover:text-ink disabled:opacity-50"
            aria-label="Incluir outro técnico na visita"
          >
            <option value="">{helperIds.length ? "Incluir mais um..." : "Incluir técnico que vai junto..."}</option>
            {available.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
                {o.detail ? ` — ${o.detail}` : ""}
              </option>
            ))}
          </select>
        </span>
      </div>
      <span className="text-xs text-ink-subtle">Eles veem a OS no app e registram fotos, acompanhamentos e horas; iniciar e concluir fica com o responsável.</span>
    </div>
  );
}
