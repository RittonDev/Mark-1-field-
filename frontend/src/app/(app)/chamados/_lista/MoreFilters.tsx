"use client";

import clsx from "clsx";
import { X } from "lucide-react";
import { useEffect, useEffectEvent, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MultiSelect } from "@/components/MultiSelect";
import { ServiceTypePicker } from "@/components/new-ticket/ServiceTypePicker";
import { Button, Checkbox, Field, isTopLayer, lockScroll, restoreFocus, SectionTitle, Select, trapTab } from "@/components/ui";
import { PRIORITY, PRIORITY_ORDER, ROLE, TICKET_TYPE } from "@/lib/constants";
import { useProjects } from "@/lib/projects";
import { useAssignable, useCategories, useServiceTypes, useTeams } from "@/lib/queries";
import type { QueuesOut, TicketPriority, TicketSource, TicketType, UUID } from "@/lib/types";
import { DateRangeForm, SCHEDULED_PRESETS } from "./DateRange";
import { type Filters, moreFilterCount, SOURCES, type View } from "./params";
import { TagPicker, useKnownTags } from "./tags";

/** Rótulo de um campo que não fica dentro de <label> (lista com busca, escolha múltipla, etiquetas). */
function FilterField({
  label,
  labelId,
  hint,
  children,
}: {
  label: string;
  labelId: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span id={labelId} className="text-xs font-semibold text-ink/80">
        {label}
      </span>
      {children}
      {hint ? <span className="text-xs text-ink-subtle">{hint}</span> : null}
    </div>
  );
}

/**
 * Painel lateral (como o "Mais filtros" do Field Control): entra da direita por cima da lista, prende o
 * Tab, fecha com Esc, com o X ou clicando fora, e devolve o foco ao botão que o abriu.
 */
function Sheet({
  title,
  description,
  onClose,
  children,
  footer,
}: {
  title: string;
  description: string;
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  // Quem tinha o foco ao abrir (o botão "Mais filtros"), para devolver ao fechar.
  const [opener] = useState<Element | null>(() => (typeof document === "undefined" ? null : document.activeElement));

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    const node = panel.current;
    // Já tratado (a lista de uma busca, o menu da prioridade) ou com outra camada por cima.
    if (e.defaultPrevented || !node) return;
    if (e.key === "Escape" && isTopLayer(node)) {
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab" && isTopLayer(node, false)) {
      trapTab(e, node);
    }
  });

  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKey(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  useEffect(() => {
    const unlock = lockScroll();
    panel.current?.focus();
    return () => {
      unlock();
      restoreFocus(opener);
    };
  }, [opener]);

  // No <body>, fora dos recortes da página; o clique dentro não "sobe" até a lista de trás.
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" onClick={(e) => e.stopPropagation()}>
      <div className="absolute inset-0 animate-fade bg-[rgb(9_11_15/0.28)]" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className="relative flex h-full w-full max-w-md animate-drawer flex-col border-l border-line bg-surface shadow-pop outline-none"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-bold tracking-[-0.01em] text-ink">
              {title}
            </h2>
            <p id={descriptionId} className="mt-0.5 text-sm text-ink-muted">
              {description}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mt-0.5 -mr-1 rounded-lg p-1.5 text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
            aria-label="Fechar"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-[color-mix(in_srgb,var(--surface-2)_60%,var(--surface))] px-5 py-3">
          {footer}
        </div>
      </div>
    </div>,
    document.body,
  );
}

const section = "flex flex-col gap-3.5 border-b border-line pb-5 [&:not(:first-child)]:pt-5 last:border-b-0 last:pb-0";

/**
 * "Mais filtros": quem (técnico, analista, grupo), o quê (tipo de OS, etiquetas, prioridade, projeto,
 * categoria, atendimento e origem), o agendamento e as situações. Cada escolha vale na hora; os
 * cadastros só carregam com o painel aberto.
 */
