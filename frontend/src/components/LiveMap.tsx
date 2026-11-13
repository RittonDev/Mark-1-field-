"use client";

import "leaflet/dist/leaflet.css";
import type { LatLngTuple, LayerGroup, Map as LeafletMap } from "leaflet";
import { useEffect, useRef, useState } from "react";
import type { Theme } from "@/components/Brand";
import { STATUS } from "@/lib/constants";
import { formatTime, initials } from "@/lib/format";
import { LIVE_STATE } from "@/lib/tracking";
import type { LiveTechnician, TrackingHistory } from "@/lib/types";

type Leaflet = typeof import("leaflet");

/** O que comparar no mapa: a loja do filtro, a casa e a posição de agora do técnico escolhido. */
export interface MapFocus {
  place: { latitude: number; longitude: number; label: string; approximate: boolean } | null;
  home: { latitude: number; longitude: number; label: string } | null;
  live: { latitude: number; longitude: number } | null;
  name?: string;
}

// Ícones (Lucide "store" e "house"), em HTML porque o marcador do Leaflet é HTML.
const STORE_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v11h16V9"/><path d="M9 20v-6h6v6"/></svg>';
const HOME_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/></svg>';
const HOME_COLOR = "#64748b";

interface Ready {
  L: Leaflet;
  map: LeafletMap;
  layers: { trail: LayerGroup; routes: LayerGroup; techs: LayerGroup; focus: LayerGroup };
  /** Vira false na hora em que o mapa é desmontado. O estado `ready` só muda no próximo render,
   *  e nesse meio-tempo nenhum efeito pode desenhar no mapa removido (o Leaflet quebra). */
  alive: { current: boolean };
}

const usable = (ready: Ready | null): ready is Ready => ready !== null && ready.alive.current;

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

