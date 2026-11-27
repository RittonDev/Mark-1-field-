"use client";

import { type UseMutationResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BadgeCheck,
  Building2,
  Car,
  CheckCircle2,
  CopyPlus,
  Eye,
  IdCard,
  KeyRound,
  Link2,
  Mail,
  MailCheck,
  MapPin,
  MessageCircle,
  Phone,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  SquarePen,
  Trash2,
  UserCheck,
  UserX,
  Users,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { MultiSelect } from "@/components/MultiSelect";
import { Tabs } from "@/components/motion";
import { NoAccess } from "@/components/NoAccess";
import { fold, isUuid, replaceSearch, useSearchChange } from "@/components/operacao/hooks";
import { DocumentRow } from "@/components/technicians/documents/DocumentRow";
import { TempPasswordPanel } from "@/components/technicians/GrantAccessDialog";
import {
  InviteDialog,
  type InvitePreset,
  InviteShareDialog,
  inviteUsesLabel,
} from "@/components/technicians/InviteDialog";
import { refreshTechnicianViews } from "@/components/technicians/refresh";
import { isPlainClick } from "@/components/ticket/TicketLink";
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
  Pill,
  Select,
  Table,
  Td,
  Textarea,
  Th,
} from "@/components/ui";
import { useNow } from "@/components/useNow";
import { absoluteApiUrl, api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatPlate, isManager, isSendableEmail, SKILL_LEVEL } from "@/lib/constants";
import { DOCUMENT_REFRESH_MS, findFileUrl, sortDocuments } from "@/lib/documents";
import { formatDate, formatDateTime, formatDocument, initials } from "@/lib/format";
import { labelMap, useOnboardingCatalog } from "@/lib/onboarding";
import { useCan } from "@/lib/permissions";
import { useMailEnabled, useTechCatalog } from "@/lib/queries";
import { REVIEW_ACTION_LABEL, technicianHref } from "@/lib/technicians";
import type {
  ApplicationApproved,
  ApplicationDetail,
  ApplicationReview,
  ApplicationStatus,
  ApplicationSummary,
  EmailQueued,
  InviteState,
  OnboardingInvite,
  SkillLevel,
  TechnicianRegion,
  TemporaryPassword,
  User,
  UUID,
} from "@/lib/types";
import { whatsappUrl } from "@/lib/whatsapp";

type Tab = ApplicationStatus | "links";

const TABS: { key: Tab; label: string }[] = [
  { key: "pending", label: "Pendentes" },
  { key: "approved", label: "Aprovadas" },
  { key: "rejected", label: "Reprovadas" },
  { key: "links", label: "Links de cadastro" },
];

/** A aba na URL (`?aba=`); sem ela, Pendentes. */
const TAB_PARAM: Record<Tab, string | null> = { pending: null, approved: "aprovadas", rejected: "reprovadas", links: "links" };

/**
 * O que a lista guarda na URL (aba, busca, UF, áreas e "Com veículo"): recarregar, mandar o link e o Voltar mantêm. O que
 * não se reconhece fica vazio.
 */
interface ListUrl {
  tab: Tab;
  q: string;
  uf: string;
  areas: string[];
  vehicle: boolean;
}

function readListUrl(params: Pick<URLSearchParams, "get">): ListUrl {
  const aba = params.get("aba");
  const uf = (params.get("uf") ?? "").trim().toUpperCase();
  return {
    tab: (Object.keys(TAB_PARAM) as Tab[]).find((key) => aba !== null && TAB_PARAM[key] === aba) ?? "pending",
    q: params.get("q") ?? "",
    uf: /^[A-Z]{2}$/.test(uf) ? uf : "",
    areas: [
      ...new Set(
        (params.get("area") ?? "")
          .split(",")
          .map((key) => key.trim())
          .filter(Boolean),
      ),
    ],
    vehicle: params.get("veiculo") === "sim",
  };
}

/** A ficha aberta por esta tela (o Voltar e o Fechar a tiram da URL). */
type FichaState = { mfFicha?: string } | null;

// Cores dos estados: neutro no que é normal; vermelho só no que foi cancelado ou recusado.
const NEUTRAL = "#64748b";
const DANGER = "#dc2626";
const BRAND = "#2447ff";

const INVITE_STATE: Record<InviteState, { label: string; color: string }> = {
  active: { label: "Ativo", color: BRAND },
  used: { label: "Usado", color: NEUTRAL },
  expired: { label: "Expirado", color: NEUTRAL },
  revoked: { label: "Revogado", color: DANGER },
};

const APPLICATION_STATE: Record<ApplicationStatus, { label: string; color: string }> = {
  pending: { label: "Aguardando análise", color: NEUTRAL },
  approved: { label: "Aprovado: está na base técnica", color: NEUTRAL },
  rejected: { label: "Reprovado", color: DANGER },
};

// Ficha esperando há mais que isso: o atraso aparece em vermelho.
const WAITING_DAYS_ALERT = 7;

const firstName = (name: string) => name.trim().split(/\s+/)[0];
const years = (n: number) => `${n} ${n === 1 ? "ano" : "anos"}`;
/** Desde quando a ficha espera análise: a reaberta conta da reabertura (como a exclusão automática). */
const waitingSince = (a: ApplicationSummary) => a.reopened_at ?? a.created_at;

/** Motivo de reabrir: de 3 a 500 caracteres (o mesmo da API). */
const REOPEN_MAX = 500;

export default function OnboardingPage() {
  // A ficha pode chegar aberta pela URL (?ficha=, ex.: "Ver ficha da homologação" no cadastro do técnico).
  return (
    <Suspense fallback={<LoadingBlock />}>
      <OnboardingView />
    </Suspense>
  );
}

