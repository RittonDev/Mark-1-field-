"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BadgeCheck,
  Car,
  CheckCircle2,
  CopyPlus,
  IdCard,
  Link2,
  Mail,
  MapPin,
  MessageCircle,
  Phone,
  Search,
  ShieldCheck,
  SquarePen,
  UserCheck,
  UserX,
  Users,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { MultiSelect } from "@/components/MultiSelect";
import { Tabs } from "@/components/motion";
import { fold, replaceSearch } from "@/components/operacao/hooks";
import { InviteDialog, type InvitePreset } from "@/components/technicians/InviteDialog";
import { refreshTechnicianViews } from "@/components/technicians/refresh";
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
import { canManageTickets } from "@/lib/constants";
import { formatDate, formatDateTime, formatDocument, initials } from "@/lib/format";
import { labelMap, useOnboardingCatalog } from "@/lib/onboarding";
import { useTeams } from "@/lib/queries";
import type {
  ApplicationDetail,
  ApplicationStatus,
  ApplicationSummary,
  InviteState,
  OnboardingInvite,
  TechnicianRegion,
  User,
} from "@/lib/types";
import { whatsappUrl } from "@/lib/whatsapp";

type Tab = ApplicationStatus | "links";

const TABS: { key: Tab; label: string }[] = [
  { key: "pending", label: "Pendentes" },
  { key: "approved", label: "Aprovadas" },
  { key: "rejected", label: "Reprovadas" },
  { key: "links", label: "Links de cadastro" },
];

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

export default function OnboardingPage() {
  // A ficha pode chegar aberta pela URL (?ficha=, ex.: "Ver ficha da homologação" no cadastro do técnico).
  return (
    <Suspense fallback={<LoadingBlock />}>
      <OnboardingView />
    </Suspense>
  );
}

