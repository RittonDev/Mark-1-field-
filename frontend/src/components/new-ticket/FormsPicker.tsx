"use client";

import clsx from "clsx";
import { ClipboardList, X } from "lucide-react";
import Link from "next/link";
import { Checkbox, Select, Skeleton } from "@/components/ui";
import type { Category, FormTemplate, ServiceType, UUID } from "@/lib/types";
import { matchedForms } from "./draft";

/** Limite de formulários na abertura (o mesmo da API). */
const MAX_FORMS = 20;

/** Obrigatório ou opcional na OS, com o mesmo botão da aba Formulários da OS. */
function RequiredToggle({ name, required, onChange }: { name: string; required: boolean; onChange: (required: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!required)}
      aria-pressed={required}
      aria-label={`${name}: obrigatório`}
      className={clsx(
        "rounded-full border px-2 py-0.5 text-xs font-medium transition-colors",
        required ? "border-brand/40 text-brand-ink" : "border-line text-ink-muted hover:border-line-strong hover:text-ink",
      )}
      title={required ? "Obrigatório: clique para deixar opcional" : "Opcional: clique para tornar obrigatório"}
    >
      {required ? "Obrigatório" : "Opcional"}
    </button>
  );
}

/**
 * Formulários (checklists) que o técnico preenche no app. Os ligados ao tipo de OS e à categoria vêm
 * marcados; os demais entram pelo seletor. Cada um entra obrigatório ou opcional (obrigatório trava a
 * conclusão da OS até ser preenchido).
 */
export function FormsPicker({
  templates,
  loading,
  serviceType,
  categoryId,
  categories,
  value,
  onToggle,
  required,
  onRequiredChange,
}: {
  templates: FormTemplate[] | undefined;
  loading: boolean;
  serviceType: ServiceType | null;
  /** A categoria com que a OS nasce (a escolhida ou a do tipo). */
  categoryId: string;
  categories: Category[] | undefined;
  value: UUID[];
  onToggle: (templateId: UUID) => void;
  /** Obrigatório ou opcional escolhido pelo analista (sem escolha, o padrão do modelo). */
  required: Record<UUID, boolean>;
  onRequiredChange: (templateId: UUID, required: boolean) => void;
}) {
  if (loading && !templates) {
    return (
      <div className="flex flex-col gap-2" role="status" aria-label="Carregando formulários">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }
  const list = templates ?? [];
  if (list.length === 0) {
    return (
      <p className="text-sm text-ink-muted">
        Nenhum formulário cadastrado.{" "}
        <Link href="/formularios" target="_blank" className="font-medium text-brand-ink hover:underline">
          Criar em Formulários
        </Link>
      </p>
    );
  }
  const byId = new Map(list.map((t) => [t.id, t]));
  const matched = matchedForms(list, serviceType, categoryId, categories).flatMap((m) => {
    const template = byId.get(m.id);
    return template ? [{ ...m, template }] : [];
  });
  const isMatched = (id: UUID) => matched.some((m) => m.id === id);
  const chosen = value.flatMap((id) => {
    const template = byId.get(id);
    return template && !isMatched(id) ? [template] : [];
  });
  const available = list.filter((t) => !value.includes(t.id) && !isMatched(t.id));
  // Modelo desativado depois de entrar no rascunho não aparece nem vai na OS.
  const count = value.filter((id) => byId.has(id)).length;
  const requiredOf = (t: FormTemplate) => required[t.id] ?? t.default_required ?? true;

  return (
    <div className="flex flex-col gap-3">
      {matched.length ? (
        <ul className="flex flex-col gap-1.5" aria-label="Formulários do tipo de OS e da categoria">
          {matched.map(({ id, via, label, template }) => {
            const on = value.includes(id);
            return (
              <li key={id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Checkbox label={template.name} checked={on} onChange={() => onToggle(id)} />
                <span className="text-xs text-ink-muted">{via === "type" ? "pelo tipo de OS" : `pela categoria ${label}`.trim()}</span>
                {on ? <RequiredToggle name={template.name} required={requiredOf(template)} onChange={(v) => onRequiredChange(id, v)} /> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {chosen.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Formulários escolhidos">
          {chosen.map((t) => (
            <li key={t.id} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 py-1 pr-1 pl-2 text-sm text-ink">
              <ClipboardList aria-hidden className="size-3.5 text-ink-subtle" />
              {t.name}
              <RequiredToggle name={t.name} required={requiredOf(t)} onChange={(v) => onRequiredChange(t.id, v)} />
              <button
                type="button"
                onClick={() => onToggle(t.id)}
                className="rounded p-0.5 text-ink-subtle hover:bg-ink/10 hover:text-ink"
                aria-label={`Tirar o formulário ${t.name}`}
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {available.length && count < MAX_FORMS ? (
        <Select
          value=""
          onChange={(e) => {
            if (e.target.value) onToggle(e.target.value);
          }}
          aria-label="Incluir formulário"
          className="sm:max-w-md"
        >
          <option value="">{count ? "Incluir mais um formulário..." : "Incluir formulário..."}</option>
          {available.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.requires_signature ? " (pede assinatura)" : ""}
            </option>
          ))}
        </Select>
      ) : null}
      {count ? null : <p className="text-xs text-ink-subtle">Nenhum formulário.</p>}
    </div>
  );
}
