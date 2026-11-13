"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  BadgeCheck,
  Camera,
  Check,
  Copy,
  Download,
  FileSpreadsheet,
  HardHat,
  KeyRound,
  MapPinned,
  MessageCircle,
  Plus,
  Search,
  Upload,
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
import { formatDate, formatRelative, initials } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { labelMap, useOnboardingCatalog } from "@/lib/onboarding";
import { useServiceTypes, useTeams } from "@/lib/queries";
import { MultiSelect } from "@/components/MultiSelect";
import { Tabs } from "@/components/motion";
import { NearbyFinder, UFS } from "@/components/technicians/NearbyFinder";
import type { ImportResult, Technician, TechnicianRegion, TemporaryPassword } from "@/lib/types";

type Active = "true" | "false" | "";

function Avatar({ tech, size = "md" }: { tech: Pick<Technician, "name" | "avatar_url">; size?: "md" | "lg" }) {
  const src = absoluteApiUrl(tech.avatar_url);
  return (
    <span
      className={clsx(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand/10 font-semibold text-brand",
        size === "lg" ? "size-16 text-lg" : "size-8 text-xs",
      )}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- link assinado da API
        <img src={src} alt="" className="size-full object-cover" />
      ) : (
        initials(tech.name)
      )}
    </span>
  );
}

