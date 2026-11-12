"use client";

import clsx from "clsx";
import {
  AlertTriangle,
  BatteryLow,
  BatteryMedium,
  Clock,
  Gauge,
  House,
  MapPinned,
  Navigation,
  Phone,
  Route,
  Search,
  ShieldCheck,
  Store,
  Wrench,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useTheme } from "@/components/Brand";
import type { MapFocus } from "@/components/LiveMap";
import { LocationPicker } from "@/components/LocationPicker";
import { Card, EmptyState, ErrorBox, Input, LoadingBlock, PageHeader, Select } from "@/components/ui";
import { useNow } from "@/components/useNow";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets, STATUS } from "@/lib/constants";
import { formatMinutes, formatTime, initials } from "@/lib/format";
import { useLiveTechnicians, useMapDistances, useTeams, useTrackingHistory } from "@/lib/queries";
import { formatAgo, formatSpeed, LIVE_STATE, LIVE_STATE_ORDER } from "@/lib/tracking";
import type { DistanceLeg, LiveState, LiveTechnician, Location, TechnicianDistance } from "@/lib/types";

const LiveMap = dynamic(() => import("@/components/LiveMap"), {
  ssr: false,
  loading: () => <LoadingBlock label="Carregando mapa..." />,
});

// Fuso da operação (mesmo de settings.TIMEZONE na API).
const OPERATION_TZ = "America/Sao_Paulo";

function todayString(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: OPERATION_TZ }).format(new Date());
}

const rank = (state: LiveState) => LIVE_STATE_ORDER.indexOf(state);

const km = (value: number) => `${value.toLocaleString("pt-BR", { maximumFractionDigits: value < 10 ? 1 : 0 })} km`;