export default function LiveMap({
  technicians,
  selectedId,
  onSelect,
  history,
  theme,
  focus = null,
  focusKey = null,
}: {
  technicians: LiveTechnician[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  history: TrackingHistory | null;
  theme: Theme;
  /** Loja do filtro, casa e posição do técnico escolhido (com as linhas entre eles). */
  focus?: MapFocus | null;
  /** Muda quando a escolha muda (loja ou técnico): só então o mapa reenquadra. */
  focusKey?: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState<Ready | null>(null);
  const onSelectRef = useRef(onSelect);
  const techniciansRef = useRef(technicians);
  const fittedRef = useRef(false);
  const focusFitRef = useRef<string | null>(null);

  useEffect(() => {
    onSelectRef.current = onSelect;
    techniciansRef.current = technicians;
  });

  // Cria o mapa uma vez (Leaflet só existe no navegador).
  useEffect(() => {
    let cancelled = false;
    let map: LeafletMap | null = null;
    const alive = { current: true };
    import("leaflet").then((mod) => {
      const L = ((mod as unknown as { default?: Leaflet }).default ?? mod) as Leaflet;
      if (cancelled || !containerRef.current) return;
      map = L.map(containerRef.current, { zoomControl: false }).setView(DEFAULT_CENTER, 11);
      L.control.zoom({ position: "bottomright" }).addTo(map);
      setReady({
        L,
        map,
        layers: {
          trail: L.layerGroup().addTo(map),
          routes: L.layerGroup().addTo(map),
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

  // Técnicos, destino da OS em campo e a linha até ele enquanto está a caminho.
  useEffect(() => {
    if (!usable(ready)) return;
    const { L, layers } = ready;
    layers.techs.clearLayers();
    layers.routes.clearLayers();
    for (const tech of technicians) {
      const pos = tech.last_position;
      const { color, label } = LIVE_STATE[tech.state];
      const selected = tech.id === selectedId;
      const ticket = tech.current_ticket;
      const dest = ticket?.location;
      if (ticket && dest?.latitude != null && dest.longitude != null) {
        if (pos && (tech.state === "en_route" || selected)) {
          L.polyline(
            [
              [pos.latitude, pos.longitude],
              [dest.latitude, dest.longitude],
            ],
            { color, weight: 2, dashArray: "6 6", opacity: 0.85, interactive: false },
          ).addTo(layers.routes);
        }
        L.marker([dest.latitude, dest.longitude], {
          icon: L.divIcon({ className: "", html: `<div class="mf-dest" style="--c:${color}"></div>`, iconSize: [14, 14] }),
          keyboard: false,
        })
          .bindTooltip(textNode(`${ticket.code} · ${dest.name}`, `Destino de ${tech.name}`), { direction: "top" })
          .addTo(layers.routes);
      }
      if (!pos) continue;
      const moving = pos.heading != null && (pos.speed_mps ?? 0) > 1;
      const classes = ["mf-pin", selected ? "is-selected" : "", tech.state === "en_route" ? "is-moving" : ""].join(" ");
      const html =
        `<div class="${classes}" style="--c:${color}">` +
        (moving ? `<i class="mf-heading" style="transform:rotate(${Number(pos.heading)}deg)"></i>` : "") +
        `<span>${escapeHtml(initials(tech.name))}</span></div>`;
      L.marker([pos.latitude, pos.longitude], {
        icon: L.divIcon({ className: "", html, iconSize: [34, 34] }),
        zIndexOffset: selected ? 1000 : 0,
        riseOnHover: true,
        alt: tech.name,
      })
        .bindTooltip(textNode(tech.name, ticket ? `${label} · ${ticket.code}` : label), {
          direction: "top",
          offset: [0, -18],
        })
        .on("click", () => onSelectRef.current(tech.id))
        .addTo(layers.techs);
    }
  }, [ready, technicians, selectedId]);

  // Primeiro carregamento: enquadra todos que estão com posição.
  useEffect(() => {
    if (!usable(ready) || fittedRef.current) return;
    const points = technicians.flatMap((t) =>
      t.last_position ? [[t.last_position.latitude, t.last_position.longitude] as LatLngTuple] : [],
    );
    if (points.length === 0) return;
    fittedRef.current = true;
    ready.map.fitBounds(ready.L.latLngBounds(points), { padding: [48, 48], maxZoom: 14 });
  }, [ready, technicians]);

  // Ao escolher um técnico na lista, o mapa vai até ele.
  useEffect(() => {
    if (!usable(ready) || !selectedId) return;
    const pos = techniciansRef.current.find((t) => t.id === selectedId)?.last_position;
    if (pos) ready.map.flyTo([pos.latitude, pos.longitude], Math.max(ready.map.getZoom(), 14), { duration: 0.6 });
  }, [ready, selectedId]);

  // Trajeto do dia do técnico escolhido, com os pontos em que ele mudou o status da OS.
  useEffect(() => {
    if (!usable(ready)) return;
    const { L, layers, map } = ready;
    layers.trail.clearLayers();
    if (!history) return;
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
    for (const ev of history.status_events) {
      if (ev.latitude == null || ev.longitude == null) continue;
      L.circleMarker([ev.latitude, ev.longitude], { radius: 6, color: "#fff", weight: 2, fillColor: color, fillOpacity: 1 })
        .bindTooltip(textNode(`${ev.ticket_code} → ${STATUS[ev.to_status]?.label ?? ev.to_status}`, formatTime(ev.at)))
        .addTo(layers.trail);
    }
    // Técnico sem posição ao vivo (fora da jornada): enquadra o trajeto.
    const live = techniciansRef.current.find((t) => t.id === history.user_id)?.last_position;
    if (!live && line.length > 0) map.fitBounds(L.latLngBounds(line), { padding: [48, 48], maxZoom: 15 });
  }, [ready, history, theme]);

  // Loja do filtro, casa do técnico escolhido e as linhas: de onde ele está e de casa até a loja
  // (sem loja: de onde ele está até a casa).
  useEffect(() => {
    if (!usable(ready)) return;
    const { L, layers, map } = ready;
    layers.focus.clearLayers();
    if (!focus) {
      focusFitRef.current = null;
      return;
    }
    const { place, home, live } = focus;
    const points: LatLngTuple[] = [];
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
      points.push([place.latitude, place.longitude]);
    }
    if (home) {
      L.marker([home.latitude, home.longitude], {
        icon: L.divIcon({ className: "", html: `<div class="mf-home">${HOME_SVG}</div>`, iconSize: [30, 30] }),
        keyboard: false,
      })
        .bindTooltip(textNode(focus.name ? `Casa de ${focus.name}` : "Casa", home.label), { direction: "top", offset: [0, -14] })
        .addTo(layers.focus);
      points.push([home.latitude, home.longitude]);
    }
    if (live) points.push([live.latitude, live.longitude]);
    const line = (a: LatLngTuple, b: LatLngTuple, color: string, dashArray: string) =>
      L.polyline([a, b], { color, weight: 3, opacity: 0.85, dashArray, interactive: false }).addTo(layers.focus);
    if (place && live) line([live.latitude, live.longitude], [place.latitude, place.longitude], TRAIL_COLOR[theme], "8 6");
    if (place && home) line([home.latitude, home.longitude], [place.latitude, place.longitude], HOME_COLOR, "2 7");
    if (!place && live && home) line([live.latitude, live.longitude], [home.latitude, home.longitude], HOME_COLOR, "2 7");
    // Reenquadra quando a escolha muda, não a cada posição nova.
    if (focusKey && focusFitRef.current !== focusKey && points.length) {
      focusFitRef.current = focusKey;
      if (points.length === 1) map.flyTo(points[0], Math.max(map.getZoom(), 13), { duration: 0.6 });
      else map.fitBounds(L.latLngBounds(points), { padding: [56, 56], maxZoom: 15 });
    }
  }, [ready, focus, focusKey, theme]);

  return <div ref={containerRef} className="mf-map h-full w-full" role="region" aria-label="Mapa dos técnicos" />;
}
