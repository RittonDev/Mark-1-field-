"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  AlertTriangle,
  Building2,
  CalendarClock,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  Globe,
  MapPin,
  PanelRightOpen,
  SlidersHorizontal,
  User as UserIcon,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useId, useMemo, useState } from "react";
import { type GridColumn, MonthView, TimeGrid } from "@/components/calendar/CalendarViews";
import { PriorityBadge, StatusBadge } from "@/components/badges";
import { LocationPicker } from "@/components/LocationPicker";
import { NoAccess } from "@/components/NoAccess";
import { fold, isUuid, replaceSearch, useActiveTechnicians, useSearchChange } from "@/components/operacao/hooks";
import { RefreshFailed } from "@/components/operacao/status";
import { ConflictHint, ConflictList, scheduleConflicts } from "@/components/ScheduleConflict";
import { useToast } from "@/components/Toaster";
import { isPlainClick } from "@/components/ticket/TicketLink";
import { useTicketPanel } from "@/components/ticket/TicketPanel";
import { isVersionConflict } from "@/components/ticket/useConflictHandler";
import {
  Button,
  buttonClassName,
  Card,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  LoadingBlock,
  PageHeader,
  SectionTitle,
  Select,
} from "@/components/ui";
import { api, errorMessage, type Query } from "@/lib/api";
import {
  ACTIVE_STATUSES,
  type CalendarView,
  colorMap,
  dayKey,
  eventsOnDay,
  formatDay,
  fromWall,
  hhmm,
  OPERATION_TIMEZONE,
  operationToday,
  parseDayKey,
  rangeTitle,
  sameDay,
  shiftAnchor,
  technicianColor,
  toWall,
  UNASSIGNED_COLOR,
  visibleRange,
  WEEKDAYS_SHORT,
} from "@/lib/calendar";
import { STATUS } from "@/lib/constants";
import { formatMinutes, formatShort, formatTime, fromLocalInput, toLocalInput } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { useCan } from "@/lib/permissions";
import { useCustomers, useTeams } from "@/lib/queries";
import type { CalendarEvent, ConflictItem, Location, TicketDetail, TicketStatus } from "@/lib/types";

const VIEWS: { key: CalendarView; label: string; previous: string; next: string }[] = [
  { key: "month", label: "Mês", previous: "Mês anterior", next: "Próximo mês" },
  { key: "week", label: "Semana", previous: "Semana anterior", next: "Próxima semana" },
  { key: "day", label: "Dia por técnico", previous: "Dia anterior", next: "Próximo dia" },
];

/** Reagendar pelo calendário só antes de a visita começar (em campo, os horários reais se corrigem na OS). */
const RESCHEDULABLE: TicketStatus[] = [
  "new",
  "triage",
  "assigned",
  "scheduled",
  "on_hold_customer",
  "on_hold_vendor",
  "reopened",
];

/** O fuso do computador quando o relógio dele difere do da operação (senão null): a agenda mostra
 *  sempre o horário de Brasília e avisa quem está com outro relógio. */
function foreignTimeZone(): string | null {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!zone || zone === OPERATION_TIMEZONE) return null;
  const now = new Date();
  const clock = (timeZone: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(now);
  return clock(zone) === clock(OPERATION_TIMEZONE) ? null : zone;
}

/**
 * Visão, dia e técnicos guardados na URL (?v=&d=&tec=). Dias no relógio da operação (lib/calendar):
 * sem ?d=, hoje no horário de Brasília.
 */
function readUrl(params: URLSearchParams): { view: CalendarView; anchor: Date; techIds: string[] } {
  const value = params.get("v");
  return {
    view: value === "month" || value === "day" ? value : "week",
    anchor: parseDayKey(params.get("d")) ?? operationToday(),
    techIds: (params.get("tec") ?? "").split(",").filter(isUuid),
  };
}

