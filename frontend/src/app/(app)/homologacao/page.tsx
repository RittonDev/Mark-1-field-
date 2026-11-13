"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  BadgeCheck,
  Car,
  Check,
  Copy,
  IdCard,
  Link2,
  Mail,
  MapPin,
  MessageCircle,
  Phone,
  ShieldCheck,
  UserCheck,
  UserX,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useToast } from "@/components/Toaster";
import {
  Button,
  Card,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  LoadingBlock,
  PageHeader,
  Select,
  Table,
  Td,
  Textarea,
  Th,
} from "@/components/ui";
import { absoluteApiUrl, api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets } from "@/lib/constants";
import { formatDate, formatDateTime, formatDocument, initials } from "@/lib/format";
import { inviteUrl, labelMap, useOnboardingCatalog } from "@/lib/onboarding";
import { useTeams } from "@/lib/queries";
import type {
  ApplicationDetail,
  ApplicationStatus,
  ApplicationSummary,
  InviteState,
  OnboardingInvite,
  User,
} from "@/lib/types";

type Tab = ApplicationStatus | "links";

const TABS: { key: Tab; label: string }[] = [
  { key: "pending", label: "Pendentes" },
  { key: "approved", label: "Aprovadas" },
  { key: "rejected", label: "Reprovadas" },
  { key: "links", label: "Links de cadastro" },
];

