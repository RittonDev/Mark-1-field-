"use client";

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import {
  AlertTriangle,
  BatteryLow,
  BatteryMedium,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Clock,
  Gauge,
  House,
  MapPin,
  MapPinned,
  MessageCircle,
  Navigation,
  Phone,
  Route,
  Search,
  ShieldCheck,
  Store,
  Wrench,
  X,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "@/components/Brand";
import type { MapFocus, MapPlace } from "@/components/LiveMap";
import { LocationPicker } from "@/components/LocationPicker";
import { fold, operationDay } from "@/components/operacao/hooks";
import { TicketLink } from "@/components/ticket/TicketLink";
import {
  Button,
  buttonClassName,
  Card,
  Checkbox,
  EmptyState,
  ErrorBox,
  Input,
  LoadingBlock,
  PageHeader,
  SectionTitle,
  Select,
} from "@/components/ui";
import { useNow } from "@/components/useNow";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets, STATUS } from "@/lib/constants";
import { formatMinutes, formatShort, formatTime, initials } from "@/lib/format";
import { useDayActivities, useLiveTechnicians, useMapDistances, useTeams, useTrackingHistory } from "@/lib/queries";
import { useConnectionState } from "@/lib/realtime";
import {
  DAY_STATE,
  formatAgo,
  formatKm,
  formatSpeed,
  inCurrentShift,
  isStale,
  isValidCoords,
  LIVE_STATE,
  LIVE_STATE_ORDER,
  shiftPosition,
  trailSummary,
} from "@/lib/tracking";
import type {
  Activity,
  DayActivities,
  DistanceLeg,
  LiveState,
  LiveTechnician,
  Location,
  TechnicianDistance,
  TrackingHistory,
} from "@/lib/types";
import { whatsappUrl } from "@/lib/whatsapp";

const LiveMap = dynamic(() => import("@/components/LiveMap"), {
  ssr: false,
  loading: () => <LoadingBlock label="Carregando mapa..." />,
});

// As posições são apagadas depois de 90 dias (TRACKING_RETENTION_DAYS na API): antes disso não há trajeto.
const TRAIL_RETENTION_DAYS = 90;
// Posição de agora vale para ordenar por distância até 2 h (a mesma regra da API); depois, vale a casa.
const RANK_LIVE_MAX_MS = 2 * 3_600_000;

/** Dia vizinho ("2026-11-12" -> "2026-11-13"), sem fuso no meio da conta. */
function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const rank = (state: LiveState) => LIVE_STATE_ORDER.indexOf(state);

// Preferências do mapa neste navegador (o que mostrar por padrão).
const PREFS_KEY = "mf-mapa-preferencias";
interface MapPrefs {
  hideOffline: boolean;
  showOs: boolean;
}
const DEFAULT_PREFS: MapPrefs = { hideOffline: false, showOs: true };