export function MoreFilters({
  view,
  filters,
  onChange,
  onOwner,
  onView,
  onClear,
  queues,
  userId,
  total,
  fetching,
  onClose,
}: {
  view: View;
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
  /** Fila de um analista ("none": sem analista; vazio: todos). */
  onOwner: (value: UUID | "none" | "") => void;
  onView: (view: View) => void;
  /** Tira só os filtros deste painel. */
  onClear: () => void;
  queues: QueuesOut | undefined;
  userId: UUID | undefined;
  /** OS na lista com os filtros de agora (o botão "Ver N OS"). */
  total: number | null;
  fetching: boolean;
  onClose: () => void;
}) {
  const ids = { serviceType: useId(), tags: useId(), priority: useId() };
  const assignable = useAssignable(null);
  const teams = useTeams();
  const serviceTypes = useServiceTypes();
  const categories = useCategories();
  const projects = useProjects();
  const knownTags = useKnownTags();

  // Técnicos primeiro (quem vai a campo), depois o resto da equipe.
  const people = useMemo(
    () =>
      [...(assignable.data ?? [])].sort(
        (a, b) => (a.role === "technician" ? 0 : 1) - (b.role === "technician" ? 0 : 1) || a.name.localeCompare(b.name, "pt-BR"),
      ),
    [assignable.data],
  );
  const categoryOptions = useMemo(
    () =>
      (categories.data ?? [])
        .filter((c) => c.is_active || c.id === filters.category_id)
        .sort((a, b) => a.full_name.localeCompare(b.full_name, "pt-BR")),
    [categories.data, filters.category_id],
  );
  const projectOptions = projects.data ?? [];
  const serviceType = serviceTypes.data?.find((t) => t.id === filters.service_type_id) ?? null;
  const queueValue = filters.no_owner ? "none" : filters.owner_id;
  const empty = moreFilterCount(filters) === 0;

  return (
    <Sheet
      title="Mais filtros"
      description="Cada escolha vale na hora: a lista atrás já mostra o resultado."
      onClose={onClose}
      footer={
        <>
          {empty ? null : (
            <Button variant="ghost" onClick={onClear} className="mr-auto">
              Limpar estes filtros
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            {total === null || fetching ? "Ver a lista" : total === 1 ? "Ver 1 OS" : `Ver ${total.toLocaleString("pt-BR")} OS`}
          </Button>
          <span className="sr-only" aria-live="polite">
            {total === null || fetching ? "" : `${total.toLocaleString("pt-BR")} OS com estes filtros`}
          </span>
        </>
      }
    >
      <div className="flex flex-col">
        <section className={section}>
          <SectionTitle as="h3">Quem</SectionTitle>
          <Field label="Técnico">
            <Select value={filters.assignee_id} onChange={(e) => onChange({ assignee_id: e.target.value })}>
              <option value="">Qualquer técnico</option>
              {people.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                  {u.role === "technician" ? "" : ` (${ROLE[u.role].toLowerCase()})`}
                </option>
              ))}
            </Select>
          </Field>
          {queues ? (
            // A fila de um analista: o que está com ele (e, na lista, o "Assumir" para puxar a OS).
            <Field label="Analista (fila)">
              <Select value={queueValue} onChange={(e) => onOwner(e.target.value as UUID | "none" | "")}>
                <option value="">Todos os analistas</option>
                {queues.queues.map((x) => (
                  <option key={x.user.id} value={x.user.id}>
                    {x.user.id === userId ? "Minha fila" : x.user.name} ({x.open} em aberto)
                  </option>
                ))}
                <option value="none">Sem analista ({queues.unowned.open} em aberto)</option>
              </Select>
            </Field>
          ) : null}
          <Field label="Grupo">
            <Select value={filters.team_id} onChange={(e) => onChange({ team_id: e.target.value })}>
              <option value="">Todos os grupos</option>
              {(teams.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        </section>

        <section className={section}>
          <SectionTitle as="h3">O quê</SectionTitle>
          <FilterField label="Tipo de OS" labelId={ids.serviceType}>
            <ServiceTypePicker
              types={serviceTypes.data}
              loading={serviceTypes.isLoading}
              value={serviceType}
              customerId={filters.customer_id || null}
              labelledBy={ids.serviceType}
              placeholder="Todos os tipos"
              onChange={(type) => onChange({ service_type_id: type?.id ?? "" })}
            />
          </FilterField>
          <FilterField label="Etiquetas" labelId={ids.tags} hint="Mostra as OS com qualquer uma das etiquetas escolhidas.">
            <TagPicker
              value={filters.tag}
              onChange={(tag) => onChange({ tag })}
              known={knownTags.data}
              allowNew={false}
              labelledBy={ids.tags}
            />
          </FilterField>
          <FilterField label="Prioridade" labelId={ids.priority}>
            <MultiSelect
              label="Prioridade"
              ariaLabel="Prioridade"
              value={filters.priority}
              onChange={(priority) => onChange({ priority: priority as TicketPriority[] })}
              options={PRIORITY_ORDER.map((p) => ({ value: p, label: `${PRIORITY[p].code} · ${PRIORITY[p].label}`, color: PRIORITY[p].color }))}
            />
          </FilterField>
          {projectOptions.length || filters.project_id ? (
            <Field label="Projeto">
              <Select value={filters.project_id} onChange={(e) => onChange({ project_id: e.target.value })}>
                <option value="">Com ou sem projeto</option>
                {projectOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} · {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label="Categoria">
            <Select value={filters.category_id} onChange={(e) => onChange({ category_id: e.target.value })}>
              <option value="">Todas as categorias</option>
              {categoryOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.full_name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid gap-3.5 sm:grid-cols-2">
            <Field label="Tipo de atendimento">
              <Select value={filters.type} onChange={(e) => onChange({ type: e.target.value as TicketType | "" })}>
                <option value="">Todos</option>
                {(Object.keys(TICKET_TYPE) as TicketType[]).map((type) => (
                  <option key={type} value={type}>
                    {TICKET_TYPE[type]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Origem">
              <Select value={filters.source} onChange={(e) => onChange({ source: e.target.value as TicketSource | "" })}>
                <option value="">Todas</option>
                {SOURCES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </section>

        <section className={section}>
          <SectionTitle as="h3">Agendamento</SectionTitle>
          <DateRangeForm
            // Limpo por fora ("Limpar estes filtros", o chip): o campo volta junto.
            key={`${filters.scheduled_from}|${filters.scheduled_to}`}
            value={{ from: filters.scheduled_from, to: filters.scheduled_to }}
            presets={SCHEDULED_PRESETS}
            legend="Data do agendamento"
            onApply={(range) => onChange({ scheduled_from: range.from, scheduled_to: range.to })}
          />
        </section>

        <section className={clsx(section, "gap-3")}>
          <SectionTitle as="h3">Situação</SectionTitle>
          <Checkbox label="Somente abertas" checked={view !== "todas"} onChange={(on) => onView(on ? "abertos" : "todas")} />
          <Checkbox label="Prazo estourado (SLA violado)" checked={view === "sla"} onChange={(on) => onView(on ? "sla" : "abertos")} />
          <Checkbox
            label="SLA violado sem justificativa"
            checked={filters.violation_pending}
            onChange={(on) => onChange({ violation_pending: on })}
          />
          <p className="text-xs text-ink-muted">“Somente abertas” e “Prazo estourado” são as abas Em aberto e SLA violado.</p>
        </section>
      </div>
    </Sheet>
  );
}
