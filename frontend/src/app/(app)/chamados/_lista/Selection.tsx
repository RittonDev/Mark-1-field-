"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Eraser, Tag as TagIcon, X } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useToast } from "@/components/Toaster";
import { Button, Dialog } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useTagRules } from "@/lib/tagRules";
import type { Tag, TicketListItem } from "@/lib/types";
import { sameTag, TagPicker, TagToggle, useKnownTags, withColor } from "./tags";

export type BulkTagMode = "add" | "remove";

const countOs = (n: number) => (n === 1 ? "1 OS" : `${n.toLocaleString("pt-BR")} OS`);

/** Barra das OS marcadas na página: exportar, pôr ou tirar etiquetas, desmarcar. */
export function SelectionBar({
  count,
  exporting,
  onExport,
  onTags,
  onClear,
}: {
  count: number;
  exporting: boolean;
  onExport: () => void;
  onTags: (mode: BulkTagMode) => void;
  onClear: () => void;
}) {
  return (
    <div
      role="region"
      aria-label="Ações para as OS selecionadas"
      className="flex flex-wrap items-center gap-x-1 gap-y-1.5 border-b border-line bg-[color-mix(in_srgb,var(--brand)_5%,var(--surface))] px-3 py-1.5"
    >
      <p className="mr-2 pl-1 text-sm font-semibold text-ink tabular-nums" aria-live="polite">
        {count === 1 ? "1 selecionada" : `${count.toLocaleString("pt-BR")} selecionadas`}
      </p>
      <Button size="sm" variant="ghost" onClick={onExport} loading={exporting}>
        {exporting ? null : <Download aria-hidden className="size-3.5" />}
        Exportar
      </Button>
      <Button size="sm" variant="ghost" onClick={() => onTags("add")}>
        <TagIcon aria-hidden className="size-3.5" />
        Adicionar etiqueta
      </Button>
      <Button size="sm" variant="ghost" onClick={() => onTags("remove")}>
        <Eraser aria-hidden className="size-3.5" />
        Remover etiqueta
      </Button>
      <Button size="sm" variant="ghost" onClick={onClear} className="ml-auto">
        <X aria-hidden className="size-3.5" />
        Limpar seleção
      </Button>
    </div>
  );
}

/** Etiquetas que as OS escolhidas têm, com quantas têm cada uma (a mais comum primeiro). */
function tagsOf(tickets: TicketListItem[]): { tag: Tag; count: number }[] {
  const found: { tag: Tag; count: number }[] = [];
  for (const t of tickets) {
    for (const tag of t.tags ?? []) {
      const entry = found.find((x) => sameTag(x.tag.name, tag.name));
      if (entry) entry.count += 1;
      else found.push({ tag, count: 1 });
    }
  }
  return found.sort((a, b) => b.count - a.count || a.tag.name.localeCompare(b.tag.name, "pt-BR"));
}

/** Etiquetas sem repetição (a primeira escrita de cada nome vale). */
function uniqueTags(tags: Tag[]): Tag[] {
  const out: Tag[] = [];
  for (const tag of tags) if (!out.some((x) => sameTag(x.name, tag.name))) out.push(tag);
  return out;
}

/**
 * Pôr ou tirar etiquetas das OS marcadas de uma vez (como no Field Control): ex.: tirar "Pendente
 * Envio PGTO" das OS já pagas, pôr "Custo Extra". Cada OS alterada ganha o registro no histórico.
 */
export function BulkTagsDialog({ mode, tickets, onClose }: { mode: BulkTagMode; tickets: TicketListItem[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const labelId = useId();
  const known = useKnownTags();
  const { rules } = useTagRules();
  const [names, setNames] = useState<string[]>([]);
  const present = useMemo(() => tagsOf(tickets), [tickets]);
  const adding = mode === "add";
  // As etiquetas automáticas (abertura, projeto, custo extra) primeiro, para um clique; depois as mais
  // usadas. A cor de cada uma é a já usada nas OS ou, para uma automática ainda sem uso, a da regra.
  const ruleTags = useMemo(() => uniqueTags([...rules.on_create, ...rules.on_project, ...rules.on_extra_cost]), [rules]);
  const palette = useMemo(() => uniqueTags([...(known.data ?? []), ...ruleTags]), [known.data, ruleTags]);
  const suggestions = useMemo(
    () => uniqueTags([...ruleTags.map((t) => withColor(t.name, palette)), ...(known.data ?? [])]).slice(0, 10),
    [ruleTags, palette, known.data],
  );

  const save = useMutation({
    mutationFn: () =>
      api.post<{ updated: number }>("/tickets/bulk-tags", {
        ids: tickets.map((t) => t.id),
        add: adding ? names.map((n) => withColor(n, palette)) : [],
        remove: adding ? [] : names,
      }),
    onSuccess: ({ updated }) => {
      void queryClient.invalidateQueries({ queryKey: ["tickets"] });
      void queryClient.invalidateQueries({ queryKey: ["ticket-tags"] });
      const what = names.length === 1 ? `Etiqueta “${names[0]}”` : `${names.length} etiquetas`;
      if (updated === 0) {
        toast({
          title: "Nada mudou",
          description: adding ? "As OS já tinham essas etiquetas." : "As OS já estavam sem essas etiquetas.",
        });
      } else {
        const verb = adding ? (names.length === 1 ? "adicionada em" : "adicionadas em") : names.length === 1 ? "removida de" : "removidas de";
        toast({ title: `${what} ${verb} ${countOs(updated)}`, tone: "success" });
      }
      onClose();
    },
    onError: (e) =>
      toast({ title: adding ? "Não foi possível adicionar as etiquetas" : "Não foi possível remover as etiquetas", description: errorMessage(e), tone: "error" }),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      busy={save.isPending}
      title={adding ? `Adicionar etiqueta em ${countOs(tickets.length)}` : `Remover etiqueta de ${countOs(tickets.length)}`}
      description={
        adding
          ? "Escolha uma ou mais etiquetas. As OS que já têm a etiqueta ficam como estão."
          : "Marque as etiquetas que saem. As outras etiquetas das OS continuam."
      }
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={names.length === 0 || tickets.length === 0}>
            {adding ? "Adicionar" : "Remover"}
          </Button>
        </>
      }
    >
      {adding ? (
        <div className="flex flex-col gap-1.5">
          <span id={labelId} className="text-xs font-semibold text-ink/80">
            Etiquetas
          </span>
          <TagPicker
            value={names}
            onChange={setNames}
            known={palette}
            suggestions={suggestions}
            labelledBy={labelId}
            placeholder="Buscar ou criar etiqueta"
          />
        </div>
      ) : present.length ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-xs font-semibold text-ink/80">Etiquetas das OS selecionadas</legend>
          <div className="flex flex-wrap gap-2">
            {present.map(({ tag, count }) => {
              const on = names.some((n) => sameTag(n, tag.name));
              return (
                <span key={tag.name} className="inline-flex items-center gap-1.5">
                  <TagToggle
                    tag={tag}
                    on={on}
                    onToggle={() => setNames(on ? names.filter((n) => !sameTag(n, tag.name)) : [...names, tag.name])}
                  />
                  <span className="text-xs text-ink-muted tabular-nums">
                    {count === tickets.length ? "em todas" : `em ${count} de ${tickets.length}`}
                  </span>
                </span>
              );
            })}
          </div>
        </fieldset>
      ) : (
        <p className="text-sm text-ink-muted">As OS selecionadas não têm etiquetas.</p>
      )}
    </Dialog>
  );
}