function readPrefs(): MapPrefs {
  try {
    const saved = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? "null") as Partial<MapPrefs> | null;
    return {
      hideOffline: typeof saved?.hideOffline === "boolean" ? saved.hideOffline : DEFAULT_PREFS.hideOffline,
      showOs: typeof saved?.showOs === "boolean" ? saved.showOs : DEFAULT_PREFS.showOs,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(prefs: MapPrefs) {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Navegador sem armazenamento (aba anônima, bloqueio): vale só nesta visita.
  }
}

/**
 * Distância medida com um ponto de fora da jornada (ou da jornada anterior): não é "agora" e não entra na
 * conta. Fora da jornada a posição do técnico não existe para a central (LGPD).
 */
function onlyShiftDistance(d: TechnicianDistance, tech: LiveTechnician | undefined): TechnicianDistance {
  if (inCurrentShift(d.live_at, tech)) return d;
  return { ...d, live: null, live_at: null, live_to_place: null, live_to_home: null };
}

/** Quem está mais perto da loja: pela posição de agora (até 2 h) ou, sem ela, pela casa. */
function closeness(d: TechnicianDistance | undefined, now: number): number {
  if (!d) return Number.POSITIVE_INFINITY;
  if (d.live_to_place && d.live_at && now - new Date(d.live_at).getTime() <= RANK_LIVE_MAX_MS) return d.live_to_place.km;
  return d.home_to_place?.km ?? d.live_to_place?.km ?? Number.POSITIVE_INFINITY;
}

export default function LiveMapPage() {
  const { user } = useAuth();
  const theme = useTheme();
  const now = useNow(15_000);
  const today = operationDay(now);
  const canManage = canManageTickets(user?.role);
  const [teamId, setTeamId] = useState("");
  const [q, setQ] = useState("");
  // Estados escolhidos nos filtros (vazio = todos).
  const [stateFilter, setStateFilter] = useState<ReadonlySet<LiveState>>(() => new Set());
  const [prefs, setPrefs] = useState<MapPrefs>(readPrefs);
  const [onlyUnassigned, setOnlyUnassigned] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Dia do trajeto: null = hoje (acompanha a virada do dia com a tela aberta).
  const [dayChoice, setDayChoice] = useState<string | null>(null);
  // Loja do cliente: escolhida na busca (cadastro completo) ou numa OS do dia no mapa.
  const [pickedLocation, setPickedLocation] = useState<Location | null>(null);
  const [mapPlace, setMapPlace] = useState<MapPlace | null>(null);
  const place = useMemo<MapPlace | null>(
    () => (pickedLocation ? { id: pickedLocation.id, name: pickedLocation.name } : mapPlace),
    [pickedLocation, mapPlace],
  );
  const day = dayChoice ?? today;
  const detailRef = useRef<HTMLDivElement>(null);
  const fromMapRef = useRef(false);

  const teams = useTeams();
  const live = useLiveTechnicians(teamId || null);
  const history = useTrackingHistory(selectedId, day);
  // As distâncias só servem com loja ou técnico escolhido: sem isso, nada na tela usa (e a conta é pesada).
  const distancesEnabled = canManage && (!!place || !!selectedId);
  const distances = useMapDistances(place?.id ?? null, teamId || null, distancesEnabled);
  const dayList = useDayActivities(canManage && prefs.showOs ? today : null, teamId || null);
  // O dia do técnico escolhido (inclui as visitas em que ele vai junto), em ordem de horário.
  const agenda = useQuery({
    queryKey: ["tickets", "day-of", selectedId, today],
    queryFn: () => api.get<DayActivities>("/activities/day", { date: today, assignee_id: selectedId ?? undefined }),
    enabled: canManage && !!selectedId,
    refetchInterval: 60_000,
  });

  const liveById = useMemo(() => new Map((live.data ?? []).map((t) => [t.id, t])), [live.data]);
  const distanceById = useMemo(
    () => new Map((distances.data?.technicians ?? []).map((d) => [d.id, onlyShiftDistance(d, liveById.get(d.id))])),
    [distances.data, liveById],
  );

  const technicians = useMemo(() => {
    const list = [...(live.data ?? [])];
    // Com loja escolhida: do mais perto para o mais longe (agora, em jornada, ou de casa).
    if (place && distances.data) {
      return list.sort(
        (a, b) => closeness(distanceById.get(a.id), now) - closeness(distanceById.get(b.id), now) || a.name.localeCompare(b.name),
      );
    }
    return list.sort((a, b) => rank(a.state) - rank(b.state) || a.name.localeCompare(b.name));
  }, [live.data, place, distances.data, distanceById, now]);
  const counts = useMemo(() => {
    const c = Object.fromEntries(LIVE_STATE_ORDER.map((s) => [s, 0])) as Record<LiveState, number>;
    technicians.forEach((t) => (c[t.state] += 1));
    return c;
  }, [technicians]);
  const visible = useMemo(() => {
    const term = fold(q.trim());
    return technicians.filter(
      (t) =>
        (stateFilter.size ? stateFilter.has(t.state) : !(prefs.hideOffline && t.state === "offline")) &&
        (!term || fold(t.name).includes(term) || fold(t.current_ticket?.code).includes(term)),
    );
  }, [technicians, q, stateFilter, prefs.hideOffline]);
  const selected = selectedId ? (liveById.get(selectedId) ?? null) : null;
  // No mapa, o técnico escolhido continua visível mesmo fora do filtro da lista.
  const mapTechnicians = useMemo(
    () => (selected && !visible.some((t) => t.id === selected.id) ? [...visible, selected] : visible),
    [visible, selected],
  );
  const activities = useMemo(() => {
    if (!prefs.showOs) return [];
    const all = dayList.data?.activities ?? [];
    return onlyUnassigned ? all.filter((a) => !a.ticket.assignee) : all;
  }, [dayList.data, prefs.showOs, onlyUnassigned]);
  const osCounts = useMemo(() => {
    const all = dayList.data?.activities ?? [];
    return {
      total: all.length,
      unassigned: all.filter((a) => !a.ticket.assignee).length,
      noCoords: all.filter((a) => !isValidCoords(a.ticket.location?.latitude, a.ticket.location?.longitude)).length,
    };
  }, [dayList.data]);

  const selectedDistance = selectedId ? distanceById.get(selectedId) : undefined;
  const placePoint = place ? (distances.data?.place ?? null) : null;
  const selectedPos = selected ? shiftPosition(selected) : null;
  const focus = useMemo<MapFocus | null>(() => {
    if (!placePoint && !selected) return null;
    return {
      place: placePoint,
      home: selectedDistance?.home ?? null,
      // Só a posição da jornada aberta: fora dela o técnico não aparece (nem a última posição conhecida).
      live: selectedPos ? { latitude: selectedPos.latitude, longitude: selectedPos.longitude } : null,
      name: selected?.name,
    };
  }, [placePoint, selected, selectedDistance, selectedPos]);
  const focusKey = place || selectedId ? `${place?.id ?? ""}|${selectedId ?? ""}` : null;
  const focusPending =
    (distancesEnabled && distances.isPending) || (!!selectedId && !selectedPos && history.isPending && day === today);

  const nobodyOnShift =
    !live.isLoading && !live.error && technicians.length > 0 && technicians.every((t) => !t.on_shift);
  const filtering = stateFilter.size > 0 || !!q.trim();

  // Técnico escolhido no mapa, em tela pequena: a ficha dele fica abaixo do mapa; leva até ela.
  useEffect(() => {
    if (!selectedId || !fromMapRef.current) return;
    fromMapRef.current = false;
    if (!window.matchMedia("(max-width: 1023px)").matches) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    detailRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "nearest" });
  }, [selectedId]);

  const select = (id: string | null) => {
    setSelectedId(id);
    // Outro técnico: o trajeto volta para hoje.
    setDayChoice(null);
  };
  const changeTeam = (id: string) => {
    setTeamId(id);
    select(null);
  };
  const changePrefs = (patch: Partial<MapPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    savePrefs(next);
  };
  const toggleState = (state: LiveState) =>
    setStateFilter((current) => {
      const next = new Set(current);
      if (next.has(state)) next.delete(state);
      else next.add(state);
      return next;
    });
  const clearFilters = () => {
    setStateFilter(new Set());
    setQ("");
  };

  if (user && !canManage) {
    return <ErrorBox message="O mapa ao vivo é exclusivo para analistas e gestores." />;
  }

  return (
    <div>
      <PageHeader
        title="Mapa ao vivo"
        description="Onde cada técnico está agora (só durante a jornada), a OS em campo e as OS do dia."
        actions={
          <>
            <LiveStatus updatedAt={live.dataUpdatedAt} />
            <Select value={teamId} onChange={(e) => changeTeam(e.target.value)} aria-label="Grupo" className="w-48">
              <option value="">Todos os grupos</option>
              {(teams.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar técnicos por estado">
          {LIVE_STATE_ORDER.map((s) => (
            <FilterChip key={s} pressed={stateFilter.has(s)} onClick={() => toggleState(s)} title={LIVE_STATE[s].hint}>
              <span aria-hidden className="size-2.5 rounded-full" style={{ background: LIVE_STATE[s].color }} />
              {LIVE_STATE[s].label}
              <span className="font-semibold text-ink tabular-nums">{counts[s]}</span>
            </FilterChip>
          ))}
        </div>
        <span aria-hidden className="mx-1 hidden h-5 w-px bg-line sm:block" />
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="OS no mapa">
          <FilterChip
            pressed={prefs.showOs}
            onClick={() => changePrefs({ showOs: !prefs.showOs })}
            title={
              osCounts.noCoords
                ? `${osCounts.noCoords} OS sem coordenada da loja não aparecem no mapa`
                : "Mostrar no mapa as OS de hoje (agendadas, em campo, atrasadas e sem técnico)"
            }
          >
            <span aria-hidden className="size-2.5 rounded-[3px] bg-ink-subtle" />
            OS do dia
            {prefs.showOs && dayList.data ? (
              <span className="font-semibold text-ink tabular-nums">{osCounts.total}</span>
            ) : null}
          </FilterChip>
          {prefs.showOs ? (
            <FilterChip pressed={onlyUnassigned} onClick={() => setOnlyUnassigned((v) => !v)} title="Só as OS de hoje sem técnico">
              <span aria-hidden className="size-2.5 rounded-[3px] border-2 border-dashed border-ink-subtle" />
              Só sem técnico
              {dayList.data ? <span className="font-semibold text-ink tabular-nums">{osCounts.unassigned}</span> : null}
            </FilterChip>
          ) : null}
        </div>
        <span className="sm:ml-auto">
          <Checkbox
            label="Ocultar quem está fora da jornada"
            checked={prefs.hideOffline}
            onChange={(v) => changePrefs({ hideOffline: v })}
          />
        </span>
      </div>

      {live.error ? (
        <div className="mb-4">
          <ErrorBox message={errorMessage(live.error)} />
        </div>
      ) : null}
      {dayList.error && prefs.showOs ? (
        <div className="mb-4">
          <ErrorBox message={`OS do dia: ${errorMessage(dayList.error)}`} />
        </div>
      ) : null}

      <div className="grid gap-4 lg:h-[calc(100vh-15.5rem)] lg:min-h-[480px] lg:grid-cols-[360px_1fr]">
        <Card className="order-2 flex max-h-[80vh] min-h-0 flex-col lg:order-1 lg:max-h-none">
          <div className="border-b border-line p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Buscar técnico ou OS"
                className="pl-9"
                aria-label="Buscar técnico ou OS"
              />
            </div>
            <div className="mt-2.5">
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-ink/80">
                <Store className="size-3.5" />
                Loja do cliente
              </p>
              {mapPlace && !pickedLocation ? (
                <div className="flex items-start justify-between gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm">
                  <p className="flex min-w-0 items-center gap-1.5 font-semibold text-ink">
                    <MapPin className="size-3.5 shrink-0 text-ink-muted" />
                    <span className="truncate">{mapPlace.name}</span>
                  </p>
                  <Button size="sm" variant="ghost" onClick={() => setMapPlace(null)} aria-label="Trocar local">
                    <X className="size-3.5" />
                    Trocar
                  </Button>
                </div>
              ) : (
                <LocationPicker
                  customerId={null}
                  value={pickedLocation}
                  onChange={(location) => {
                    setPickedLocation(location);
                    setMapPlace(null);
                  }}
                />
              )}
              {place ? (
                <p className="mt-1.5 text-[11px] text-ink-muted">
                  {distances.data?.place?.approximate ? "A loja não tem coordenada: medindo pelo centro da cidade. " : ""}
                  Técnicos do mais perto para o mais longe: de onde estão agora (em jornada) ou de casa.
                </p>
              ) : (
                <p className="mt-1.5 text-[11px] text-ink-muted">
                  Escolha a loja para ver quem está mais perto. No mapa, clique numa OS do dia e em “Medir técnicos”.
                </p>
              )}
              {distances.error && place ? (
                <div className="mt-2">
                  <ErrorBox message={errorMessage(distances.error)} />
                </div>
              ) : null}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {live.isLoading ? (
              <LoadingBlock />
            ) : live.error ? null : technicians.length === 0 ? (
              teamId ? (
                <EmptyState
                  icon={<MapPinned className="size-6" />}
                  title="Nenhum técnico ativo neste grupo"
                  action={<Button onClick={() => changeTeam("")}>Ver todos os grupos</Button>}
                />
              ) : (
                <EmptyState
                  icon={<MapPinned className="size-6" />}
                  title="Nenhum técnico com acesso ao app"
                  description="Libere o acesso em Técnicos ou aprove fichas na Homologação para vê-los aqui."
                  action={
                    <Link href="/tecnicos" className={buttonClassName()}>
                      Ir para Técnicos
                    </Link>
                  }
                />
              )
            ) : visible.length === 0 ? (
              <EmptyState
                icon={<MapPinned className="size-6" />}
                title="Nenhum técnico neste filtro"
                description={
                  !filtering && prefs.hideOffline ? "Todos estão fora da jornada (e você ocultou quem está fora)." : undefined
                }
                action={
                  filtering ? (
                    <Button onClick={clearFilters}>Limpar filtros</Button>
                  ) : (
                    <Button onClick={() => changePrefs({ hideOffline: false })}>Mostrar quem está fora da jornada</Button>
                  )
                }
              />
            ) : (
              <ul className="divide-y divide-line">
                {visible.map((t) => (
                  <TechnicianRow
                    key={t.id}
                    tech={t}
                    now={now}
                    selected={t.id === selectedId}
                    onSelect={() => select(t.id === selectedId ? null : t.id)}
                    distance={place ? distanceById.get(t.id) : undefined}
                  />
                ))}
              </ul>
            )}
          </div>
          {selected ? (
            <div ref={detailRef} className="max-h-[65%] shrink-0 overflow-y-auto border-t border-line">
              <TechnicianDetail
                tech={selected}
                now={now}
                today={today}
                day={day}
                onDay={(value) => setDayChoice(value === today ? null : value)}
                onClose={() => select(null)}
                trail={history.data}
                trailLoading={history.isFetching && !history.data}
                distance={selectedDistance}
                placeName={place?.name ?? null}
                agenda={agenda.data?.activities}
                agendaLoading={agenda.isLoading}
              />
            </div>
          ) : null}
        </Card>

        <Card className="order-1 h-[55vh] min-h-[360px] overflow-hidden lg:order-2 lg:h-full">
          <LiveMap
            technicians={mapTechnicians}
            selectedId={selectedId}
            onSelect={(id) => {
              fromMapRef.current = true;
              if (id !== selectedId) select(id);
            }}
            history={selectedId ? (history.data ?? null) : null}
            theme={theme}
            now={now}
            today={today}
            activities={activities}
            onMeasure={(target) => {
              setPickedLocation(null);
              setMapPlace(target);
            }}
            focus={focus}
            focusKey={focusKey}
            focusPending={focusPending}
            fitKey={teamId}
            notice={
              nobodyOnShift
                ? "Ninguém em jornada agora. A posição aparece quando o técnico inicia a jornada no app."
                : null
            }
          />
        </Card>
      </div>
    </div>
  );
}

/** Situação do tempo real: o mapa congelado não pode parecer ao vivo. */
function LiveStatus({ updatedAt }: { updatedAt: number }) {
  const connection = useConnectionState();
  // Antes da primeira conexão é "conectando"; depois, cair é "reconectando" (as posições param de chegar).
  const [everOnline, setEverOnline] = useState(false);
  if (connection === "online" && !everOnline) setEverOnline(true);
  const reconnecting = connection !== "online" && everOnline;
  return (
    <span
      className={clsx(
        "inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs",
        reconnecting
          ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
          : "border-line bg-surface text-ink-muted",
      )}
    >
      <span
        aria-hidden
        className={clsx(
          "size-1.5 rounded-full",
          connection === "online" ? "bg-emerald-600" : reconnecting ? "bg-amber-500" : "bg-ink-subtle",
        )}
      />
      <span aria-live="polite">
        {connection === "online" ? "Ao vivo" : reconnecting ? "Reconectando: as posições podem estar atrasadas" : "Conectando…"}
      </span>
      {updatedAt ? <span className="tabular-nums">· {formatTime(new Date(updatedAt).toISOString())}</span> : null}
    </span>
  );
}

function FilterChip({
  pressed,
  onClick,
  title,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={title}
      onClick={onClick}
      className={clsx(
        "inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none",
        pressed ? "border-brand bg-nav-active text-ink" : "border-line bg-surface text-ink-muted hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function TechnicianRow({
  tech,
  now,
  selected,
  onSelect,
  distance,
}: {
  tech: LiveTechnician;
  now: number;
  selected: boolean;
  onSelect: () => void;
  /** Com loja escolhida: de onde ele está (em jornada) e de casa até a loja. */
  distance?: TechnicianDistance;
}) {
  const state = LIVE_STATE[tech.state];
  const pos = shiftPosition(tech);
  // Em jornada e sem posição nova há mais de 5 min: o técnico pode já estar em outro lugar.
  const stale = !!pos && isStale(pos.recorded_at, now);
  const liveFresh = !!distance?.live_at && !isStale(distance.live_at, now);
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={clsx(
          "flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none focus-visible:ring-inset",
          selected ? "bg-nav-active" : "hover:bg-surface-2",
        )}
      >
        <span
          className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
          style={{ background: state.color }}
          aria-hidden
        >
          {initials(tech.name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-semibold text-ink">{tech.name}</span>
            {pos ? (
              <span
                className={clsx("shrink-0 text-xs tabular-nums", stale ? "text-red-700 dark:text-red-400" : "text-ink-muted")}
                title={stale ? "Sem posição nova há mais de 5 min" : "Última posição recebida"}
              >
                {formatAgo(pos.recorded_at, now)}
              </span>
            ) : null}
          </span>
          <span
            className={clsx(
              "mt-0.5 flex items-center gap-1.5 text-xs",
              tech.state === "no_signal" ? "text-red-700 dark:text-red-400" : "text-ink-muted",
            )}
          >
            <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: state.color }} />
            {state.label}
            {pos?.is_mock ? (
              <span className="ml-1 inline-flex items-center gap-0.5 text-red-700 dark:text-red-400">
                <AlertTriangle className="size-3" /> GPS simulado
              </span>
            ) : null}
          </span>
          {tech.current_ticket ? (
            <span className="mt-0.5 block truncate text-xs text-ink-muted">
              {tech.current_ticket.code} · {tech.current_ticket.location?.name ?? tech.current_ticket.title}
            </span>
          ) : tech.team ? (
            <span className="mt-0.5 block truncate text-xs text-ink-muted">{tech.team.name}</span>
          ) : null}
          {distance && (distance.live_to_place || distance.home_to_place) ? (
            <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs tabular-nums">
              {distance.live_to_place ? (
                <span
                  className="inline-flex items-center gap-1 font-medium text-ink"
                  title="De onde ele está (em jornada) até a loja, em linha reta"
                >
                  <Navigation className="size-3 text-brand" aria-hidden />
                  {liveFresh
                    ? `agora ${formatKm(distance.live_to_place.km)}`
                    : `${formatKm(distance.live_to_place.km)} (posição ${formatAgo(distance.live_at, now)})`}
                </span>
              ) : null}
              {distance.home_to_place ? (
                <span
                  className="inline-flex items-center gap-1 text-ink-muted"
                  title={`${distance.home?.label ?? "Casa"} até a loja (linha reta)`}
                >
                  <House className="size-3" aria-hidden />
                  {distance.home?.kind === "base_city" ? "base" : "casa"} {formatKm(distance.home_to_place.km)}
                  {distance.home_to_place.approximate ? <span className="text-ink-subtle">≈</span> : null}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

/** Um trecho: linha reta, pelas ruas e tempo de carro (estimativas). */
function LegRow({ icon, label, leg }: { icon: React.ReactNode; label: string; leg: DistanceLeg | null }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="mt-px shrink-0 text-ink-muted">{icon}</span>
      <span className="w-[5.5rem] shrink-0 text-ink-muted">{label}</span>
      {leg ? (
        <span className="min-w-0 text-ink">
          <span className="font-semibold tabular-nums">{formatKm(leg.km)}</span>
          <span className="text-ink-muted">
            {" "}
            em linha reta · ~{formatKm(leg.road_km)} pelas ruas · ~{formatMinutes(leg.minutes)} de carro
          </span>
          {leg.approximate ? (
            <span className="ml-1 rounded bg-amber-50 px-1 text-[10px] font-medium text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              aprox.
            </span>
          ) : null}
        </span>
      ) : (
        <span className="text-ink-subtle">—</span>
      )}
    </div>
  );
}

function Fact({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs text-ink-muted">
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}

function TechnicianDetail({
  tech,
  now,
  today,
  day,
  onDay,
  onClose,
  trail,
  trailLoading,
  distance,
  placeName,
  agenda,
  agendaLoading,
}: {
  tech: LiveTechnician;
  now: number;
  today: string;
  day: string;
  onDay: (day: string) => void;
  onClose: () => void;
  trail: TrackingHistory | undefined;
  trailLoading: boolean;
  distance?: TechnicianDistance;
  placeName: string | null;
  /** OS de hoje do técnico (dele e as em que vai junto), em ordem de horário. */
  agenda: Activity[] | undefined;
  agendaLoading: boolean;
}) {
  const pos = shiftPosition(tech);
  const stale = !!pos && (tech.state === "no_signal" || isStale(pos.recorded_at, now));
  const battery = pos?.battery_pct;
  const speed = stale ? null : formatSpeed(pos?.speed_mps);
  const ticket = tech.current_ticket;
  const first = tech.name.trim().split(/\s+/)[0];
  const shiftStart = tech.shift_started_at;
  // Jornada aberta em outro dia: o técnico provavelmente esqueceu de encerrar no app.
  const oldShift = !!shiftStart && operationDay(shiftStart) !== today;
  const summary = trail ? trailSummary(trail.points) : null;
  const minDay = shiftDay(today, -TRAIL_RETENTION_DAYS);
  return (
    <div className="space-y-2.5 bg-surface-2/60 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-ink">{tech.name}</p>
          {tech.open_tickets ? (
            <Link
              href={`/chamados?assignee_id=${tech.id}&open_only=true`}
              className="text-xs text-ink-muted underline-offset-2 hover:text-brand hover:underline"
            >
              {tech.open_tickets} {tech.open_tickets === 1 ? "OS aberta" : "OS abertas"}
            </Link>
          ) : (
            <span className="text-xs text-ink-muted">Nenhuma OS aberta</span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="-mt-0.5 -mr-1 rounded-lg p-1.5 text-ink-subtle transition-colors hover:bg-surface-3 hover:text-ink"
          aria-label={`Fechar ${tech.name}`}
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        <Fact icon={<Clock className="size-3.5" />}>
          {shiftStart ? `Jornada desde ${oldShift ? formatShort(shiftStart) : formatTime(shiftStart)}` : "Fora da jornada"}
        </Fact>
        <Fact icon={<Navigation className="size-3.5" />}>
          {pos ? (
            <span className={stale ? "text-red-700 dark:text-red-400" : undefined}>Posição {formatAgo(pos.recorded_at, now)}</span>
          ) : tech.on_shift ? (
            "Sem posição nesta jornada"
          ) : (
            "Posição só na jornada"
          )}
        </Fact>
        {battery != null ? (
          <Fact
            icon={
              battery <= 20 ? (
                <BatteryLow className="size-3.5 text-red-600 dark:text-red-400" />
              ) : (
                <BatteryMedium className="size-3.5" />
              )
            }
          >
            Bateria {battery}%
          </Fact>
        ) : null}
        {speed ? <Fact icon={<Gauge className="size-3.5" />}>{speed}</Fact> : null}
        {pos?.accuracy_m != null ? (
          <Fact icon={<ShieldCheck className="size-3.5" />}>Precisão ±{Math.round(pos.accuracy_m)} m</Fact>
        ) : null}
      </div>
      {oldShift && shiftStart ? (
        <p className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          Jornada aberta há {formatMinutes((now - new Date(shiftStart).getTime()) / 60_000)}: o técnico pode ter esquecido de
          encerrar.
        </p>
      ) : null}

      {tech.phone ? (
        <div className="flex flex-wrap gap-2">
          <a
            href={whatsappUrl(tech.phone, `Olá, ${first}!`)}
            target="_blank"
            rel="noreferrer"
            className={buttonClassName("secondary", "sm")}
          >
            <MessageCircle className="size-3.5" />
            WhatsApp
          </a>
          <a href={`tel:${tech.phone.replace(/[^\d+]/g, "")}`} className={buttonClassName("secondary", "sm")}>
            <Phone className="size-3.5" />
            {tech.phone}
          </a>
        </div>
      ) : (
        <p className="text-xs text-ink-muted">Sem celular no cadastro (complete em Técnicos).</p>
      )}

      {ticket ? (
        <TicketLink
          ticketId={ticket.id}
          className="flex items-start gap-2 rounded-lg border border-line bg-surface p-2 text-xs hover:border-brand"
        >
          <Wrench className="mt-0.5 size-3.5 shrink-0 text-ink-muted" />
          <span className="min-w-0">
            <span className="block font-semibold text-ink">
              {ticket.code} · {STATUS[ticket.status]?.label ?? ticket.status}
            </span>
            <span className="block truncate text-ink-muted">
              {[ticket.location?.name, ticket.location?.city ?? ticket.service_address].filter(Boolean).join(" · ") ||
                ticket.title}
            </span>
          </span>
        </TicketLink>
      ) : null}

      <div className="space-y-1.5 rounded-lg border border-line bg-surface p-2.5">
        <SectionTitle>Hoje</SectionTitle>
        {agendaLoading ? (
          <p className="text-xs text-ink-muted">Carregando…</p>
        ) : agenda?.length ? (
          <ul className="flex flex-col gap-1">
            {agenda.map((a) => {
              const state = DAY_STATE[a.state];
              const when = a.scheduled_start ?? a.started_at;
              return (
                <li key={a.ticket.id}>
                  <TicketLink
                    ticketId={a.ticket.id}
                    className="flex items-baseline gap-2 rounded-md px-1 py-0.5 text-xs hover:bg-surface-2"
                    title={a.ticket.title}
                  >
                    <span className="w-10 shrink-0 font-semibold text-ink tabular-nums">{when ? formatTime(when) : "—"}</span>
                    <span className="min-w-0 flex-1 truncate text-ink">
                      {a.ticket.code} · {a.ticket.location?.name ?? a.ticket.title}
                    </span>
                    <span
                      className={clsx(
                        "shrink-0",
                        state.tone === "danger" ? "font-medium text-red-700 dark:text-red-400" : "text-ink-muted",
                      )}
                    >
                      {state.label}
                    </span>
                  </TicketLink>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-xs text-ink-muted">Nenhuma OS hoje.</p>
        )}
      </div>

      {distance ? (
        <div className="space-y-1.5 rounded-lg border border-line bg-surface p-2.5">
          <SectionTitle>{placeName ? `Distâncias até ${placeName}` : "Distâncias"}</SectionTitle>
          {placeName ? (
            <>
              {tech.on_shift ? (
                <LegRow icon={<Navigation className="size-3.5" />} label="Agora → loja" leg={distance.live_to_place} />
              ) : null}
              <LegRow
                icon={<House className="size-3.5" />}
                label={distance.home?.kind === "base_city" ? "Base → loja" : "Casa → loja"}
                leg={distance.home_to_place}
              />
            </>
          ) : null}
          {tech.on_shift ? (
            <LegRow
              icon={<Route className="size-3.5" />}
              label={distance.home?.kind === "base_city" ? "Agora → base" : "Agora → casa"}
              leg={distance.live_to_home}
            />
          ) : null}
          <p className="flex items-start gap-1.5 text-[11px] text-ink-muted">
            <House className="mt-px size-3 shrink-0" />
            {distance.home ? distance.home.label : "Sem endereço de casa no cadastro (complete em Técnicos)."}
          </p>
          {!tech.on_shift ? (
            <p className="text-[11px] text-ink-muted">Fora da jornada: a posição não aparece, só a casa.</p>
          ) : !distance.live ? (
            <p className="text-[11px] text-ink-muted">Ainda sem posição nesta jornada.</p>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-1.5">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-ink/80">
          <Route className="size-3.5" />
          Trajeto do dia
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            onClick={() => onDay(shiftDay(day, -1))}
            disabled={day <= minDay}
            aria-label="Dia anterior"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Input
            type="date"
            value={day}
            min={minDay}
            max={today}
            onChange={(e) => {
              const value = e.target.value;
              if (value && value >= minDay && value <= today) onDay(value);
            }}
            className="w-40"
            aria-label="Dia do trajeto"
          />
          <Button size="sm" onClick={() => onDay(shiftDay(day, 1))} disabled={day >= today} aria-label="Próximo dia">
            <ChevronRight className="size-4" />
          </Button>
          {day !== today ? (
            <Button size="sm" variant="ghost" onClick={() => onDay(today)}>
              <CalendarClock className="size-3.5" />
              Hoje
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-ink-muted tabular-nums" aria-live="polite">
          {trailLoading
            ? "Carregando o trajeto…"
            : summary
              ? `${formatKm(summary.km)} percorridos · ${formatTime(summary.start)}–${formatTime(summary.end)}`
              : "Sem trajeto neste dia."}
        </p>
      </div>
    </div>
  );
}