export default function LiveMapPage() {
  const { user } = useAuth();
  const theme = useTheme();
  const now = useNow(15_000);
  const [teamId, setTeamId] = useState("");
  const [q, setQ] = useState("");
  const [stateFilter, setStateFilter] = useState<LiveState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [day, setDay] = useState(todayString);
  // Loja do cliente: o mapa mostra a loja e mede de onde cada técnico está e de casa até ela.
  const [place, setPlace] = useState<Location | null>(null);
  const teams = useTeams();
  const live = useLiveTechnicians(teamId || null);
  const history = useTrackingHistory(selectedId, day);
  const distances = useMapDistances(place?.id ?? null, teamId || null, canManageTickets(user?.role));
  const distanceById = useMemo(
    () => new Map((distances.data?.technicians ?? []).map((d, index) => [d.id, { d, index }])),
    [distances.data],
  );

  const technicians = useMemo(() => {
    const list = [...(live.data ?? [])];
    // Com loja escolhida: do mais perto para o mais longe (agora, ou de casa).
    if (place && distances.data) {
      const at = (id: string) => distanceById.get(id)?.index ?? Number.MAX_SAFE_INTEGER;
      return list.sort((a, b) => at(a.id) - at(b.id));
    }
    return list.sort((a, b) => rank(a.state) - rank(b.state) || a.name.localeCompare(b.name));
  }, [live.data, place, distances.data, distanceById]);
  const counts = useMemo(() => {
    const c = Object.fromEntries(LIVE_STATE_ORDER.map((s) => [s, 0])) as Record<LiveState, number>;
    technicians.forEach((t) => (c[t.state] += 1));
    return c;
  }, [technicians]);
  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    return technicians.filter(
      (t) =>
        (!stateFilter || t.state === stateFilter) &&
        (!term || t.name.toLowerCase().includes(term) || t.current_ticket?.code.toLowerCase().includes(term)),
    );
  }, [technicians, q, stateFilter]);
  const selected = technicians.find((t) => t.id === selectedId) ?? null;
  const selectedDistance = selectedId ? distanceById.get(selectedId)?.d : undefined;
  const placePoint = place ? (distances.data?.place ?? null) : null;
  const selectedPos = selected?.last_position;
  const focus = useMemo<MapFocus | null>(() => {
    if (!placePoint && !selectedDistance) return null;
    return {
      place: placePoint,
      home: selectedDistance?.home ?? null,
      // A posição do mapa ao vivo é a mais recente; a do cálculo de distância, a reserva.
      live: selectedPos ? { latitude: selectedPos.latitude, longitude: selectedPos.longitude } : (selectedDistance?.live ?? null),
      name: selectedDistance?.name,
    };
  }, [placePoint, selectedDistance, selectedPos]);

  if (user && !canManageTickets(user.role)) {
    return <ErrorBox message="O mapa ao vivo é exclusivo para analistas e gestores." />;
  }

  return (
    <div>
      <PageHeader
        title="Mapa ao vivo"
        description="Onde cada técnico está agora, o status de deslocamento e a OS em campo."
        actions={
          <Select value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label="Grupo" className="w-48">
            <option value="">Todos os grupos</option>
            {(teams.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filtrar por estado">
        {LIVE_STATE_ORDER.map((s) => {
          const active = stateFilter === s;
          return (
            <button
              key={s}
              type="button"
              aria-pressed={active}
              title={LIVE_STATE[s].hint}
              onClick={() => setStateFilter(active ? null : s)}
              className={clsx(
                "inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors",
                active ? "border-brand bg-nav-active text-ink" : "border-line bg-surface text-ink-muted hover:text-ink",
              )}
            >
              <span className="size-2.5 rounded-full" style={{ background: LIVE_STATE[s].color }} />
              {LIVE_STATE[s].label}
              <span className="font-semibold text-ink tabular-nums">{counts[s]}</span>
            </button>
          );
        })}
      </div>

      {live.error ? <ErrorBox message={errorMessage(live.error)} /> : null}

      <div className="grid gap-4 lg:h-[calc(100vh-15.5rem)] lg:min-h-[480px] lg:grid-cols-[360px_1fr]">
        <Card className="order-2 flex max-h-[70vh] min-h-0 flex-col lg:order-1 lg:max-h-none">
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
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-ink-subtle">
                <Store className="size-3.5" />
                Loja do cliente
              </p>
              <LocationPicker customerId={null} value={place} onChange={setPlace} />
              {place ? (
                <p className="mt-1.5 text-[11px] text-ink-muted">
                  {distances.data?.place?.approximate
                    ? "A loja não tem coordenada: medindo pelo centro da cidade. "
                    : ""}
                  Técnicos do mais perto para o mais longe: de onde estão agora ou, sem posição recente, de casa.
                </p>
              ) : null}
              {distances.error && place ? <ErrorBox message={errorMessage(distances.error)} /> : null}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {live.isLoading ? (
              <LoadingBlock />
            ) : visible.length === 0 ? (
              <EmptyState
                icon={<MapPinned className="size-6" />}
                title={technicians.length === 0 ? "Nenhum técnico cadastrado" : "Nenhum técnico neste filtro"}
                description={
                  technicians.length === 0
                    ? "Cadastre técnicos ou aprove fichas na homologação para vê-los aqui."
                    : undefined
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
                    onSelect={() => setSelectedId(t.id === selectedId ? null : t.id)}
                    distance={place ? distanceById.get(t.id)?.d : undefined}
                  />
                ))}
              </ul>
            )}
          </div>
          {selected ? (
            <TechnicianDetail
              tech={selected}
              now={now}
              day={day}
              onDay={setDay}
              trailPoints={history.data?.points.length ?? null}
              trailLoading={history.isFetching && !history.data}
              distance={selectedDistance}
              placeName={place?.name ?? null}
            />
          ) : null}
        </Card>

        <Card className="order-1 h-[55vh] min-h-[360px] overflow-hidden lg:order-2 lg:h-full">
          <LiveMap
            technicians={visible}
            selectedId={selectedId}
            onSelect={setSelectedId}
            history={selectedId ? (history.data ?? null) : null}
            theme={theme}
            focus={focus}
            focusKey={`${place?.id ?? ""}|${selectedId ?? ""}`}
          />
        </Card>
      </div>
    </div>
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
  /** Com loja escolhida: de onde ele está e de casa até a loja. */
  distance?: TechnicianDistance;
}) {
  const state = LIVE_STATE[tech.state];
  const pos = tech.last_position;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={clsx(
          "flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors",
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
            <span className="truncate text-sm font-medium text-ink">{tech.name}</span>
            {pos ? (
              <span className="shrink-0 text-xs text-ink-muted tabular-nums">{formatAgo(pos.recorded_at, now)}</span>
            ) : null}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-xs" style={{ color: state.color }}>
            <span className="size-1.5 rounded-full" style={{ background: state.color }} />
            {state.label}
            {pos?.is_mock ? (
              <span className="ml-1 inline-flex items-center gap-0.5 text-red-600 dark:text-red-400">
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
                <span className="inline-flex items-center gap-1 font-medium text-ink" title="De onde ele está agora até a loja (linha reta)">
                  <Navigation className="size-3 text-brand" />
                  agora {km(distance.live_to_place.km)}
                </span>
              ) : null}
              {distance.home_to_place ? (
                <span
                  className="inline-flex items-center gap-1 text-ink-muted"
                  title={`${distance.home?.label ?? "Casa"} até a loja (linha reta)`}
                >
                  <House className="size-3" />
                  {distance.home?.kind === "base_city" ? "base" : "casa"} {km(distance.home_to_place.km)}
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
          <span className="font-semibold tabular-nums">{km(leg.km)}</span>
          <span className="text-ink-muted">
            {" "}
            em linha reta · ~{km(leg.road_km)} pelas ruas · ~{formatMinutes(leg.minutes)} de carro
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
  day,
  onDay,
  trailPoints,
  trailLoading,
  distance,
  placeName,
}: {
  tech: LiveTechnician;
  now: number;
  day: string;
  onDay: (day: string) => void;
  trailPoints: number | null;
  trailLoading: boolean;
  distance?: TechnicianDistance;
  placeName: string | null;
}) {
  const pos = tech.last_position;
  const battery = pos?.battery_pct;
  const speed = formatSpeed(pos?.speed_mps);
  const ticket = tech.current_ticket;
  return (
    <div className="space-y-2 border-t border-line bg-surface-2/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm font-semibold text-ink">{tech.name}</p>
        <span className="text-xs text-ink-muted">{tech.open_tickets} OS abertas</span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        <Fact icon={<Clock className="size-3.5" />}>
          {tech.shift_started_at ? `Jornada desde ${formatTime(tech.shift_started_at)}` : "Fora da jornada"}
        </Fact>
        <Fact icon={<Navigation className="size-3.5" />}>
          {pos ? `Posição ${formatAgo(pos.recorded_at, now)}` : "Sem posição"}
        </Fact>
        {battery != null ? (
          <Fact icon={battery <= 20 ? <BatteryLow className="size-3.5 text-red-500" /> : <BatteryMedium className="size-3.5" />}>
            Bateria {battery}%
          </Fact>
        ) : null}
        {speed ? <Fact icon={<Gauge className="size-3.5" />}>{speed}</Fact> : null}
        {pos?.accuracy_m != null ? (
          <Fact icon={<ShieldCheck className="size-3.5" />}>Precisão ±{Math.round(pos.accuracy_m)} m</Fact>
        ) : null}
        {tech.phone ? (
          <Fact icon={<Phone className="size-3.5" />}>
            <a href={`tel:${tech.phone}`} className="hover:text-brand">
              {tech.phone}
            </a>
          </Fact>
        ) : null}
      </div>
      {ticket ? (
        <Link
          href={`/chamados/${ticket.id}`}
          className="flex items-start gap-2 rounded-lg border border-line bg-surface p-2 text-xs hover:border-brand"
        >
          <Wrench className="mt-0.5 size-3.5 shrink-0 text-ink-muted" />
          <span className="min-w-0">
            <span className="block font-medium text-ink">
              {ticket.code} · {STATUS[ticket.status]?.label ?? ticket.status}
            </span>
            <span className="block truncate text-ink-muted">
              {[ticket.location?.name, ticket.location?.city ?? ticket.service_address].filter(Boolean).join(" · ") ||
                ticket.title}
            </span>
          </span>
        </Link>
      ) : null}
      {distance ? (
        <div className="space-y-1.5 rounded-lg border border-line bg-surface p-2.5">
          <p className="truncate text-xs font-medium text-ink">
            {placeName ? `Distâncias até ${placeName}` : "Distâncias"}
          </p>
          {placeName ? (
            <>
              <LegRow icon={<Navigation className="size-3.5" />} label="Agora → loja" leg={distance.live_to_place} />
              <LegRow
                icon={<House className="size-3.5" />}
                label={distance.home?.kind === "base_city" ? "Base → loja" : "Casa → loja"}
                leg={distance.home_to_place}
              />
            </>
          ) : null}
          <LegRow
            icon={<Route className="size-3.5" />}
            label={distance.home?.kind === "base_city" ? "Agora → base" : "Agora → casa"}
            leg={distance.live_to_home}
          />
          <p className="flex items-start gap-1.5 text-[11px] text-ink-subtle">
            <House className="mt-px size-3 shrink-0" />
            {distance.home ? distance.home.label : "Sem endereço de casa no cadastro (complete em Técnicos)."}
          </p>
          {!distance.live ? <p className="text-[11px] text-ink-subtle">Sem posição do app nas últimas 24 h.</p> : null}
        </div>
      ) : null}
      <label className="flex items-center gap-2 text-xs text-ink-muted">
        <Route className="size-3.5 shrink-0" />
        Trajeto de
        <input
          type="date"
          value={day}
          max={todayString()}
          onChange={(e) => e.target.value && onDay(e.target.value)}
          className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink"
        />
        <span className="ml-auto tabular-nums">
          {trailLoading ? "…" : trailPoints != null ? `${trailPoints} pontos` : ""}
        </span>
      </label>
    </div>
  );
}
