"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  ArrowDown,
  BadgeCheck,
  Camera,
  Check,
  Copy,
  Download,
  FileSpreadsheet,
  HardHat,
  KeyRound,
  Loader2,
  MapPinned,
  MessageCircle,
  Phone,
  Plus,
  Search,
  SquarePen,
  Upload,
  UserPlus,
  Wallet,
  X,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useRef, useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { fold } from "@/components/operacao/hooks";
import { useToast } from "@/components/Toaster";
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
  Table,
  Td,
  Th,
} from "@/components/ui";
import { useNow } from "@/components/useNow";
import { absoluteApiUrl, api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets } from "@/lib/constants";
import { downloadCsv } from "@/lib/download";
import { formatDate, formatMoney, formatRelative, initials } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { labelMap, maskPhone, resizePhotoBlob, UFS, useOnboardingCatalog } from "@/lib/onboarding";
import { useServiceTypes, useTeams } from "@/lib/queries";
import { Tabs } from "@/components/motion";
import { InviteDialog } from "@/components/technicians/InviteDialog";
import { NearbyFinder } from "@/components/technicians/NearbyFinder";
import { refreshTechnicianViews } from "@/components/technicians/refresh";
import { useCopy } from "@/components/technicians/useCopy";
import type {
  ImportResult,
  NearbyTechnician,
  PayoutList,
  Technician,
  TechnicianRegion,
  TemporaryPassword,
} from "@/lib/types";
import { whatsappUrl } from "@/lib/whatsapp";

type Active = "true" | "false" | "";

// A lista abre com as primeiras linhas; o resto vem no "Mostrar mais" (a base passa de mil técnicos).
const PAGE = 150;
// Quantos técnicos a tela pede de uma vez (a busca, os filtros e as contagens são sobre a lista inteira).
// Ao chegar nele, a lista avisa que há mais.
const API_LIMIT = 2000;

/** Cadastros incompletos que atrapalham a operação (filtro rápido sobre a lista carregada). */
type Gap = "phone" | "region" | "services" | "gps";
const GAPS: { key: Gap; label: string; hint: string; test: (t: Technician) => boolean }[] = [
  { key: "phone", label: "Sem celular", hint: "Sem celular, o WhatsApp não abre direto na conversa", test: (t) => !t.phone },
  {
    key: "region",
    label: "Sem região",
    hint: "Sem cidade de casa nem histórico de atendimento: fica fora das sugestões por cidade",
    test: (t) => !t.base_city && !t.home_city,
  },
  { key: "services", label: "Sem serviços", hint: "Sem os serviços que faz: não aparece na busca por serviço", test: (t) => !(t.services ?? []).length },
  {
    key: "gps",
    label: "Sem aceite do GPS",
    hint: "Com acesso ao app, mas ainda não autorizou o GPS: não consegue iniciar a jornada",
    test: (t) => t.is_active && !t.location_consent_at,
  },
];

function regionText(city: string | null | undefined, state: string | null | undefined): string {
  return [city, state].filter(Boolean).join("-");
}

function Avatar({ tech, size = "md" }: { tech: Pick<Technician, "name" | "avatar_url">; size?: "md" | "lg" }) {
  const src = absoluteApiUrl(tech.avatar_url);
  // Foto que não abre (ex.: link antigo do Field Control): ficam as iniciais.
  const [broken, setBroken] = useState<string | null>(null);
  return (
    <span
      className={clsx(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand/10 font-semibold text-brand",
        size === "lg" ? "size-16 text-lg" : "size-8 text-xs",
      )}
    >
      {src && broken !== src ? (
        // eslint-disable-next-line @next/next/no-img-element -- link assinado da API
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setBroken(src)}
          className="size-full object-cover"
        />
      ) : (
        initials(tech.name)
      )}
    </span>
  );
}

export default function TechniciansPage() {
  // A busca pode chegar pela URL (?q=, ex.: "Ver na base técnica" da Homologação).
  return (
    <Suspense fallback={<LoadingBlock />}>
      <TechniciansView />
    </Suspense>
  );
}

