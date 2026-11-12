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

interface Ready {
  L: Leaflet;
  map: LeafletMap;
  layers: { trail: LayerGroup; routes: LayerGroup; techs: LayerGroup };
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
    if (i === 0) row.style.fontWeight = "600";
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
}: {
  technicians: LiveTechnician[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  history: TrackingHistory | null;
  theme: Theme;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState<Ready | null>(null);
  const onSelectRef = useRef(onSelect);
  const techniciansRef = useRef(technicians);
  const fittedRef = useRef(false);

  useEffect(() => {
    onSelectRef.current = onSelect;
    techniciansRef.current = technicians;
  });

  // Cria o mapa uma vez (Leaflet só existe no navegador).
  useEffect(() => {
    let cancelled = false;
    let map: LeafletMap | null = null;
    import("leaflet").then((mod) => {
      const L = ((mod as unknown as { default?: Leaflet }).default ?? mod) as Leaflet;
      if (cancelled || !containerRef.current) return;
      map = L.map(containerRef.current, { zoomControl: false }).setView(DEFAULT_CENTER, 11);
      L.control.zoom({ position: "bottomright" }).addTo(map);
      setReady({
        L,
        map,
        layers: { trail: L.layerGroup().addTo(map), routes: L.layerGroup().addTo(map), techs: L.layerGroup().addTo(map) },
      });
    });
    return () => {
      cancelled = true;
      map?.remove();
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
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
    if (!ready) return;
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
    if (!ready || fittedRef.current) return;
    const points = technicians.flatMap((t) =>
      t.last_position ? [[t.last_position.latitude, t.last_position.longitude] as LatLngTuple] : [],
    );
    if (points.length === 0) return;
    fittedRef.current = true;
    ready.map.fitBounds(ready.L.latLngBounds(points), { padding: [48, 48], maxZoom: 14 });
  }, [ready, technicians]);

  // Ao escolher um técnico na lista, o mapa vai até ele.
  useEffect(() => {
    if (!ready || !selectedId) return;
    const pos = techniciansRef.current.find((t) => t.id === selectedId)?.last_position;
    if (pos) ready.map.flyTo([pos.latitude, pos.longitude], Math.max(ready.map.getZoom(), 14), { duration: 0.6 });
  }, [ready, selectedId]);

  // Trajeto do dia do técnico escolhido, com os pontos em que ele mudou o status da OS.
  useEffect(() => {
    if (!ready) return;
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

  return <div ref={containerRef} className="mf-map h-full w-full" role="region" aria-label="Mapa dos técnicos" />;
}
