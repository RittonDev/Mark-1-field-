"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Copy, Home, MapPin, MessageCircle, Navigation, Phone, Store } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { LocationPicker } from "@/components/LocationPicker";
import { Tabs } from "@/components/motion";
import { buttonClassName, Card, Checkbox, EmptyState, ErrorBox, Input, LoadingBlock, Select } from "@/components/ui";
import { absoluteApiUrl, api, errorMessage } from "@/lib/api";
import { formatDate, formatMinutes, initials } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { UFS } from "@/lib/onboarding";
import { estimateDrive, formatKm } from "@/lib/tracking";
import type { Location, NearbyResult, NearbyTechnician, TechnicianRegion } from "@/lib/types";
import { whatsappUrl } from "@/lib/whatsapp";
import { useCopy } from "./useCopy";

type Mode = "store" | "city" | "coords";

/**
 * Lê coordenadas coladas ("-23.5505, -46.6333", "-23,5505; -46,6333" das planilhas) ou de um link do
 * Google Maps (@lat,lng / !3d...!4d... / ?q=lat,lng).
 */
export function parseCoordinates(text: string): { latitude: number; longitude: number } | null {
  let raw = text.trim();
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // "%" solto (ex.: "50% da loja" ou um link cortado): usa o texto como veio.
  }
  const patterns: [RegExp, boolean][] = [
    [/@(-?\d+\.\d+),(-?\d+\.\d+)/, false],
    [/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, false],
    [/[?&](?:q|query|ll|center|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/, false],
    [/(-?\d{1,2}\.\d{3,})\s*[,;\s]\s*(-?\d{1,3}\.\d{3,})/, false],
    // Vírgula decimal: separadas por ";", por espaço ou por ", " (vírgula seguida de espaço).
    [/(-?\d{1,2},\d{2,})\s*(?:;|,\s|\s)\s*(-?\d{1,3},\d{2,})/, true],
  ];
  for (const [pattern, comma] of patterns) {
    const m = raw.match(pattern);
    if (!m) continue;
    const latitude = Number(comma ? m[1].replace(",", ".") : m[1]);
    const longitude = Number(comma ? m[2].replace(",", ".") : m[2]);
    if (Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
      return { latitude, longitude };
    }
  }
  return null;
}

const KIND: Record<NearbyTechnician["nearest_kind"], { label: string; icon: typeof Store }> = {
  store_history: { label: "pelo histórico de atendimentos", icon: Store },
  home: { label: "pelo endereço", icon: Home },
  live: { label: "posição agora (em jornada)", icon: Navigation },
};

const ICON_LINK =
  "inline-flex size-8 items-center justify-center rounded-lg border border-line bg-surface text-ink-muted shadow-elev-1 transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none";

