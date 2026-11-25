"use client";

import { Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { fold } from "@/components/operacao/hooks";
import { Button, Input } from "@/components/ui";

// Etiquetas dos serviços marcados: acima disso, só a contagem (há técnico com quase 200 serviços).
const SERVICE_CHIPS = 24;

/**
 * "Serviços que faz": busca, marcar os filtrados e etiquetas do que está marcado agora (não do que foi
 * salvo). `readOnly`: só as etiquetas do que está marcado, sem busca nem lista.
 */
export function ServicePicker({
  value,
  onChange,
  options,
  saved,
  loading,
  readOnly = false,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  options: { id: string; name: string }[];
  /** Serviços salvos no cadastro (inclui tipos que foram desativados, para poder desmarcar). */
  saved: { id: string; name: string }[];
  loading: boolean;
  readOnly?: boolean;
}) {
  const [term, setTerm] = useState("");
  const all = useMemo(() => {
    const known = new Set(options.map((o) => o.id));
    return [...options, ...saved.filter((s) => !known.has(s.id))];
  }, [options, saved]);
  const names = useMemo(() => new Map(all.map((o) => [o.id, o.name])), [all]);
  const visible = useMemo(() => {
    const t = fold(term.trim());
    return t ? all.filter((o) => fold(o.name).includes(t)) : all;
  }, [all, term]);
  const selected = new Set(value);
  const toggle = (id: string) => onChange(selected.has(id) ? value.filter((v) => v !== id) : [...value, id]);
  const markVisible = () => onChange([...new Set([...value, ...visible.map((o) => o.id)])]);
  if (readOnly) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs font-semibold text-ink/80">
          Serviços que faz <span className="font-normal text-ink-muted tabular-nums">({value.length})</span>
        </p>
        {value.length ? (
          <ul className="flex flex-wrap gap-1" aria-label="Serviços que faz">
            {value.slice(0, SERVICE_CHIPS).map((id) => (
              <li key={id} className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-muted ring-1 ring-line ring-inset">
                {names.get(id) ?? "Serviço"}
              </li>
            ))}
            {value.length > SERVICE_CHIPS ? (
              <li className="self-center text-[11px] text-ink-muted">+{value.length - SERVICE_CHIPS}</li>
            ) : null}
          </ul>
        ) : (
          <p className="text-xs text-ink-muted">Nenhum serviço marcado.</p>
        )}
      </div>
    );
  }
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1.5 text-xs font-semibold text-ink/80">
        Serviços que faz <span className="font-normal text-ink-muted tabular-nums">({value.length})</span>
      </legend>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted" />
          <Input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => {
              // Enter na busca não salva a seção.
              if (e.key === "Enter") e.preventDefault();
            }}
            placeholder="Buscar serviço"
            className="pl-9"
            aria-label="Buscar serviço"
          />
        </div>
        <Button size="sm" variant="ghost" onClick={markVisible} disabled={!visible.length}>
          {term.trim() ? "Marcar os filtrados" : "Marcar todos"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onChange([])} disabled={!value.length}>
          Limpar
        </Button>
      </div>
      <div className="max-h-56 overflow-y-auto rounded-lg border border-line p-1">
        {loading ? (
          <p className="px-2 py-1.5 text-xs text-ink-muted">Carregando os serviços…</p>
        ) : visible.length ? (
          visible.map((o) => (
            <label key={o.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm text-ink hover:bg-surface-2">
              <input
                type="checkbox"
                checked={selected.has(o.id)}
                onChange={() => toggle(o.id)}
                className="size-4 shrink-0 rounded border-line accent-[var(--brand)]"
              />
              <span className="min-w-0 truncate">{o.name}</span>
            </label>
          ))
        ) : (
          <p className="px-2 py-1.5 text-xs text-ink-muted">Nenhum serviço com “{term.trim()}”.</p>
        )}
      </div>
      {value.length ? (
        <div className="flex flex-wrap gap-1">
          {value.slice(0, SERVICE_CHIPS).map((id) => {
            const name = names.get(id) ?? "Serviço";
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 rounded-md bg-surface-2 py-0.5 pr-0.5 pl-1.5 text-[11px] text-ink-muted ring-1 ring-line ring-inset"
              >
                {name}
                <button
                  type="button"
                  onClick={() => toggle(id)}
                  className="rounded p-0.5 hover:bg-surface-3 hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none"
                  aria-label={`Tirar ${name}`}
                >
                  <X className="size-3" />
                </button>
              </span>
            );
          })}
          {value.length > SERVICE_CHIPS ? (
            <span className="self-center text-[11px] text-ink-muted">+{value.length - SERVICE_CHIPS}</span>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-ink-muted">Nenhum serviço marcado.</p>
      )}
    </fieldset>
  );
}