function TechniciansView() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const now = useNow(60_000);
  const [qInput, setQInput] = useState(() => searchParams.get("q") ?? "");
  const [teamId, setTeamId] = useState("");
  // Depois da migração, quem está "inativo" no Field Control continua na rede (só sem licença): mostra todos.
  const [active, setActive] = useState<Active>("");
  const [view, setView] = useState<"list" | "nearby">("list");
  const [uf, setUf] = useState("");
  const [city, setCity] = useState("");
  const [gap, setGap] = useState<Gap | null>(null);
  const [sortByVisit, setSortByVisit] = useState(false);
  const [editing, setEditing] = useState<Technician | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [inviting, setInviting] = useState(false);
  const q = useDebounced(qInput.trim());
  const teams = useTeams();

  const list = useQuery({
    queryKey: ["technicians", "list", { q, teamId, active, uf, city }],
    queryFn: () =>
      api.get<Technician[]>("/technicians", {
        q: q || undefined,
        team_id: teamId || undefined,
        active: active || undefined,
        state: uf || undefined,
        city: city || undefined,
        limit: API_LIMIT,
      }),
    placeholderData: (previous) => previous,
    // A lista é pesada (a base inteira com os serviços): não recarrega a cada volta para a aba.
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  // Estados e cidades onde a base técnica está (pela região de atuação).
  const regions = useQuery({
    queryKey: ["technicians", "regions", active],
    queryFn: () => api.get<TechnicianRegion[]>("/technicians/regions", { active: active || undefined }),
    staleTime: 60_000,
  });
  const cities = regions.data?.find((r) => r.state === uf)?.cities ?? [];
  // O UF e a cidade escolhidos continuam na lista mesmo quando a situação muda e eles somem das opções.
  const ufOptions = useMemo(() => {
    const states = regions.data?.length ? regions.data.map((r) => r.state) : UFS;
    return uf && !states.includes(uf) ? [uf, ...states] : states;
  }, [regions.data, uf]);
  const cityOptions = city && !cities.some((c) => c.city === city) ? [{ city, total: 0 }, ...cities] : cities;

  const gapCounts = useMemo(() => {
    const all = list.data ?? [];
    return Object.fromEntries(GAPS.map((g) => [g.key, all.filter(g.test).length])) as Record<Gap, number>;
  }, [list.data]);
  const rows = useMemo(() => {
    const test = GAPS.find((g) => g.key === gap)?.test;
    const all = (list.data ?? []).filter((t) => !test || test(t));
    // Por padrão os ativos primeiro (a API já ordena por nome ou pela busca); ou pela última OS.
    if (sortByVisit) return all.sort((a, b) => (b.last_visit_at ?? "").localeCompare(a.last_visit_at ?? ""));
    return all.sort((a, b) => Number(b.is_active) - Number(a.is_active));
  }, [list.data, gap, sortByVisit]);
  // Quantas linhas mostrar; volta ao começo quando a lista muda (outro filtro).
  const listKey = JSON.stringify([q, teamId, active, uf, city, gap, sortByVisit]);
  const [shown, setShown] = useState({ key: listKey, count: PAGE });
  const shownCount = shown.key === listKey ? shown.count : PAGE;
  const filtered = !!(q || teamId || active || uf || city || gap);

  const clearFilters = () => {
    setQInput("");
    setTeamId("");
    setActive("");
    setUf("");
    setCity("");
    setGap(null);
  };
  const exportCsv = () =>
    downloadCsv("tecnicos.csv", [
      ["nome", "email", "celular", "grupo", "cidade", "uf", "regiao_atuacao", "situacao", "ultimo_acesso", "ultima_os", "os_abertas"],
      ...rows.map((t) => [
        t.name,
        t.email,
        t.phone,
        t.team?.name,
        t.home_city,
        t.home_state,
        regionText(t.base_city, t.base_state),
        t.is_active ? "Ativo" : "Desativado",
        t.last_login_at ? formatDate(t.last_login_at) : "",
        t.last_visit_at ? formatDate(t.last_visit_at) : "",
        t.open_tickets,
      ]),
    ]);
  // Nome clicado em "Mais próximos": abre o cadastro (da lista carregada ou buscado pelo e-mail).
  const openTechnician = async (tech: NearbyTechnician) => {
    const known = list.data?.find((t) => t.id === tech.id);
    if (known) {
      setEditing(known);
      return;
    }
    try {
      const found = await queryClient.fetchQuery({
        queryKey: ["technicians", "list", { q: tech.email, teamId: "", active: "", uf: "", city: "" }],
        queryFn: () => api.get<Technician[]>("/technicians", { q: tech.email }),
        staleTime: 60_000,
      });
      const match = found.find((t) => t.id === tech.id);
      if (match) setEditing(match);
      else toast({ title: "Não achei este técnico na base", tone: "error" });
    } catch (error) {
      toast({ title: errorMessage(error), tone: "error" });
    }
  };

  if (user && !canManageTickets(user.role)) {
    return <ErrorBox message="A base técnica é exclusiva para analistas e gestores." />;
  }

  return (
    <div>
      <PageHeader
        title="Técnicos"
        description="Base técnica: acesso ao app, contato, região, serviços e foto. Novos técnicos chegam pelo convite (homologação) ou são cadastrados aqui."
        actions={
          <>
            <Link href="/homologacao" className={buttonClassName()}>
              <BadgeCheck className="size-4" />
              Homologação
            </Link>
            <Button onClick={() => setImporting(true)}>
              <Upload className="size-4" />
              Importar planilha
            </Button>
            <Button onClick={() => setInviting(true)}>
              <UserPlus className="size-4" />
              Convidar técnico
            </Button>
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus className="size-4" />
              Novo técnico
            </Button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Tabs
          variant="segmented"
          items={[
            { key: "list" as const, label: "Base técnica" },
            { key: "nearby" as const, label: "Mais próximos de uma loja" },
          ]}
          value={view}
          onChange={setView}
          ariaLabel="Visão"
          idPrefix="tecnicos"
        />
        {view === "list" && list.data ? (
          <span className="flex items-center gap-3 text-xs text-ink-muted">
            {list.isPlaceholderData ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 className="size-3.5 animate-spin" />
                Atualizando…
              </span>
            ) : null}
            <span className="tabular-nums">
              {rows.length} {rows.length === 1 ? "técnico" : "técnicos"}
            </span>
            {rows.length ? (
              <Button size="sm" variant="ghost" onClick={exportCsv}>
                <Download className="size-3.5" />
                Exportar
              </Button>
            ) : null}
          </span>
        ) : null}
      </div>

      {view === "nearby" ? (
        <div role="tabpanel" id="tecnicos-panel-nearby" aria-labelledby="tecnicos-tab-nearby">
          <NearbyFinder regions={regions.data} onOpenTechnician={openTechnician} />
        </div>
      ) : (
        <div role="tabpanel" id="tecnicos-panel-list" aria-labelledby="tecnicos-tab-list">
          <div className="mb-3 flex flex-wrap gap-2">
            <div className="w-full sm:w-40">
              <Select
                value={uf}
                onChange={(e) => {
                  setUf(e.target.value);
                  setCity("");
                }}
                aria-label="Estado"
              >
                <option value="">Todas as UFs</option>
                {ufOptions.map((s) => (
                  <option key={s} value={s}>
                    {s}
                    {regions.data ? ` (${regions.data.find((r) => r.state === s)?.total ?? 0})` : ""}
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-full sm:w-56">
              <Select value={city} onChange={(e) => setCity(e.target.value)} disabled={!uf} aria-label="Cidade">
                <option value="">{uf ? "Todas as cidades" : "Escolha a UF"}</option>
                {cityOptions.map((c) => (
                  <option key={c.city} value={c.city}>
                    {c.city} ({c.total})
                  </option>
                ))}
              </Select>
            </div>
            <div className="relative min-w-56 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted" />
              <Input
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                placeholder="Buscar por nome, e-mail ou telefone"
                className="pl-9"
                aria-label="Buscar técnico"
              />
            </div>
            <div className="w-full sm:w-52">
              <Select value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label="Grupo">
                <option value="">Todos os grupos</option>
                {(teams.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-full sm:w-36">
              <Select value={active} onChange={(e) => setActive(e.target.value as Active)} aria-label="Situação">
                <option value="true">Ativos</option>
                <option value="false">Inativos</option>
                <option value="">Todos</option>
              </Select>
            </div>
          </div>

          {GAPS.some((g) => gapCounts[g.key] > 0) || gap ? (
            <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Cadastros incompletos">
              <span className="text-xs font-semibold text-ink/80">Cadastro incompleto:</span>
              {GAPS.filter((g) => gapCounts[g.key] > 0 || gap === g.key).map((g) => (
                <button
                  key={g.key}
                  type="button"
                  aria-pressed={gap === g.key}
                  title={g.hint}
                  onClick={() => setGap(gap === g.key ? null : g.key)}
                  className={clsx(
                    "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none",
                    gap === g.key ? "border-brand bg-nav-active text-ink" : "border-line bg-surface text-ink-muted hover:text-ink",
                  )}
                >
                  {g.label}
                  <span className="font-semibold text-ink tabular-nums">{gapCounts[g.key]}</span>
                </button>
              ))}
            </div>
          ) : null}

          <Card className={clsx("transition-opacity", list.isPlaceholderData && "opacity-70")}>
            {list.isLoading ? (
              <LoadingBlock />
            ) : list.error ? (
              <div className="p-4">
                <ErrorBox message={errorMessage(list.error)} />
              </div>
            ) : rows.length === 0 ? (
              filtered ? (
                <EmptyState
                  icon={<HardHat className="size-6" />}
                  title="Nenhum técnico com estes filtros"
                  action={<Button onClick={clearFilters}>Limpar filtros</Button>}
                />
              ) : (
                <EmptyState
                  icon={<HardHat className="size-6" />}
                  title="Nenhum técnico na base"
                  description="Convide pelo WhatsApp, cadastre aqui ou importe a sua base em planilha."
                  action={
                    <Button variant="primary" onClick={() => setInviting(true)}>
                      <UserPlus className="size-4" />
                      Convidar técnico
                    </Button>
                  }
                />
              )
            ) : (
              <>
                {(list.data?.length ?? 0) >= API_LIMIT ? (
                  <p className="border-b border-line px-4 py-2.5 text-xs text-ink-muted">
                    Mostrando os primeiros {API_LIMIT.toLocaleString("pt-BR")} técnicos (por nome): use a busca ou os filtros
                    para achar os demais.
                  </p>
                ) : null}
                <Table>
                  <thead>
                    <tr>
                      <Th>Técnico</Th>
                      <Th className="hidden md:table-cell">Grupo</Th>
                      <Th className="hidden lg:table-cell">Região de atuação</Th>
                      <Th className="hidden lg:table-cell">Celular</Th>
                      <Th>App</Th>
                      <Th className="hidden xl:table-cell">
                        <button
                          type="button"
                          onClick={() => setSortByVisit((v) => !v)}
                          aria-pressed={sortByVisit}
                          title={sortByVisit ? "Voltar à ordem por nome" : "Ordenar pela última OS"}
                          className="inline-flex items-center gap-1 rounded uppercase hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none"
                        >
                          Última OS
                          <ArrowDown className={clsx("size-3", sortByVisit ? "text-ink" : "opacity-40")} />
                        </button>
                      </Th>
                      <Th className="hidden sm:table-cell">OS abertas</Th>
                      <Th className="edit-col">Editar</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, shownCount).map((t) => (
                      <tr
                        key={t.id}
                        className="cursor-pointer transition-colors hover:bg-[var(--row-hover)]"
                        onClick={(e) => {
                          // Só o clique na própria linha (não o que vem de um diálogo aberto a partir dela).
                          if (e.currentTarget.contains(e.target as Node)) setEditing(t);
                        }}
                      >
                        <Td>
                          <span className="flex items-center gap-2.5">
                            <Avatar tech={t} />
                            <span className="min-w-0">
                              <span className="block truncate font-semibold text-ink">{t.name}</span>
                              <span className="block truncate text-xs text-ink-muted">{t.email}</span>
                            </span>
                          </span>
                        </Td>
                        <Td className="hidden md:table-cell">{t.team?.name ?? <span className="text-ink-muted">—</span>}</Td>
                        <Td className="hidden lg:table-cell">
                          {t.base_city || t.home_city ? (
                            <span className="block">
                              <span className="whitespace-nowrap text-ink">
                                {t.base_city ? regionText(t.base_city, t.base_state) : regionText(t.home_city, t.home_state)}
                              </span>
                              <span className="block text-xs text-ink-muted">
                                {t.base_source === "history" ? `pelo histórico · ${t.base_visits ?? 0} OS` : "pelo endereço"}
                              </span>
                            </span>
                          ) : (
                            <span className="text-xs text-ink-muted">Sem região</span>
                          )}
                        </Td>
                        <Td className="hidden lg:table-cell">
                          {t.phone ? (
                            <span className="flex items-center gap-1">
                              <a
                                href={whatsappUrl(t.phone, `Olá, ${t.name.trim().split(/\s+/)[0]}!`)}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="inline-flex items-center gap-1 rounded text-ink underline-offset-2 hover:text-brand hover:underline"
                                title={`Conversar com ${t.name} no WhatsApp`}
                              >
                                <MessageCircle className="size-3.5 shrink-0 text-ink-muted" />
                                <span className="whitespace-nowrap">{t.phone}</span>
                              </a>
                              <a
                                href={`tel:${t.phone.replace(/[^\d+]/g, "")}`}
                                onClick={(e) => e.stopPropagation()}
                                className="rounded p-1 text-ink-muted hover:text-ink"
                                aria-label={`Ligar para ${t.name}`}
                                title="Ligar"
                              >
                                <Phone className="size-3.5" />
                              </a>
                            </span>
                          ) : (
                            <span className="text-ink-muted">—</span>
                          )}
                        </Td>
                        <Td>
                          <AppStatus tech={t} now={now} />
                        </Td>
                        <Td className="hidden text-xs whitespace-nowrap text-ink-muted xl:table-cell">
                          {t.last_visit_at ? formatDate(t.last_visit_at) : "—"}
                        </Td>
                        <Td className="hidden tabular-nums sm:table-cell">
                          {t.open_tickets ? (
                            <Link
                              href={`/chamados?assignee_id=${t.id}&open_only=true`}
                              onClick={(e) => e.stopPropagation()}
                              className="font-medium text-ink underline-offset-2 hover:text-brand hover:underline"
                              title={`OS abertas de ${t.name}`}
                            >
                              {t.open_tickets}
                            </Link>
                          ) : (
                            <span className="text-ink-muted">0</span>
                          )}
                        </Td>
                        <Td className="edit-col">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditing(t);
                            }}
                            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-brand shadow-elev-1 transition-[border-color,background-color] duration-150 hover:border-brand/40 hover:bg-brand-soft focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none"
                            aria-label={`Editar ${t.name}`}
                            title={`Editar ${t.name}`}
                          >
                            <SquarePen className="size-4" />
                          </button>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                {rows.length > shownCount ? (
                  <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-xs text-ink-muted">
                    <span className="tabular-nums">
                      Mostrando {shownCount} de {rows.length}
                    </span>
                    <Button size="sm" onClick={() => setShown({ key: listKey, count: shownCount + PAGE })}>
                      Mostrar mais
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </Card>
        </div>
      )}

      {editing ? <EditDialog key={editing.id} tech={editing} onClose={() => setEditing(null)} /> : null}
      {creating ? <CreateDialog onClose={() => setCreating(false)} /> : null}
      {importing ? <ImportDialog onClose={() => setImporting(false)} /> : null}
      {inviting ? <InviteDialog onClose={() => setInviting(false)} /> : null}
    </div>
  );
}

function AppStatus({ tech, now }: { tech: Technician; now: number }) {
  if (!tech.is_active) {
    return (
      <span className="inline-flex rounded-full border border-line bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-muted">
        Desativado
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-0.5 text-xs">
      {tech.on_shift ? (
        <Link
          href="/mapa"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1 font-medium text-ink underline-offset-2 hover:text-brand hover:underline"
          title="Ver no mapa ao vivo"
        >
          <span aria-hidden className="size-1.5 rounded-full bg-emerald-600" />
          Em jornada
        </Link>
      ) : null}
      {tech.must_change_password ? (
        <span className="text-amber-800 dark:text-amber-300">Senha provisória</span>
      ) : null}
      {tech.last_login_at && !tech.location_consent_at ? (
        <span className="text-amber-800 dark:text-amber-300" title="Sem o aceite, o app não inicia a jornada">
          GPS não autorizado
        </span>
      ) : null}
      <span className="text-ink-muted">
        {tech.last_login_at ? `Acesso ${formatRelative(tech.last_login_at, now)}` : "Nunca acessou"}
      </span>
    </span>
  );
}

/** Senha provisória: aparece uma vez, com atalhos para enviar ao técnico. */
function TempPasswordPanel({ result }: { result: TemporaryPassword }) {
  const copy = useCopy();
  const codeRef = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  const { technician: t, temporary_password: pw } = result;
  const message = `Olá, ${t.name.trim().split(/\s+/)[0]}! Seu acesso ao app Maxx Field: e-mail ${t.email} e senha provisória ${pw}. No primeiro acesso, o app pede para você criar uma senha nova.`;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink">
        Senha provisória de <strong>{t.name}</strong>. No primeiro acesso ao app, ele cria uma senha nova.
      </p>
      <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 p-2">
        <code ref={codeRef} className="flex-1 text-center font-mono text-lg tracking-wider text-ink">
          {pw}
        </code>
        <Button
          onClick={async () => {
            if (await copy(pw, { select: codeRef.current, title: "Senha copiada" })) setCopied(true);
          }}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? "Copiada" : "Copiar"}
        </Button>
      </div>
      <a href={whatsappUrl(t.phone, message)} target="_blank" rel="noreferrer" className={buttonClassName("secondary", "md", "self-start")}>
        <MessageCircle className="size-4" />
        {t.phone ? "Enviar no WhatsApp dele" : "Enviar por WhatsApp"}
      </a>
      <p className="text-xs text-ink-muted">Por segurança, esta senha não aparece de novo. Se perder, gere outra.</p>
    </div>
  );
}

interface TechnicianForm {
  name: string;
  email: string;
  phone: string;
  team_id: string;
  job_title: string;
  home_city: string;
  home_state: string;
  coverage_area: string;
}

/** Confere antes de enviar (a API responderia em inglês). */
function validateTechnician(v: TechnicianForm): string | null {
  if (v.name.trim().length < 3) return "Informe o nome do técnico (pelo menos 3 letras).";
  if (!/^\S+@\S+\.\S+$/.test(v.email.trim())) return "Informe um e-mail válido: é o login do técnico no app.";
  const phone = v.phone.replace(/\D/g, "");
  if (phone && phone.length < 10) return "Informe o celular com DDD.";
  return null;
}

function TechnicianFields({
  value,
  onChange,
  emailHint,
}: {
  value: TechnicianForm;
  onChange: (v: TechnicianForm) => void;
  emailHint?: string;
}) {
  const teams = useTeams();
  const set = (k: keyof TechnicianForm, v: string) => onChange({ ...value, [k]: v });
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Nome" required className="sm:col-span-2">
        <Input value={value.name} onChange={(e) => set("name", e.target.value)} maxLength={160} autoComplete="off" />
      </Field>
      <Field label="E-mail (login no app)" required hint={emailHint}>
        <Input type="email" value={value.email} onChange={(e) => set("email", e.target.value)} autoComplete="off" />
      </Field>
      <Field label="Celular (WhatsApp)">
        <Input
          value={value.phone}
          onChange={(e) => set("phone", maskPhone(e.target.value))}
          inputMode="tel"
          placeholder="(11) 90000-0000"
          autoComplete="off"
        />
      </Field>
      <Field label="Grupo técnico">
        <Select value={value.team_id} onChange={(e) => set("team_id", e.target.value)}>
          <option value="">Sem grupo</option>
          {(teams.data ?? [])
            .filter((t) => t.is_active || t.id === value.team_id)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
        </Select>
      </Field>
      <Field label="Cargo">
        <Input value={value.job_title} onChange={(e) => set("job_title", e.target.value)} maxLength={120} />
      </Field>
      <div className="grid grid-cols-[1fr_6rem] gap-4 sm:col-span-2">
        <Field label="Cidade onde mora" hint="Base das sugestões de técnico por cidade">
          <Input value={value.home_city} onChange={(e) => set("home_city", e.target.value)} maxLength={120} />
        </Field>
        <Field label="UF">
          <Select value={value.home_state} onChange={(e) => set("home_state", e.target.value)}>
            <option value="">—</option>
            {(UFS.includes(value.home_state) || !value.home_state ? UFS : [value.home_state, ...UFS]).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Região que atende" className="sm:col-span-2">
        <Input
          value={value.coverage_area}
          onChange={(e) => set("coverage_area", e.target.value)}
          placeholder="Ex.: Santos, São Vicente e Guarujá"
          maxLength={1000}
        />
      </Field>
    </div>
  );
}

const EMPTY_TECHNICIAN: TechnicianForm = {
  name: "",
  email: "",
  phone: "",
  team_id: "",
  job_title: "Técnico de campo",
  home_city: "",
  home_state: "",
  coverage_area: "",
};

function CreateDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<TechnicianForm>(EMPTY_TECHNICIAN);
  const [problem, setProblem] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api.post<TemporaryPassword>("/technicians", {
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone || null,
        team_id: form.team_id || null,
        job_title: form.job_title || null,
        home_city: form.home_city || null,
        home_state: form.home_state || null,
        coverage_area: form.coverage_area || null,
      }),
    onSuccess: () => refreshTechnicianViews(queryClient),
  });
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      busy={create.isPending}
      // Fechar sem cadastrar pergunta antes de descartar o que foi digitado.
      dirty={!create.data && JSON.stringify(form) !== JSON.stringify(EMPTY_TECHNICIAN)}
      title="Novo técnico"
      description="Cadastro direto, sem ficha de homologação. O técnico recebe uma senha provisória."
      footer={
        create.data ? (
          <Button variant="primary" onClick={onClose}>
            Concluir
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancelar</Button>
            <Button variant="primary" type="submit" form="tech-create-form" loading={create.isPending}>
              Cadastrar
            </Button>
          </>
        )
      }
    >
      {create.data ? (
        <TempPasswordPanel result={create.data} />
      ) : (
        <form
          id="tech-create-form"
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const found = validateTechnician(form);
            setProblem(found);
            if (!found && !create.isPending) create.mutate();
          }}
        >
          <TechnicianFields value={form} onChange={setForm} />
          {/* O ErrorBox já é anunciado (role="alert"). */}
          {problem || create.error ? <ErrorBox message={problem ?? errorMessage(create.error)} /> : null}
        </form>
      )}
    </Dialog>
  );
}

/** O que o diálogo edita, para saber se algo mudou antes de fechar sem salvar. */
function editableOf(tech: Technician) {
  const time = (value: string | null | undefined) => value?.slice(0, 5) ?? "";
  return {
    form: {
      name: tech.name,
      email: tech.email,
      phone: tech.phone ?? "",
      team_id: tech.team?.id ?? "",
      job_title: tech.job_title ?? "",
      home_city: tech.home_city ?? "",
      home_state: tech.home_state ?? "",
      coverage_area: tech.coverage_area ?? "",
    } satisfies TechnicianForm,
    // Ficha completa (endereço, jornada e serviços), como veio do Field Control.
    address: { line: tech.address_line ?? "", district: tech.address_district ?? "", zip: tech.address_zip ?? "" },
    schedule: {
      start: time(tech.work_schedule?.start),
      end: time(tech.work_schedule?.end),
      break_start: time(tech.work_schedule?.break_start),
      break_end: time(tech.work_schedule?.break_end),
    },
    serviceIds: (tech.services ?? []).map((s) => s.id),
    isActive: tech.is_active,
  };
}
type Editable = ReturnType<typeof editableOf>;
const snapshot = (value: Editable) => JSON.stringify({ ...value, serviceIds: [...value.serviceIds].sort() });

function EditDialog({ tech, onClose }: { tech: Technician; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const catalog = useOnboardingCatalog();
  const areas = useMemo(() => labelMap(catalog.data?.service_areas), [catalog.data]);
  const levels = useMemo(() => labelMap(catalog.data?.skill_levels), [catalog.data]);
  const [baseline] = useState(() => editableOf(tech));
  const [current, setCurrent] = useState(tech);
  const [form, setForm] = useState(baseline.form);
  const [isActive, setIsActive] = useState(baseline.isActive);
  const [address, setAddress] = useState(baseline.address);
  const [schedule, setSchedule] = useState(baseline.schedule);
  const [serviceIds, setServiceIds] = useState(baseline.serviceIds);
  const [confirmReset, setConfirmReset] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const serviceTypes = useServiceTypes({ active: true });
  // Parceiro recebe por chamado: o que ele tem a receber, sem sair do cadastro.
  const payouts = useQuery({
    queryKey: ["payouts", "technician", tech.id],
    queryFn: () => api.get<PayoutList>("/payouts", { technician_id: tech.id }),
    staleTime: 60_000,
  });
  const dirty = snapshot({ form, address, schedule, serviceIds, isActive }) !== snapshot(baseline);
  const emailChanged = form.email.trim().toLowerCase() !== tech.email.toLowerCase();
  const refresh = (t: Technician) => {
    setCurrent(t);
    refreshTechnicianViews(queryClient);
  };

  const save = useMutation({
    mutationFn: () =>
      api.patch<Technician>(`/technicians/${tech.id}`, {
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone || null,
        team_id: form.team_id || null,
        job_title: form.job_title || null,
        home_city: form.home_city || null,
        home_state: form.home_state || null,
        coverage_area: form.coverage_area || null,
        is_active: isActive,
        address_line: address.line.trim() || null,
        address_district: address.district.trim() || null,
        address_zip: address.zip.replace(/\D/g, "") || null,
        work_schedule:
          schedule.start || schedule.end
            ? {
                start: schedule.start || null,
                end: schedule.end || null,
                break_start: schedule.break_start || null,
                break_end: schedule.break_end || null,
              }
            : null,
        service_type_ids: serviceIds,
      }),
    onSuccess: (t) => {
      refresh(t);
      toast({ title: "Técnico atualizado", tone: "success" });
      onClose();
    },
  });
  const reset = useMutation({
    mutationFn: () => api.post<TemporaryPassword>(`/technicians/${tech.id}/reset-password`),
    onSuccess: (r) => refresh(r.technician),
  });
  const photo = useMutation({
    mutationFn: async (file: File | null) => {
      if (!file) return api.delete<Technician>(`/technicians/${tech.id}/photo`);
      // A foto do celular (4 a 10 MB) é reduzida aqui mesmo: chega com poucos KB e passa no limite de 2 MB.
      const blob = await resizePhotoBlob(file);
      const body = new FormData();
      body.append("file", new File([blob], "foto.jpg", { type: "image/jpeg" }));
      return api.upload<Technician>(`/technicians/${tech.id}/photo`, body);
    },
    onSuccess: (t, file) => {
      refresh(t);
      if (!file && t.avatar_url) {
        toast({ title: "Esta foto veio do Field Control e ainda não pode ser removida aqui.", tone: "error" });
      } else {
        toast({ title: file ? "Foto atualizada" : "Foto removida", tone: "success" });
      }
    },
    onError: (e) => toast({ title: errorMessage(e), tone: "error" }),
  });

  const requestClose = async () => {
    if (
      dirty &&
      !(await confirm({
        tone: "danger",
        title: "Descartar as alterações?",
        description: "O que você mudou neste técnico ainda não foi salvo.",
        confirmLabel: "Descartar",
        cancelLabel: "Continuar editando",
      }))
    ) {
      return;
    }
    onClose();
  };

  const submit = async () => {
    const found = validateTechnician(form);
    setProblem(found);
    if (found || save.isPending) return;
    if (tech.is_active && !isActive) {
      const open = current.open_tickets;
      const ok = await confirm({
        tone: "danger",
        title: `Desativar ${tech.name}?`,
        description: open
          ? `Ele sai do app na hora e some do mapa e das sugestões. As ${open} OS abertas dele continuam com ele: reatribua em Chamados.`
          : "Ele sai do app na hora e some do mapa e das sugestões.",
        confirmLabel: "Desativar",
      });
      if (!ok) return;
    }
    save.mutate();
  };

  if (reset.data) {
    return (
      <Dialog
        open
        onClose={onClose}
        title="Senha redefinida"
        description="As sessões abertas do técnico foram encerradas."
        footer={
          <Button variant="primary" onClick={onClose}>
            Concluir
          </Button>
        }
      >
        <TempPasswordPanel result={reset.data} />
      </Dialog>
    );
  }

  const summary = payouts.data?.summary;
  return (
    <Dialog
      open
      size="lg"
      onClose={requestClose}
      busy={save.isPending}
      title={current.name}
      description={current.job_title ?? "Técnico"}
      footer={
        <>
          <Button onClick={requestClose}>Cancelar</Button>
          <Button variant="primary" type="submit" form="tech-edit-form" loading={save.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      <form
        id="tech-edit-form"
        noValidate
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex items-center gap-4">
          <Avatar tech={current} size="lg" />
          <div className="flex flex-col gap-1.5">
            <label
              className={clsx(
                buttonClassName("secondary", "sm"),
                "cursor-pointer self-start has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/45",
                photo.isPending && "pointer-events-none opacity-60",
              )}
            >
              {photo.isPending ? <Loader2 className="size-4 animate-spin" /> : <Camera className="size-4" />}
              {photo.isPending ? "Enviando foto…" : current.avatar_url ? "Trocar foto" : "Adicionar foto"}
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                disabled={photo.isPending}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) photo.mutate(file);
                }}
              />
            </label>
            {current.avatar_url && !photo.isPending ? (
              <button
                type="button"
                className="self-start rounded text-xs text-red-700 hover:underline focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none dark:text-red-400"
                onClick={async () => {
                  if (await confirm({ tone: "danger", title: "Remover a foto?", description: "O técnico fica com as iniciais no lugar da foto.", confirmLabel: "Remover" })) {
                    photo.mutate(null);
                  }
                }}
              >
                Remover foto
              </button>
            ) : null}
            <span className="text-xs text-ink-muted">Foto do rosto. A foto é reduzida antes de enviar.</span>
          </div>
        </div>

        <TechnicianFields
          value={form}
          onChange={setForm}
          emailHint={emailChanged ? "O técnico passa a entrar no app com este e-mail." : undefined}
        />
        <div className="flex flex-col gap-1">
          <Checkbox label="Acesso ao app liberado" checked={isActive} onChange={setIsActive} />
          <p className="pl-6 text-xs text-ink-muted">
            {isActive
              ? "Ao desativar, ele sai do app na hora e some do mapa e das sugestões."
              : tech.is_active
                ? "Ao salvar, ele sai do app na hora."
                : "Sem acesso: não entra no app nem recebe OS novas."}
            {!isActive && current.open_tickets ? (
              <>
                {" "}
                <Link
                  href={`/chamados?assignee_id=${tech.id}&open_only=true`}
                  target="_blank"
                  className="font-medium text-ink underline underline-offset-2 hover:text-brand"
                >
                  Ver as {current.open_tickets} OS abertas dele
                </Link>
              </>
            ) : null}
          </p>
        </div>

        <section className="flex flex-col gap-3 rounded-lg border border-line p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SectionTitle>Ficha completa</SectionTitle>
            <p className="text-xs text-ink-muted">
              {current.base_city
                ? `Atua em ${regionText(current.base_city, current.base_state)} ${current.base_source === "history" ? `(pelo histórico, ${current.base_visits ?? 0} OS)` : "(pelo endereço)"}`
                : "Região de atuação ainda não identificada"}
              {current.last_visit_at ? ` · última visita ${formatDate(current.last_visit_at)}` : ""}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_8rem]">
            <Field label="Endereço (rua, número, complemento)">
              <Input value={address.line} onChange={(e) => setAddress((a) => ({ ...a, line: e.target.value }))} maxLength={255} />
            </Field>
            <Field label="Bairro">
              <Input value={address.district} onChange={(e) => setAddress((a) => ({ ...a, district: e.target.value }))} maxLength={120} />
            </Field>
            <Field label="CEP">
              <Input value={address.zip} onChange={(e) => setAddress((a) => ({ ...a, zip: e.target.value }))} inputMode="numeric" maxLength={9} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(
              [
                ["start", "Jornada: início"],
                ["end", "Jornada: fim"],
                ["break_start", "Intervalo: de"],
                ["break_end", "Intervalo: até"],
              ] as const
            ).map(([key, label]) => (
              <Field key={key} label={label}>
                <Input type="time" value={schedule[key]} onChange={(e) => setSchedule((s) => ({ ...s, [key]: e.target.value }))} />
              </Field>
            ))}
          </div>
          <ServicePicker
            value={serviceIds}
            onChange={setServiceIds}
            options={serviceTypes.data ?? []}
            saved={current.services ?? []}
            loading={serviceTypes.isLoading}
          />
          {current.legacy ? (
            <p className="text-xs text-ink-muted">
              Importado do Field Control{current.legacy.id ? ` · ID ${current.legacy.id}` : ""}
              {current.legacy.territories?.length ? ` · territórios: ${current.legacy.territories.join(", ")}` : ""}
            </p>
          ) : null}
        </section>

        {current.service_areas.length || current.skills.length || current.application_id ? (
          <section>
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-bold tracking-wide text-ink-muted uppercase">Perfil da homologação</h3>
              {current.application_id ? (
                <Link href={`/homologacao?ficha=${current.application_id}`} className={buttonClassName("ghost", "sm")}>
                  <BadgeCheck className="size-3.5" />
                  Ver ficha da homologação
                </Link>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {current.service_areas.map((k) => (
                <span key={k} className="rounded-full bg-nav-active px-2.5 py-0.5 text-xs font-medium text-brand-ink">
                  {areas[k] ?? k}
                </span>
              ))}
              {current.skills.map((s) => (
                <span key={s.name} className="rounded-full border border-line px-2.5 py-0.5 text-xs text-ink">
                  {s.name} · {levels[s.level] ?? s.level}
                </span>
              ))}
            </div>
          </section>
        ) : null}

        {summary && payouts.data?.items.length ? (
          <section className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-3">
            <div className="min-w-0">
              <SectionTitle>Pagamentos por chamado</SectionTitle>
              <p className="mt-1 text-xs text-ink-muted tabular-nums">
                A pagar <strong className="font-semibold text-ink">{formatMoney(summary.to_pay)}</strong> · Previsto{" "}
                {formatMoney(summary.expected)} · Pago {formatMoney(summary.paid)}
              </p>
            </div>
            <Link href="/pagamentos" className={buttonClassName("ghost", "sm")}>
              <Wallet className="size-3.5" />
              Ver em Pagamentos
            </Link>
          </section>
        ) : null}

        <section className="rounded-lg border border-line p-3">
          <SectionTitle>Acesso ao app</SectionTitle>
          <p className="mt-1 text-xs text-ink-muted">
            {current.location_consent_at ? (
              <span className="inline-flex items-center gap-1">
                <MapPinned className="size-3.5" /> Autorizou o GPS durante a jornada
              </span>
            ) : (
              "Ainda não autorizou o GPS (o app pede antes da primeira jornada; sem o aceite, não inicia a jornada)."
            )}
          </p>
          {confirmReset ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-sm text-ink">Gerar senha provisória e encerrar as sessões abertas?</span>
              <Button onClick={() => setConfirmReset(false)}>Não</Button>
              <Button variant="danger" loading={reset.isPending} onClick={() => reset.mutate()}>
                Sim, redefinir
              </Button>
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button onClick={() => setConfirmReset(true)} disabled={dirty}>
                <KeyRound className="size-4" />
                Redefinir senha
              </Button>
              {dirty ? <span className="text-xs text-ink-muted">Salve as alterações antes de redefinir a senha.</span> : null}
            </div>
          )}
        </section>

        {problem || save.error || reset.error ? (
          <ErrorBox message={problem ?? errorMessage(save.error ?? reset.error)} />
        ) : null}
      </form>
    </Dialog>
  );
}

// Etiquetas dos serviços marcados: acima disso, só a contagem (há técnico com quase 200 serviços).
const SERVICE_CHIPS = 24;

/** "Serviços que faz": busca, marcar os filtrados e etiquetas do que está marcado agora (não do que foi salvo). */
function ServicePicker({
  value,
  onChange,
  options,
  saved,
  loading,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  options: { id: string; name: string }[];
  /** Serviços salvos no cadastro (inclui tipos que foram desativados, para poder desmarcar). */
  saved: { id: string; name: string }[];
  loading: boolean;
}) {
  const [term, setTerm] = useState("");
  const all = useMemo(() => {
    const known = new Set(options.map((o) => o.id));
    return [...options, ...saved.filter((s) => !known.has(s.id))];
  }, [options, saved]);
  const names = useMemo(() => new Map(all.map((o) => [o.id, o.name])), [all]);
  const visible = useMemo(() => {
    const t = fold(term.trim());
    return t ? all.filter((o) => fold(o.name).includes(t)) : all;
  }, [all, term]);
  const selected = new Set(value);
  const toggle = (id: string) => onChange(selected.has(id) ? value.filter((v) => v !== id) : [...value, id]);
  const markVisible = () => onChange([...new Set([...value, ...visible.map((o) => o.id)])]);
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1.5 text-xs font-semibold text-ink/80">
        Serviços que faz <span className="font-normal text-ink-muted tabular-nums">({value.length})</span>
      </legend>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted" />
          <Input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => {
              // Enter na busca não salva o cadastro.
              if (e.key === "Enter") e.preventDefault();
            }}
            placeholder="Buscar serviço"
            className="pl-9"
            aria-label="Buscar serviço"
          />
        </div>
        <Button size="sm" variant="ghost" onClick={markVisible} disabled={!visible.length}>
          {term.trim() ? "Marcar os filtrados" : "Marcar todos"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onChange([])} disabled={!value.length}>
          Limpar
        </Button>
      </div>
      <div className="max-h-56 overflow-y-auto rounded-lg border border-line p-1">
        {loading ? (
          <p className="px-2 py-1.5 text-xs text-ink-muted">Carregando os serviços…</p>
        ) : visible.length ? (
          visible.map((o) => (
            <label key={o.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm text-ink hover:bg-surface-2">
              <input
                type="checkbox"
                checked={selected.has(o.id)}
                onChange={() => toggle(o.id)}
                className="size-4 shrink-0 rounded border-line accent-[var(--brand)]"
              />
              <span className="min-w-0 truncate">{o.name}</span>
            </label>
          ))
        ) : (
          <p className="px-2 py-1.5 text-xs text-ink-muted">Nenhum serviço com “{term.trim()}”.</p>
        )}
      </div>
      {value.length ? (
        <div className="flex flex-wrap gap-1">
          {value.slice(0, SERVICE_CHIPS).map((id) => {
            const name = names.get(id) ?? "Serviço";
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 rounded-md bg-surface-2 py-0.5 pr-0.5 pl-1.5 text-[11px] text-ink-muted ring-1 ring-line ring-inset"
              >
                {name}
                <button
                  type="button"
                  onClick={() => toggle(id)}
                  className="rounded p-0.5 hover:bg-surface-3 hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none"
                  aria-label={`Tirar ${name}`}
                >
                  <X className="size-3" />
                </button>
              </span>
            );
          })}
          {value.length > SERVICE_CHIPS ? (
            <span className="self-center text-[11px] text-ink-muted">+{value.length - SERVICE_CHIPS}</span>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-ink-muted">Nenhum serviço marcado.</p>
      )}
    </fieldset>
  );
}

const TEMPLATE: string[][] = [
  ["nome", "email", "telefone", "grupo", "cargo", "cidade", "uf", "regiao"],
  ["Maria Exemplo", "maria@exemplo.com.br", "(11) 90000-0000", "Campo - Infraestrutura", "Técnico de campo", "Santos", "SP", "Santos, São Vicente e Guarujá"],
];

function ImportDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [file, setFile] = useState<File | null>(null);
  // As senhas provisórias só aparecem uma vez: sair sem baixar obriga a redefinir uma a uma.
  const [downloaded, setDownloaded] = useState(false);
  const run = useMutation({
    mutationFn: (dryRun: boolean) => {
      const body = new FormData();
      body.append("file", file as File);
      return api.upload<ImportResult>(`/technicians/import?dry_run=${dryRun}`, body);
    },
    onSuccess: (r) => {
      if (!r.dry_run) refreshTechnicianViews(queryClient);
    },
  });
  const result = run.data;
  const done = result && !result.dry_run;
  const requestClose = async () => {
    if (
      done &&
      result.credentials.length &&
      !downloaded &&
      !(await confirm({
        tone: "danger",
        title: "Sair sem baixar as senhas?",
        description: "As senhas provisórias não aparecem de novo: será preciso redefinir a senha de cada técnico novo.",
        confirmLabel: "Sair sem baixar",
        cancelLabel: "Voltar e baixar",
      }))
    ) {
      return;
    }
    onClose();
  };

  return (
    <Dialog
      open
      size="lg"
      onClose={requestClose}
      title="Importar técnicos"
      description="Planilha CSV ou Excel (XLSX) com nome, e-mail, telefone, grupo, cargo, cidade, UF e região."
      footer={
        done ? (
          <Button variant="primary" onClick={requestClose}>
            Concluir
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancelar</Button>
            {result?.dry_run ? (
              <Button
                variant="primary"
                loading={run.isPending}
                disabled={result.created + result.updated === 0}
                onClick={() => run.mutate(false)}
              >
                Importar {result.created + result.updated} técnico(s)
              </Button>
            ) : (
              <Button variant="primary" loading={run.isPending} disabled={!file} onClick={() => run.mutate(true)}>
                Ver prévia
              </Button>
            )}
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {!done ? (
          <div className="flex flex-wrap items-center gap-2">
            <label
              className={clsx(
                buttonClassName("secondary"),
                "max-w-full cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/45",
              )}
            >
              <FileSpreadsheet className="size-4 shrink-0" />
              <span className="truncate">{file ? file.name : "Escolher arquivo"}</span>
              <input
                type="file"
                accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="sr-only"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  run.reset();
                }}
              />
            </label>
            <Button variant="ghost" onClick={() => downloadCsv("modelo-tecnicos.csv", TEMPLATE)}>
              <Download className="size-4" />
              Baixar modelo
            </Button>
          </div>
        ) : null}
        <p className="text-xs text-ink-muted">
          E-mail novo cria o técnico com senha provisória; e-mail de técnico já cadastrado atualiza nome, telefone, grupo,
          cargo, cidade, UF e região (a senha não muda). Nada é gravado antes de você confirmar a prévia.
        </p>

        {result ? (
          <>
            <div className="flex flex-wrap gap-2 text-sm">
              <Count label={result.dry_run ? "Serão criados" : "Criados"} value={result.created} />
              <Count label={result.dry_run ? "Serão atualizados" : "Atualizados"} value={result.updated} />
              <Count label="Com erro (ignorados)" value={result.errors} problem={result.errors > 0} />
            </div>
            {done && result.credentials.length ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
                <p className="font-semibold">Baixe agora as senhas provisórias dos novos técnicos.</p>
                <p className="mt-0.5 text-xs">Por segurança, elas não aparecem de novo. Guarde o arquivo em local seguro e apague depois de enviar.</p>
                <Button
                  className="mt-2"
                  onClick={() => {
                    downloadCsv("senhas-provisorias-tecnicos.csv", [
                      ["nome", "email", "senha_provisoria"],
                      ...result.credentials.map((c) => [c.name, c.email, c.temporary_password]),
                    ]);
                    setDownloaded(true);
                  }}
                >
                  {downloaded ? <Check className="size-4" /> : <Download className="size-4" />}
                  {downloaded ? "Senhas baixadas" : `Baixar senhas (${result.credentials.length})`}
                </Button>
              </div>
            ) : null}
            <div className="max-h-72 overflow-auto rounded-lg border border-line">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-surface-2 text-ink-muted">
                  <tr>
                    <th className="px-2 py-1.5 font-semibold">Linha</th>
                    <th className="px-2 py-1.5 font-semibold">Técnico</th>
                    <th className="px-2 py-1.5 font-semibold">Grupo</th>
                    <th className="px-2 py-1.5 font-semibold">Resultado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {result.rows.map((r) => (
                    <tr key={r.line}>
                      <td className="px-2 py-1.5 tabular-nums text-ink-muted">{r.line}</td>
                      <td className="px-2 py-1.5">
                        <span className="block font-semibold text-ink">{r.name || "—"}</span>
                        <span className="text-ink-muted">{r.email}</span>
                      </td>
                      <td className="px-2 py-1.5 text-ink-muted">{r.team ?? "—"}</td>
                      <td className="px-2 py-1.5">
                        {r.action === "error" ? (
                          <span className="text-red-700 dark:text-red-400">{r.errors.join(" · ")}</span>
                        ) : r.action === "create" ? (
                          <span className="font-medium text-ink">Novo</span>
                        ) : (
                          <span className="text-ink-muted">Atualizar</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
        {run.error ? <ErrorBox message={errorMessage(run.error)} /> : null}
      </div>
    </Dialog>
  );
}

/** Contador da prévia: neutro; vermelho só quando há erro. */
function Count({ label, value, problem = false }: { label: string; value: number; problem?: boolean }) {
  return (
    <span
      className={clsx(
        "rounded-lg px-3 py-1.5",
        problem ? "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300" : "bg-surface-2 text-ink",
      )}
    >
      {label}: <strong className="tabular-nums">{value}</strong>
    </span>
  );
}