function ResultRow({
  tech,
  rank,
  placeLabel,
  onOpen,
}: {
  tech: NearbyTechnician;
  rank: number;
  placeLabel: string;
  onOpen?: (tech: NearbyTechnician) => void;
}) {
  const copy = useCopy();
  const kind = KIND[tech.nearest_kind];
  const KindIcon = kind.icon;
  const avatar = absoluteApiUrl(tech.avatar_url);
  const drive = estimateDrive(tech.distance_km);
  const first = tech.name.trim().split(/\s+/)[0];
  // Convite pronto: os parceiros são chamados por atendimento, pelo WhatsApp (sem telefone, o WhatsApp
  // abre para escolher o contato).
  const invite = whatsappUrl(
    tech.phone,
    `Olá, ${first}! Temos um atendimento em ${placeLabel}. Você tem disponibilidade?`,
  );
  return (
    <li className="flex flex-wrap items-start gap-3 px-4 py-3.5 transition-colors hover:bg-[var(--row-hover)] sm:px-5">
      <span className="mt-1 w-5 shrink-0 text-right text-xs font-semibold text-ink-subtle tabular-nums">{rank + 1}</span>
      <Avatar name={tech.name} src={avatar} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">
          {onOpen ? (
            <button
              type="button"
              onClick={() => onOpen(tech)}
              className="rounded text-left underline-offset-2 hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none"
              title="Abrir o cadastro do técnico"
            >
              {tech.name}
            </button>
          ) : (
            tech.name
          )}
          {tech.is_active ? null : (
            <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-ink-muted ring-1 ring-line ring-inset">
              sem acesso ao app
            </span>
          )}
          {tech.on_shift ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-muted">
              <span aria-hidden className="size-1.5 rounded-full bg-emerald-600" />
              em jornada
            </span>
          ) : null}
        </p>
        <p className="mt-0.5 text-xs text-ink-muted">
          {[
            tech.base_city ? [tech.base_city, tech.base_state].filter(Boolean).join("-") : "Região não informada",
            tech.total_visits ? `${tech.total_visits} OS atendidas` : null,
            tech.last_visit_at ? `última em ${formatDate(tech.last_visit_at)}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          {tech.open_tickets ? (
            <>
              {" · "}
              <Link
                href={`/chamados?assignee_id=${tech.id}&open_only=true`}
                className="underline-offset-2 hover:text-brand hover:underline"
              >
                {tech.open_tickets} {tech.open_tickets === 1 ? "OS aberta agora" : "OS abertas agora"}
              </Link>
            </>
          ) : null}
        </p>
        {tech.reasons.length ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {tech.reasons
              .filter((r) => !/^inativo/i.test(r))
              .slice(0, 4)
              .map((r) => (
                <span key={r} className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-muted ring-1 ring-line ring-inset">
                  {r}
                </span>
              ))}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <span className="text-right">
          <span className="block text-lg leading-none font-semibold text-ink tabular-nums">{formatKm(tech.distance_km)}</span>
          <span className="mt-0.5 block text-[11px] text-ink-muted">
            em linha reta · ~{formatMinutes(drive.minutes)} de carro
          </span>
          <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-ink-muted" title={kind.label}>
            <KindIcon className="size-3" aria-hidden />
            {kind.label}
          </span>
        </span>
        <span className="flex items-center gap-1">
          <a
            href={invite}
            target="_blank"
            rel="noreferrer"
            className={buttonClassName("secondary", "sm")}
            title={
              tech.phone
                ? `Convidar ${tech.name} pelo WhatsApp para este atendimento`
                : `${tech.name} está sem celular no cadastro: o WhatsApp abre para você escolher o contato`
            }
          >
            <MessageCircle className="size-3.5" />
            Convidar
          </a>
          {tech.phone ? (
            <a
              href={`tel:${tech.phone.replace(/[^\d+]/g, "")}`}
              className={ICON_LINK}
              aria-label={`Ligar para ${tech.name}`}
              title={tech.phone}
            >
              <Phone className="size-4" />
            </a>
          ) : null}
          <button
            type="button"
            onClick={() =>
              copy(`${tech.name}\n${tech.email}${tech.phone ? `\n${tech.phone}` : ""}`, {
                title: "Contato copiado",
                description: tech.name,
              })
            }
            className={ICON_LINK}
            aria-label={`Copiar contato de ${tech.name}`}
            title="Copiar contato"
          >
            <Copy className="size-4" />
          </button>
        </span>
      </div>
    </li>
  );
}

/** Foto do técnico; sem foto (ou link quebrado), as iniciais. */
function Avatar({ name, src }: { name: string; src: string | null }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-soft text-xs font-semibold text-brand-ink">
      {src && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element -- link assinado da API
        <img src={src} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} className="size-full object-cover" />
      ) : (
        initials(name)
      )}
    </span>
  );
}

/** Joga a localização da loja e vê quem está mais perto (histórico de atendimentos, endereço e jornada ao vivo). */
export function NearbyFinder({
  regions,
  onOpenTechnician,
}: {
  /** Estados e cidades da base técnica (sugestões de cidade). */
  regions?: TechnicianRegion[];
  /** Abre o cadastro do técnico (o nome vira botão). */
  onOpenTechnician?: (tech: NearbyTechnician) => void;
} = {}) {
  const cityListId = useId();
  const tabsId = useId();
  const [mode, setMode] = useState<Mode>("store");
  const [store, setStore] = useState<Location | null>(null);
  const [uf, setUf] = useState("");
  const [city, setCity] = useState("");
  const [coordsText, setCoordsText] = useState("");
  const [includeInactive, setIncludeInactive] = useState(true);
  // A busca por cidade espera a pessoa parar de digitar (cada consulta mede a base inteira).
  const cityQuery = useDebounced(city.trim(), 500);
  const coords = mode === "coords" ? parseCoordinates(coordsText) : null;
  const knownCities = regions?.find((r) => r.state === uf)?.cities ?? [];

  const params: Record<string, string | number> | null =
    mode === "store" && store
      ? { location_id: store.id }
      : mode === "city" && uf && cityQuery.length >= 2
        ? { city: cityQuery, state: uf }
        : mode === "coords" && coords
          ? { latitude: coords.latitude, longitude: coords.longitude }
          : null;

  const result = useQuery({
    // O limite entra na chave: a ficha da loja usa a mesma rota com outro limite.
    queryKey: ["technicians", "nearby", params, includeInactive, 20],
    // "false" vai como texto: o valor booleano false some da URL e a API entende o padrão (incluir).
    queryFn: () =>
      api.get<NearbyResult>("/technicians/nearby", { ...params, include_inactive: includeInactive ? "true" : "false", limit: 20 }),
    enabled: params !== null,
    placeholderData: keepPreviousData,
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
            idPrefix={tabsId}
          />
          <Checkbox label="Incluir técnicos sem acesso ao app" checked={includeInactive} onChange={setIncludeInactive} />
        </div>
        <div className="mt-4" role="tabpanel" id={`${tabsId}-panel-${mode}`} aria-labelledby={`${tabsId}-tab-${mode}`}>
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
              <Input
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder={uf ? "Cidade da loja (ex.: Santos)" : "Escolha a UF e digite a cidade"}
                aria-label="Cidade"
                list={knownCities.length ? cityListId : undefined}
                autoComplete="off"
              />
              {knownCities.length ? (
                <datalist id={cityListId}>
                  {knownCities.map((c) => (
                    <option key={c.city} value={c.city} />
                  ))}
                </datalist>
              ) : null}
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
        <Card className={clsx("overflow-hidden transition-opacity", result.isPlaceholderData && "opacity-70")}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3 sm:px-5">
            <p className="text-sm font-bold text-ink">
              Mais próximos de <span className="text-brand-ink">{result.data.point.label}</span>
              {result.isPlaceholderData ? <span className="ml-2 text-xs font-normal text-ink-muted">Atualizando…</span> : null}
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
            <EmptyState
              icon={<MapPin />}
              title="Nenhum técnico encontrado"
              description={includeInactive ? "Nenhum técnico com região ou endereço perto deste ponto." : "Tente incluir os técnicos sem acesso ao app."}
            />
          ) : (
            <ul className="divide-y divide-line">
              {result.data.technicians.map((t, i) => (
                <ResultRow key={t.id} tech={t} rank={i} placeLabel={result.data.point.label} onOpen={onOpenTechnician} />
              ))}
            </ul>
          )}
        </Card>
      ) : null}
    </div>
  );
}