function AgendaView() {
  // Visualizar: a agenda e a prévia de cada OS. Editar: também o Reagendar daqui (o editor da OS é de
  // toda a central e continua remarcando).
  const canView = useCan("operation.calendar");
  const canEdit = useCan("operation.calendar", "edit");
  const searchParams = useSearchParams();
  // Visão, data e técnicos ficam na URL: recarregar ou mandar o link mantém a agenda.
  const [view, setView] = useState(() => readUrl(searchParams).view);
  const [anchor, setAnchor] = useState(() => readUrl(searchParams).anchor);
  const [techIds, setTechIds] = useState(() => readUrl(searchParams).techIds);
  // A URL mudou com a tela aberta (o link do menu, Voltar, um link com outro dia): mostra o que ela diz.
  const urlChange = useSearchChange();
  if (urlChange) {
    const next = readUrl(urlChange);
    if (next.view !== view) setView(next.view);
    if (dayKey(next.anchor) !== dayKey(anchor)) setAnchor(next.anchor);
    if (next.techIds.join(",") !== techIds.join(",")) setTechIds(next.techIds);
  }
  const [techSearch, setTechSearch] = useState("");
  const [unassigned, setUnassigned] = useState(false);
  const [teamId, setTeamId] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [location, setLocation] = useState<Location | null>(null);
  const [cityInput, setCityInput] = useState("");
  const [hideDone, setHideDone] = useState(true);
  const [onlyConflicts, setOnlyConflicts] = useState(false);
  // Dia por técnico: só quem tem visita; marcado, todos os técnicos (para achar quem está livre).
  const [showIdle, setShowIdle] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  // A OS aberta na prévia. Status, horário e conflitos vêm dos dados atuais (o tempo real atualiza);
  // o objeto guardado só vale se ela saiu do período.
  const [opened, setOpened] = useState<CalendarEvent | null>(null);
  const [zone] = useState(foreignTimeZone);
  // "Abrir OS" fecha a prévia e abre a OS no painel lateral, com o calendário à vista.
  const ticketPanel = useTicketPanel();
  const city = useDebounced(cityInput.trim());
  const locationLabelId = useId();

  const technicians = useActiveTechnicians();
  const teams = useTeams();
  const customers = useCustomers();

  const techList = useMemo(() => technicians.data ?? [], [technicians.data]);
  const colors = useMemo(() => colorMap(techList.map((t) => t.id)), [techList]);
  const { start, end, days } = visibleRange(view, anchor);

  const params: Query = {
    start: fromWall(start).toISOString(),
    end: fromWall(end).toISOString(),
    assignee_id: techIds.length ? techIds : undefined,
    unassigned: unassigned || undefined,
    team_id: teamId || undefined,
    customer_id: customerId || undefined,
    location_id: location?.id,
    city: city || undefined,
    status: hideDone ? ACTIVE_STATUSES : undefined,
  };
  const calendar = useQuery({
    queryKey: ["tickets", "calendar", params],
    // A busca obsoleta (período ou filtro trocados no meio) é cancelada.
    queryFn: ({ signal }) => api.get<CalendarEvent[]>("/calendar", params, { signal }),
    placeholderData: keepPreviousData,
    // O tempo real atualiza na hora; a releitura cobre a conexão caída e a tela parada num monitor.
    refetchInterval: 120_000,
    enabled: canView,
  });
  const allEvents = useMemo(() => calendar.data ?? [], [calendar.data]);
  const events = useMemo(
    () => (onlyConflicts ? allEvents.filter((e) => e.conflict_with.length > 0) : allEvents),
    [allEvents, onlyConflicts],
  );
  const byId = useMemo(() => new Map(allEvents.map((e) => [e.id, e])), [allEvents]);
  const conflicted = useMemo(
    () => allEvents.filter((e) => e.conflict_with.length > 0).sort((a, b) => a.start.localeCompare(b.start)),
    [allEvents],
  );
  const ready = Boolean(calendar.data) && !calendar.isPlaceholderData;

  useEffect(() => {
    replaceSearch({
      v: view === "week" ? null : view,
      d: sameDay(anchor, operationToday()) ? null : dayKey(anchor),
      tec: techIds.length ? techIds.join(",") : null,
    });
  }, [view, anchor, techIds]);

  if (!canView) return <NoAccess kind="module" item="operation.calendar" />;

  const openDay = (day: Date) => {
    setAnchor(day);
    setView("day");
  };
  const columns: GridColumn[] =
    view === "week"
      ? days.map((day) => ({
          key: dayKey(day),
          day,
          events: eventsOnDay(events, day),
          header: <DayHeader day={day} onPick={() => openDay(day)} />,
        }))
      : dayColumns(days[0], events, techList, techIds, colors, showIdle);

  const toggleTech = (id: string) =>
    setTechIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const advanced =
    [teamId, customerId, location, city].filter(Boolean).length + (techIds.length ? 1 : 0) + (unassigned ? 1 : 0);
  // Filtros que escondem visitas ("Ocultar OS concluídas" é o padrão e fica de fora).
  const filtered = advanced > 0 || onlyConflicts;
  const clearFilters = () => {
    setTechIds([]);
    setUnassigned(false);
    setTeamId("");
    setCustomerId("");
    setLocation(null);
    setCityInput("");
    setOnlyConflicts(false);
  };
  // Dia por técnico vazio: oferece mostrar todos os técnicos, para achar quem está livre.
  const idleOffer = !showIdle && techList.length > 0;
  const techTerm = fold(techSearch.trim());
  const visibleTechs = techTerm ? techList.filter((t) => fold(t.name).includes(techTerm)) : techList;
  const viewInfo = VIEWS.find((v) => v.key === view) ?? VIEWS[1];
  const current = opened ? (byId.get(opened.id) ?? opened) : null;

  return (
    <div>
      <PageHeader
        title="Calendário"
        description="Agenda das OS por técnico. Horários sobrepostos do mesmo técnico aparecem em vermelho."
        actions={
          <Button className="lg:hidden" onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters}>
            <SlidersHorizontal className="size-4" />
            Filtros{advanced ? ` (${advanced})` : ""}
          </Button>
        }
      />

      {zone ? (
        <p className="mb-4 flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink-muted">
          <Globe className="size-3.5 shrink-0" />
          Dias e horários no horário de Brasília, o da operação. O relógio deste computador está em outro fuso ({zone}).
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[272px_1fr]">
        <aside className={clsx("flex-col gap-4", showFilters ? "flex" : "hidden lg:flex")}>
          <Card className="p-3">
            <SectionTitle
              as="h2"
              className="mb-2"
              aside={
                techIds.length ? (
                  <button type="button" className="text-xs text-brand-ink hover:underline" onClick={() => setTechIds([])}>
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
              className="mb-2 h-8! text-xs"
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
              {!technicians.isLoading && !visibleTechs.length ? (
                <li className="px-1.5 py-1 text-xs text-ink-muted">Nenhum técnico com esse nome</li>
              ) : null}
            </ul>
            <div className="mt-2 border-t border-line pt-2">
              <Checkbox label="Sem técnico" checked={unassigned} onChange={setUnassigned} />
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
                  const value = e.target.value;
                  setCustomerId(value);
                  if (location && location.customer_id !== value) setLocation(null);
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
            {/* Busca com paginação (o cliente maior tem mais de mil lojas). Fora de um <label>: o botão
                "Trocar" do local escolhido não pode receber o clique do rótulo. */}
            <div className="flex flex-col gap-1.5">
              <span id={locationLabelId} className="text-xs font-semibold text-ink/80">
                Local
              </span>
              <LocationPicker
                customerId={customerId || null}
                customerName={customers.data?.find((c) => c.id === customerId)?.name}
                onClearCustomer={() => setCustomerId("")}
                labelledBy={locationLabelId}
                value={location}
                onChange={(picked) => {
                  setLocation(picked);
                  if (picked) setCustomerId(picked.customer_id);
                }}
              />
            </div>
            <Field label="Cidade">
              <Input value={cityInput} onChange={(e) => setCityInput(e.target.value)} placeholder="Ex.: Campinas" />
            </Field>
            <Checkbox label="Ocultar OS concluídas" checked={hideDone} onChange={setHideDone} />
          </Card>

          <Card className="p-3">
            {/* O alerta fica junto do contador: vermelho só quando há conflito. */}
            <SectionTitle
              as="h2"
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
            )}
            {/* Marcado, fica à vista mesmo sem conflito no período (senão não haveria como desmarcar). */}
            {conflicted.length > 0 || onlyConflicts ? (
              <div className="mt-2 border-t border-line pt-2">
                <Checkbox label="Mostrar só os conflitos" checked={onlyConflicts} onChange={setOnlyConflicts} />
              </div>
            ) : null}
          </Card>
        </aside>

        <Card className="flex min-w-0 flex-col overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
            <Button onClick={() => setAnchor(operationToday())}>Hoje</Button>
            <div className="flex">
              <button
                type="button"
                onClick={() => setAnchor((a) => shiftAnchor(view, a, -1))}
                className="rounded-md p-1.5 text-ink-muted hover:bg-surface-2 hover:text-ink"
                aria-label={viewInfo.previous}
                title={viewInfo.previous}
              >
                <ChevronLeft className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => setAnchor((a) => shiftAnchor(view, a, 1))}
                className="rounded-md p-1.5 text-ink-muted hover:bg-surface-2 hover:text-ink"
                aria-label={viewInfo.next}
                title={viewInfo.next}
              >
                <ChevronRight className="size-4" />
              </button>
            </div>
            <h2 className="text-sm font-bold text-ink first-letter:uppercase">{rangeTitle(view, anchor)}</h2>
            {/* Só ao trocar de período ou de filtro: a releitura de fundo não pisca nada na tela. */}
            {calendar.isPlaceholderData ? <span className="text-xs text-ink-muted">Carregando...</span> : null}
            <div className="ml-auto flex flex-wrap items-center gap-3">
              {view === "day" && !techIds.length ? (
                <Checkbox label="Técnicos sem visita" checked={showIdle} onChange={setShowIdle} />
              ) : null}
              <div className="flex rounded-lg border border-line p-0.5" role="group" aria-label="Visão">
                {VIEWS.map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    aria-pressed={view === v.key}
                    onClick={() => setView(v.key)}
                    className={clsx(
                      "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                      view === v.key ? "bg-brand text-white dark:bg-brand-strong" : "text-ink-muted hover:text-ink",
                    )}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {calendar.error && calendar.data ? (
            <div className="border-b border-line p-3">
              <RefreshFailed
                at={calendar.errorUpdatedAt}
                onRetry={() => void calendar.refetch()}
                retrying={calendar.isFetching}
              />
            </div>
          ) : null}
          {/* Período ou filtro novo carregando: a grade anterior fica esmaecida até a resposta chegar. */}
          <div
            aria-busy={calendar.isPlaceholderData || undefined}
            className={clsx(
              "h-[calc(100vh-15rem)] min-h-[520px] transition-opacity duration-150",
              calendar.isPlaceholderData && "opacity-60",
            )}
          >
            {calendar.error && !calendar.data ? (
              <div className="p-3">
                <ErrorBox message={errorMessage(calendar.error)} onRetry={() => void calendar.refetch()} />
              </div>
            ) : !calendar.data || (view === "day" && columns.length === 0 && !ready) ? (
              <LoadingBlock rows={5} label="Carregando a agenda..." />
            ) : view === "month" ? (
              <MonthView
                days={days}
                month={anchor.getUTCMonth()}
                events={events}
                colors={colors}
                onOpen={setOpened}
                onDay={openDay}
              />
            ) : view === "day" && columns.length === 0 ? (
              <EmptyState
                icon={<CalendarDays />}
                title={
                  filtered
                    ? "Nenhuma visita com esses filtros"
                    : hideDone
                      ? "Nenhuma visita em aberto neste dia"
                      : "Nenhuma visita neste dia"
                }
                description={
                  filtered
                    ? "Limpe os filtros para ver todas as visitas do dia."
                    : [hideDone ? "As OS concluídas estão ocultas." : "", idleOffer ? "Mostre os técnicos sem visita para achar quem está livre." : ""]
                        .filter(Boolean)
                        .join(" ") || undefined
                }
                action={
                  filtered ? (
                    <Button onClick={clearFilters}>Limpar filtros</Button>
                  ) : hideDone || idleOffer ? (
                    <div className="flex flex-wrap justify-center gap-2">
                      {hideDone ? <Button onClick={() => setHideDone(false)}>Mostrar concluídas</Button> : null}
                      {idleOffer ? <Button onClick={() => setShowIdle(true)}>Ver técnicos sem visita</Button> : null}
                    </div>
                  ) : undefined
                }
              />
            ) : (
              <TimeGrid
                columns={columns}
                colors={colors}
                onOpen={setOpened}
                scrollKey={`${view}:${dayKey(start)}`}
                ready={ready}
              />
            )}
          </div>
        </Card>
      </div>

      {current ? (
        <EventDialog
          event={current}
          related={current.conflict_with.map((id) => byId.get(id)).filter((e): e is CalendarEvent => !!e)}
          color={current.assignee ? (colors.get(current.assignee.id) ?? technicianColor(current.assignee.id)) : UNASSIGNED_COLOR}
          zone={zone}
          canReschedule={canEdit}
          onOpen={setOpened}
          onOpenTicket={
            ticketPanel
              ? (id) => {
                  setOpened(null);
                  ticketPanel.open(id);
                }
              : undefined
          }
          onClose={() => setOpened(null)}
        />
      ) : null}
    </div>
  );
}

export default function AgendaPage() {
  // useSearchParams pede um Suspense em volta.
  return (
    <Suspense fallback={<LoadingBlock />}>
      <AgendaView />
    </Suspense>
  );
}

/** Cabeçalho do dia na semana: o clique abre o dia por técnico. */
function DayHeader({ day, onPick }: { day: Date; onPick: () => void }) {
  const today = sameDay(day, operationToday());
  return (
    <button
      type="button"
      onClick={onPick}
      aria-label={`Ver ${formatDay(day, { weekday: "long", day: "numeric", month: "long" })} por técnico`}
      aria-current={today ? "date" : undefined}
      className="mx-auto flex flex-col items-center rounded-lg px-2 py-0.5 leading-tight transition-colors hover:bg-surface-2"
    >
      <span className="text-[11px] font-bold tracking-wide text-ink-muted uppercase">{WEEKDAYS_SHORT[day.getUTCDay()]}</span>
      <span
        className={clsx(
          "mt-0.5 flex size-7 items-center justify-center rounded-full text-sm font-semibold tabular-nums",
          today ? "bg-brand text-white dark:bg-brand-strong" : "text-ink",
        )}
      >
        {day.getUTCDate()}
      </span>
    </button>
  );
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "pt-BR");

/**
 * Dia por técnico: uma coluna por pessoa com visita no dia (responsável ou junto), ou pelos técnicos
 * filtrados; com `showIdle`, também os técnicos sem visita. Por último, "Sem técnico".
 */
function dayColumns(
  day: Date,
  events: CalendarEvent[],
  techs: { id: string; name: string }[],
  selected: string[],
  colors: Map<string, string>,
  showIdle: boolean,
): GridColumn[] {
  const onDay = eventsOnDay(events, day);
  // Quem tem visita no dia (analistas e técnicos desativados também), inclusive quem vai junto.
  const busy = new Map<string, string>();
  onDay.forEach((e) => {
    if (e.assignee) busy.set(e.assignee.id, e.assignee.name);
    e.helpers?.forEach((h) => busy.set(h.id, h.name));
  });
  const names = new Map(techs.map((t) => [t.id, t.name]));
  const people = selected.length
    ? selected.map((id) => ({ id, name: names.get(id) ?? busy.get(id) ?? "Técnico" })).sort(byName)
    : [
        ...[...busy].map(([id, name]) => ({ id, name })).sort(byName),
        ...(showIdle ? techs.filter((t) => !busy.has(t.id)).sort(byName) : []),
      ];
  const cols: GridColumn[] = people.map((p) => {
    const mine = onDay.filter((e) => e.assignee?.id === p.id || e.helpers?.some((h) => h.id === p.id));
    const clash = mine.some((e) => e.conflict_with.length > 0);
    return {
      key: p.id,
      day,
      events: mine,
      header: (
        <span className="flex min-w-0 items-center justify-center gap-1.5 text-xs" title={p.name}>
          <span className="size-2.5 shrink-0 rounded-full" style={{ background: colors.get(p.id) ?? technicianColor(p.id) }} />
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
      header: <span className="text-xs font-semibold text-ink-muted">Sem técnico · {orphan.length}</span>,
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

/** O que mudou na OS desde que o reagendamento abriu: a situação, a visita e o técnico. */
function changeSummary(before: TicketDetail, now: TicketDetail): string {
  const parts: string[] = [];
  if (now.status !== before.status) parts.push(`situação agora: ${STATUS[now.status].label}`);
  if (now.scheduled_start !== before.scheduled_start || now.scheduled_end !== before.scheduled_end) {
    parts.push(now.scheduled_start ? `visita agora: ${formatShort(now.scheduled_start)}` : "a visita saiu da agenda");
  }
  if ((now.assignee?.id ?? null) !== (before.assignee?.id ?? null)) parts.push(`técnico agora: ${now.assignee?.name ?? "nenhum"}`);
  const text = parts.length ? parts.join(" · ") : "outros dados da OS foram alterados";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function EventDialog({
  event,
  related,
  color,
  zone,
  canReschedule,
  onOpen,
  onOpenTicket,
  onClose,
}: {
  event: CalendarEvent;
  related: CalendarEvent[];
  color: string;
  /** Fuso do computador quando difere do da operação: o formulário lembra que a hora é a de Brasília. */
  zone: string | null;
  /** Calendário com Editar: o Reagendar daqui. */
  canReschedule: boolean;
  onOpen: (event: CalendarEvent) => void;
  /** Abre a OS no painel lateral; sem ele, "Abrir OS" vai para a página da OS. */
  onOpenTicket?: (ticketId: string) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [mode, setMode] = useState<"view" | "reschedule">("view");
  const [shownId, setShownId] = useState(event.id);
  const [startInput, setStartInput] = useState("");
  const [endInput, setEndInput] = useState("");
  const [endTouched, setEndTouched] = useState(false);
  // A API barrou por conflito de agenda: mostra as OS em choque e o próximo envio confirma.
  const [conflicts, setConflicts] = useState<ConflictItem[] | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  // A OS lida depois que o reagendamento abriu: a versão dela vai no envio, para não sobrescrever o que
  // outra pessoa (ou o app do técnico) mudar enquanto isso.
  const [openedAt, setOpenedAt] = useState(0);
  const [base, setBase] = useState<TicketDetail | null>(null);
  // Na prévia: o reagendamento fechou porque a OS saiu das situações que se reagendam por aqui.
  const [notice, setNotice] = useState<string | null>(null);
  // Outra OS aberta pela lista de conflitos: volta para a prévia, no mesmo diálogo.
  if (shownId !== event.id) {
    setShownId(event.id);
    setMode("view");
    setConflicts(null);
    setLocalError(null);
    setBase(null);
    setNotice(null);
  }
  const rescheduling = mode === "reschedule";
  // A OS completa só para reagendar (versão e duração estimada). O tempo real relê a cada mudança nela.
  const detail = useQuery({
    queryKey: ["ticket", event.id],
    queryFn: ({ signal }) => api.get<TicketDetail>(`/tickets/${event.id}`, undefined, { signal }),
    enabled: rescheduling,
    // Ao abrir o formulário relê sempre, mesmo com uma cópia de segundos atrás no cache.
    staleTime: 0,
  });
  // A base é a primeira leitura terminada depois de abrir (uma cópia antiga do cache não serve).
  if (rescheduling && !base && detail.data && detail.dataUpdatedAt >= openedAt) setBase(detail.data);
  // Mudou depois disso: o formulário mostra o que mudou e salvar passa a ser a confirmação.
  const changed = base && detail.data && detail.data.version !== base.version ? detail.data : null;
  const save = useMutation({
    mutationFn: (version: number) =>
      api.patch<TicketDetail>(`/tickets/${event.id}`, {
        scheduled_start: fromLocalInput(startInput),
        // Em branco, a API usa a duração estimada da OS.
        scheduled_end: fromLocalInput(endInput),
        expected_version: version,
        allow_conflict: Boolean(conflicts),
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(["ticket", event.id], updated);
      void queryClient.invalidateQueries({ queryKey: ["tickets"] });
      toast({
        title: `${updated.code} reagendada`,
        description: updated.scheduled_start ? `Nova visita: ${formatShort(updated.scheduled_start)}` : undefined,
        tone: "success",
      });
      onClose();
    },
    onError: (error) => {
      const clash = scheduleConflicts(error);
      if (clash) {
        setConflicts(clash);
        return;
      }
      // A OS mudou entre a última leitura e o envio: relê, e o aviso do que mudou pede a confirmação.
      if (isVersionConflict(error)) {
        void queryClient.invalidateQueries({ queryKey: ["ticket", event.id] });
        void queryClient.invalidateQueries({ queryKey: ["tickets"] });
      }
    },
  });

  // Saiu das situações que se reagendam por aqui (ex.: o técnico saiu para a visita): volta para a
  // prévia e diz por quê. A situação vem do calendário e, depois de aberto, da leitura atual da OS.
  const moved = [event.status, base ? detail.data?.status : undefined].find(
    (status): status is TicketStatus => status !== undefined && !RESCHEDULABLE.includes(status),
  );
  if (rescheduling && moved && !save.isPending) {
    setMode("view");
    setNotice(`${event.code} passou para ${STATUS[moved].label}: não dá mais para reagendar pelo calendário.`);
  }

  const start = new Date(event.start);
  const end = new Date(event.end);
  // Duração da visita com fim marcado: ao mudar o início, o fim acompanha até alguém mexer nele.
  const duration = event.end_is_estimated ? null : end.getTime() - start.getTime();
  const estimate = detail.data?.estimated_minutes ?? null;

  const beginReschedule = () => {
    save.reset();
    setStartInput(toLocalInput(event.start));
    setEndInput(event.end_is_estimated ? "" : toLocalInput(event.end));
    setEndTouched(false);
    setConflicts(null);
    setLocalError(null);
    setNotice(null);
    setBase(null);
    setOpenedAt(Date.now());
    setMode("reschedule");
  };
  const changeStart = (value: string) => {
    setStartInput(value);
    setConflicts(null);
    const iso = fromLocalInput(value);
    if (!endTouched && duration !== null && iso) {
      setEndInput(toLocalInput(new Date(new Date(iso).getTime() + duration).toISOString()));
    }
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!base || save.isPending) return;
    const startIso = fromLocalInput(startInput);
    const endIso = fromLocalInput(endInput);
    if (!startIso) return setLocalError("Informe a data e a hora da visita.");
    if (endIso && new Date(endIso).getTime() <= new Date(startIso).getTime()) {
      return setLocalError("O fim precisa ser depois do início.");
    }
    setLocalError(null);
    // Com o aviso de mudança à vista, salvar confirma sobre a OS como ela está agora.
    const target = changed ?? base;
    if (changed) setBase(changed);
    save.mutate(target.version);
  };
  const saveError = save.error && !conflicts && !isVersionConflict(save.error) ? errorMessage(save.error) : null;
  const error = localError ?? saveError;
  const endHint = !endInput
    ? estimate
      ? `Em branco, a visita dura o estimado: ${formatMinutes(estimate)}`
      : "Em branco, a visita dura o estimado do tipo de serviço"
    : !endTouched && duration !== null
      ? "Acompanha o início, com a mesma duração"
      : undefined;

  return (
    <Dialog
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <span className="size-2.5 rounded-full" style={{ background: color }} />
          <span className="font-mono">{event.code}</span>
          {rescheduling ? <span className="font-sans">· Reagendar</span> : null}
        </span>
      }
      description={event.title}
      footer={
        rescheduling ? (
          <>
            <Button onClick={() => setMode("view")}>Voltar</Button>
            <Button
              variant="primary"
              type="submit"
              form="reschedule-form"
              // Espera a leitura da OS (a versão do envio) e as releituras do tempo real.
              loading={save.isPending || (!base && !detail.error)}
              disabled={!base || detail.isFetching}
            >
              {conflicts ? "Reagendar mesmo assim" : changed ? "Salvar mesmo assim" : "Salvar horário"}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Fechar</Button>
            {canReschedule && RESCHEDULABLE.includes(event.status) ? (
              <Button onClick={beginReschedule}>
                <CalendarClock className="size-4" />
                Reagendar
              </Button>
            ) : null}
            {/* Link de verdade: clique abre no painel; Ctrl+clique ou botão do meio, a página em outra aba. */}
            <Link
              href={`/chamados/${event.id}`}
              className={buttonClassName("primary")}
              onClick={(e) => {
                if (!onOpenTicket || !isPlainClick(e)) return;
                e.preventDefault();
                onOpenTicket(event.id);
              }}
            >
              <PanelRightOpen className="size-4" />
              Abrir OS
            </Link>
          </>
        )
      }
    >
      {rescheduling ? (
        <form id="reschedule-form" onSubmit={submit} className="flex flex-col gap-4">
          <p className="text-sm text-ink-muted">
            Escolha o novo horário da visita{event.assignee ? ` de ${event.assignee.name}` : ""}. Antes:{" "}
            {formatShort(base?.scheduled_start ?? event.start)}
            {zone ? " (horário de Brasília)" : ""}.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Início" required hint={zone ? "No horário de Brasília, o da operação" : undefined}>
              <Input type="datetime-local" value={startInput} onChange={(e) => changeStart(e.target.value)} required autoFocus />
            </Field>
            <Field label="Fim" hint={endHint}>
              <Input
                type="datetime-local"
                value={endInput}
                min={startInput || undefined}
                onChange={(e) => {
                  setEndInput(e.target.value);
                  setEndTouched(true);
                  setConflicts(null);
                }}
              />
            </Field>
          </div>
          {changed && base ? (
            <div
              role="alert"
              className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
            >
              <p className="font-semibold">A OS mudou enquanto você editava</p>
              <p className="mt-0.5 text-xs">
                {changeSummary(base, changed)}. Confira o horário e use Salvar mesmo assim para confirmar.
              </p>
            </div>
          ) : null}
          {conflicts ? (
            <ConflictList
              tone="error"
              items={conflicts}
              title="Há outra OS no mesmo horário. Confirme para reagendar mesmo assim."
            />
          ) : startInput ? (
            <ConflictHint
              assigneeId={event.assignee?.id}
              assigneeName={event.assignee?.name}
              start={fromLocalInput(startInput)}
              end={fromLocalInput(endInput)}
              estimatedMinutes={estimate}
              excludeId={event.id}
            />
          ) : null}
          {detail.error && !base ? (
            <ErrorBox message={errorMessage(detail.error)} onRetry={() => void detail.refetch()} />
          ) : null}
          {error ? <ErrorBox message={error} /> : null}
        </form>
      ) : (
        <div className="flex flex-col gap-3">
          {notice ? (
            <p
              role="status"
              className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
            >
              {notice}
            </p>
          ) : null}
          <EventDetails event={event} related={related} canReschedule={canReschedule} onOpen={onOpen} />
        </div>
      )}
    </Dialog>
  );
}

function EventDetails({
  event,
  related,
  canReschedule,
  onOpen,
}: {
  event: CalendarEvent;
  related: CalendarEvent[];
  canReschedule: boolean;
  onOpen: (event: CalendarEvent) => void;
}) {
  // No relógio da operação, como a grade.
  const start = toWall(event.start);
  const end = toWall(event.end);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        <StatusBadge status={event.status} />
        <PriorityBadge priority={event.priority} />
      </div>
      <Row icon={<Clock className="size-4" />}>
        {formatDay(start, { weekday: "long", day: "2-digit", month: "long" })}, {hhmm(start)} –{" "}
        {sameDay(start, end) ? hhmm(end) : formatShort(event.end)}
        {event.end_is_estimated ? <span className="text-ink-muted"> (fim estimado)</span> : null}
      </Row>
      <Row icon={<UserIcon className="size-4" />}>
        {event.assignee?.name ?? <span className="text-ink-muted">Sem técnico</span>}
        {event.team ? <span className="text-ink-muted"> · {event.team.name}</span> : null}
        {event.helpers?.length ? (
          <span className="block text-xs text-ink-muted">Vai junto: {event.helpers.map((h) => h.name).join(", ")}</span>
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
                  <span className="font-mono font-medium">{r.code}</span> · {formatTime(r.start)}–{formatTime(r.end)} ·{" "}
                  {[r.customer?.name, r.location?.name].filter(Boolean).join(" · ") || r.title}
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-red-800 dark:text-red-200">
            {canReschedule
              ? "Use Reagendar numa delas ou troque o técnico na própria OS."
              : "Troque o horário ou o técnico na própria OS."}
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
  );
}
