"use client";

import { ClipboardList, X } from "lucide-react";
import Link from "next/link";
import { Checkbox, Select, Skeleton } from "@/components/ui";
import type { FormTemplate, ServiceType, UUID } from "@/lib/types";

/**
 * Formulários (checklists) que o técnico preenche no app. Os do tipo de serviço escolhido vêm marcados;
 * os demais entram pelo seletor. Obrigatório trava a conclusão da OS até ser preenchido.
 */
export function FormsPicker({
  templates,
  loading,
  serviceType,
  value,
  onToggle,
  required,
  onRequiredChange,
}: {
  templates: FormTemplate[] | undefined;
  loading: boolean;
  serviceType: ServiceType | null;
  value: UUID[];
  onToggle: (templateId: UUID) => void;
  required: boolean;
  onRequiredChange: (required: boolean) => void;
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
  const suggested = serviceType ? list.filter((t) => t.service_type_ids.includes(serviceType.id)) : [];
  const chosen = list.filter((t) => value.includes(t.id) && !suggested.some((s) => s.id === t.id));
  const available = list.filter((t) => !value.includes(t.id) && !suggested.some((s) => s.id === t.id));

  return (
    <div className="flex flex-col gap-3">
      {suggested.length ? (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-xs font-semibold text-ink/80">Do tipo “{serviceType?.name}”</legend>
          {suggested.map((t) => (
            <Checkbox key={t.id} label={t.name} checked={value.includes(t.id)} onChange={() => onToggle(t.id)} />
          ))}
        </fieldset>
      ) : null}
      {chosen.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Formulários escolhidos">
          {chosen.map((t) => (
            <li key={t.id} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 py-1 pr-1 pl-2 text-sm text-ink">
              <ClipboardList aria-hidden className="size-3.5 text-ink-subtle" />
              {t.name}
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
      {available.length ? (
        <Select
          value=""
          onChange={(e) => {
            if (e.target.value) onToggle(e.target.value);
          }}
          aria-label="Incluir formulário"
          className="sm:max-w-md"
        >
          <option value="">{value.length ? "Incluir mais um formulário..." : "Incluir formulário..."}</option>
          {available.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.requires_signature ? " (pede assinatura)" : ""}
            </option>
          ))}
        </Select>
      ) : null}
      {value.length ? (
        <Checkbox
          label="Obrigatórios: a OS só é concluída com eles preenchidos"
          checked={required}
          onChange={onRequiredChange}
        />
      ) : (
        <p className="text-xs text-ink-subtle">Nenhum formulário por enquanto (dá para incluir depois, na OS).</p>
      )}
    </div>
  );
}
