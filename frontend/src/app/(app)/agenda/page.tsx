"use client";

import clsx from "clsx";
import {
  AlertTriangle,
  Building2,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  MapPin,
  PanelRightOpen,
  SlidersHorizontal,
  User as UserIcon,
  Wrench,
} from "lucide-react";
import { useMemo, useState } from "react";
import { type GridColumn, MonthView, TimeGrid } from "@/components/calendar/CalendarViews";
import { PriorityBadge, StatusBadge } from "@/components/badges";
import { TicketEditorDialog } from "@/components/ticket/editor/TicketEditorDialog";
import { Button, Card, Checkbox, Dialog, ErrorBox, Field, Input, PageHeader, SectionTitle, Select } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  ACTIVE_STATUSES,
  type CalendarView,
  colorMap,
  eventsOnDay,
  hhmm,
  rangeTitle,
  sameDay,
  shiftAnchor,
  UNASSIGNED_COLOR,
  visibleRange,
  WEEKDAYS_SHORT,
} from "@/lib/calendar";
import { canManageTickets } from "@/lib/constants";
import { formatShort, initials } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { useCalendar, useCustomers, useLocations, useTeams, useUsers } from "@/lib/queries";
import type { CalendarEvent } from "@/lib/types";

const VIEWS: { key: CalendarView; label: string }[] = [
  { key: "month", label: "Mês" },
  { key: "week", label: "Semana" },
  { key: "day", label: "Dia por técnico" },
];

