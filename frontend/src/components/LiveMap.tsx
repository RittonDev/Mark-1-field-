"use client";

import "leaflet/dist/leaflet.css";
import clsx from "clsx";
import type { Circle, DivIcon, LatLngTuple, LayerGroup, Map as LeafletMap, Marker, Polyline } from "leaflet";
import { ChevronDown, Ruler, Scan, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Theme } from "@/components/Brand";
import { TicketLink } from "@/components/ticket/TicketLink";
import { Button, buttonClassName, restoreFocus } from "@/components/ui";
import { STATUS } from "@/lib/constants";
import { formatTime, initials } from "@/lib/format";
import { DAY_STATE, formatAgo, isStale, isValidCoords, LIVE_STATE, shiftPosition } from "@/lib/tracking";
import type { Activity, LiveTechnician, LiveTicket, TrackingHistory } from "@/lib/types";

type Leaflet = typeof import("leaflet");

/** O que comparar no mapa: a loja do filtro, a casa e a posição de agora do técnico escolhido. */
export interface MapFocus {
  place: { latitude: number; longitude: number; label: string; approximate: boolean } | null;
  home: { latitude: number; longitude: number; label: string } | null;
  live: { latitude: number; longitude: number } | null;
  name?: string;
}

/** Loja (local de atendimento) escolhida no mapa para medir a distância dos técnicos até ela. */
export interface MapPlace {
  id: string;
  name: string;
}

// Ícones (Lucide "store" e "house"), em HTML porque o marcador do Leaflet é HTML.
const STORE_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v11h16V9"/><path d="M9 20v-6h6v6"/></svg>';
const HOME_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/></svg>';
const HOME_COLOR = "#64748b";
const LATE_COLOR = "#dc2626";

interface Ready {
  L: Leaflet;
  map: LeafletMap;
  layers: { trail: LayerGroup; routes: LayerGroup; os: LayerGroup; techs: LayerGroup; focus: LayerGroup };
  /** Vira false na hora em que o mapa é desmontado. O estado `ready` só muda no próximo render,
   *  e nesse meio-tempo nenhum efeito pode desenhar no mapa removido (o Leaflet quebra). */
  alive: { current: boolean };
}

const usable = (ready: Ready | null): ready is Ready => ready !== null && ready.alive.current;

/*
 * Marcadores desenhados, por id: a cada posição nova (várias por minuto com a equipe em campo) o mapa só
 * move o pino e troca o ícone quando a aparência muda. Recriar tudo apagava o tooltip sob o mouse e
 * tirava o foco de quem navega pelo teclado.
 */
interface TechPin {
  marker: Marker;
  /** Aparência do ícone (cor, seleção, iniciais, direção, posição antiga). */
  look: string;
  tip: string;
  aria: string;
}
interface DestPin {
  marker: Marker;
  line: Polyline | null;
  look: string;
  tip: string;
  ticketId: string;
}
interface OsPin {
  marker: Marker;
  look: string;
  tip: string;
}

/** A OS escolhida no mapa (pino da OS do dia ou destino de um técnico em campo), para o cartão de ações. */
interface PickedTicket {
  id: string;
  code: string;
  state: string;
  late: boolean;
  time: string | null;
  place: string;
  who: string;
  location: MapPlace | null;
}

function describeActivity(activity: Activity): PickedTicket {
  const { ticket } = activity;
  const loc = ticket.location;
  const helpers = ticket.helpers?.length ?? 0;
  return {
    id: ticket.id,
    code: ticket.code,
    state: DAY_STATE[activity.state].label,
    late: activity.state === "late",
    time: activity.scheduled_start ? formatTime(activity.scheduled_start) : null,
    place: [loc?.name, loc?.city].filter(Boolean).join(" · ") || ticket.title,
    who: ticket.assignee ? `${ticket.assignee.name}${helpers ? ` + ${helpers}` : ""}` : "Sem técnico",
    location: loc ? { id: loc.id, name: loc.name } : null,
  };
}

function describeFieldTicket(tech: LiveTechnician, ticket: LiveTicket): PickedTicket {
  return {
    id: ticket.id,
    code: ticket.code,
    state: STATUS[ticket.status]?.label ?? ticket.status,
    late: false,
    time: null,
    place:
      [ticket.location?.name, ticket.location?.city ?? ticket.service_address].filter(Boolean).join(" · ") || ticket.title,
    who: tech.name,
    location: null,
  };
}

