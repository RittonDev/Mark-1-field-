"use client";

import clsx from "clsx";
import { Check } from "lucide-react";
import Link from "next/link";
import { useCan } from "@/lib/permissions";
import type { UUID } from "@/lib/types";

/** Etiqueta neutra do item marcado, só leitura (como as do perfil técnico). */
const READ_CHIP = "rounded-full border border-line px-2.5 py-0.5 text-xs text-ink";

/**
 * Os itens de um catálogo dos técnicos (Áreas de atuação, Ferramental) como botões de marcar e desmarcar, na ordem que
 * vierem (a alfabética do catálogo). Marcado: borda da marca, fundo do item ativo do menu e o visto (o estado não fica
 * só na cor); `aria-pressed` para o leitor de tela. Com `max` marcados, os outros travam. Sem `onToggle`, só leitura:
 * só os marcados, como etiquetas.
 */
export function CatalogChips({
  items,
  selected,
  onToggle,
  label,
  max,
}: {
  items: readonly { id: UUID; name: string }[];
  selected: readonly UUID[];
  onToggle?: (id: UUID) => void;
  /** O nome do grupo para o leitor de tela ("Áreas de atuação"). */
  label: string;
  max?: number;
}) {
  const marked = new Set(selected);
  if (!onToggle) {
    return (
      <ul className="flex flex-wrap gap-1.5" aria-label={label}>
        {items
          .filter((item) => marked.has(item.id))
          .map((item) => (
            <li key={item.id} className={READ_CHIP}>
              {item.name}
            </li>
          ))}
      </ul>
    );
  }
  const full = max !== undefined && marked.size >= max;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={label}>
      {items.map((item) => {
        const on = marked.has(item.id);
        return (
          <li key={item.id}>
            <button
              type="button"
              aria-pressed={on}
              disabled={!on && full}
              onClick={() => onToggle(item.id)}
              className={clsx(
                "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm transition-colors",
                "focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none disabled:opacity-50",
                on
                  ? "border-brand bg-nav-active text-ink"
                  : "border-line text-ink-muted hover:border-line-strong hover:text-ink disabled:hover:border-line disabled:hover:text-ink-muted",
              )}
            >
              {on ? <Check aria-hidden className="size-3.5 shrink-0 text-brand-ink" /> : null}
              {item.name}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * O catálogo sem nenhum item ativo: "Nenhuma área cadastrada." e, para quem cadastra (Configurações em Editar), o link
 * para Configurações › Técnicos.
 */
export function EmptyCatalog({ text }: { text: string }) {
  const canSettings = useCan("setup.settings", "edit");
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-muted">
      {text}
      {canSettings ? (
        <Link
          href="/configuracoes#tecnicos"
          className="rounded font-medium text-brand-ink underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
        >
          Cadastrar em Configurações
        </Link>
      ) : null}
    </p>
  );
}
