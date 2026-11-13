"use client";

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Check, X } from "lucide-react";
import { useId, useState } from "react";
import { api } from "@/lib/api";
import type { Tag } from "@/lib/types";

// Cor de cada etiqueta (nomes do Field Control) num ponto de 6 px: o chip fica neutro. Quase toda OS tem
// "Ticket Avulso" ou "Ticket Contratual", e etiqueta colorida em toda linha apagava os sinais de problema.
const DOT: Record<string, string> = {
  red: "bg-red-500",
  pink: "bg-pink-500",
  purple: "bg-purple-500",
  indigo: "bg-indigo-500",
  blue: "bg-blue-500",
  "light-blue": "bg-sky-500",
  teal: "bg-teal-500",
  green: "bg-emerald-500",
  yellow: "bg-yellow-400",
  orange: "bg-orange-500",
  brown: "bg-amber-700",
  "blue-grey": "bg-slate-500",
  "field-pale": "bg-stone-400",
};

const CHIP = "inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-ink-muted ring-1 ring-line ring-inset";

function TagDot({ color }: { color: string | null }) {
  return <span aria-hidden className={clsx("size-1.5 shrink-0 rounded-full", DOT[color ?? ""] ?? "bg-ink-subtle")} />;
}

/** Etiquetas da OS ou do cliente (ex.: "Ticket Avulso", "Faturamento Matriz", "Pendente Envio PGTO"). */
export function TagChips({ tags, max = 3, className }: { tags?: Tag[] | null; max?: number; className?: string }) {
  if (!tags?.length) return null;
  const shown = tags.slice(0, max);
  const hidden = tags.slice(max).map((t) => t.name).join(", ");
  const rest = tags.length - shown.length;
  return (
    <span className={clsx("inline-flex flex-wrap gap-1", className)}>
      {shown.map((t) => (
        <span key={t.name} className={CHIP}>
          <TagDot color={t.color} />
          {t.name}
        </span>
      ))}
      {rest > 0 ? (
        <span className={CHIP} title={hidden}>
          <span aria-hidden>+{rest}</span>
          <span className="sr-only">
            Mais {rest} {rest === 1 ? "etiqueta" : "etiquetas"}: {hidden}
          </span>
        </span>
      ) : null}
    </span>
  );
}

/** As etiquetas que dizem como a OS é cobrada: uma exclui a outra. */
export const BILLING_TAGS: Tag[] = [
  { name: "Ticket Avulso", color: "green" },
  { name: "Ticket Contratual", color: "pink" },
];

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Etiquetas da OS para editar: os atalhos de cobrança ("Ticket Avulso" ou "Ticket Contratual"), as
 * escolhidas (tira com o ×) e um campo para incluir outra, com as já usadas nas OS como sugestão.
 */
export function TagsInput({
  value,
  onChange,
  inputId,
  labelledBy,
}: {
  value: Tag[];
  onChange: (tags: Tag[]) => void;
  inputId?: string;
  /** id do rótulo visível do campo. */
  labelledBy?: string;
}) {
  const listId = useId();
  const [draft, setDraft] = useState("");
  const known = useQuery({ queryKey: ["ticket-tags"], queryFn: () => api.get<Tag[]>("/ticket-tags"), staleTime: 5 * 60_000 });
  const has = (name: string) => value.some((t) => same(t.name, name));
  const full = value.length >= 20;

  const add = (name: string) => {
    const clean = name.replace(/\s+/g, " ").trim().slice(0, 60);
    setDraft("");
    if (!clean || has(clean) || full) return;
    onChange([...value, known.data?.find((t) => same(t.name, clean)) ?? { name: clean, color: null }]);
  };
  const toggleBilling = (tag: Tag) => {
    if (has(tag.name)) return onChange(value.filter((t) => !same(t.name, tag.name)));
    const rest = value.filter((t) => !BILLING_TAGS.some((b) => same(b.name, t.name)));
    onChange([...rest, known.data?.find((t) => same(t.name, tag.name)) ?? tag]);
  };
  const others = value.filter((t) => !BILLING_TAGS.some((b) => same(b.name, t.name)));

  return (
    <div className="flex flex-col gap-2">
      <div role="group" aria-labelledby={labelledBy} className="flex flex-wrap gap-1.5">
        {BILLING_TAGS.map((tag) => {
          const on = has(tag.name);
          return (
            <button
              key={tag.name}
              type="button"
              aria-pressed={on}
              onClick={() => toggleBilling(tag)}
              className={clsx(
                "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors",
                "focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none",
                on ? "border-brand/40 bg-brand-soft text-brand-ink" : "border-line bg-surface text-ink-muted hover:border-line-strong hover:text-ink",
              )}
            >
              {on ? <Check aria-hidden className="size-3.5" /> : <TagDot color={tag.color} />}
              {tag.name}
            </button>
          );
        })}
      </div>
      <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1 shadow-elev-1 focus-within:border-brand focus-within:ring-4 focus-within:ring-brand/15">
        {others.map((t) => (
          <span key={t.name} className="inline-flex items-center gap-1 rounded-md bg-surface-2 py-0.5 pr-0.5 pl-1.5 text-xs font-medium text-ink-muted ring-1 ring-line ring-inset">
            <TagDot color={t.color} />
            {t.name}
            <button
              type="button"
              onClick={() => onChange(value.filter((x) => x.name !== t.name))}
              className="rounded p-0.5 hover:bg-ink/10 hover:text-ink"
              aria-label={`Tirar a etiqueta ${t.name}`}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          id={inputId}
          list={listId}
          value={draft}
          disabled={full}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
              // Enter inclui a etiqueta (não envia o formulário).
              e.preventDefault();
              add(draft);
            } else if (e.key === "Backspace" && !draft && others.length) {
              onChange(value.filter((x) => x.name !== others[others.length - 1].name));
            }
          }}
          onBlur={() => {
            if (draft.trim()) add(draft);
          }}
          maxLength={60}
          placeholder={full ? "Limite de 20 etiquetas" : others.length ? "Outra etiqueta" : "Outra etiqueta (ex.: Adicional Noturno)"}
          className="h-7 min-w-40 flex-1 bg-transparent px-1 text-sm text-ink outline-none placeholder:text-ink-subtle"
          aria-label="Incluir etiqueta"
        />
        <datalist id={listId}>
          {(known.data ?? [])
            .filter((t) => !has(t.name) && !BILLING_TAGS.some((b) => same(b.name, t.name)))
            .map((t) => (
              <option key={t.name} value={t.name} />
            ))}
        </datalist>
      </div>
    </div>
  );
}