/** A OS do dia tem mais dados (horário, loja com id); sem ela, a OS em campo do técnico. */
function findTicket(id: string, activities: Activity[], technicians: LiveTechnician[]): PickedTicket | null {
  const activity = activities.find((a) => a.ticket.id === id);
  if (activity) return describeActivity(activity);
  const tech = technicians.find((t) => t.current_ticket?.id === id);
  return tech?.current_ticket ? describeFieldTicket(tech, tech.current_ticket) : null;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Leva o mapa até os pontos: um ponto centraliza; vários enquadram. Movimento curto (ou nenhum). */
function moveCamera(ready: Ready, points: LatLngTuple[], zoom: number) {
  const { L, map } = ready;
  const animate = !prefersReducedMotion();
  if (points.length === 1) map.setView(points[0], Math.max(map.getZoom(), zoom), { animate, duration: 0.3 });
  else map.fitBounds(L.latLngBounds(points), { padding: [56, 56], maxZoom: zoom + 1, animate, duration: 0.3 });
}

/** Clique, toque, Enter ou espaço no marcador (o Leaflet não transforma o Enter em clique). */
function onActivate(marker: Marker, action: () => void) {
  marker.on("click", action);
  marker.on("keydown", (e) => {
    const key = e.originalEvent.key;
    if (key !== "Enter" && key !== " ") return;
    e.originalEvent.preventDefault();
    action();
  });
}

function techIcon(
  L: Leaflet,
  opts: { color: string; selected: boolean; name: string; heading: number | null; stale: boolean; moving: boolean },
): DivIcon {
  const style = `--c:${opts.color}${opts.stale ? ";opacity:.7;border-style:dashed" : ""}`;
  // A caminho do cliente: anel fixo em volta do pino (nada pisca; o mapa fica aberto o dia todo).
  const classes = ["mf-pin", opts.selected ? "is-selected" : "", opts.moving ? "is-moving" : ""].filter(Boolean).join(" ");
  const html =
    `<div class="${classes}" style="${style}">` +
    (opts.heading != null ? `<i class="mf-heading" style="transform:rotate(${opts.heading}deg)"></i>` : "") +
    `<span aria-hidden="true">${escapeHtml(initials(opts.name))}</span></div>`;
  return L.divIcon({ className: "", html, iconSize: [34, 34] });
}

function destIcon(L: Leaflet, color: string): DivIcon {
  return L.divIcon({ className: "", html: `<div class="mf-dest" style="--c:${color}"></div>`, iconSize: [14, 14] });
}

/** Pino da OS do dia: quadrado neutro; marca quando está em campo; vermelho só no atraso; tracejado sem técnico. */
function osIcon(L: Leaflet, opts: { tone: "neutral" | "brand" | "danger"; assigned: boolean; done: boolean; picked: boolean }): DivIcon {
  const color = opts.tone === "danger" ? LATE_COLOR : opts.tone === "brand" ? "var(--brand)" : "var(--ink-subtle)";
  const square = [
    "width:14px",
    "height:14px",
    "border-radius:4px",
    `background:${opts.assigned ? color : "var(--surface)"}`,
    `border:2px ${opts.assigned ? "solid var(--surface)" : `dashed ${color}`}`,
    "box-shadow:0 1px 4px rgb(16 24 40 / .35)",
    opts.done ? "opacity:.6" : "",
    opts.picked ? `outline:3px solid color-mix(in srgb, ${color} 45%, transparent);outline-offset:1px` : "",
  ]
    .filter(Boolean)
    .join(";");
  // Área de toque maior que o desenho (24 px), para acertar no celular.
  return L.divIcon({
    className: "",
    html: `<div style="display:flex;width:24px;height:24px;align-items:center;justify-content:center"><div style="${square}"></div></div>`,
    iconSize: [24, 24],
  });
}

// Mapa base. Padrão: OpenStreetMap (sem chave; uso moderado). Em produção, configure um
// provedor contratado (MapTiler, Stadia, Mapbox...) em NEXT_PUBLIC_MAP_TILES_URL. Sem uma
// versão escura própria (NEXT_PUBLIC_MAP_TILES_DARK_URL), o tema escuro aplica um filtro.
const OSM_TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILES_LIGHT = process.env.NEXT_PUBLIC_MAP_TILES_URL || OSM_TILES;
const TILES_DARK = process.env.NEXT_PUBLIC_MAP_TILES_DARK_URL || "";
const ATTRIBUTION =
  process.env.NEXT_PUBLIC_MAP_ATTRIBUTION ||
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const TRAIL_COLOR: Record<Theme, string> = { light: "#2447ff", dark: "#7f95ff" };
const DEFAULT_CENTER: LatLngTuple = [-23.55, -46.63]; // São Paulo, até chegar a primeira posição

/** Texto puro para tooltips: nomes vêm do cadastro e não podem virar HTML. */
function textNode(...lines: string[]): HTMLElement {
  const el = document.createElement("div");
  lines.forEach((line, i) => {
    const row = document.createElement("div");
    row.textContent = line;
    if (i === 0) row.style.fontWeight = "700";
    el.appendChild(row);
  });
  return el;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const NO_ACTIVITIES: Activity[] = [];

export default function LiveMap({
  technicians,
  selectedId,
  onSelect,
  history,
  theme,
  now,
  today,
  activities = NO_ACTIVITIES,
  onMeasure,
  focus = null,
  focusKey = null,
  focusPending = false,
  fitKey = "",
  fitPending = false,
  notice = null,
}: {
  technicians: LiveTechnician[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  history: TrackingHistory | null;
  theme: Theme;
  /** Relógio da tela: a posição sem atualização há mais de 5 min aparece como antiga. */
  now: number;
  /** Dia de hoje (AAAA-MM-DD, no fuso da operação). */
  today: string;
  /** OS do dia (pinos quadrados); as que já são destino de um técnico em campo não se repetem. */
  activities?: Activity[];
  /** "Medir técnicos até esta loja", a partir de uma OS do dia. */
  onMeasure?: (place: MapPlace) => void;
  /** Loja do filtro, casa e posição do técnico escolhido (com as linhas entre eles). */
  focus?: MapFocus | null;
  /** Muda quando a escolha muda (loja ou técnico): só então o mapa reenquadra. */
  focusKey?: string | null;
  /** Dados do foco ainda chegando: a câmera espera para se mexer uma vez só. */
  focusPending?: boolean;
  /** Muda com o grupo: o mapa enquadra de novo os técnicos e as OS. */
  fitKey?: string;
  /** Técnicos ou OS ainda chegando: o enquadramento espera para incluir todos de uma vez. */
  fitPending?: boolean;
  /** Aviso sobre o mapa (ex.: ninguém em jornada). */
  notice?: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState<Ready | null>(null);
  // OS escolhida no mapa (cartão com "Abrir OS" e "Medir técnicos até esta loja").
  const [picked, setPicked] = useState<string | null>(null);
  const onSelectRef = useRef(onSelect);
  const techPins = useRef(new Map<string, TechPin>());
  const destPins = useRef(new Map<string, DestPin>());
  const osPins = useRef(new Map<string, OsPin>());
  const extrasRef = useRef<{ accuracy: Circle | null }>({ accuracy: null });
  const openerRef = useRef<Element | null>(null);
  const fitRef = useRef<string | null>(null);
  const cameraRef = useRef<string | null>(null);
  const trailKeyRef = useRef<string | null>(null);

  useEffect(() => {
    onSelectRef.current = onSelect;
  });

  // Cria o mapa uma vez (Leaflet só existe no navegador).
  useEffect(() => {
    let cancelled = false;
    let map: LeafletMap | null = null;
    const alive = { current: true };
    const registries = [techPins.current, destPins.current, osPins.current];
    const extras = extrasRef.current;
    import("leaflet").then((mod) => {
      const L = ((mod as unknown as { default?: Leaflet }).default ?? mod) as Leaflet;
      if (cancelled || !containerRef.current) return;
      map = L.map(containerRef.current, { zoomControl: false }).setView(DEFAULT_CENTER, 11);
      L.control.zoom({ position: "bottomright" }).addTo(map);
      // Clique no mapa (fora dos pinos) fecha o cartão da OS.
      map.on("click", () => setPicked(null));
      setReady({
        L,
        map,
        layers: {
          trail: L.layerGroup().addTo(map),
          routes: L.layerGroup().addTo(map),
          os: L.layerGroup().addTo(map),
          focus: L.layerGroup().addTo(map),
          techs: L.layerGroup().addTo(map),
        },
        alive,
      });
    });
    return () => {
      cancelled = true;
      alive.current = false;
      map?.remove();
      registries.forEach((registry) => registry.clear());
      extras.accuracy = null;
    };
  }, []);

  useEffect(() => {
    if (!usable(ready)) return;
    const dark = theme === "dark";
    const tiles = ready.L.tileLayer(dark && TILES_DARK ? TILES_DARK : TILES_LIGHT, {
      attribution: ATTRIBUTION,
      maxZoom: 19,
      className: dark && !TILES_DARK ? "mf-tiles-dim" : "",
    });
    tiles.addTo(ready.map).bringToBack();
    return () => {
      tiles.remove();
    };
  }, [ready, theme]);

  // Técnicos (só a posição da jornada aberta), destino da OS em campo e a linha até ele enquanto está a caminho.
  useEffect(() => {
    if (!usable(ready)) return;
    const { L, layers } = ready;
    const pins = techPins.current;
    const dests = destPins.current;
    const extras = extrasRef.current;
    const seenPins = new Set<string>();
    const seenDests = new Set<string>();
    let accuracy: { at: LatLngTuple; radius: number; color: string } | null = null;

    for (const tech of technicians) {
      const pos = shiftPosition(tech);
      const { color, label } = LIVE_STATE[tech.state];
      const selected = tech.id === selectedId;
      const ticket = tech.current_ticket;
      const dest = ticket?.location;

      if (ticket && dest && isValidCoords(dest.latitude, dest.longitude)) {
        const target: LatLngTuple = [dest.latitude as number, dest.longitude as number];
        const tip = [`${ticket.code} · ${dest.name}`, `Destino de ${tech.name}`];
        seenDests.add(tech.id);
        let route = dests.get(tech.id);
        if (route && route.ticketId !== ticket.id) {
          route.marker.remove();
          route.line?.remove();
          route = undefined;
        }
        if (!route) {
          const ticketId = ticket.id;
          const marker = L.marker(target, { icon: destIcon(L, color), zIndexOffset: -50, riseOnHover: true })
            .bindTooltip(textNode(...tip), { direction: "top" })
            .addTo(layers.routes);
          onActivate(marker, () => {
            openerRef.current = marker.getElement() ?? null;
            setPicked(ticketId);
          });
          route = { marker, line: null, look: color, tip: tip.join("\n"), ticketId };
          dests.set(tech.id, route);
        } else {
          route.marker.setLatLng(target);
          if (route.look !== color) {
            route.marker.setIcon(destIcon(L, color));
            route.look = color;
          }
          if (route.tip !== tip.join("\n")) {
            route.marker.setTooltipContent(textNode(...tip));
            route.tip = tip.join("\n");
          }
        }
        route.marker.getElement()?.setAttribute("aria-label", `${ticket.code}: destino de ${tech.name}, ${dest.name}`);
        if (pos && (tech.state === "en_route" || selected)) {
          const path: LatLngTuple[] = [[pos.latitude, pos.longitude], target];
          if (route.line) route.line.setLatLngs(path).setStyle({ color });
          else {
            route.line = L.polyline(path, { color, weight: 2, dashArray: "6 6", opacity: 0.85, interactive: false }).addTo(
              layers.routes,
            );
          }
        } else if (route.line) {
          route.line.remove();
          route.line = null;
        }
      }

      if (!pos) continue;
      seenPins.add(tech.id);
      const at: LatLngTuple = [pos.latitude, pos.longitude];
      const stale = tech.state === "no_signal" || isStale(pos.recorded_at, now);
      const heading = !stale && pos.heading != null && (pos.speed_mps ?? 0) > 1 ? Math.round(pos.heading / 15) * 15 : null;
      const moving = !stale && tech.state === "en_route";
      const look = [color, selected, initials(tech.name), heading ?? "-", stale, moving].join("|");
      const precision = pos.accuracy_m != null ? ` · ±${Math.round(pos.accuracy_m)} m` : "";
      const lines = [tech.name, ticket ? `${label} · ${ticket.code}` : label];
      if (stale) lines.push(`Última posição ${formatAgo(pos.recorded_at, now)}${precision}`);
      const aria = `${tech.name}: ${label}${ticket ? `, ${ticket.code}` : ""}${
        stale ? `, última posição ${formatAgo(pos.recorded_at, now)}` : ""
      }`;
      let entry = pins.get(tech.id);
      if (!entry) {
        const id = tech.id;
        const marker = L.marker(at, {
          icon: techIcon(L, { color, selected, name: tech.name, heading, stale, moving }),
          zIndexOffset: selected ? 1000 : 0,
          riseOnHover: true,
        })
          .bindTooltip(textNode(...lines), { direction: "top", offset: [0, -18] })
          .addTo(layers.techs);
        onActivate(marker, () => onSelectRef.current(id));
        entry = { marker, look, tip: lines.join("\n"), aria: "" };
        pins.set(tech.id, entry);
      } else {
        entry.marker.setLatLng(at);
        if (entry.look !== look) {
          entry.marker.setIcon(techIcon(L, { color, selected, name: tech.name, heading, stale, moving }));
          entry.look = look;
        }
        entry.marker.setZIndexOffset(selected ? 1000 : 0);
        if (entry.tip !== lines.join("\n")) {
          entry.marker.setTooltipContent(textNode(...lines));
          entry.tip = lines.join("\n");
        }
      }
      if (entry.aria !== aria) {
        entry.marker.getElement()?.setAttribute("aria-label", aria);
        entry.aria = aria;
      }
      // Precisão ruim (posição pela rede, não pelo GPS): o círculo mostra onde ele pode estar.
      if (selected && pos.accuracy_m != null && pos.accuracy_m > 50) {
        accuracy = { at, radius: pos.accuracy_m, color };
      }
    }

    for (const [id, entry] of pins) {
      if (seenPins.has(id)) continue;
      entry.marker.remove();
      pins.delete(id);
    }
    for (const [id, entry] of dests) {
      if (seenDests.has(id)) continue;
      entry.marker.remove();
      entry.line?.remove();
      dests.delete(id);
    }
    if (accuracy) {
      if (extras.accuracy) {
        extras.accuracy.setLatLng(accuracy.at).setRadius(accuracy.radius).setStyle({ color: accuracy.color, fillColor: accuracy.color });
      } else {
        extras.accuracy = L.circle(accuracy.at, {
          radius: accuracy.radius,
          color: accuracy.color,
          weight: 1,
          fillColor: accuracy.color,
          fillOpacity: 0.08,
          interactive: false,
        }).addTo(layers.routes);
      }
    } else if (extras.accuracy) {
      extras.accuracy.remove();
      extras.accuracy = null;
    }
  }, [ready, technicians, selectedId, now]);

  // OS do dia (quadrados). A que já é destino de um técnico em campo aparece só como o losango dele.
  useEffect(() => {
    if (!usable(ready)) return;
    const { L, layers } = ready;
    const pins = osPins.current;
    const seen = new Set<string>();
    const inField = new Set(technicians.flatMap((t) => (t.current_ticket ? [t.current_ticket.id] : [])));
    for (const activity of activities) {
      const { ticket } = activity;
      const loc = ticket.location;
      if (!loc || !isValidCoords(loc.latitude, loc.longitude) || inField.has(ticket.id)) continue;
      seen.add(ticket.id);
      const at: LatLngTuple = [loc.latitude as number, loc.longitude as number];
      const info = describeActivity(activity);
      const opts = {
        tone: DAY_STATE[activity.state].tone,
        assigned: !!ticket.assignee,
        done: activity.state === "done",
        picked: picked === ticket.id,
      };
      const look = [opts.tone, opts.assigned, opts.done, opts.picked].join("|");
      const lines = [`${info.code} · ${info.state}${info.time ? ` · ${info.time}` : ""}`, `${info.place} · ${info.who}`];
      let entry = pins.get(ticket.id);
      if (!entry) {
        const ticketId = ticket.id;
        const marker = L.marker(at, { icon: osIcon(L, opts), zIndexOffset: -100, riseOnHover: true })
          .bindTooltip(textNode(...lines), { direction: "top", offset: [0, -8] })
          .addTo(layers.os);
        onActivate(marker, () => {
          openerRef.current = marker.getElement() ?? null;
          setPicked(ticketId);
        });
        entry = { marker, look, tip: lines.join("\n") };
        pins.set(ticket.id, entry);
      } else {
        entry.marker.setLatLng(at);
        if (entry.look !== look) {
          entry.marker.setIcon(osIcon(L, opts));
          entry.look = look;
        }
        if (entry.tip !== lines.join("\n")) {
          entry.marker.setTooltipContent(textNode(...lines));
          entry.tip = lines.join("\n");
        }
      }
      entry.marker
        .getElement()
        ?.setAttribute(
          "aria-label",
          `${info.code}: ${info.state}${info.time ? `, ${info.time}` : ""}, ${info.place}, ${info.who}`,
        );
    }
    for (const [id, entry] of pins) {
      if (seen.has(id)) continue;
      entry.marker.remove();
      pins.delete(id);
    }
  }, [ready, activities, technicians, picked]);

  // Enquadra técnicos e OS na primeira carga e a cada troca de grupo (não a cada posição nova).
  useEffect(() => {
    if (!usable(ready) || fitPending || fitRef.current === fitKey) return;
    const points = pinPoints(techPins.current, osPins.current);
    if (points.length === 0) return;
    fitRef.current = fitKey;
    moveCamera(ready, points, 13);
  }, [ready, fitKey, fitPending, technicians, activities]);

  // Ao escolher técnico ou loja, a câmera se mexe uma vez só, quando os dados do foco chegam.
  useEffect(() => {
    if (!focusKey) {
      cameraRef.current = null;
      return;
    }
    if (!usable(ready) || cameraRef.current === focusKey || focusPending) return;
    const points: LatLngTuple[] = [];
    if (focus?.place) points.push([focus.place.latitude, focus.place.longitude]);
    if (focus?.home) points.push([focus.home.latitude, focus.home.longitude]);
    if (focus?.live) points.push([focus.live.latitude, focus.live.longitude]);
    // Sem posição agora: o trajeto de hoje mostra por onde ele passou.
    if (!focus?.live && history && history.user_id === selectedId) {
      history.points.forEach((p) => points.push([p.latitude, p.longitude]));
    }
    if (points.length === 0) return;
    cameraRef.current = focusKey;
    moveCamera(ready, points, 14);
  }, [ready, focus, focusKey, focusPending, history, selectedId]);

  // Trajeto do dia do técnico escolhido, com os pontos em que ele mudou o status da OS.
  useEffect(() => {
    if (!usable(ready)) return;
    const { L, layers } = ready;
    layers.trail.clearLayers();
    if (!history) {
      // Sem técnico escolhido: ao escolher de novo, quem enquadra é a câmera do foco (não o trajeto).
      trailKeyRef.current = null;
      return;
    }
    const color = TRAIL_COLOR[theme];
    const line = history.points.map((p) => [p.latitude, p.longitude] as LatLngTuple);
    if (line.length > 1) {
      L.polyline(line, { color, weight: 4, opacity: 0.55, lineJoin: "round", interactive: false }).addTo(layers.trail);
    }
    if (line.length > 0) {
      L.circleMarker(line[0], { radius: 5, color, weight: 2, fillColor: "#fff", fillOpacity: 1 })
        .bindTooltip(textNode("Início do trajeto", formatTime(history.points[0].recorded_at)))
        .addTo(layers.trail);
    }
    if (line.length > 1) {
      const last = history.points[history.points.length - 1];
      L.circleMarker(line[line.length - 1], { radius: 5, color, weight: 3, fillColor: color, fillOpacity: 1 })
        .bindTooltip(textNode(history.date === today ? "Último ponto do trajeto" : "Fim do trajeto", formatTime(last.recorded_at)))
        .addTo(layers.trail);
    }
    for (const ev of history.status_events) {
      if (ev.latitude == null || ev.longitude == null) continue;
      L.circleMarker([ev.latitude, ev.longitude], { radius: 6, color: "#fff", weight: 2, fillColor: color, fillOpacity: 1 })
        .bindTooltip(textNode(`${ev.ticket_code} → ${STATUS[ev.to_status]?.label ?? ev.to_status}`, formatTime(ev.at)))
        .addTo(layers.trail);
    }
    // Outro dia do mesmo técnico: o mapa vai até o trajeto daquele dia (ao escolher o técnico, quem
    // enquadra é a câmera do foco).
    const key = `${history.user_id}|${history.date}`;
    const previous = trailKeyRef.current;
    trailKeyRef.current = key;
    if (previous && previous !== key && previous.startsWith(`${history.user_id}|`) && line.length) moveCamera(ready, line, 14);
  }, [ready, history, theme, today]);

  // Loja do filtro, casa do técnico escolhido e as linhas: de onde ele está e de casa até a loja
  // (sem loja: de onde ele está até a casa).
  useEffect(() => {
    if (!usable(ready)) return;
    const { L, layers } = ready;
    layers.focus.clearLayers();
    if (!focus) return;
    const { place, home, live } = focus;
    if (place) {
      L.marker([place.latitude, place.longitude], {
        icon: L.divIcon({ className: "", html: `<div class="mf-place">${STORE_SVG}</div>`, iconSize: [30, 30] }),
        keyboard: false,
        zIndexOffset: 500,
      })
        .bindTooltip(
          textNode(place.label, place.approximate ? "Centro da cidade (a loja não tem coordenada)" : "Loja escolhida"),
          { direction: "top", offset: [0, -14] },
        )
        .addTo(layers.focus);
    }
    if (home) {
      L.marker([home.latitude, home.longitude], {
        icon: L.divIcon({ className: "", html: `<div class="mf-home">${HOME_SVG}</div>`, iconSize: [30, 30] }),
        keyboard: false,
      })
        .bindTooltip(textNode(focus.name ? `Casa de ${focus.name}` : "Casa", home.label), { direction: "top", offset: [0, -14] })
        .addTo(layers.focus);
    }
    const line = (a: LatLngTuple, b: LatLngTuple, color: string, dashArray: string) =>
      L.polyline([a, b], { color, weight: 3, opacity: 0.85, dashArray, interactive: false }).addTo(layers.focus);
    if (place && live) line([live.latitude, live.longitude], [place.latitude, place.longitude], TRAIL_COLOR[theme], "8 6");
    if (place && home) line([home.latitude, home.longitude], [place.latitude, place.longitude], HOME_COLOR, "2 7");
    if (!place && live && home) line([live.latitude, live.longitude], [home.latitude, home.longitude], HOME_COLOR, "2 7");
  }, [ready, focus, theme]);

  // O cartão da OS recebe o foco ao abrir (pelo teclado, o Enter no pino leva direto às ações).
  useEffect(() => {
    if (picked) cardRef.current?.focus({ preventScroll: true });
  }, [picked]);

  const pickedTicket = picked ? findTicket(picked, activities, technicians) : null;
  const closeCard = () => {
    setPicked(null);
    restoreFocus(openerRef.current);
  };
  const hasPins =
    technicians.some((t) => shiftPosition(t)) ||
    activities.some((a) => isValidCoords(a.ticket.location?.latitude, a.ticket.location?.longitude));
  const showAll = () => {
    if (!usable(ready)) return;
    const points = pinPoints(techPins.current, osPins.current, destPins.current);
    if (focus?.place) points.push([focus.place.latitude, focus.place.longitude]);
    if (points.length) moveCamera(ready, points, 13);
  };

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="mf-map h-full w-full" role="region" aria-label="Mapa dos técnicos e das OS" />

      {hasPins ? (
        <Button size="sm" onClick={showAll} className="absolute top-3 right-3 z-10" title="Enquadrar técnicos e OS">
          <Scan className="size-4" />
          Ver todos
        </Button>
      ) : null}

      {pickedTicket ? (
        <div
          ref={cardRef}
          tabIndex={-1}
          role="group"
          aria-label={`${pickedTicket.code}: ${pickedTicket.state}`}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            closeCard();
          }}
          className="absolute top-3 left-3 z-10 w-[min(21rem,calc(100%-8.5rem))] min-w-[14rem] animate-enter rounded-xl border border-line bg-surface p-3 shadow-pop outline-none focus-visible:ring-2 focus-visible:ring-brand/45"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-bold text-ink">
                {pickedTicket.code}
                <span className={clsx("font-medium", pickedTicket.late ? "text-red-700 dark:text-red-400" : "text-ink-muted")}>
                  {" "}
                  · {pickedTicket.state}
                </span>
              </p>
              <p className="mt-0.5 text-xs text-ink-muted">
                {pickedTicket.time ? `${pickedTicket.time} · ` : ""}
                {pickedTicket.place}
              </p>
              <p className="text-xs text-ink-muted">{pickedTicket.who}</p>
            </div>
            <button
              type="button"
              onClick={closeCard}
              className="-mt-1 -mr-1 rounded-lg p-1.5 text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
              aria-label="Fechar"
            >
              <X className="size-4" />
            </button>
          </div>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <TicketLink ticketId={pickedTicket.id} className={buttonClassName("primary", "sm")}>
              Abrir OS
            </TicketLink>
            {pickedTicket.location && onMeasure ? (
              <Button
                size="sm"
                onClick={() => {
                  onMeasure(pickedTicket.location as MapPlace);
                  setPicked(null);
                }}
              >
                <Ruler className="size-3.5" />
                Medir técnicos até esta loja
              </Button>
            ) : null}
          </div>
        </div>
      ) : notice ? (
        <p className="absolute top-3 left-3 z-10 max-w-[calc(100%-8.5rem)] rounded-lg border border-line bg-surface/95 px-3 py-2 text-xs text-ink-muted shadow-elev-1">
          {notice}
        </p>
      ) : null}

      <MapLegend />
    </div>
  );
}

/** Pontos dos pinos desenhados (para enquadrar). */
function pinPoints(...registries: ReadonlyMap<string, { marker: Marker }>[]): LatLngTuple[] {
  const points: LatLngTuple[] = [];
  for (const registry of registries) {
    registry.forEach(({ marker }) => {
      const p = marker.getLatLng();
      points.push([p.lat, p.lng]);
    });
  }
  return points;
}

/** Legenda das formas do mapa (as cores dos técnicos estão nos filtros acima do mapa). */
function MapLegend() {
  const item = (glyph: React.ReactNode, text: string) => (
    <li className="flex items-center gap-2">
      <span aria-hidden className="flex w-5 shrink-0 justify-center">
        {glyph}
      </span>
      {text}
    </li>
  );
  return (
    <details className="group absolute bottom-3 left-3 z-10 max-w-[15rem] rounded-lg border border-line bg-surface/95 text-xs text-ink-muted shadow-elev-1">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-semibold text-ink focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
        <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
        Legenda
      </summary>
      <ul className="flex flex-col gap-1.5 border-t border-line px-2.5 py-2">
        {item(<span className="size-3.5 rounded-full border-2 border-surface bg-ink-subtle shadow-elev-1" />, "Técnico (a cor é o estado)")}
        {item(
          <span className="size-3.5 rounded-full border-2 border-surface bg-ink-subtle shadow-elev-1 outline-2 outline-offset-1 outline-ink-subtle/40" />,
          "A caminho do cliente (anel)",
        )}
        {item(
          <span className="size-3.5 rounded-full border-2 border-dashed border-surface bg-ink-subtle opacity-70 shadow-elev-1" />,
          "Posição antiga (sem sinal)",
        )}
        {item(<span className="size-2.5 rotate-45 rounded-[2px] border-2 border-ink-subtle bg-surface" />, "Destino da OS em campo")}
        {item(<span className="size-3 rounded-[3px] border-2 border-surface bg-ink-subtle shadow-elev-1" />, "OS do dia")}
        {item(<span className="size-3 rounded-[3px] border-2 border-dashed border-ink-subtle bg-surface" />, "OS do dia sem técnico")}
        {item(<span className="size-3.5 rounded-[4px] bg-ink" />, "Loja escolhida")}
        {item(<span className="size-3.5 rounded-[4px]" style={{ background: HOME_COLOR }} />, "Casa do técnico")}
        {item(<span className="w-5 border-t-2 border-dashed border-ink-subtle" />, "Caminho até o destino")}
        {item(<span className="h-1 w-5 rounded-full bg-brand/60" />, "Trajeto do dia")}
      </ul>
    </details>
  );
}
