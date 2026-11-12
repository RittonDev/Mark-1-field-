import clsx from "clsx";
import type { Tag } from "@/lib/types";

// Cores das etiquetas (mesmos nomes usados no Field Control), em tons suaves que funcionam nos dois temas.
const TONE: Record<string, string> = {
  red: "bg-red-50 text-red-700 ring-red-200 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/25",
  pink: "bg-pink-50 text-pink-700 ring-pink-200 dark:bg-pink-500/10 dark:text-pink-300 dark:ring-pink-500/25",
  purple: "bg-purple-50 text-purple-700 ring-purple-200 dark:bg-purple-500/10 dark:text-purple-300 dark:ring-purple-500/25",
  indigo: "bg-indigo-50 text-indigo-700 ring-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-500/25",
  blue: "bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:ring-blue-500/25",
  "light-blue": "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/25",
  teal: "bg-teal-50 text-teal-700 ring-teal-200 dark:bg-teal-500/10 dark:text-teal-300 dark:ring-teal-500/25",
  green: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/25",
  yellow: "bg-yellow-50 text-yellow-800 ring-yellow-200 dark:bg-yellow-500/10 dark:text-yellow-300 dark:ring-yellow-500/25",
  orange: "bg-orange-50 text-orange-700 ring-orange-200 dark:bg-orange-500/10 dark:text-orange-300 dark:ring-orange-500/25",
  brown: "bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-500/25",
  "blue-grey": "bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-500/15 dark:text-slate-300 dark:ring-slate-500/25",
  "field-pale": "bg-stone-100 text-stone-700 ring-stone-200 dark:bg-stone-500/15 dark:text-stone-300 dark:ring-stone-500/25",
};

/** Etiquetas da OS ou do cliente (ex.: "Avulso", "Faturamento Matriz", "Pendente envio PGTO"). */
export function TagChips({ tags, max = 3, className }: { tags?: Tag[] | null; max?: number; className?: string }) {
  if (!tags?.length) return null;
  const shown = tags.slice(0, max);
  const rest = tags.length - shown.length;
  return (
    <span className={clsx("inline-flex flex-wrap gap-1", className)}>
      {shown.map((t) => (
        <span
          key={t.name}
          className={clsx(
            "rounded-md px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ring-1 ring-inset",
            TONE[t.color ?? ""] ?? "bg-surface-2 text-ink-muted ring-line",
          )}
        >
          {t.name}
        </span>
      ))}
      {rest > 0 ? (
        <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-ink-subtle" title={tags.slice(max).map((t) => t.name).join(", ")}>
          +{rest}
        </span>
      ) : null}
    </span>
  );
}