export default function TechniciansPage() {
  const { user } = useAuth();
  const now = useNow(60_000);
  const [qInput, setQInput] = useState("");
  const [teamId, setTeamId] = useState("");
  // Depois da migração, quem está "inativo" no Field Control continua na rede (só sem licença): mostra todos.
  const [active, setActive] = useState<Active>("");
  const [view, setView] = useState<"list" | "nearby">("list");
  const [uf, setUf] = useState("");
  const [city, setCity] = useState("");
  const [editing, setEditing] = useState<Technician | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const q = useDebounced(qInput.trim());
  const teams = useTeams();

  const list = useQuery({
    queryKey: ["technicians", q, teamId, active, uf, city],
    queryFn: () =>
      api.get<Technician[]>("/technicians", {
        q: q || undefined,
        team_id: teamId || undefined,
        active: active || undefined,
        state: uf || undefined,
        city: city || undefined,
      }),
    placeholderData: (previous) => previous,
  });
  // Estados e cidades onde a base técnica está (pela região de atuação).
  const regions = useQuery({
    queryKey: ["technicians", "regions", active],
    queryFn: () => api.get<TechnicianRegion[]>("/technicians/regions", { active: active || undefined }),
    staleTime: 60_000,
  });
  const cities = regions.data?.find((r) => r.state === uf)?.cities ?? [];

  if (user && !canManageTickets(user.role)) {
    return <ErrorBox message="A base técnica é exclusiva para analistas e gestores." />;
  }

  return (
    <div>
      <PageHeader
        title="Técnicos"
        description="Base técnica: acesso ao app, dados de contato e foto. Novos técnicos chegam pela homologação ou são cadastrados aqui."
        actions={
          <>
            <Link href="/homologacao">
              <Button>
                <BadgeCheck className="size-4" />
                Homologação
              </Button>
            </Link>
            <Button onClick={() => setImporting(true)}>
              <Upload className="size-4" />
              Importar planilha
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
        />
        {view === "list" && list.data ? (
          <span className="text-xs text-ink-subtle">{list.data.length} técnico(s)</span>
        ) : null}
      </div>

      {view === "nearby" ? (
        <NearbyFinder />
      ) : (
      <>
      <div className="mb-4 flex flex-wrap gap-2">
        <div className="w-full sm:w-40">
          <Select
            value={uf}
            onChange={(e) => {
              setUf(e.target.value);
              setCity("");
            }}
            aria-label="Estado"
          >
            <option value="">Todos os UF</option>
            {(regions.data?.length ? regions.data.map((r) => r.state) : UFS).map((s) => (
              <option key={s} value={s}>
                {s}
                {regions.data ? ` (${regions.data.find((r) => r.state === s)?.total ?? 0})` : ""}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-full sm:w-56">
          <Select value={city} onChange={(e) => setCity(e.target.value)} disabled={!uf} aria-label="Cidade">
            <option value="">{uf ? "Todas as cidades" : "Escolha o UF"}</option>
            {cities.map((c) => (
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

      <Card>
        {list.isLoading ? (
          <LoadingBlock />
        ) : list.error ? (
          <div className="p-4">
            <ErrorBox message={errorMessage(list.error)} />
          </div>
        ) : (list.data ?? []).length === 0 ? (
          <EmptyState
            icon={<HardHat className="size-6" />}
            title="Nenhum técnico encontrado"
            description="Cadastre, importe a sua base em planilha ou envie o link de homologação."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Técnico</Th>
                <Th className="hidden md:table-cell">Grupo</Th>
                <Th className="hidden lg:table-cell">Região de atuação</Th>
                <Th className="hidden lg:table-cell">Telefone</Th>
                <Th>App</Th>
                <Th className="hidden sm:table-cell">OS abertas</Th>
              </tr>
            </thead>
            <tbody>
              {(list.data ?? []).map((t) => (
                <tr key={t.id} className={clsx("cursor-pointer hover:bg-surface-2", !t.is_active && "opacity-60")} onClick={() => setEditing(t)}>
                  <Td>
                    <button type="button" className="flex items-center gap-2.5 text-left" onClick={() => setEditing(t)}>
                      <Avatar tech={t} />
                      <span className="min-w-0">
                        <span className="block truncate font-semibold text-ink">{t.name}</span>
                        <span className="block truncate text-xs text-ink-muted">{t.email}</span>
                      </span>
                    </button>
                  </Td>
                  <Td className="hidden md:table-cell">{t.team?.name ?? <span className="text-ink-muted">—</span>}</Td>
                  <Td className="hidden lg:table-cell">
                    {t.base_city || t.home_city ? (
                      <span className="block">
                        <span className="whitespace-nowrap text-ink">
                          {t.base_city ?? t.home_city}-{t.base_state ?? t.home_state}
                        </span>
                        <span className="block text-xs text-ink-subtle">
                          {t.base_source === "history"
                            ? `pelo histórico · ${t.base_visits ?? 0} OS`
                            : "pelo endereço"}
                        </span>
                      </span>
                    ) : (
                      <span className="text-xs text-ink-subtle">Sem região</span>
                    )}
                  </Td>
                  <Td className="hidden lg:table-cell">{t.phone ?? <span className="text-ink-muted">—</span>}</Td>
                  <Td>
                    <AppStatus tech={t} now={now} />
                  </Td>
                  <Td className="hidden tabular-nums sm:table-cell">{t.open_tickets}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      </>
      )}

      {editing ? <EditDialog tech={editing} onClose={() => setEditing(null)} /> : null}
      {creating ? <CreateDialog onClose={() => setCreating(false)} /> : null}
      {importing ? <ImportDialog onClose={() => setImporting(false)} /> : null}
    </div>
  );
}

function AppStatus({ tech, now }: { tech: Technician; now: number }) {
  if (!tech.is_active) return <span className="text-xs text-ink-muted">Desativado</span>;
  return (
    <span className="flex flex-col gap-0.5 text-xs">
      {tech.on_shift ? (
        <span className="inline-flex items-center gap-1 font-medium text-emerald-700 dark:text-emerald-400">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          Em jornada
        </span>
      ) : null}
      {tech.must_change_password ? (
        <span className="text-amber-700 dark:text-amber-400">Senha provisória</span>
      ) : null}
      <span className="text-ink-muted">
        {tech.last_login_at ? `Acesso ${formatRelative(tech.last_login_at, now)}` : "Nunca acessou"}
      </span>
    </span>
  );
}

/** Senha provisória: aparece uma vez, com atalhos para enviar ao técnico. */
function TempPasswordPanel({ result }: { result: TemporaryPassword }) {
  const [copied, setCopied] = useState(false);
  const { technician: t, temporary_password: pw } = result;
  const message = `Olá, ${t.name.split(" ")[0]}! Seu acesso ao app Maxx Field: e-mail ${t.email} e senha provisória ${pw}. No primeiro acesso, o app pede para você criar uma senha nova.`;
  const phone = t.phone?.replace(/\D/g, "");
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink">
        Senha provisória de <strong>{t.name}</strong>. No primeiro acesso ao app, ele cria uma senha nova.
      </p>
      <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 p-2">
        <code className="flex-1 text-center font-mono text-lg tracking-wider text-ink">{pw}</code>
        <Button
          onClick={async () => {
            await navigator.clipboard.writeText(pw);
            setCopied(true);
          }}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? "Copiada" : "Copiar"}
        </Button>
      </div>
      <a
        href={`https://wa.me/${phone ? `55${phone}` : ""}?text=${encodeURIComponent(message)}`}
        target="_blank"
        rel="noreferrer"
        className="self-start"
      >
        <Button>
          <MessageCircle className="size-4" />
          Enviar por WhatsApp
        </Button>
      </a>
      <p className="text-xs text-ink-muted">Por segurança, esta senha não aparece de novo. Se perder, gere outra.</p>
    </div>
  );
}

function TechnicianFields({
  value,
  onChange,
}: {
  value: {
    name: string;
    email: string;
    phone: string;
    team_id: string;
    job_title: string;
    home_city: string;
    home_state: string;
    coverage_area: string;
  };
  onChange: (v: typeof value) => void;
}) {
  const teams = useTeams();
  const set = (k: keyof typeof value, v: string) => onChange({ ...value, [k]: v });
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Nome" required className="sm:col-span-2">
        <Input value={value.name} onChange={(e) => set("name", e.target.value)} minLength={3} maxLength={160} />
      </Field>
      <Field label="E-mail (login no app)" required>
        <Input type="email" value={value.email} onChange={(e) => set("email", e.target.value)} />
      </Field>
      <Field label="Celular">
        <Input value={value.phone} onChange={(e) => set("phone", e.target.value)} inputMode="tel" />
      </Field>
      <Field label="Grupo técnico">
        <Select value={value.team_id} onChange={(e) => set("team_id", e.target.value)}>
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
        <Input value={value.job_title} onChange={(e) => set("job_title", e.target.value)} maxLength={120} />
      </Field>
      <div className="grid grid-cols-[1fr_5rem] gap-4 sm:col-span-2">
        <Field label="Cidade onde mora" hint="Base das sugestões de técnico por cidade">
          <Input value={value.home_city} onChange={(e) => set("home_city", e.target.value)} maxLength={120} />
        </Field>
        <Field label="UF">
          <Input value={value.home_state} onChange={(e) => set("home_state", e.target.value.toUpperCase().slice(0, 2))} maxLength={2} />
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

function CreateDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    team_id: "",
    job_title: "Técnico de campo",
    home_city: "",
    home_state: "",
    coverage_area: "",
  });
  const create = useMutation({
    mutationFn: () =>
      api.post<TemporaryPassword>("/technicians", {
        name: form.name,
        email: form.email,
        phone: form.phone || null,
        team_id: form.team_id || null,
        job_title: form.job_title || null,
        home_city: form.home_city || null,
        home_state: form.home_state || null,
        coverage_area: form.coverage_area || null,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["technicians"] }),
  });
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
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
            <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
              Cadastrar
            </Button>
          </>
        )
      }
    >
      {create.data ? (
        <TempPasswordPanel result={create.data} />
      ) : (
        <div className="flex flex-col gap-4">
          <TechnicianFields value={form} onChange={setForm} />
          {create.error ? <ErrorBox message={errorMessage(create.error)} /> : null}
        </div>
      )}
    </Dialog>
  );
}

function EditDialog({ tech, onClose }: { tech: Technician; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const catalog = useOnboardingCatalog();
  const areas = useMemo(() => labelMap(catalog.data?.service_areas), [catalog.data]);
  const levels = useMemo(() => labelMap(catalog.data?.skill_levels), [catalog.data]);
  const [current, setCurrent] = useState(tech);
  const [form, setForm] = useState({
    name: tech.name,
    email: tech.email,
    phone: tech.phone ?? "",
    team_id: tech.team?.id ?? "",
    job_title: tech.job_title ?? "",
    home_city: tech.home_city ?? "",
    home_state: tech.home_state ?? "",
    coverage_area: tech.coverage_area ?? "",
  });
  const [isActive, setIsActive] = useState(tech.is_active);
  const [confirmReset, setConfirmReset] = useState(false);
  // Ficha completa (endereço, jornada e serviços), como veio do Field Control.
  const [address, setAddress] = useState({
    line: tech.address_line ?? "",
    district: tech.address_district ?? "",
    zip: tech.address_zip ?? "",
  });
  const [schedule, setSchedule] = useState({
    start: tech.work_schedule?.start?.slice(0, 5) ?? "",
    end: tech.work_schedule?.end?.slice(0, 5) ?? "",
    break_start: tech.work_schedule?.break_start?.slice(0, 5) ?? "",
    break_end: tech.work_schedule?.break_end?.slice(0, 5) ?? "",
  });
  const [serviceIds, setServiceIds] = useState<string[]>(() => (tech.services ?? []).map((s) => s.id));
  const serviceTypes = useServiceTypes({ active: true });
  const refresh = (t: Technician) => {
    setCurrent(t);
    queryClient.invalidateQueries({ queryKey: ["technicians"] });
  };

  const save = useMutation({
    mutationFn: () =>
      api.patch<Technician>(`/technicians/${tech.id}`, {
        name: form.name,
        email: form.email,
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
        work_schedule: schedule.start || schedule.end
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
    mutationFn: (file: File | null) => {
      if (!file) return api.delete<Technician>(`/technicians/${tech.id}/photo`);
      const body = new FormData();
      body.append("file", file);
      return api.upload<Technician>(`/technicians/${tech.id}/photo`, body);
    },
    onSuccess: refresh,
    onError: (e) => toast({ title: errorMessage(e), tone: "error" }),
  });

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

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={current.name}
      description={current.job_title ?? "Técnico"}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-4">
          <Avatar tech={current} size="lg" />
          <div className="flex flex-col gap-1.5">
            <label className="inline-flex cursor-pointer items-center gap-2 self-start rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-2">
              <Camera className="size-4" />
              {current.avatar_url ? "Trocar foto" : "Adicionar foto"}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) photo.mutate(file);
                }}
              />
            </label>
            {current.avatar_url ? (
              <button type="button" className="self-start text-xs text-red-600 hover:underline" onClick={() => photo.mutate(null)}>
                Remover foto
              </button>
            ) : null}
            <span className="text-xs text-ink-muted">JPG, PNG ou WebP até 2 MB.</span>
          </div>
        </div>

        <TechnicianFields value={form} onChange={setForm} />
        <Checkbox label="Acesso ativo (desativado, sai do app na hora)" checked={isActive} onChange={setIsActive} />

        <section className="flex flex-col gap-3 rounded-lg border border-line p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SectionTitle>Ficha completa</SectionTitle>
            <p className="text-xs text-ink-subtle">
              {current.base_city
                ? `Atua em ${current.base_city}-${current.base_state} ${current.base_source === "history" ? `(pelo histórico, ${current.base_visits ?? 0} OS)` : "(pelo endereço)"}`
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
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-ink/80">Serviços que faz</span>
            <MultiSelect
              label="Serviços que faz"
              ariaLabel="Serviços que faz"
              value={serviceIds}
              onChange={setServiceIds}
              options={(serviceTypes.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
            />
            {(current.services ?? []).length ? (
              <div className="flex flex-wrap gap-1">
                {(current.services ?? []).slice(0, 12).map((s) => (
                  <span key={s.id} className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-muted ring-1 ring-line ring-inset">
                    {s.name}
                  </span>
                ))}
                {(current.services ?? []).length > 12 ? (
                  <span className="text-[11px] text-ink-subtle">+{(current.services ?? []).length - 12}</span>
                ) : null}
              </div>
            ) : null}
          </div>
          {current.legacy ? (
            <p className="text-xs text-ink-subtle">
              Importado do Field Control{current.legacy.id ? ` · ID ${current.legacy.id}` : ""}
              {current.legacy.territories?.length ? ` · territórios: ${current.legacy.territories.join(", ")}` : ""}
            </p>
          ) : null}
        </section>

        {current.service_areas.length || current.skills.length ? (
          <section>
            <h3 className="mb-1.5 text-xs font-bold tracking-wide text-ink-muted uppercase">Perfil da homologação</h3>
            <div className="flex flex-wrap gap-1.5">
              {current.service_areas.map((k) => (
                <span key={k} className="rounded-full bg-nav-active px-2.5 py-0.5 text-xs font-medium text-brand">
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

        <section className="rounded-lg border border-line p-3">
          <SectionTitle>Acesso ao app</SectionTitle>
          <p className="mt-1 text-xs text-ink-muted">
            {current.location_consent_at ? (
              <span className="inline-flex items-center gap-1">
                <MapPinned className="size-3.5" /> Autorizou o rastreamento na jornada
              </span>
            ) : (
              "Ainda não autorizou o rastreamento (o app pede antes da primeira jornada)."
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
            <Button className="mt-3" onClick={() => setConfirmReset(true)}>
              <KeyRound className="size-4" />
              Redefinir senha
            </Button>
          )}
        </section>

        {save.error || reset.error ? <ErrorBox message={errorMessage(save.error ?? reset.error)} /> : null}
      </div>
    </Dialog>
  );
}

const TEMPLATE: string[][] = [
  ["nome", "email", "telefone", "grupo", "cargo", "cidade", "uf", "regiao"],
  ["Maria Exemplo", "maria@exemplo.com.br", "(11) 90000-0000", "Campo - Infraestrutura", "Técnico de campo", "Santos", "SP", "Santos, São Vicente e Guarujá"],
];

function ImportDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const run = useMutation({
    mutationFn: (dryRun: boolean) => {
      const body = new FormData();
      body.append("file", file as File);
      return api.upload<ImportResult>(`/technicians/import?dry_run=${dryRun}`, body);
    },
    onSuccess: (r) => {
      if (!r.dry_run) queryClient.invalidateQueries({ queryKey: ["technicians"] });
    },
  });
  const result = run.data;
  const done = result && !result.dry_run;

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title="Importar técnicos"
      description="Planilha CSV ou Excel (XLSX) com nome, e-mail, telefone, grupo e cargo."
      footer={
        done ? (
          <Button variant="primary" onClick={onClose}>
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
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-2">
              <FileSpreadsheet className="size-4" />
              {file ? file.name : "Escolher arquivo"}
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
          E-mail novo cria o técnico com senha provisória; e-mail de técnico já cadastrado atualiza nome, telefone, grupo e
          cargo (a senha não muda). Nada é gravado antes de você confirmar a prévia.
        </p>

        {result ? (
          <>
            <div className="flex flex-wrap gap-2 text-sm">
              <Count label={result.dry_run ? "Serão criados" : "Criados"} value={result.created} tone="emerald" />
              <Count label={result.dry_run ? "Serão atualizados" : "Atualizados"} value={result.updated} tone="sky" />
              <Count label="Com erro (ignorados)" value={result.errors} tone="red" />
            </div>
            {done && result.credentials.length ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
                <p className="font-semibold">Baixe agora as senhas provisórias dos novos técnicos.</p>
                <p className="mt-0.5 text-xs">Por segurança, elas não aparecem de novo. Guarde o arquivo em local seguro e apague depois de enviar.</p>
                <Button
                  className="mt-2"
                  onClick={() =>
                    downloadCsv("senhas-provisorias-tecnicos.csv", [
                      ["nome", "email", "senha_provisoria"],
                      ...result.credentials.map((c) => [c.name, c.email, c.temporary_password]),
                    ])
                  }
                >
                  <Download className="size-4" />
                  Baixar senhas ({result.credentials.length})
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
                          <span className="text-red-600 dark:text-red-400">{r.errors.join(" · ")}</span>
                        ) : r.action === "create" ? (
                          <span className="text-emerald-700 dark:text-emerald-400">Novo</span>
                        ) : (
                          <span className="text-sky-700 dark:text-sky-400">Atualizar</span>
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

function Count({ label, value, tone }: { label: string; value: number; tone: "emerald" | "sky" | "red" }) {
  const cls = {
    emerald: "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300",
    sky: "bg-sky-50 text-sky-800 dark:bg-sky-500/10 dark:text-sky-300",
    red: "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300",
  }[tone];
  return (
    <span className={clsx("rounded-lg px-3 py-1.5", cls)}>
      {label}: <strong className="tabular-nums">{value}</strong>
    </span>
  );
}