function OnboardingView() {
  // Visualizar: as fichas, os links e o que cada candidato mandou. Editar: gerar e revogar links,
  // aprovar e reprovar.
  const canView = useCan("base.onboarding");
  const canEdit = useCan("base.onboarding", "edit");
  const searchParams = useSearchParams();
  const now = useNow(60_000);
  // A aba e os filtros ficam na URL (por replaceSearch, sem entrada no histórico).
  const [initial] = useState(() => readListUrl(searchParams));
  const [tab, setTab] = useState<Tab>(initial.tab);
  const [q, setQ] = useState(initial.q);
  const [uf, setUf] = useState(initial.uf);
  const [areaFilter, setAreaFilter] = useState<string[]>(initial.areas);
  const [withVehicle, setWithVehicle] = useState(initial.vehicle);
  // A URL mudou com a tela aberta (o link do menu, Voltar, um link com outros filtros): mostra o que ela diz.
  const urlChange = useSearchChange();
  if (urlChange) {
    const next = readListUrl(urlChange);
    if (next.tab !== tab) setTab(next.tab);
    if (next.q !== q) setQ(next.q);
    if (next.uf !== uf) setUf(next.uf);
    if (next.areas.join(",") !== areaFilter.join(",")) setAreaFilter(next.areas);
    if (next.vehicle !== withVehicle) setWithVehicle(next.vehicle);
  }
  useEffect(() => {
    replaceSearch({
      aba: TAB_PARAM[tab],
      q: q || null,
      uf: uf || null,
      area: areaFilter.length ? areaFilter.join(",") : null,
      veiculo: withVehicle ? "sim" : null,
    });
  }, [tab, q, uf, areaFilter, withVehicle]);
  // A ficha aberta é a da URL (?ficha=): abrir por aqui cria uma entrada no histórico (o Voltar fecha), e recarregar ou
  // mandar o link mantém; o "Ver ficha da homologação" da ficha do técnico chega com ela.
  const fichaParam = searchParams.get("ficha");
  const openedId = isUuid(fichaParam) ? fichaParam : null;
  // Fechando pelo Voltar: até a URL mudar, um segundo Esc não pode voltar mais uma entrada (sairia da tela).
  const closingRef = useRef(false);
  useEffect(() => {
    closingRef.current = false;
  }, [openedId]);
  // Convite aberto: novo (sem dados) ou "gerar outro igual" a um link da lista.
  const [inviting, setInviting] = useState<{ preset?: InvitePreset } | null>(null);
  const catalog = useOnboardingCatalog();
  const areas = useMemo(() => labelMap(catalog.data?.service_areas), [catalog.data]);
  // O filtro de áreas: as ativas do catálogo (API de antes da Entrega 2: as fixas da ficha, pelo código).
  const areaCatalog = useTechCatalog("areas", true);

  const applications = useQuery({
    queryKey: ["onboarding", "applications", tab],
    queryFn: () => api.get<ApplicationSummary[]>("/onboarding/applications", { status: tab }),
    enabled: canView && tab !== "links",
  });
  const pending = useQuery({
    queryKey: ["onboarding", "pending-count"],
    queryFn: () => api.get<{ pending: number }>("/onboarding/applications/pending-count"),
    enabled: canView,
  });

  const all = useMemo(() => applications.data ?? [], [applications.data]);
  const ufs = useMemo(() => [...new Set(all.map((a) => a.state))].sort(), [all]);
  const rows = useMemo(() => {
    const term = fold(q.trim());
    const digits = q.replace(/\D/g, "");
    const list = all.filter(
      (a) =>
        (!term ||
          fold(`${a.full_name} ${a.email} ${a.city}`).includes(term) ||
          (digits.length >= 3 && a.phone.replace(/\D/g, "").includes(digits))) &&
        (!uf || a.state === uf) &&
        (!areaFilter.length || areaFilter.some((k) => a.service_areas.includes(k))) &&
        (!withVehicle || a.has_vehicle),
    );
    // Pendentes: quem espera há mais tempo é analisado primeiro. Analisadas: as mais recentes em cima.
    return tab === "pending"
      ? list.sort((a, b) => waitingSince(a).localeCompare(waitingSince(b)))
      : list.sort((a, b) => (b.reviewed_at ?? b.created_at).localeCompare(a.reviewed_at ?? a.created_at));
  }, [all, q, uf, areaFilter, withVehicle, tab]);
  const filtering = !!(q.trim() || uf || areaFilter.length || withVehicle);
  const clearFilters = () => {
    setQ("");
    setUf("");
    setAreaFilter([]);
    setWithVehicle(false);
  };
  const closeApplication = () => {
    setOpenedId(null);
    if (searchParams.get("ficha")) replaceSearch({ ficha: null });
  };

  if (!canView) return <NoAccess kind="module" item="base.onboarding" />;

  return (
    <div>
      <PageHeader
        title="Homologação"
        description="Fichas enviadas pelos técnicos pelo link de cadastro. Aprovada, a pessoa entra na base técnica e já acessa o app."
        actions={
          canEdit ? (
            <Button variant="primary" onClick={() => setInviting({})}>
              <Link2 className="size-4" />
              Gerar link de cadastro
            </Button>
          ) : undefined
        }
      />

      <Tabs
        className="mb-4 border-b border-line"
        items={TABS.map((t) => ({ ...t, count: t.key === "pending" ? (pending.data?.pending ?? null) : null }))}
        value={tab}
        onChange={setTab}
        ariaLabel="Fichas e links"
        idPrefix="homologacao"
      />

      {tab === "links" ? (
        <div role="tabpanel" id="homologacao-panel-links" aria-labelledby="homologacao-tab-links">
          <InvitesTab canEdit={canEdit} onCreate={(preset) => setInviting({ preset })} />
        </div>
      ) : (
        <div role="tabpanel" id={`homologacao-panel-${tab}`} aria-labelledby={`homologacao-tab-${tab}`}>
          {all.length || filtering ? (
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <div className="relative min-w-56 flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted" />
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Buscar por nome, e-mail, telefone ou cidade"
                  className="pl-9"
                  aria-label="Buscar ficha"
                />
              </div>
              <div className="w-full sm:w-36">
                <Select value={uf} onChange={(e) => setUf(e.target.value)} aria-label="UF">
                  <option value="">Todas as UFs</option>
                  {(uf && !ufs.includes(uf) ? [uf, ...ufs] : ufs).map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="w-full sm:w-60">
                <MultiSelect
                  label="Áreas de atuação"
                  ariaLabel="Áreas de atuação"
                  value={areaFilter}
                  onChange={setAreaFilter}
                  options={(catalog.data?.service_areas ?? []).map((s) => ({ value: s.key, label: s.label }))}
                />
              </div>
              <Checkbox label="Com veículo" checked={withVehicle} onChange={setWithVehicle} />
            </div>
          ) : null}
          <Card>
            {applications.isLoading ? (
              <LoadingBlock />
            ) : applications.error ? (
              <div className="p-4">
                <ErrorBox message={errorMessage(applications.error)} />
              </div>
            ) : rows.length === 0 ? (
              filtering ? (
                <EmptyState
                  icon={<BadgeCheck className="size-6" />}
                  title="Nenhuma ficha com estes filtros"
                  action={<Button onClick={clearFilters}>Limpar filtros</Button>}
                />
              ) : (
                <EmptyState
                  icon={<BadgeCheck className="size-6" />}
                  title={tab === "pending" ? "Nenhuma ficha aguardando análise" : "Nenhuma ficha aqui"}
                  description={
                    tab === "pending" && canEdit
                      ? "Gere um link de cadastro e envie ao técnico pelo WhatsApp. A ficha dele aparece aqui na hora."
                      : undefined
                  }
                  action={
                    tab === "pending" && canEdit ? (
                      <Button onClick={() => setInviting({})}>
                        <Link2 className="size-4" />
                        Gerar link
                      </Button>
                    ) : undefined
                  }
                />
              )
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Técnico</Th>
                    <Th className="hidden md:table-cell">Região</Th>
                    <Th className="hidden lg:table-cell">Atuação</Th>
                    <Th className="hidden sm:table-cell">Experiência</Th>
                    <Th>{tab === "pending" ? "Enviada" : "Analisada"}</Th>
                    <Th className="edit-col">{canEdit ? "Analisar" : "Ver"}</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => {
                    const waitingDays = Math.floor((now - new Date(waitingSince(a)).getTime()) / 86_400_000);
                    return (
                      <tr
                        key={a.id}
                        className="cursor-pointer transition-colors hover:bg-[var(--row-hover)]"
                        onClick={(e) => {
                          if (e.currentTarget.contains(e.target as Node)) setOpenedId(a.id);
                        }}
                      >
                        <Td>
                          <span className="flex items-center gap-2.5">
                            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand-ink">
                              {initials(a.full_name)}
                            </span>
                            <span className="min-w-0">
                              <span className="flex min-w-0 items-center gap-1.5">
                                <span className="truncate font-semibold text-ink">{a.full_name}</span>
                                {a.status === "pending" && a.reopened_at ? (
                                  <span title={`Reaberta em ${formatDateTime(a.reopened_at)}`} className="inline-flex shrink-0">
                                    <Pill color={NEUTRAL}>Reaberta</Pill>
                                  </span>
                                ) : null}
                              </span>
                              <span className="flex min-w-0 items-center gap-1 text-xs text-ink-muted">
                                <span className="truncate">{a.email}</span>
                                {/* Sem o campo (API antiga), nada: não dá para dizer se validou. Aprovada, a validação
                                    passa a ser do técnico (fica na ficha dele), e a da ficha para de valer. */}
                                {a.status === "approved" ? null : a.email_verified_at ? (
                                  <span role="img" aria-label="E-mail validado" title="E-mail validado" className="inline-flex shrink-0">
                                    <MailCheck aria-hidden className="size-3.5 text-ink-muted" />
                                  </span>
                                ) : a.email_verified_at === null ? (
                                  <span className="shrink-0">· e-mail pendente</span>
                                ) : null}
                              </span>
                            </span>
                          </span>
                        </Td>
                        <Td className="hidden md:table-cell">
                          {a.city}-{a.state}
                        </Td>
                        <Td className="hidden lg:table-cell">
                          <span className="line-clamp-2 text-xs text-ink-muted">
                            {a.service_areas.map((k) => areas[k] ?? k).join(" · ")}
                          </span>
                        </Td>
                        <Td className="hidden sm:table-cell">
                          {a.years_experience != null ? years(a.years_experience) : "—"}
                          {a.has_vehicle ? (
                            <Car className="ml-1.5 inline size-3.5 text-ink-muted" aria-label="Com veículo" />
                          ) : null}
                        </Td>
                        <Td className="text-xs whitespace-nowrap text-ink-muted">
                          {tab === "pending" ? (
                            <>
                              <span className="block">{formatDate(a.created_at)}</span>
                              <span
                                className={
                                  waitingDays > WAITING_DAYS_ALERT ? "font-medium text-red-700 dark:text-red-400" : undefined
                                }
                              >
                                {a.reopened_at ? "reaberta " : ""}
                                {waitingDays < 1 ? "hoje" : `há ${waitingDays} ${waitingDays === 1 ? "dia" : "dias"}`}
                              </span>
                            </>
                          ) : (
                            formatDateTime(a.reviewed_at ?? a.created_at)
                          )}
                        </Td>
                        <Td className="edit-col">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenedId(a.id);
                            }}
                            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-brand shadow-elev-1 transition-[border-color,background-color] duration-150 hover:border-brand/40 hover:bg-brand-soft focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none"
                            aria-label={`${canEdit ? "Analisar" : "Ver"} a ficha de ${a.full_name}`}
                            title={canEdit ? "Analisar a ficha" : "Ver a ficha"}
                          >
                            {canEdit ? <SquarePen className="size-4" /> : <Eye className="size-4" />}
                          </button>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      )}

      {inviting ? <InviteDialog preset={inviting.preset} onClose={() => setInviting(null)} /> : null}
      {openedId ? <ApplicationDialog key={openedId} id={openedId} canEdit={canEdit} onClose={closeApplication} /> : null}
    </div>
  );
}

/** Links de cadastro. Sem `canEdit` (só Visualizar): a lista e o reenvio do link ativo, sem gerar nem revogar. */
function InvitesTab({ canEdit, onCreate }: { canEdit: boolean; onCreate: (preset?: InvitePreset) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  // Link ativo aberto para copiar e enviar de novo.
  const [sharing, setSharing] = useState<OnboardingInvite | null>(null);
  const invites = useQuery({
    queryKey: ["onboarding", "invites"],
    queryFn: () => api.get<OnboardingInvite[]>("/onboarding/invites"),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/onboarding/invites/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["onboarding", "invites"] });
      toast({ title: "Link revogado", tone: "success" });
    },
    onError: (e) => toast({ title: errorMessage(e), tone: "error" }),
  });
  const askRevoke = async (invite: OnboardingInvite) => {
    const ok = await confirm({
      tone: "danger",
      title: "Revogar este link?",
      description: "Quem abrir o link verá “Link indisponível”. As fichas já enviadas continuam na Homologação.",
      confirmLabel: "Revogar",
    });
    if (ok) revoke.mutate(invite.id);
  };

  return (
    <Card>
      {invites.isLoading ? (
        <LoadingBlock />
      ) : invites.error ? (
        <div className="p-4">
          <ErrorBox message={errorMessage(invites.error)} />
        </div>
      ) : (invites.data ?? []).length === 0 ? (
        <EmptyState
          icon={<Link2 className="size-6" />}
          title="Nenhum link gerado"
          description="O link de cadastro vai pelo WhatsApp: o técnico preenche a ficha no celular."
          action={canEdit ? <Button onClick={() => onCreate()}>Gerar link</Button> : undefined}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Link</Th>
              <Th>Situação</Th>
              <Th className="hidden sm:table-cell">Fichas</Th>
              <Th className="hidden md:table-cell">Expira em</Th>
              <Th className="hidden lg:table-cell">Criado por</Th>
              <Th className="edit-col">Ações</Th>
            </tr>
          </thead>
          <tbody>
            {(invites.data ?? []).map((i) => (
              <tr key={i.id} className="transition-colors hover:bg-[var(--row-hover)]">
                <Td>
                  <span className="block font-semibold text-ink">{i.label ?? "Sem identificação"}</span>
                  <span className="text-xs text-ink-muted">{inviteUsesLabel(i.max_uses)}</span>
                </Td>
                <Td>
                  <Pill color={INVITE_STATE[i.state].color}>{INVITE_STATE[i.state].label}</Pill>
                </Td>
                <Td className="hidden tabular-nums sm:table-cell">
                  {i.use_count}
                  {i.max_uses != null && i.max_uses > 1 ? <span className="text-ink-muted"> de {i.max_uses}</span> : null}
                </Td>
                <Td className="hidden text-xs text-ink-muted md:table-cell">{formatDateTime(i.expires_at)}</Td>
                <Td className="hidden text-xs text-ink-muted lg:table-cell">{i.created_by?.name ?? "—"}</Td>
                <Td className="edit-col">
                  <span className="flex items-center justify-end gap-1">
                    {i.state === "active" && i.url ? (
                      <Button size="sm" variant="ghost" onClick={() => setSharing(i)} title="Copiar e enviar este link de novo">
                        <Send className="size-3.5" />
                        Enviar
                      </Button>
                    ) : null}
                    {canEdit ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        // Uso único tem max_uses 1; reutilizável não tem limite ou tem um limite maior que 1.
                        onClick={() => onCreate({ label: i.label, reusable: i.max_uses !== 1, maxUses: i.max_uses !== 1 ? i.max_uses : null })}
                        aria-label={`Gerar outro link igual a ${i.label ?? "este"}`}
                        title="Gerar outro link com a mesma identificação e o mesmo tipo"
                      >
                        <CopyPlus className="size-3.5" />
                        <span className="hidden xl:inline">Gerar outro igual</span>
                      </Button>
                    ) : null}
                    {canEdit && i.state === "active" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => askRevoke(i)}
                        loading={revoke.isPending && revoke.variables === i.id}
                      >
                        Revogar
                      </Button>
                    ) : null}
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {sharing ? <InviteShareDialog invite={sharing} onClose={() => setSharing(null)} /> : null}
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-xs font-bold tracking-wide text-ink-muted uppercase">{title}</h3>
      <div className="flex flex-col gap-1.5 text-sm text-ink">{children}</div>
    </section>
  );
}

function Line({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0 text-ink-muted">{icon}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/** Foto da ficha; sem foto (ou com o link vencido), as iniciais. */
function ApplicantPhoto({ name, url }: { name: string; url: string | null }) {
  const src = absoluteApiUrl(url);
  const [broken, setBroken] = useState(false);
  return (
    <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-soft text-lg font-semibold text-brand-ink">
      {src && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element -- link assinado da API
        <img src={src} alt={`Foto de ${name}`} onError={() => setBroken(true)} className="size-full object-cover" />
      ) : (
        initials(name)
      )}
    </div>
  );
}

/**
 * Resultado da análise: o diálogo fica aberto para avisar o candidato pelo WhatsApp. Aprovada: o técnico criado, o
 * e-mail de boas-vindas (`welcome` null com a API antiga, que não manda) e se ele leva o link de criar senha.
 */
type Approved = { technician: User; welcome: EmailQueued | null; passwordLink: boolean };
type Outcome = ({ kind: "approved" } & Approved) | { kind: "rejected" };

/**
 * A resposta do Aprovar: a API nova manda o técnico, a boas-vindas e `password_link` (o link de criar senha vai só com o
 * e-mail validado); a antiga, só o usuário. Sem `password_link` (API de antes dele), o link ia com toda boas-vindas.
 */
function approvedOf(body: ApplicationApproved | User): Approved {
  if (!("technician" in body)) return { technician: body, welcome: null, passwordLink: false };
  const welcome = body.welcome ?? null;
  return { technician: body.technician, welcome, passwordLink: body.password_link ?? welcome?.status === "queued" };
}

/** "Reprovada · 20/11/2026 14:32 · por Ana"; a expirada, sem autor. */
function reviewLine(review: ApplicationReview): string {
  const by = review.action !== "expired" && review.by ? ` · por ${review.by.name}` : "";
  return `${REVIEW_ACTION_LABEL[review.action] ?? review.action} · ${formatDateTime(review.at)}${by}`;
}

/** Ficha do candidato. Sem `canEdit` (Homologação só com Visualizar): consulta, sem aprovar, reprovar, reabrir nem excluir. */
function ApplicationDialog({ id, canEdit, onClose }: { id: string; canEdit: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  // "Abrir ficha do técnico" leva a Técnicos: só com acesso a essa tela.
  const canTechnicians = useCan("base.technicians");
  const { toast } = useToast();
  const confirm = useConfirm();
  const catalog = useOnboardingCatalog();
  // Envio de e-mail ligado no servidor: undefined enquanto não se sabe; false desligado (ou API antiga).
  const mailEnabled = useMailEnabled();
  const [mode, setMode] = useState<"view" | "reject" | "reopen">("view");
  const [reason, setReason] = useState("");
  const [reopenReason, setReopenReason] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const detail = useQuery({
    queryKey: ["onboarding", "application", id],
    queryFn: () => api.get<ApplicationDetail>(`/onboarding/applications/${id}`),
  });
  // Quantos técnicos ativos já atendem a cidade e a UF do candidato (para decidir se a região precisa dele).
  const regions = useQuery({
    queryKey: ["technicians", "regions", "true"],
    queryFn: () => api.get<TechnicianRegion[]>("/technicians/regions", { active: "true" }),
    staleTime: 60_000,
  });
  const decided = () => {
    void queryClient.invalidateQueries({ queryKey: ["onboarding"] });
    refreshTechnicianViews(queryClient);
  };
  // Aprovar é um passo só (a confirmação diz o que acontece com o e-mail): grupo e cargo ficam para a ficha do técnico.
  const approve = useMutation({
    mutationFn: () => api.post<ApplicationApproved | User>(`/onboarding/applications/${id}/approve`, {}),
    onSuccess: (body) => {
      decided();
      setOutcome({ kind: "approved", ...approvedOf(body) });
    },
  });
  const reject = useMutation({
    mutationFn: () => api.post(`/onboarding/applications/${id}/reject`, { reason: reason.trim() }),
    onSuccess: () => {
      decided();
      setOutcome({ kind: "rejected" });
    },
  });
  // A reprovada (ou expirada) volta para Pendentes: o diálogo segue com ela, já pendente.
  const reopen = useMutation({
    mutationFn: () => api.post<ApplicationDetail>(`/onboarding/applications/${id}/reopen`, { reason: reopenReason.trim() }),
    onSuccess: (updated) => {
      queryClient.setQueryData(["onboarding", "application", id], updated);
      void queryClient.invalidateQueries({ queryKey: ["onboarding"] });
      setMode("view");
      setReopenReason("");
      toast({ title: "Ficha reaberta: está em Pendentes", tone: "success" });
    },
  });
  const resend = useMutation({
    mutationFn: () => api.post<EmailQueued>(`/onboarding/applications/${id}/email-verification`),
    onSuccess: (sent) => {
      const to = sent.to ?? detail.data?.email ?? "";
      if (sent.status === "queued") toast({ title: `Validação enviada para ${to}`, tone: "success" });
      else if (sent.status === "not_configured") toast({ title: "E-mail não enviado: envio de e-mail desligado", tone: "error" });
      else toast({ title: "E-mail não enviado: este endereço não recebe mensagens", tone: "error" });
    },
    onError: (e) => toast({ title: errorMessage(e), tone: "error" }),
  });
  // Aprovada sem senha e sem o link por e-mail: a senha provisória para mandar pelo WhatsApp (fica aqui para o
  // diálogo não fechar no meio e perder a senha).
  const temp = useMutation({
    mutationFn: (userId: string) => api.post<TemporaryPassword>(`/technicians/${userId}/reset-password`),
    onSettled: () => refreshTechnicianViews(queryClient),
  });
  // Pedido do candidato (LGPD): só gestores apagam a ficha pendente ou reprovada, com a foto.
  const remove = useMutation({
    mutationFn: () => api.delete(`/onboarding/applications/${id}`),
    onSuccess: () => {
      // As listas e o contador (a ficha aberta some junto com o diálogo).
      void queryClient.invalidateQueries({ queryKey: ["onboarding", "applications"] });
      void queryClient.invalidateQueries({ queryKey: ["onboarding", "pending-count"] });
      toast({ title: "Ficha excluída", tone: "success" });
      onClose();
    },
    onError: (e) => toast({ title: errorMessage(e), tone: "error" }),
  });

  const a = detail.data;
  const areas = labelMap(catalog.data?.service_areas);
  const availability = labelMap(catalog.data?.availability);
  const levels = labelMap(catalog.data?.skill_levels);
  const vehicles = labelMap(catalog.data?.vehicle_types);
  const pending = a?.status === "pending";
  // Os modos só valem enquanto a ficha está no estado deles (o tempo real pode mudar a ficha com o diálogo aberto).
  const rejecting = mode === "reject" && pending && canEdit;
  const reopening = mode === "reopen" && a?.status === "rejected" && canEdit;
  const coverage = (() => {
    if (!a || !regions.data) return null;
    const state = regions.data.find((r) => r.state === a.state);
    const city = state?.cities.find((c) => fold(c.city) === fold(a.city));
    return { inCity: city?.total ?? 0, inState: state?.total ?? 0 };
  })();
  const askRemove = async () => {
    if (!a) return;
    const ok = await confirm({
      tone: "danger",
      title: `Excluir a ficha de ${a.full_name}?`,
      description:
        "Use quando o candidato pedir a exclusão dos dados dele (LGPD). A ficha e a foto são apagadas de vez: não dá para desfazer.",
      confirmLabel: "Excluir ficha",
    });
    if (ok) remove.mutate();
  };
  const askApprove = async () => {
    if (!a) return;
    const sendable = isSendableEmail(a.email);
    const sends = mailEnabled === true && sendable;
    // E-mail nunca validado (null; sem o campo, a API antiga, não dá para saber): pode ter sido digitado errado, e a
    // boas-vindas não leva o link de criar senha (quem tem a caixa ficaria com a conta).
    const unverified = a.email_verified_at === null;
    const parts = ["Entra na base técnica e já pode entrar no app."];
    if (sends) parts.push(`O e-mail de boas-vindas vai para ${a.email}.`);
    if (unverified) parts.push("E-mail ainda não validado: confira o endereço com o candidato pelo WhatsApp antes de aprovar.");
    if (a.has_password === false) {
      parts.push(
        sends && !unverified
          ? "A ficha está sem senha: o e-mail leva o link para criar a senha."
          : mailEnabled === undefined
            ? "A ficha está sem senha."
            : "A ficha está sem senha: depois de aprovar, gere uma senha provisória.",
      );
    }
    if (mailEnabled === false) parts.push("Envio de e-mail desligado: avise pelo WhatsApp.");
    else if (mailEnabled && !sendable) parts.push("Sem e-mail válido: avise pelo WhatsApp.");
    const ok = await confirm({ title: `Aprovar ${a.full_name}?`, description: parts.join(" "), confirmLabel: "Aprovar" });
    if (ok) approve.mutate();
  };
  // A aprovada virou o cadastro do técnico: sai pela base técnica, não por aqui. Excluir (pedido do
  // candidato, LGPD) pede Editar e continua só com supervisores e administradores.
  const removeButton =
    a && a.status !== "approved" && canEdit && isManager(user?.role) ? (
      <Button variant="ghost" className="mr-auto" onClick={askRemove} loading={remove.isPending}>
        <Trash2 className="size-4" />
        Excluir ficha
      </Button>
    ) : null;

  const footer = !a ? (
    detail.error ? (
      <>
        <Button onClick={onClose}>Fechar</Button>
        <Button variant="primary" onClick={() => detail.refetch()} loading={detail.isFetching}>
          Tentar de novo
        </Button>
      </>
    ) : undefined
  ) : outcome ? (
    <Button variant="primary" onClick={onClose}>
      Concluir
    </Button>
  ) : reopening ? (
    <>
      <Button onClick={() => setMode("view")}>Voltar</Button>
      <Button variant="primary" loading={reopen.isPending} disabled={reopenReason.trim().length < 3} onClick={() => reopen.mutate()}>
        <RotateCcw className="size-4" />
        Reabrir ficha
      </Button>
    </>
  ) : !pending || !canEdit ? (
    <>
      {removeButton}
      {a.status === "rejected" && canEdit ? (
        <Button
          onClick={() => {
            reopen.reset();
            setMode("reopen");
          }}
        >
          <RotateCcw className="size-4" />
          Reabrir para análise
        </Button>
      ) : null}
      {a.user_id && canTechnicians ? (
        <Link href={technicianHref(a.user_id)} className={buttonClassName()}>
          <Users className="size-4" />
          Abrir ficha do técnico
        </Link>
      ) : null}
      <Button onClick={onClose}>Fechar</Button>
    </>
  ) : rejecting ? (
    <>
      <Button onClick={() => setMode("view")}>Voltar</Button>
      <Button variant="danger" loading={reject.isPending} disabled={reason.trim().length < 3} onClick={() => reject.mutate()}>
        <UserX className="size-4" />
        Reprovar ficha
      </Button>
    </>
  ) : (
    <>
      {removeButton}
      <Button variant="ghost" onClick={() => setMode("reject")}>
        <UserX className="size-4" />
        Reprovar
      </Button>
      <Button variant="primary" loading={approve.isPending} onClick={() => void askApprove()}>
        <UserCheck className="size-4" />
        Aprovar
      </Button>
    </>
  );

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      busy={approve.isPending || reject.isPending || reopen.isPending || remove.isPending || temp.isPending}
      // Motivo escrito e ainda não enviado: fechar pergunta antes de descartar.
      dirty={!outcome && ((rejecting && reason.trim() !== "") || (reopening && reopenReason.trim() !== ""))}
      title={a ? a.full_name : "Ficha de homologação"}
      description={a ? `Enviada em ${formatDateTime(a.created_at)}${a.invite_label ? ` · link: ${a.invite_label}` : ""}` : undefined}
      footer={footer}
    >
      {detail.error && !a ? (
        <ErrorBox message={errorMessage(detail.error)} />
      ) : !a ? (
        <LoadingBlock />
      ) : outcome ? (
        <OutcomePanel application={a} outcome={outcome} temp={temp} />
      ) : rejecting ? (
        <div className="flex flex-col gap-4">
          <Field label="Motivo" required hint="O candidato não vê.">
            <Textarea rows={4} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} autoFocus />
          </Field>
          {reject.error ? <ErrorBox message={errorMessage(reject.error)} /> : null}
        </div>
      ) : reopening ? (
        <div className="flex flex-col gap-4">
          <Field label="Motivo" required>
            <Textarea rows={3} value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} maxLength={REOPEN_MAX} autoFocus />
          </Field>
          {reopen.error ? <ErrorBox message={errorMessage(reopen.error)} /> : null}
        </div>
      ) : (
        <ApplicationView
          application={a}
          labels={{ areas, availability, levels, vehicles }}
          coverage={coverage}
          approveError={pending ? approve.error : null}
          resend={
            canEdit && pending && a.email_verified_at === null
              ? { onClick: () => resend.mutate(), loading: resend.isPending, off: mailEnabled === false }
              : null
          }
        />
      )}
    </Dialog>
  );
}

/** O que o candidato mandou na ficha, as análises e o aviso de privacidade aceito. */
function ApplicationView({
  application: a,
  labels,
  coverage,
  approveError,
  resend,
}: {
  application: ApplicationDetail;
  labels: Record<"areas" | "availability" | "levels" | "vehicles", Record<string, string>>;
  coverage: { inCity: number; inState: number } | null;
  approveError: unknown;
  /** "Reenviar validação" (ficha pendente com o e-mail sem validar, com Editar); `off`: envio de e-mail desligado. */
  resend: { onClick: () => void; loading: boolean; off: boolean } | null;
}) {
  const { areas, availability, levels, vehicles } = labels;
  // A API antiga não manda as análises: a nota da última fica no topo, como era.
  const reviews = [...(a.reviews ?? [])].sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
  const street = a.address && a.address_number ? `${a.address}, ${a.address_number}` : a.address;
  const address = [street, a.address_complement, a.address_district, `${a.city}-${a.state}`, a.postal_code].filter(Boolean).join(" · ");
  const rg = a.rg_number ? [a.rg_number, [a.rg_issuer, a.rg_state].filter(Boolean).join("/")].filter(Boolean).join(" · ") : null;
  const vehicleType = a.vehicle_type ? (vehicles[a.vehicle_type] ?? a.vehicle_type) : null;
  const vehicle = a.has_vehicle
    ? [
        vehicleType ? `Veículo próprio (${vehicleType})` : "Veículo próprio",
        a.vehicle_model,
        a.vehicle_plate ? formatPlate(a.vehicle_plate) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "Sem veículo";
  const company = [
    a.company_document ? `CNPJ ${formatDocument(a.company_document)}` : null,
    a.company_name ? `Razão social ${a.company_name}` : null,
    a.company_trade_name ? `Nome fantasia ${a.company_trade_name}` : null,
  ].filter((line): line is string => Boolean(line));
  return (
    <div className="flex flex-col gap-5">
      {approveError ? <ErrorBox title="Não foi possível aprovar" message={errorMessage(approveError)} /> : null}
      <div className="flex items-center gap-4">
        <ApplicantPhoto name={a.full_name} url={a.photo_url} />
        <div className="min-w-0 text-sm">
          <Pill color={APPLICATION_STATE[a.status].color}>{APPLICATION_STATE[a.status].label}</Pill>
          {!reviews.length && a.review_note ? <p className="mt-1.5 text-ink-muted">“{a.review_note}”</p> : null}
          {!reviews.length && a.reviewed_by ? (
            <p className="mt-0.5 text-xs text-ink-muted">
              por {a.reviewed_by.name} em {formatDateTime(a.reviewed_at)}
            </p>
          ) : null}
          {a.status === "rejected" && a.purge_at ? (
            <p className="mt-1.5 text-xs text-ink-muted">Excluída automaticamente em {formatDate(a.purge_at)}.</p>
          ) : null}
        </div>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <Section title="Contato e identificação">
          <Line icon={<Mail className="size-4" />}>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="break-all">
                {a.email}
                {/* Sem o campo (API antiga), só o e-mail. Aprovada: a validação fica na ficha do técnico. */}
                {a.status === "approved"
                  ? ""
                  : a.email_verified_at
                    ? ` · validado em ${formatDate(a.email_verified_at)}`
                    : a.email_verified_at === null
                      ? " · validação pendente"
                      : ""}
              </span>
              {resend ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2"
                  loading={resend.loading}
                  disabled={resend.off}
                  title={resend.off ? "Envio de e-mail desligado" : undefined}
                  onClick={resend.onClick}
                >
                  Reenviar validação
                </Button>
              ) : null}
            </span>
          </Line>
          <Line icon={<Phone className="size-4" />}>
            <a
              href={whatsappUrl(a.phone, `Olá, ${firstName(a.full_name)}!`)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 underline-offset-2 hover:text-brand hover:underline"
              title="Conversar no WhatsApp"
            >
              {a.phone}
              <MessageCircle className="size-3.5 text-ink-muted" />
            </a>
          </Line>
          {a.phone_secondary ? <Line icon={<Phone className="size-4" />}>Telefone secundário {a.phone_secondary}</Line> : null}
          <Line icon={<IdCard className="size-4" />}>
            CPF {formatDocument(a.document)}
            {a.birth_date ? ` · nasc. ${formatDate(a.birth_date)}` : ""}
          </Line>
          {rg ? <Line icon={<IdCard className="size-4" />}>RG {rg}</Line> : null}
          <Line icon={<MapPin className="size-4" />}>{address}</Line>
        </Section>
        <Section title="Região e disponibilidade">
          <p>{a.coverage_area}</p>
          {coverage ? (
            <p className="text-ink-muted">
              {coverage.inCity
                ? `Já temos ${coverage.inCity} ${coverage.inCity === 1 ? "técnico ativo" : "técnicos ativos"} em ${a.city}-${a.state}`
                : `Nenhum técnico ativo em ${a.city}-${a.state} ainda`}{" "}
              ({coverage.inState} na UF).
            </p>
          ) : null}
          <p className="text-ink-muted">{a.availability.map((k) => availability[k] ?? k).join(" · ") || "Disponibilidade não informada"}</p>
          <Line icon={<Car className="size-4" />}>
            {vehicle}
            {a.has_driver_license ? " · CNH" : ""}
          </Line>
        </Section>
      </div>
      {company.length ? (
        <Section title="Empresa">
          {company.map((line, i) => (
            <Line key={line} icon={i === 0 ? <Building2 className="size-4" /> : <span className="block size-4" />}>
              {line}
            </Line>
          ))}
        </Section>
      ) : null}
      <Section title="Atuação">
        <div className="flex flex-wrap gap-1.5">
          {a.service_areas.map((k) => (
            <span key={k} className="rounded-full bg-nav-active px-2.5 py-0.5 text-xs font-medium text-brand-ink">
              {areas[k] ?? k}
            </span>
          ))}
        </div>
        <p className="text-ink-muted">
          {a.years_experience != null ? `${years(a.years_experience)} de experiência` : "Experiência não informada"}
        </p>
      </Section>
      {a.skills.length ? (
        <Section title="Aptidões">
          <ul className="grid gap-1 sm:grid-cols-2">
            {a.skills.map((s) => (
              <li key={s.name} className="flex items-center justify-between gap-2 rounded-md border border-line px-2.5 py-1">
                <span className="truncate">{s.name}</span>
                <span className="shrink-0 text-xs text-ink-muted">{levels[s.level] ?? s.level}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {a.bio ? (
        <Section title="Mini biografia">
          <p className="whitespace-pre-line">{a.bio}</p>
        </Section>
      ) : null}
      {a.certifications || a.tools || a.notes ? (
        <Section title="Mais informações">
          {a.certifications ? <Line icon={<BadgeCheck className="size-4" />}>{a.certifications}</Line> : null}
          {a.tools ? <Line icon={<Wrench className="size-4" />}>{a.tools}</Line> : null}
          {a.notes ? <p className="text-ink-muted">{a.notes}</p> : null}
        </Section>
      ) : null}
      {reviews.length ? (
        <Section title="Análises">
          <ul className="flex flex-col gap-1.5">
            {reviews.map((r, i) => (
              <li key={`${r.at}-${i}`}>
                {reviewLine(r)}
                {/* A expirada já diz o motivo no rótulo. */}
                {r.note && fold(r.note) !== fold(REVIEW_ACTION_LABEL[r.action] ?? "") ? (
                  <span className="block text-ink-muted">“{r.note}”</span>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <p className="flex items-center gap-1.5 text-xs text-ink-muted">
        <ShieldCheck className="size-3.5" />
        Aceitou o aviso de privacidade (versão {a.privacy_version}) em {formatDateTime(a.privacy_consent_at)}.
      </p>
    </div>
  );
}

/**
 * Depois de aprovar ou reprovar: a mensagem pronta para avisar o candidato pelo WhatsApp. Aprovada: o que aconteceu
 * com o e-mail de boas-vindas e, sem senha e sem o link por e-mail (envio desligado, sem e-mail válido ou e-mail ainda
 * não validado), a senha provisória (com Técnicos em Editar).
 */
function OutcomePanel({
  application: a,
  outcome,
  temp,
}: {
  application: ApplicationDetail;
  outcome: Outcome;
  temp: UseMutationResult<TemporaryPassword, Error, string>;
}) {
  const canTechnicians = useCan("base.technicians");
  const canResetPassword = useCan("base.technicians", "edit");
  const first = firstName(a.full_name);
  if (outcome.kind === "rejected") {
    const message = `Olá, ${first}! Obrigado pelo interesse em ser técnico parceiro da Maxx Field. No momento não vamos seguir com o seu cadastro.`;
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <UserX className="mt-0.5 size-5 shrink-0 text-ink-muted" />
          <div className="min-w-0 text-sm">
            <p className="font-semibold text-ink">Ficha reprovada</p>
            <p className="mt-0.5 text-ink-muted">Se quiser, avise o candidato com uma mensagem educada.</p>
          </div>
        </div>
        <p className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink">{message}</p>
        <div className="flex flex-wrap gap-2">
          <a href={whatsappUrl(a.phone, message)} target="_blank" rel="noreferrer" className={buttonClassName("secondary")}>
            <MessageCircle className="size-4" />
            Avisar pelo WhatsApp
          </a>
        </div>
      </div>
    );
  }
  const { technician, welcome, passwordLink } = outcome;
  const email = welcome?.to ?? technician.email;
  // Sem senha na ficha, a API cria o usuário com uma senha que ninguém sabe e pede a troca no primeiro acesso.
  const noPassword = technician.must_change_password;
  // O link de criar senha foi junto da boas-vindas: só com o e-mail validado (`password_link`) e a boas-vindas na fila.
  const linkSent = noPassword && passwordLink && welcome?.status === "queued";
  const mailLine =
    welcome?.status === "queued"
      ? `E-mail de boas-vindas enviado para ${email}.${noPassword && !passwordLink ? " Sem o link de senha: o e-mail ainda não foi validado." : ""}`
      : welcome?.status === "not_configured"
        ? "E-mail de boas-vindas não enviado: envio de e-mail desligado."
        : welcome?.status === "not_sendable"
          ? "Sem e-mail válido: avise pelo WhatsApp."
          : null;
  // Sem senha e sem o link do e-mail: ele só entra com uma senha provisória (o painel dela tem o próprio WhatsApp).
  const needsTemp = noPassword && !linkSent;
  const message = !noPassword
    ? `Olá, ${first}! Seu cadastro de técnico parceiro na Maxx Field foi aprovado. No app, entre com ${email} e a senha que você criou na ficha.`
    : linkSent
      ? `Olá, ${first}! Seu cadastro de técnico parceiro na Maxx Field foi aprovado. Enviamos para ${email} o link para você criar a senha do app.`
      : null;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-brand" />
        <div className="min-w-0 text-sm">
          <p className="font-semibold text-ink">{technician.name} está na base técnica</p>
          <p className="mt-0.5 text-ink-muted">
            {needsTemp
              ? "A ficha está sem senha: gere uma senha provisória e mande pelo WhatsApp."
              : noPassword
                ? "Avise o técnico: ele cria a senha pelo link do e-mail e já pode entrar no app."
                : "Avise o técnico: ele já pode entrar no app com o e-mail e a senha da ficha."}
          </p>
          {mailLine ? <p className="mt-0.5 text-ink-muted">{mailLine}</p> : null}
        </div>
      </div>
      {temp.data ? (
        <TempPasswordPanel result={temp.data} />
      ) : message ? (
        <p className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink">{message}</p>
      ) : null}
      {needsTemp && !temp.data ? (
        canResetPassword ? (
          <div className="flex flex-col items-start gap-2">
            <Button variant="primary" loading={temp.isPending} onClick={() => temp.mutate(technician.id)}>
              {temp.isPending ? null : <KeyRound className="size-4" />}
              {temp.error ? "Tentar de novo" : "Gerar senha provisória"}
            </Button>
            {temp.error ? <ErrorBox message={errorMessage(temp.error)} /> : null}
          </div>
        ) : (
          <p className="text-xs text-ink-muted">A senha provisória sai na ficha do técnico, por quem tem Técnicos em Editar.</p>
        )
      ) : null}
      <div className="flex flex-wrap gap-2">
        {message ? (
          <a href={whatsappUrl(a.phone, message)} target="_blank" rel="noreferrer" className={buttonClassName("secondary")}>
            <MessageCircle className="size-4" />
            Avisar pelo WhatsApp
          </a>
        ) : null}
        {canTechnicians ? (
          <Link href={technicianHref(technician.id)} className={buttonClassName("ghost")}>
            <Users className="size-4" />
            Abrir ficha do técnico
          </Link>
        ) : null}
      </div>
    </div>
  );
}
