"use client";

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Copy, Home, Mail, MapPin, MessageCircle, Navigation, Phone, Store } from "lucide-react";
import { useState } from "react";
import { LocationPicker } from "@/components/LocationPicker";
import { Tabs } from "@/components/motion";
import { useToast } from "@/components/Toaster";
import { Card, Checkbox, EmptyState, ErrorBox, Input, LoadingBlock, Select } from "@/components/ui";
import { absoluteApiUrl, api, errorMessage } from "@/lib/api";
import { formatDate, initials } from "@/lib/format";
import type { Location, NearbyResult, NearbyTechnician } from "@/lib/types";

export const UFS = [
  "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA", "PB",
  "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO",
];

type Mode = "store" | "city" | "coords";

/** Lê coordenadas coladas ("-3,73, -38,52"?) ou de um link do Google Maps (@lat,lng / !3d...!4d... / ?q=lat,lng). */
export function parseCoordinates(text: string): { latitude: number; longitude: number } | null {
  const raw = decodeURIComponent(text.trim());
  const patterns = [
    /@(-?\d+\.\d+),(-?\d+\.\d+)/,
    /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,
    /[?&](?:q|query|ll|center|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/,
    /(-?\d{1,2}\.\d{3,})\s*[,;\s]\s*(-?\d{1,3}\.\d{3,})/,
  ];
  for (const p of patterns) {
    const m = raw.match(p);
    if (m) {
      const latitude = Number(m[1]);
      const longitude = Number(m[2]);
      if (Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) return { latitude, longitude };
    }
  }
  return null;
}

const KIND: Record<NearbyTechnician["nearest_kind"], { label: string; icon: typeof Store }> = {
  store_history: { label: "pelo histórico de atendimentos", icon: Store },
  home: { label: "pelo endereço", icon: Home },
  live: { label: "posição agora (em jornada)", icon: Navigation },
};

const km = (value: number) => `${value.toLocaleString("pt-BR", { maximumFractionDigits: value < 10 ? 1 : 0 })} km`;

function ResultRow({ tech, rank }: { tech: NearbyTechnician; rank: number }) {
  const { toast } = useToast();
  const phone = tech.phone?.replace(/\D/g, "");
  const kind = KIND[tech.nearest_kind];
  const KindIcon = kind.icon;
  const avatar = absoluteApiUrl(tech.avatar_url);
  return (
    <li style={{ ["--i" as string]: rank }} className="flex flex-wrap items-start gap-3 px-4 py-3.5 transition-colors hover:bg-[var(--row-hover)] sm:px-5">
      <span className="mt-1 w-5 shrink-0 text-right text-xs font-semibold text-ink-subtle tabular-nums">{rank + 1}</span>
      <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-soft text-xs font-semibold text-brand-ink">
        {avatar ? (
          // eslint-disable-next-line @next/next/no-img-element -- link assinado da API
          <img src={avatar} alt="" className="size-full object-cover" />
        ) : (
          initials(tech.name)
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">
          {tech.name}
          {tech.is_active ? null : (
            <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-ink-muted ring-1 ring-line ring-inset">
              sem acesso ao app
            </span>
          )}
          {tech.on_shift ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              em jornada
            </span>
          ) : null}
        </p>
        <p className="mt-0.5 text-xs text-ink-muted">
          {tech.base_city ? `${tech.base_city}-${tech.base_state}` : "Região não informada"}
          {tech.total_visits ? ` · ${tech.total_visits} OS atendidas` : ""}
          {tech.last_visit_at ? ` · última em ${formatDate(tech.last_visit_at)}` : ""}
          {tech.open_tickets ? ` · ${tech.open_tickets} aberta(s) agora` : ""}
        </p>
        {tech.reasons.length ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {tech.reasons.filter((r) => !/^inativo/i.test(r)).slice(0, 4).map((r) => (
              <span key={r} className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-muted ring-1 ring-line ring-inset">
                {r}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <span className="text-right">
          <span className="block text-lg leading-none font-semibold text-ink tabular-nums">{km(tech.distance_km)}</span>
          <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-ink-subtle" title={kind.label}>
            <KindIcon className="size-3" />
            {kind.label}
          </span>
        </span>
        <span className="flex items-center gap-1">
          {phone ? (
            <>
              <a
                href={`https://wa.me/55${phone}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex size-8 items-center justify-center rounded-lg border border-line bg-surface text-emerald-600 shadow-elev-1 hover:bg-emerald-50 dark:hover:bg-emerald-500/10"
                aria-label={`Chamar ${tech.name} no WhatsApp`}
                title="WhatsApp"
              >
                <MessageCircle className="size-4" />
              </a>
              <a
                href={`tel:${phone}`}
                className="inline-flex size-8 items-center justify-center rounded-lg border border-line bg-surface text-ink-muted shadow-elev-1 hover:text-ink"
                aria-label={`Ligar para ${tech.name}`}
                title={tech.phone ?? "Ligar"}
              >
                <Phone className="size-4" />
              </a>
            </>
          ) : null}
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(`${tech.name}\n${tech.email}${tech.phone ? `\n${tech.phone}` : ""}`);
              toast({ title: "Contato copiado", description: tech.name, tone: "success" });
            }}
            className="inline-flex size-8 items-center justify-center rounded-lg border border-line bg-surface text-ink-muted shadow-elev-1 hover:text-ink"
            aria-label={`Copiar contato de ${tech.name}`}
            title="Copiar contato"
          >
            {phone ? <Copy className="size-4" /> : <Mail className="size-4" />}
          </button>
        </span>
      </div>
    </li>
  );
}

/** Joga a localização da loja e vê quem está mais perto (histórico de atendimentos, endereço e jornada ao vivo). */
export function NearbyFinder() {
  const [mode, setMode] = useState<Mode>("store");
  const [store, setStore] = useState<Location | null>(null);
  const [uf, setUf] = useState("");
  const [city, setCity] = useState("");
  const [coordsText, setCoordsText] = useState("");
  const [includeInactive, setIncludeInactive] = useState(true);
  const coords = mode === "coords" ? parseCoordinates(coordsText) : null;

  const params: Record<string, string | number | boolean> | null =
    mode === "store" && store
      ? { location_id: store.id }
      : mode === "city" && uf && city.trim().length >= 2
        ? { city: city.trim(), state: uf }
        : mode === "coords" && coords
          ? { latitude: coords.latitude, longitude: coords.longitude }
          : null;

  const result = useQuery({
    queryKey: ["technicians", "nearby", params, includeInactive],
    queryFn: () => api.get<NearbyResult>("/technicians/nearby", { ...params, include_inactive: includeInactive, limit: 20 }),
    enabled: params !== null,
  });

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Tabs
            variant="segmented"
            items={[
              { key: "store" as Mode, label: "Loja cadastrada" },
              { key: "city" as Mode, label: "Cidade" },
              { key: "coords" as Mode, label: "Coordenadas ou link do Maps" },
            ]}
            value={mode}
            onChange={setMode}
            ariaLabel="Como informar a localização"
          />
          <Checkbox label="Incluir técnicos sem acesso ao app" checked={includeInactive} onChange={setIncludeInactive} />
        </div>
        <div className="mt-4">
          {mode === "store" ? (
            <LocationPicker customerId={null} value={store} onChange={setStore} />
          ) : mode === "city" ? (
            <div className="grid gap-2 sm:grid-cols-[6rem_minmax(0,1fr)]">
              <Select value={uf} onChange={(e) => setUf(e.target.value)} aria-label="UF">
                <option value="">UF</option>
                {UFS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
              <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Cidade da loja (ex.: Santos)" aria-label="Cidade" />
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Input
                value={coordsText}
                onChange={(e) => setCoordsText(e.target.value)}
                placeholder="Cole as coordenadas (-3.7319, -38.5267) ou o link do Google Maps"
                aria-label="Coordenadas ou link do Google Maps"
              />
              <p className={clsx("text-xs", coordsText && !coords ? "text-amber-700 dark:text-amber-400" : "text-ink-subtle")}>
                {coordsText && !coords
                  ? "Não achei coordenadas aqui. Abra o local no Google Maps e copie o link da barra de endereço (o link curto não traz as coordenadas)."
                  : "No Google Maps: clique com o botão direito no local e clique nos números para copiar."}
              </p>
            </div>
          )}
        </div>
      </Card>

      {params === null ? (
        <Card>
          <EmptyState
            icon={<MapPin />}
            title="Informe onde é o atendimento"
            description="Escolha a loja, a cidade ou cole a localização. A lista mostra quem está mais perto, quem já atendeu a loja e quem está em jornada agora."
          />
        </Card>
      ) : result.isLoading ? (
        <Card>
          <LoadingBlock rows={5} label="Procurando técnicos por perto..." />
        </Card>
      ) : result.error ? (
        <ErrorBox message={errorMessage(result.error)} />
      ) : result.data ? (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3 sm:px-5">
            <p className="text-sm font-bold text-ink">
              Mais próximos de <span className="text-brand-ink">{result.data.point.label}</span>
            </p>
            <a
              href={`https://www.google.com/maps/search/?api=1&query=${result.data.point.latitude},${result.data.point.longitude}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-ink-muted hover:text-brand"
            >
              <MapPin className="size-3.5" />
              Ver o ponto no mapa
            </a>
          </div>
          {result.data.technicians.length === 0 ? (
            <EmptyState icon={<MapPin />} title="Nenhum técnico encontrado" description="Tente incluir os técnicos sem acesso ao app." />
          ) : (
            <ul className="stagger divide-y divide-line">
              {result.data.technicians.map((t, i) => (
                <ResultRow key={t.id} tech={t} rank={i} />
              ))}
            </ul>
          )}
        </Card>
      ) : null}
    </div>
  );
}