export default function AgendaPage() {
  const { user } = useAuth();
  const [view, setView] = useState<CalendarView>("week");
  const [anchor, setAnchor] = useState(() => new Date());
  const [techIds, setTechIds] = useState<string[]>([]);
  const [techSearch, setTechSearch] = useState("");
  const [unassigned, setUnassigned] = useState(false);
  const [teamId, setTeamId] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [cityInput, setCityInput] = useState("");
  const [hideDone, setHideDone] = useState(true);
  const [onlyConflicts, setOnlyConflicts] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [opened, setOpened] = useState<CalendarEvent | null>(null);
  // "Abrir OS" fecha a prévia e abre a OS no painel lateral, com o calendário à vista.
  const [panelId, setPanelId] = useState<string | null>(null);
  const city = useDebounced(cityInput.trim());

  const technicians = useUsers({ role: "technician" });
  const teams = useTeams();
  const customers = useCustomers();
  const locations = useLocations(customerId || null);

  const techList = useMemo(
    () => [...(technicians.data ?? [])].filter((t) => t.is_active).sort((a, b) => a.name.localeCompare(b.name)),
    [technicians.data],
  );
  const colors = useMemo(() => colorMap(techList.map((t) => t.id)), [techList]);
  const { start, end, days } = visibleRange(view, anchor);

  const calendar = useCalendar({
    start: start.toISOString(),
    end: end.toISOString(),
    assignee_id: techIds.length ? techIds : undefined,
    unassigned: techIds.length ? unassigned : undefined,
    team_id: teamId || undefined,
    customer_id: customerId || undefined,
    location_id: locationId || undefined,
    city: city || undefined,
    status: hideDone ? ACTIVE_STATUSES : undefined,
  });
  const allEvents = useMemo(() => calendar.data ?? [], [calendar.data]);
  const events = useMemo(() => {
    let list = allEvents;
    if (!techIds.length && unassigned) list = list.filter((e) => !e.assignee);
    if (onlyConflicts) list = list.filter((e) => e.conflict_with.length > 0);
    return list;
  }, [allEvents, techIds.length, unassigned, onlyConflicts]);
  const byId = useMemo(() => new Map(allEvents.map((e) => [e.id, e])), [allEvents]);
  const conflicted = useMemo(
    () => allEvents.filter((e) => e.conflict_with.length > 0).sort((a, b) => a.start.localeCompare(b.start)),
    [allEvents],
  );

  if (user && !canManageTickets(user.role)) {
    return <ErrorBox message="O calendário da equipe é exclusivo para analistas e gestores." />;
  }

  const columns: GridColumn[] =
    view === "week"
      ? days.map((day) => ({
          key: day.toISOString(),
          day,
          events: eventsOnDay(events, day),
          header: <DayHeader day={day} />,
        }))
      : dayColumns(days[0], events, techList, techIds, colors);

  const toggleTech = (id: string) =>
    setTechIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const advanced = [teamId, customerId, locationId, city].filter(Boolean).length + (techIds.length ? 1 : 0);
  const visibleTechs = techList.filter((t) => t.name.toLowerCase().includes(techSearch.trim().toLowerCase()));

  return (
    <div>
      <PageHeader
        title="Calendário"
        description="Agenda das OS por técnico. Horários sobrepostos do mesmo técnico aparecem em vermelho."
        actions={
          <Button className="lg:hidden" onClick={() => setShowFilters((v) => !v)}>
            <SlidersHorizontal className="size-4" />
            Filtros{advanced ? ` (${advanced})` : ""}
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[272px_1fr]">
        <aside className={clsx("flex-col gap-4", showFilters ? "flex" : "hidden lg:flex")}>
          <Card className="p-3">
            <SectionTitle
              className="mb-2"
              aside={
                techIds.length ? (
                  <button type="button" className="text-xs text-brand hover:underline" onClick={() => setTechIds([])}>
                    Mostrar todos
                  </button>
                ) : (
                  <span className="text-xs text-ink-muted">Todos</span>
                )
              }
            >
              Técnicos
            </SectionTitle>
            <Input
              value={techSearch}
              onChange={(e) => setTechSearch(e.target.value)}
              placeholder="Buscar técnico"
              aria-label="Buscar técnico"
              className="mb-2 h-8 text-xs"
            />
            <ul className="max-h-64 space-y-0.5 overflow-y-auto">
              {visibleTechs.map((t) => {
                const checked = techIds.includes(t.id);
                return (
                  <li key={t.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-surface-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleTech(t.id)}
                        className="size-3.5 rounded"
                        style={{ accentColor: colors.get(t.id) }}
                      />
                      <span className="size-2.5 shrink-0 rounded-full" style={{ background: colors.get(t.id) }} />
                      <span className="truncate text-ink">{t.name}</span>
                    </label>
                  </li>
                );
              })}
              {technicians.isLoading ? <li className="px-1.5 py-1 text-xs text-ink-muted">Carregando...</li> : null}
            </ul>
            <div className="mt-2 border-t border-line pt-2">
              <Checkbox label="Sem responsável" checked={unassigned} onChange={setUnassigned} />
            </div>
          </Card>

          <Card className="flex flex-col gap-3 p-3">
            <Field label="Grupo">
              <Select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                <option value="">Todos</option>
                {(teams.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Cliente">
              <Select
                value={customerId}
                onChange={(e) => {
                  setCustomerId(e.target.value);
                  setLocationId("");
                }}
              >
                <option value="">Todos</option>
                {(customers.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Local">
              <Select value={locationId} onChange={(e) => setLocationId(e.target.value)} disabled={!customerId}>
                <option value="">{customerId ? "Todos" : "Escolha o cliente"}</option>
                {(locations.data ?? []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Cidade">
              <Input value={cityInput} onChange={(e) => setCityInput(e.target.value)} placeholder="Ex.: Campinas" />
            </Field>
            <Checkbox label="Ocultar OS concluídas" checked={hideDone} onChange={setHideDone} />
          </Card>

          <Card className="p-3">
            {/* O alerta fica junto do contador: vermelho só quando há conflito. */}
            <SectionTitle
              aside={
                <>
                  <AlertTriangle className={clsx("size-4", conflicted.length ? "text-red-500" : "text-ink-muted")} />
                  <span
                    className={clsx(
                      "rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums",
                      conflicted.length ? "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300" : "bg-surface-2 text-ink-muted",
                    )}
                  >
                    {conflicted.length}
                  </span>
                </>
              }
            >
              Conflitos de horário
            </SectionTitle>
            {conflicted.length === 0 ? (
              <p className="mt-1.5 text-xs text-ink-muted">Nenhum técnico com duas OS no mesmo horário neste período.</p>
            ) : (
              <>
                <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
                  {conflicted.map((e) => (
                    <li key={e.id}>
                      <button
                        type="button"
                        onClick={() => setOpened(e)}
                        className="w-full rounded-md px-1.5 py-1 text-left text-xs hover:bg-surface-2"
                      >
                        <span className="block font-semibold text-ink">
                          {e.assignee?.name} · {formatShort(e.start)}
                        </span>
                        <span className="block truncate text-ink-muted">
                          {e.code} × {e.conflict_with.map((id) => byId.get(id)?.code ?? "OS").join(", ")}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 border-t border-line pt-2">
                  <Checkbox label="Mostrar só os conflitos" checked={onlyConflicts} onChange={setOnlyConflicts} />
                </div>
              </>
            )}
          </Card>
        </aside>

        <Card className="flex min-w-0 flex-col overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
            <Button onClick={() => setAnchor(new Date())}>Hoje</Button>
            <div className="flex">
              <button
                type="button"
                onClick={() => setAnchor((a) => shiftAnchor(view, a, -1))}
                className="rounded-md p-1.5 text-ink-muted hover:bg-surface-2 hover:text-ink"
                aria-label="Anterior"
              >
                <ChevronLeft className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => setAnchor((a) => shiftAnchor(view, a, 1))}
                className="rounded-md p-1.5 text-ink-muted hover:bg-surface-2 hover:text-ink"
                aria-label="Próximo"
              >
                <ChevronRight className="size-4" />
              </button>
            </div>
            <h2 className="text-sm font-bold text-ink first-letter:uppercase">{rangeTitle(view, anchor)}</h2>
            {calendar.isFetching ? <span className="text-xs text-ink-muted">Atualizando...</span> : null}
            <div className="ml-auto flex rounded-lg border border-line p-0.5" role="tablist" aria-label="Visão">
              {VIEWS.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  role="tab"
                  aria-selected={view === v.key}
                  onClick={() => setView(v.key)}
                  className={clsx(
                    "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    view === v.key ? "bg-brand text-white" : "text-ink-muted hover:text-ink",
                  )}
                >
                  {v.label}
                </button>
              ))}
            </div>
          </div>
          {calendar.error ? (
            <div className="p-3">
              <ErrorBox message={errorMessage(calendar.error)} />
            </div>
          ) : null}
          <div className="h-[calc(100vh-15rem)] min-h-[520px]">
            {view === "month" ? (
              <MonthView
                days={days}
                month={anchor.getMonth()}
                events={events}
                colors={colors}
                onOpen={setOpened}
                onDay={(day) => {
                  setAnchor(day);
                  setView("day");
                }}
              />
            ) : (
              <TimeGrid columns={columns} colors={colors} onOpen={setOpened} />
            )}
          </div>
        </Card>
      </div>

      {opened ? (
        <EventDialog
          event={opened}
          related={opened.conflict_with.map((id) => byId.get(id)).filter((e): e is CalendarEvent => !!e)}
          color={(opened.assignee && colors.get(opened.assignee.id)) || UNASSIGNED_COLOR}
          onOpen={setOpened}
          onOpenTicket={(id) => {
            setOpened(null);
            setPanelId(id);
          }}
          onClose={() => setOpened(null)}
        />
      ) : null}
      {panelId ? <TicketEditorDialog key={panelId} ticketId={panelId} onClose={() => setPanelId(null)} /> : null}
    </div>
  );
}

function DayHeader({ day }: { day: Date }) {
  const today = sameDay(day, new Date());
  return (
    <span className="flex flex-col items-center leading-tight">
      <span className="text-[11px] font-bold tracking-wide text-ink-muted uppercase">{WEEKDAYS_SHORT[day.getDay()]}</span>
      <span
        className={clsx(
          "mt-0.5 flex size-7 items-center justify-center rounded-full text-sm font-semibold tabular-nums",
          today ? "bg-brand text-white" : "text-ink",
        )}
      >
        {day.getDate()}
      </span>
    </span>
  );
}

/** Dia por técnico: uma coluna por técnico (os filtrados, ou todos), mais "Sem responsável". */
function dayColumns(
  day: Date,
  events: CalendarEvent[],
  techs: { id: string; name: string }[],
  selected: string[],
  colors: Map<string, string>,
): GridColumn[] {
  const onDay = eventsOnDay(events, day);
  const shown = selected.length ? techs.filter((t) => selected.includes(t.id)) : techs;
  const known = new Set(shown.map((t) => t.id));
  // Analistas ou técnicos fora da lista que têm OS no dia também ganham coluna.
  const extra = new Map<string, string>();
  onDay.forEach((e) => {
    if (e.assignee && !known.has(e.assignee.id)) extra.set(e.assignee.id, e.assignee.name);
    // Quem vai junto também tem a visita na agenda dele.
    e.helpers?.forEach((h) => {
      if (!known.has(h.id)) extra.set(h.id, h.name);
    });
  });
  const people = [...shown, ...[...extra].map(([id, name]) => ({ id, name }))];
  const cols: GridColumn[] = people.map((p) => {
    const mine = onDay.filter((e) => e.assignee?.id === p.id || e.helpers?.some((h) => h.id === p.id));
    const clash = mine.some((e) => e.conflict_with.length > 0);
    return {
      key: p.id,
      day,
      events: mine,
      header: (
        <span className="flex items-center justify-center gap-1.5 text-xs">
          <span
            className="flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
            style={{ background: colors.get(p.id) ?? UNASSIGNED_COLOR }}
          >
            {initials(p.name)}
          </span>
          <span className="truncate font-semibold text-ink">{p.name}</span>
          <span className={clsx("tabular-nums", clash ? "font-semibold text-red-600 dark:text-red-400" : "text-ink-muted")}>
            {mine.length}
          </span>
        </span>
      ),
    };
  });
  const orphan = onDay.filter((e) => !e.assignee);
  if (orphan.length) {
    cols.push({
      key: "unassigned",
      day,
      events: orphan,
      header: <span className="text-xs font-semibold text-ink-muted">Sem responsável · {orphan.length}</span>,
    });
  }
  return cols;
}

function Row({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 text-sm">
      <span className="mt-0.5 shrink-0 text-ink-muted">{icon}</span>
      <div className="min-w-0 text-ink">{children}</div>
    </div>
  );
}

function EventDialog({
  event,
  related,
  color,
  onOpen,
  onOpenTicket,
  onClose,
}: {
  event: CalendarEvent;
  related: CalendarEvent[];
  color: string;
  onOpen: (event: CalendarEvent) => void;
  onOpenTicket: (ticketId: string) => void;
  onClose: () => void;
}) {
  const start = new Date(event.start);
  const end = new Date(event.end);
  return (
    <Dialog
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <span className="size-2.5 rounded-full" style={{ background: color }} />
          <span className="font-mono">{event.code}</span>
        </span>
      }
      description={event.title}
      footer={
        <>
          <Button onClick={onClose}>Fechar</Button>
          <Button variant="primary" onClick={() => onOpenTicket(event.id)}>
            <PanelRightOpen className="size-4" />
            Abrir OS
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-1.5">
          <StatusBadge status={event.status} />
          <PriorityBadge priority={event.priority} />
        </div>
        <Row icon={<Clock className="size-4" />}>
          {start.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" })}, {hhmm(start)} –{" "}
          {sameDay(start, end) ? hhmm(end) : formatShort(event.end)}
          {event.end_is_estimated ? <span className="text-ink-muted"> (fim estimado)</span> : null}
        </Row>
        <Row icon={<UserIcon className="size-4" />}>
          {event.assignee?.name ?? <span className="text-ink-muted">Sem responsável</span>}
          {event.team ? <span className="text-ink-muted"> · {event.team.name}</span> : null}
          {event.helpers?.length ? (
            <span className="block text-xs text-ink-muted">Junto: {event.helpers.map((h) => h.name).join(", ")}</span>
          ) : null}
        </Row>
        {event.customer ? <Row icon={<Building2 className="size-4" />}>{event.customer.name}</Row> : null}
        {event.location ? (
          <Row icon={<MapPin className="size-4" />}>
            {event.location.name}
            {event.location.city ? <span className="text-ink-muted"> · {event.location.city}</span> : null}
          </Row>
        ) : null}
        {event.service_type ? <Row icon={<Wrench className="size-4" />}>{event.service_type}</Row> : null}
        {related.length ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900/60 dark:bg-red-950/40">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-red-800 dark:text-red-200">
              <AlertTriangle className="size-4" />
              Conflito: {event.assignee?.name ?? "o técnico"} tem outra OS no mesmo horário
            </p>
            <ul className="mt-1.5 space-y-1">
              {related.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(r)}
                    className="text-left text-xs text-red-900 hover:underline dark:text-red-100"
                  >
                    <span className="font-mono font-medium">{r.code}</span> · {hhmm(new Date(r.start))}–
                    {hhmm(new Date(r.end))} · {[r.customer?.name, r.location?.name].filter(Boolean).join(" · ") || r.title}
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-red-800/80 dark:text-red-200/80">
              Reagende uma delas ou troque o técnico na própria OS.
            </p>
          </div>
        ) : null}
        {!event.assignee ? (
          <p className="flex items-center gap-1.5 text-xs text-ink-muted">
            <CalendarDays className="size-3.5" />
            Defina o técnico na OS para que ela entre na agenda dele.
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