function OnboardingView() {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const now = useNow(60_000);
  const [tab, setTab] = useState<Tab>("pending");
  const [openedId, setOpenedId] = useState<string | null>(() => searchParams.get("ficha"));
  // Convite aberto: novo (sem dados) ou "gerar outro igual" a um link da lista.
  const [inviting, setInviting] = useState<{ preset?: InvitePreset } | null>(null);
  const [q, setQ] = useState("");
  const [uf, setUf] = useState("");
  const [areaFilter, setAreaFilter] = useState<string[]>([]);
  const [withVehicle, setWithVehicle] = useState(false);
  const catalog = useOnboardingCatalog();
  const areas = useMemo(() => labelMap(catalog.data?.service_areas), [catalog.data]);

  const applications = useQuery({
    queryKey: ["onboarding", "applications", tab],
    queryFn: () => api.get<ApplicationSummary[]>("/onboarding/applications", { status: tab }),
    enabled: tab !== "links",
  });
  const pending = useQuery({
    queryKey: ["onboarding", "pending-count"],
    queryFn: () => api.get<{ pending: number }>("/onboarding/applications/pending-count"),
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
    // Pendentes: quem chegou primeiro é analisado primeiro. Analisadas: as mais recentes em cima.
    return tab === "pending"
      ? list.sort((a, b) => a.created_at.localeCompare(b.created_at))
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

  if (user && !canManageTickets(user.role)) {
    return <ErrorBox message="A homologação é exclusiva para analistas e gestores." />;
  }

  return (
    <div>
      <PageHeader
        title="Homologação"
        description="Fichas enviadas pelos técnicos pelo link de cadastro. Aprovada, a pessoa entra na base técnica e já acessa o app."
        actions={
          <Button variant="primary" onClick={() => setInviting({})}>
            <Link2 className="size-4" />
            Gerar link de cadastro
          </Button>
        }
      />

      <Tabs
        className="mb-4 border-b border-line"
        items={TABS.map((t) => ({ ...t, count: t.key === "pending" ? (pending.data?.pending ?? null) : null }))}
        value={tab}
        onChange={setTab}
        ariaLabel="Fichas e links"
      />

      {tab === "links" ? (
        <InvitesTab onCreate={(preset) => setInviting({ preset })} />
      ) : (
        <>
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
                    tab === "pending"
                      ? "Gere um link de cadastro e envie ao técnico pelo WhatsApp. A ficha dele aparece aqui na hora."
                      : undefined
                  }
                  action={
                    tab === "pending" ? (
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
                    <Th className="edit-col">Analisar</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => {
                    const waitingDays = Math.floor((now - new Date(a.created_at).getTime()) / 86_400_000);
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
                            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand/10 text-xs font-semibold text-brand">
                              {initials(a.full_name)}
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate font-semibold text-ink">{a.full_name}</span>
                              <span className="block truncate text-xs text-ink-muted">{a.email}</span>
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
                            aria-label={`Analisar a ficha de ${a.full_name}`}
                            title="Analisar a ficha"
                          >
                            <SquarePen className="size-4" />
                          </button>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      )}

      {inviting ? <InviteDialog preset={inviting.preset} onClose={() => setInviting(null)} /> : null}
      {openedId ? <ApplicationDialog key={openedId} id={openedId} onClose={closeApplication} /> : null}
    </div>
  );
}

function InvitesTab({ onCreate }: { onCreate: (preset?: InvitePreset) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
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
          action={<Button onClick={() => onCreate()}>Gerar link</Button>}
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
                  <span className="text-xs text-ink-muted">{i.max_uses == null ? "Reutilizável" : "Uso único"}</span>
                </Td>
                <Td>
                  <Pill color={INVITE_STATE[i.state].color}>{INVITE_STATE[i.state].label}</Pill>
                </Td>
                <Td className="hidden tabular-nums sm:table-cell">{i.use_count}</Td>
                <Td className="hidden text-xs text-ink-muted md:table-cell">{formatDateTime(i.expires_at)}</Td>
                <Td className="hidden text-xs text-ink-muted lg:table-cell">{i.created_by?.name ?? "—"}</Td>
                <Td className="edit-col">
                  <span className="flex items-center justify-end gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onCreate({ label: i.label, reusable: i.max_uses == null })}
                      title="O link completo só aparece uma vez: gere outro com os mesmos dados"
                    >
                      <CopyPlus className="size-3.5" />
                      Gerar outro igual
                    </Button>
                    {i.state === "active" ? (
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

/** Resultado da análise: o diálogo fica aberto para avisar o candidato pelo WhatsApp. */
type Outcome = { kind: "approved"; name: string } | { kind: "rejected" };

function ApplicationDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const catalog = useOnboardingCatalog();
  const teams = useTeams();
  const [mode, setMode] = useState<"view" | "approve" | "reject">("view");
  const [teamId, setTeamId] = useState("");
  const [jobTitle, setJobTitle] = useState("Técnico de campo");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
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
  const approve = useMutation({
    mutationFn: () =>
      api.post<User>(`/onboarding/applications/${id}/approve`, {
        team_id: teamId || null,
        job_title: jobTitle.trim() || null,
        note: note.trim() || null,
      }),
    onSuccess: (u) => {
      decided();
      setOutcome({ kind: "approved", name: u.name });
    },
  });
  const reject = useMutation({
    mutationFn: () => api.post(`/onboarding/applications/${id}/reject`, { reason: reason.trim() }),
    onSuccess: () => {
      decided();
      setOutcome({ kind: "rejected" });
    },
  });

  const a = detail.data;
  const areas = labelMap(catalog.data?.service_areas);
  const availability = labelMap(catalog.data?.availability);
  const levels = labelMap(catalog.data?.skill_levels);
  const vehicles = labelMap(catalog.data?.vehicle_types);
  const pending = a?.status === "pending";
  const error = approve.error ?? reject.error;
  const coverage = (() => {
    if (!a || !regions.data) return null;
    const state = regions.data.find((r) => r.state === a.state);
    const city = state?.cities.find((c) => fold(c.city) === fold(a.city));
    return { inCity: city?.total ?? 0, inState: state?.total ?? 0 };
  })();

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
  ) : !pending ? (
    <>
      {a.user_id ? (
        <Link href={`/tecnicos?q=${encodeURIComponent(a.email)}`} className={buttonClassName()}>
          <Users className="size-4" />
          Ver na base técnica
        </Link>
      ) : null}
      <Button onClick={onClose}>Fechar</Button>
    </>
  ) : mode === "approve" ? (
    <>
      <Button onClick={() => setMode("view")}>Voltar</Button>
      <Button variant="primary" loading={approve.isPending} onClick={() => approve.mutate()}>
        <UserCheck className="size-4" />
        Aprovar e incluir na base
      </Button>
    </>
  ) : mode === "reject" ? (
    <>
      <Button onClick={() => setMode("view")}>Voltar</Button>
      <Button variant="danger" loading={reject.isPending} disabled={reason.trim().length < 3} onClick={() => reject.mutate()}>
        <UserX className="size-4" />
        Reprovar ficha
      </Button>
    </>
  ) : (
    <>
      <Button variant="ghost" onClick={() => setMode("reject")}>
        <UserX className="size-4" />
        Reprovar
      </Button>
      <Button variant="primary" onClick={() => setMode("approve")}>
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
      title={a ? a.full_name : "Ficha de homologação"}
      description={a ? `Enviada em ${formatDateTime(a.created_at)}${a.invite_label ? ` · link: ${a.invite_label}` : ""}` : undefined}
      footer={footer}
    >
      {detail.error && !a ? (
        <ErrorBox message={errorMessage(detail.error)} />
      ) : !a ? (
        <LoadingBlock />
      ) : outcome ? (
        <OutcomePanel application={a} outcome={outcome} />
      ) : mode === "approve" ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-ink">
            {a.full_name} passa a ser técnico da base e entra no app com <strong>{a.email}</strong> e a senha que cadastrou na
            ficha.
          </p>
          <Field label="Grupo técnico">
            <Select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              <option value="">Sem grupo</option>
              {(teams.data ?? [])
                .filter((t) => t.is_active)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Cargo">
            <Input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} maxLength={120} />
          </Field>
          <Field label="Observação (opcional)" hint="Fica registrada na ficha. Ex.: combinado o valor por chamado.">
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
          </Field>
          {error ? <ErrorBox message={errorMessage(error)} /> : null}
        </div>
      ) : mode === "reject" ? (
        <div className="flex flex-col gap-4">
          <Field label="Motivo" required hint="Fica registrado na ficha (o candidato não vê).">
            <Textarea rows={4} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} autoFocus />
          </Field>
          {error ? <ErrorBox message={errorMessage(error)} /> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex items-center gap-4">
            <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand/10 text-lg font-semibold text-brand">
              {a.photo_url ? (
                // eslint-disable-next-line @next/next/no-img-element -- link assinado da API
                <img src={absoluteApiUrl(a.photo_url) ?? undefined} alt={`Foto de ${a.full_name}`} className="size-full object-cover" />
              ) : (
                initials(a.full_name)
              )}
            </div>
            <div className="min-w-0 text-sm">
              <Pill color={APPLICATION_STATE[a.status].color}>{APPLICATION_STATE[a.status].label}</Pill>
              {a.review_note ? <p className="mt-1.5 text-ink-muted">“{a.review_note}”</p> : null}
              {a.reviewed_by ? (
                <p className="mt-0.5 text-xs text-ink-muted">
                  por {a.reviewed_by.name} em {formatDateTime(a.reviewed_at)}
                </p>
              ) : null}
            </div>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <Section title="Contato e identificação">
              <Line icon={<Mail className="size-4" />}>{a.email}</Line>
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
              <Line icon={<IdCard className="size-4" />}>
                CPF {formatDocument(a.document)}
                {a.birth_date ? ` · nasc. ${formatDate(a.birth_date)}` : ""}
              </Line>
              {a.company_document ? <Line icon={<IdCard className="size-4" />}>CNPJ {formatDocument(a.company_document)}</Line> : null}
              <Line icon={<MapPin className="size-4" />}>
                {[a.address, `${a.city}-${a.state}`, a.postal_code].filter(Boolean).join(" · ")}
              </Line>
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
                {a.has_vehicle ? `Veículo próprio (${vehicles[a.vehicle_type ?? ""] ?? a.vehicle_type})` : "Sem veículo"}
                {a.has_driver_license ? " · CNH" : ""}
              </Line>
            </Section>
          </div>
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
            <Section title="Skills">
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
          {a.certifications || a.tools || a.notes ? (
            <Section title="Mais informações">
              {a.certifications ? <Line icon={<BadgeCheck className="size-4" />}>{a.certifications}</Line> : null}
              {a.tools ? <Line icon={<Wrench className="size-4" />}>{a.tools}</Line> : null}
              {a.notes ? <p className="text-ink-muted">{a.notes}</p> : null}
            </Section>
          ) : null}
          <p className="flex items-center gap-1.5 text-xs text-ink-muted">
            <ShieldCheck className="size-3.5" />
            Aceitou o aviso de privacidade (versão {a.privacy_version}) em {formatDateTime(a.privacy_consent_at)}.
          </p>
        </div>
      )}
    </Dialog>
  );
}

/** Depois de aprovar ou reprovar: a mensagem pronta para avisar o candidato pelo WhatsApp. */
function OutcomePanel({ application: a, outcome }: { application: ApplicationDetail; outcome: Outcome }) {
  const first = firstName(a.full_name);
  const approved = outcome.kind === "approved";
  const message = approved
    ? `Olá, ${first}! Seu cadastro de técnico parceiro na Maxx Field foi aprovado. No app, entre com ${a.email} e a senha que você criou na ficha.`
    : `Olá, ${first}! Obrigado pelo interesse em ser técnico parceiro da Maxx Field. No momento não vamos seguir com o seu cadastro.`;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        {approved ? (
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-brand" />
        ) : (
          <UserX className="mt-0.5 size-5 shrink-0 text-ink-muted" />
        )}
        <div className="min-w-0 text-sm">
          <p className="font-semibold text-ink">
            {outcome.kind === "approved" ? `${outcome.name} está na base técnica` : "Ficha reprovada"}
          </p>
          <p className="mt-0.5 text-ink-muted">
            {approved
              ? "Avise o técnico: ele já pode entrar no app com o e-mail e a senha da ficha."
              : "Se quiser, avise o candidato com uma mensagem educada."}
          </p>
        </div>
      </div>
      <p className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink">{message}</p>
      <div className="flex flex-wrap gap-2">
        <a href={whatsappUrl(a.phone, message)} target="_blank" rel="noreferrer" className={buttonClassName("secondary")}>
          <MessageCircle className="size-4" />
          Avisar pelo WhatsApp
        </a>
        {approved ? (
          <Link href={`/tecnicos?q=${encodeURIComponent(a.email)}`} className={buttonClassName("ghost")}>
            <Users className="size-4" />
            Ver na base técnica
          </Link>
        ) : null}
      </div>
    </div>
  );
}