const INVITE_STATE: Record<InviteState, { label: string; className: string }> = {
  active: { label: "Ativo", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300" },
  used: { label: "Usado", className: "bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-300" },
  expired: { label: "Expirado", className: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300" },
  revoked: { label: "Cancelado", className: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300" },
};

export default function OnboardingPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>("pending");
  const [openedId, setOpenedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
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

  if (user && !canManageTickets(user.role)) {
    return <ErrorBox message="A homologação é exclusiva para analistas e gestores." />;
  }

  return (
    <div>
      <PageHeader
        title="Homologação"
        description="Fichas enviadas pelos técnicos pelo link de cadastro. Aprovada, a pessoa entra na base técnica e já acessa o app."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Link2 className="size-4" />
            Gerar link de cadastro
          </Button>
        }
      />

      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-line" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={clsx(
              "relative shrink-0 px-3 pt-1 pb-2.5 text-sm transition-colors",
              tab === t.key ? "font-semibold text-ink" : "font-medium text-ink-muted hover:text-ink",
            )}
          >
            {t.label}
            {t.key === "pending" && pending.data?.pending ? (
              <span className="ml-1.5 rounded-full bg-red-500 px-1.5 text-[11px] font-semibold text-white">
                {pending.data.pending}
              </span>
            ) : null}
            {tab === t.key ? <span className="brand-gradient absolute inset-x-2 -bottom-px h-0.5 rounded-full" /> : null}
          </button>
        ))}
      </div>

      {tab === "links" ? (
        <InvitesTab onCreate={() => setCreating(true)} />
      ) : (
        <Card>
          {applications.isLoading ? (
            <LoadingBlock />
          ) : applications.error ? (
            <div className="p-4">
              <ErrorBox message={errorMessage(applications.error)} />
            </div>
          ) : (applications.data ?? []).length === 0 ? (
            <EmptyState
              icon={<BadgeCheck className="size-6" />}
              title={tab === "pending" ? "Nenhuma ficha aguardando análise" : "Nenhuma ficha aqui"}
              description={
                tab === "pending" ? "Gere um link de cadastro e envie ao técnico. A ficha dele aparece aqui na hora." : undefined
              }
              action={
                tab === "pending" ? (
                  <Button onClick={() => setCreating(true)}>
                    <Link2 className="size-4" />
                    Gerar link
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Técnico</Th>
                  <Th className="hidden md:table-cell">Região</Th>
                  <Th className="hidden lg:table-cell">Atuação</Th>
                  <Th className="hidden sm:table-cell">Experiência</Th>
                  <Th>{tab === "pending" ? "Enviada" : "Analisada"}</Th>
                </tr>
              </thead>
              <tbody>
                {(applications.data ?? []).map((a) => (
                  <tr key={a.id} className="cursor-pointer hover:bg-surface-2" onClick={() => setOpenedId(a.id)}>
                    <Td>
                      <button type="button" className="flex items-center gap-2.5 text-left" onClick={() => setOpenedId(a.id)}>
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand/10 text-xs font-semibold text-brand">
                          {initials(a.full_name)}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate font-semibold text-ink">{a.full_name}</span>
                          <span className="block truncate text-xs text-ink-muted">{a.email}</span>
                        </span>
                      </button>
                    </Td>
                    <Td className="hidden md:table-cell">
                      {a.city}/{a.state}
                    </Td>
                    <Td className="hidden lg:table-cell">
                      <span className="line-clamp-2 text-xs text-ink-muted">
                        {a.service_areas.map((k) => areas[k] ?? k).join(" · ")}
                      </span>
                    </Td>
                    <Td className="hidden sm:table-cell">
                      {a.years_experience != null ? `${a.years_experience} anos` : "—"}
                      {a.has_vehicle ? <Car className="ml-1.5 inline size-3.5 text-ink-muted" aria-label="Com veículo" /> : null}
                    </Td>
                    <Td className="text-xs text-ink-muted">{formatDateTime(a.reviewed_at ?? a.created_at)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {creating ? <CreateInviteDialog onClose={() => setCreating(false)} /> : null}
      {openedId ? <ApplicationDialog id={openedId} onClose={() => setOpenedId(null)} /> : null}
    </div>
  );
}

function InvitesTab({ onCreate }: { onCreate: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const invites = useQuery({
    queryKey: ["onboarding", "invites"],
    queryFn: () => api.get<OnboardingInvite[]>("/onboarding/invites"),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/onboarding/invites/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["onboarding", "invites"] });
      toast({ title: "Link cancelado", tone: "success" });
    },
    onError: (e) => toast({ title: errorMessage(e), tone: "error" }),
  });

  return (
    <Card>
      {invites.isLoading ? (
        <LoadingBlock />
      ) : (invites.data ?? []).length === 0 ? (
        <EmptyState
          icon={<Link2 className="size-6" />}
          title="Nenhum link gerado"
          action={<Button onClick={onCreate}>Gerar link</Button>}
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
              <Th />
            </tr>
          </thead>
          <tbody>
            {(invites.data ?? []).map((i) => (
              <tr key={i.id}>
                <Td>
                  <span className="block font-semibold text-ink">{i.label ?? "Sem identificação"}</span>
                  <span className="text-xs text-ink-muted">{i.max_uses == null ? "Reutilizável" : "Uso único"}</span>
                </Td>
                <Td>
                  <span className={clsx("rounded-full px-2 py-0.5 text-xs font-medium", INVITE_STATE[i.state].className)}>
                    {INVITE_STATE[i.state].label}
                  </span>
                </Td>
                <Td className="hidden tabular-nums sm:table-cell">{i.use_count}</Td>
                <Td className="hidden text-xs text-ink-muted md:table-cell">{formatDateTime(i.expires_at)}</Td>
                <Td className="hidden text-xs text-ink-muted lg:table-cell">{i.created_by?.name ?? "—"}</Td>
                <Td className="text-right">
                  {i.state === "active" ? (
                    <Button
                      variant="ghost"
                      onClick={() => revoke.mutate(i.id)}
                      loading={revoke.isPending && revoke.variables === i.id}
                    >
                      Cancelar
                    </Button>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function CreateInviteDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [reusable, setReusable] = useState(false);
  const [days, setDays] = useState("7");
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: () =>
      api.post<OnboardingInvite>("/onboarding/invites", {
        label: label.trim() || null,
        reusable,
        days_valid: Number(days),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["onboarding", "invites"] }),
  });
  const url = create.data?.token ? inviteUrl(create.data.token) : null;
  const message = url
    ? `Olá! Para se cadastrar como técnico parceiro da Maxx Field, preencha a ficha neste link: ${url}`
    : "";

  return (
    <Dialog
      open
      onClose={onClose}
      title="Link de cadastro de técnico"
      description="O técnico abre no celular, preenche a ficha e ela chega aqui para análise."
      footer={
        url ? (
          <Button variant="primary" onClick={onClose}>
            Concluir
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancelar</Button>
            <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
              Gerar link
            </Button>
          </>
        )
      }
    >
      {url ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 p-2">
            <code className="min-w-0 flex-1 truncate text-xs text-ink">{url}</code>
            <Button
              onClick={async () => {
                await navigator.clipboard.writeText(url);
                setCopied(true);
              }}
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? "Copiado" : "Copiar"}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <a href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer">
              <Button>
                <MessageCircle className="size-4" />
                Enviar por WhatsApp
              </Button>
            </a>
            <a
              href={`mailto:?subject=${encodeURIComponent("Cadastro de técnico parceiro — Maxx Field")}&body=${encodeURIComponent(message)}`}
            >
              <Button>
                <Mail className="size-4" />
                Enviar por e-mail
              </Button>
            </a>
          </div>
          <p className="text-xs text-ink-muted">
            Guarde ou envie agora: por segurança, o link completo só aparece nesta tela. {reusable ? "Vale para várias pessoas" : "Vale para uma ficha"} até{" "}
            {create.data ? formatDateTime(create.data.expires_at) : ""}.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Field label="Para quem" hint="Para identificar o link na lista. Ex.: nome do técnico ou da região.">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={160} autoFocus />
          </Field>
          <Field label="Validade">
            <Select value={days} onChange={(e) => setDays(e.target.value)}>
              <option value="3">3 dias</option>
              <option value="7">7 dias</option>
              <option value="15">15 dias</option>
              <option value="30">30 dias</option>
              <option value="90">90 dias</option>
            </Select>
          </Field>
          <Checkbox
            label="Reutilizável (várias pessoas podem usar o mesmo link, ex.: grupo de técnicos)"
            checked={reusable}
            onChange={setReusable}
          />
          {create.error ? <ErrorBox message={errorMessage(create.error)} /> : null}
        </div>
      )}
    </Dialog>
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

function ApplicationDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const catalog = useOnboardingCatalog();
  const teams = useTeams();
  const [mode, setMode] = useState<"view" | "approve" | "reject">("view");
  const [teamId, setTeamId] = useState("");
  const [jobTitle, setJobTitle] = useState("Técnico de campo");
  const [reason, setReason] = useState("");
  const detail = useQuery({
    queryKey: ["onboarding", "application", id],
    queryFn: () => api.get<ApplicationDetail>(`/onboarding/applications/${id}`),
  });
  const done = (title: string) => {
    queryClient.invalidateQueries({ queryKey: ["onboarding"] });
    queryClient.invalidateQueries({ queryKey: ["users"] });
    toast({ title, tone: "success" });
    onClose();
  };
  const approve = useMutation({
    mutationFn: () =>
      api.post<User>(`/onboarding/applications/${id}/approve`, { team_id: teamId || null, job_title: jobTitle || null }),
    onSuccess: (u) => done(`${u.name} aprovado e incluído na base técnica`),
  });
  const reject = useMutation({
    mutationFn: () => api.post(`/onboarding/applications/${id}/reject`, { reason }),
    onSuccess: () => done("Ficha reprovada"),
  });

  const a = detail.data;
  const areas = labelMap(catalog.data?.service_areas);
  const availability = labelMap(catalog.data?.availability);
  const levels = labelMap(catalog.data?.skill_levels);
  const vehicles = labelMap(catalog.data?.vehicle_types);
  const pending = a?.status === "pending";
  const error = approve.error ?? reject.error;

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={a ? a.full_name : "Ficha de homologação"}
      description={a ? `Enviada em ${formatDateTime(a.created_at)}${a.invite_label ? ` · link: ${a.invite_label}` : ""}` : undefined}
      footer={
        !a ? undefined : !pending ? (
          <>
            {a.user_id ? (
              <Link href="/usuarios">
                <Button>Ver na base técnica</Button>
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
        )
      }
    >
      {detail.isLoading || !a ? (
        <LoadingBlock />
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
          {error ? <ErrorBox message={errorMessage(error)} /> : null}
        </div>
      ) : mode === "reject" ? (
        <div className="flex flex-col gap-4">
          <Field label="Motivo" required hint="Fica registrado na ficha.">
            <Textarea rows={4} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
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
              <StatusLine status={a.status} />
              {a.review_note ? <p className="mt-1 text-ink-muted">“{a.review_note}”</p> : null}
              {a.reviewed_by ? (
                <p className="text-xs text-ink-muted">
                  por {a.reviewed_by.name} em {formatDateTime(a.reviewed_at)}
                </p>
              ) : null}
            </div>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <Section title="Contato e identificação">
              <Line icon={<Mail className="size-4" />}>{a.email}</Line>
              <Line icon={<Phone className="size-4" />}>
                <a href={`https://wa.me/55${a.phone.replace(/\D/g, "")}`} target="_blank" rel="noreferrer" className="hover:text-brand">
                  {a.phone}
                </a>
              </Line>
              <Line icon={<IdCard className="size-4" />}>
                CPF {formatDocument(a.document)}
                {a.birth_date ? ` · nasc. ${formatDate(a.birth_date)}` : ""}
              </Line>
              {a.company_document ? <Line icon={<IdCard className="size-4" />}>CNPJ {formatDocument(a.company_document)}</Line> : null}
              <Line icon={<MapPin className="size-4" />}>
                {[a.address, `${a.city}/${a.state}`, a.postal_code].filter(Boolean).join(" · ")}
              </Line>
            </Section>
            <Section title="Região e disponibilidade">
              <p>{a.coverage_area}</p>
              <p className="text-ink-muted">{a.availability.map((k) => availability[k] ?? k).join(" · ") || "Não informada"}</p>
              <Line icon={<Car className="size-4" />}>
                {a.has_vehicle ? `Veículo próprio (${vehicles[a.vehicle_type ?? ""] ?? a.vehicle_type})` : "Sem veículo"}
                {a.has_driver_license ? " · CNH" : ""}
              </Line>
            </Section>
          </div>
          <Section title="Atuação">
            <div className="flex flex-wrap gap-1.5">
              {a.service_areas.map((k) => (
                <span key={k} className="rounded-full bg-nav-active px-2.5 py-0.5 text-xs font-medium text-brand">
                  {areas[k] ?? k}
                </span>
              ))}
            </div>
            <p className="text-ink-muted">
              {a.years_experience != null ? `${a.years_experience} anos de experiência` : "Experiência não informada"}
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

function StatusLine({ status }: { status: ApplicationStatus }) {
  const map: Record<ApplicationStatus, { label: string; className: string }> = {
    pending: { label: "Aguardando análise", className: "text-amber-700 dark:text-amber-300" },
    approved: { label: "Aprovado — na base técnica", className: "text-emerald-700 dark:text-emerald-300" },
    rejected: { label: "Reprovado", className: "text-red-700 dark:text-red-300" },
  };
  return <p className={clsx("font-medium", map[status].className)}>{map[status].label}</p>;
}
