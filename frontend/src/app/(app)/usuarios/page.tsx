"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, Copy, KeyRound, MessageCircle, Plus, Users, UsersRound } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { Tabs } from "@/components/motion";
import { InactiveChip, plural, RowEditButton, RowEditLink, SearchField } from "@/components/settings/shared";
import { useToast } from "@/components/Toaster";
import {
  Button,
  buttonClassName,
  Card,
  CardHeader,
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
import { api, errorMessage, request } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { isManager, ROLE } from "@/lib/constants";
import { formatDateTime, initials } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { useAssignable, useCustomers, useTeams } from "@/lib/queries";
import { sessionStore } from "@/lib/session";
import type { QueuesOut, TemporaryPassword, Team, User, UserRole } from "@/lib/types";
import { copyText, whatsappUrl } from "@/lib/whatsapp";

type Situation = "active" | "inactive" | "all";

// Linhas por vez na lista (o resto entra com "Mostrar mais").
const PAGE_SIZE = 100;
const ROLE_ORDER: UserRole[] = ["admin", "supervisor", "analyst", "technician", "requester"];
const STAFF_ROLES: UserRole[] = ["admin", "supervisor", "analyst"];

/** O que cada papel acessa (as regras valem no servidor; aqui só explicam). */
const ROLE_HELP: Record<UserRole, { where: string; can: string }> = {
  admin: {
    where: "Central, no navegador",
    can: "Tudo o que o supervisor faz, mais o SLA e os usuários de qualquer papel.",
  },
  supervisor: {
    where: "Central, no navegador",
    can: "Tudo o que o analista faz, mais categorias, grupos técnicos, motivos de violação, dados da empresa, regras de campo e valor do km. Cria e edita analistas e clientes do portal.",
  },
  analyst: {
    where: "Central, no navegador",
    can: "Abre e cuida das OS, clientes, locais, técnicos, formulários, textos do WhatsApp, tipos de serviço, custos extras e motivos de visita improdutiva.",
  },
  technician: {
    where: "App do técnico, no celular",
    can: "Só as OS atribuídas a ele, com o básico do atendimento. Não entra na central.",
  },
  requester: {
    where: "Portal do cliente, no navegador",
    can: "Abre e acompanha as solicitações da empresa dele, só com os dados liberados ao cliente.",
  },
};

// Espelho de backend/app/api/routes/users.py: o supervisor cuida de analistas e clientes do portal;
// os outros papéis, só o administrador.
const SUPERVISOR_MANAGES: UserRole[] = ["analyst", "requester"];
const canManageRole = (me: UserRole | undefined, role: UserRole) =>
  me === "admin" || (me === "supervisor" && SUPERVISOR_MANAGES.includes(role));
/** Papéis que dá para escolher no cadastro. Técnico novo sai pelo cadastro de técnicos (senha provisória). */
function roleOptions(me: UserRole | undefined, creating: boolean): UserRole[] {
  return ROLE_ORDER.filter((r) => canManageRole(me, r) || (creating && r === "technician" && isManager(me)));
}

// Gerenciadores de senha tratam e-mail + senha como tela de login e preencheriam os dados de quem
// está logado: estes atributos pedem para eles ignorarem os campos.
const NO_AUTOFILL = {
  "data-1p-ignore": "true",
  "data-lpignore": "true",
  "data-bwignore": "true",
  "data-form-type": "other",
} as const;

interface Providers {
  microsoft: boolean;
  password_for_staff: boolean;
  microsoft_domains: string[];
}

/** Senha forte para conta que entra só pela Microsoft (a API exige uma, mas ela não é usada). */
function randomPassword(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 24);
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** Dados de acesso para mandar à pessoa (aparecem uma vez, com copiar e WhatsApp). */
interface Credentials {
  title: string;
  intro: React.ReactNode;
  /** Senha para mostrar em destaque (null: entra pela Microsoft). */
  secret: string | null;
  message: string;
  phone: string | null;
}

function accessFor(user: User, password: string | null): Credentials {
  const origin = window.location.origin;
  const hello = `Olá, ${firstName(user.name)}!`;
  if (user.role === "requester") {
    return {
      title: "Acesso ao portal criado",
      intro: (
        <>
          <strong className="font-semibold">{user.name}</strong> já pode entrar no portal e abrir as solicitações
          {user.customer ? ` da ${user.customer.name}` : ""}.
        </>
      ),
      secret: password,
      message: [
        `${hello} Seu acesso ao portal de solicitações está pronto.`,
        `Endereço: ${origin}/login`,
        `E-mail: ${user.email}`,
        `Senha: ${password}`,
        `No portal você abre e acompanha as solicitações${user.customer ? ` da ${user.customer.name}` : ""}.`,
      ].join("\n"),
      phone: user.phone,
    };
  }
  return {
    title: "Acesso criado",
    intro: (
      <>
        <strong className="font-semibold">{user.name}</strong> já pode entrar na central como {ROLE[user.role].toLowerCase()}.
      </>
    ),
    secret: password,
    message: password
      ? [`${hello} Seu acesso à central Maxx Field está pronto.`, `Endereço: ${origin}/login`, `E-mail: ${user.email}`, `Senha: ${password}`].join("\n")
      : [`${hello} Seu acesso à central Maxx Field está pronto.`, `Endereço: ${origin}/login`, `Entre com a sua conta Microsoft da empresa (${user.email}).`].join("\n"),
    phone: user.phone,
  };
}

/** Senha nova definida pela central para outra pessoa: a mensagem pronta para mandar a ela. */
function passwordChangedFor(user: User, password: string): Credentials {
  const portal = user.role === "requester";
  return {
    title: "Senha alterada",
    intro: (
      <>
        <strong className="font-semibold">{user.name}</strong> já entra com a senha nova. As sessões abertas com a senha
        antiga foram encerradas.
      </>
    ),
    secret: password,
    message: [
      `Olá, ${firstName(user.name)}! Sua senha ${portal ? "do portal de solicitações" : "da central Maxx Field"} foi trocada.`,
      `Endereço: ${window.location.origin}/login`,
      `E-mail: ${user.email}`,
      `Senha nova: ${password}`,
    ].join("\n"),
    phone: user.phone,
  };
}

function technicianAccess(result: TemporaryPassword, reset: boolean): Credentials {
  const { technician: t, temporary_password: pw } = result;
  const hello = `Olá, ${firstName(t.name)}!`;
  return {
    title: reset ? "Senha provisória gerada" : "Técnico cadastrado",
    intro: reset ? (
      <>
        Nova senha provisória de <strong className="font-semibold">{t.name}</strong>. As sessões abertas dele foram
        encerradas e o app pede uma senha nova no próximo acesso.
      </>
    ) : (
      <>
        Senha provisória de <strong className="font-semibold">{t.name}</strong>. No primeiro acesso ao app, ele cria
        uma senha nova. Cidade e área de atendimento ficam em{" "}
        <Link href="/tecnicos" className="font-medium text-brand hover:underline">
          Técnicos
        </Link>
        .
      </>
    ),
    secret: pw,
    message: reset
      ? `${hello} Sua nova senha provisória do app Maxx Field é ${pw} (e-mail ${t.email}). Ao entrar, o app pede para você criar uma senha nova.`
      : `${hello} Seu acesso ao app Maxx Field: e-mail ${t.email} e senha provisória ${pw}. No primeiro acesso, o app pede para você criar uma senha nova.`,
    phone: t.phone,
  };
}

/** Senha e mensagem prontas, mostradas uma vez. */
function CredentialsPanel({ credentials }: { credentials: Credentials }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState<"secret" | "message" | null>(null);
  const { intro, secret, message, phone } = credentials;
  const copy = async (what: "secret" | "message", text: string) => {
    if (await copyText(text)) setCopied(what);
    else toast({ title: "Não foi possível copiar", description: "Selecione o texto e copie com Ctrl+C.", tone: "error" });
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink">{intro}</p>
      {secret ? (
        <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 p-2">
          <code className="min-w-0 flex-1 text-center font-mono text-lg tracking-wider break-all text-ink select-all">{secret}</code>
          <Button onClick={() => copy("secret", secret)}>
            {copied === "secret" ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied === "secret" ? "Copiada" : "Copiar senha"}
          </Button>
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-ink/80">Mensagem pronta</span>
        <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm break-words whitespace-pre-wrap text-ink">{message}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => copy("message", message)}>
          {copied === "message" ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied === "message" ? "Mensagem copiada" : "Copiar mensagem"}
        </Button>
        <a href={whatsappUrl(phone, message)} target="_blank" rel="noreferrer" className={buttonClassName("secondary")}>
          <MessageCircle className="size-4" />
          Enviar por WhatsApp
        </a>
      </div>
      {secret ? (
        <p className="text-xs text-ink-muted">Por segurança, a senha não aparece de novo depois que você fechar.</p>
      ) : null}
    </div>
  );
}

function RoleChip({ role }: { role: UserRole }) {
  return (
    <span className="inline-flex items-center rounded-full border border-line px-2 py-0.5 text-xs font-medium whitespace-nowrap text-ink-muted">
      {ROLE[role]}
    </span>
  );
}

type SaveResult =
  | { kind: "updated"; user: User; password: string | null }
  | { kind: "created"; user: User; password: string | null }
  | { kind: "technician"; result: TemporaryPassword };

function UserDialog({ user, onClose }: { user: User | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const { user: me } = useAuth();
  const teams = useTeams();
  const customers = useCustomers();
  const editing = user !== null;
  const self = editing && user.id === me?.id;
  const [initial] = useState(() => ({
    name: user?.name ?? "",
    email: user?.email ?? "",
    role: (user?.role ?? "analyst") as UserRole,
    phone: user?.phone ?? "",
    job_title: user?.job_title ?? "",
    team_id: user?.team_id ?? "",
    customer_id: user?.customer_id ?? "",
    is_active: user?.is_active ?? true,
  }));
  const [form, setForm] = useState(initial);
  const [password, setPassword] = useState("");
  // Editando, a senha fica escondida até alguém pedir para trocar (o navegador não preenche sozinho).
  const [changingPassword, setChangingPassword] = useState(!editing);
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  // Usuário do cliente fica ligado à empresa (o portal mostra as solicitações de todas as lojas dela).
  const isClient = form.role === "requester";
  // Técnico novo: cadastro de técnicos (senha provisória gerada pela API e troca no 1º acesso ao app).
  const technicianFlow = !editing && form.role === "technician";
  const savedTechnician = editing && user.role === "technician";
  const roles = roleOptions(me?.role, !editing);
  const teamOptions = (teams.data ?? []).filter((t) => t.is_active || t.id === initial.team_id);
  const customerOptions = (customers.data ?? []).filter((c) => c.is_active || c.id === initial.customer_id);

  const providers = useQuery({
    queryKey: ["auth", "providers"],
    queryFn: () => request<Providers>("/auth/providers", { auth: false }),
    staleTime: 5 * 60_000,
  });
  const domain = form.email.trim().toLowerCase().split("@")[1] ?? "";
  // Analistas e gestores do domínio da empresa podem ser obrigados a entrar pela Microsoft.
  const microsoftOnly =
    providers.data?.password_for_staff === false &&
    STAFF_ROLES.includes(form.role) &&
    providers.data.microsoft_domains.includes(domain);

  // OS que ficariam com quem for desativado (como responsável pelo atendimento e na fila de analista).
  const watchLoad = editing && user.is_active && user.role !== "requester";
  const assignable = useAssignable(null, watchLoad);
  const queues = useQuery({
    queryKey: ["tickets", "queues"],
    queryFn: () => api.get<QueuesOut>("/queues"),
    enabled: watchLoad && user.role !== "technician",
    staleTime: 30_000,
  });
  const asAssignee = editing ? (assignable.data?.find((a) => a.id === user.id)?.open_tickets ?? 0) : 0;
  const asOwner = editing ? (queues.data?.queues.find((q) => q.user.id === user.id)?.open ?? 0) : 0;
  const deactivating = editing && user.is_active && !form.is_active;
  // A própria senha muda em "Trocar senha" (pede a atual e não derruba a sessão): aqui, só a dos outros.
  const settingPassword = editing && !self && changingPassword && password !== "";
  const sessionEnds =
    editing && (settingPassword || form.email.trim().toLowerCase() !== initial.email.toLowerCase() || form.role !== initial.role);

  const dirty = JSON.stringify(form) !== JSON.stringify(initial) || password !== "";

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["users"] });
    queryClient.invalidateQueries({ queryKey: ["assignable"] });
    queryClient.invalidateQueries({ queryKey: ["technicians"] });
  };

  const save = useMutation({
    mutationFn: async (): Promise<SaveResult> => {
      const common = {
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim() || null,
        job_title: form.job_title.trim() || null,
      };
      if (technicianFlow) {
        const result = await api.post<TemporaryPassword>("/technicians", { ...common, team_id: form.team_id || null });
        return { kind: "technician", result };
      }
      const body: Record<string, unknown> = {
        ...common,
        role: form.role,
        team_id: isClient ? null : form.team_id || null,
        customer_id: isClient ? form.customer_id || null : null,
      };
      if (editing) {
        body.is_active = form.is_active;
        if (settingPassword) body.password = password;
        return { kind: "updated", user: await api.patch<User>(`/users/${user.id}`, body), password: settingPassword ? password : null };
      }
      const secret = microsoftOnly ? randomPassword() : password;
      const created = await api.post<User>("/users", { ...body, password: secret });
      return { kind: "created", user: created, password: microsoftOnly ? null : secret };
    },
    onSuccess: (r) => {
      invalidate();
      if (r.kind === "updated") {
        if (r.user.id === me?.id) sessionStore.updateUser(r.user);
        toast({ title: `${r.user.name}: cadastro atualizado`, tone: "success" });
        // Senha nova de outra pessoa: a mensagem pronta para mandar (a senha não aparece de novo).
        if (r.password) setCredentials(passwordChangedFor(r.user, r.password));
        else onClose();
      } else if (r.kind === "created") {
        toast({ title: `${r.user.name} cadastrado`, tone: "success" });
        setCredentials(accessFor(r.user, r.password));
      } else {
        toast({ title: `${r.result.technician.name} cadastrado`, tone: "success" });
        setCredentials(technicianAccess(r.result, false));
      }
    },
  });

  const reset = useMutation({
    mutationFn: () => api.post<TemporaryPassword>(`/technicians/${user?.id}/reset-password`),
    onSuccess: (r) => {
      invalidate();
      setCredentials(technicianAccess(r, true));
    },
    onError: (e) => toast({ title: "Não foi possível gerar a senha", description: errorMessage(e), tone: "error" }),
  });

  const askReset = async () => {
    if (!editing) return;
    const ok = await confirm({
      title: `Gerar senha provisória para ${user.name}?`,
      description: `O app dele sai na hora e só volta a entrar com a senha nova.${dirty ? " As alterações deste cadastro que não foram salvas serão descartadas." : ""}`,
      confirmLabel: "Gerar senha",
    });
    if (ok) reset.mutate();
  };

  const submit = async () => {
    if (deactivating && (asAssignee > 0 || asOwner > 0)) {
      const ok = await confirm({
        title: `Desativar ${user?.name} com OS abertas?`,
        description: "A pessoa não entra mais no sistema, e as OS continuam com ela até você reatribuir.",
        confirmLabel: "Desativar mesmo assim",
        cancelLabel: "Voltar",
        tone: "danger",
      });
      if (!ok) return;
    }
    save.mutate();
  };

  if (credentials) {
    return (
      <Dialog
        open
        onClose={onClose}
        title={credentials.title}
        footer={
          <Button variant="primary" onClick={onClose}>
            Concluir
          </Button>
        }
      >
        <CredentialsPanel credentials={credentials} />
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      dirty={dirty}
      busy={save.isPending || reset.isPending}
      size="lg"
      title={editing ? `Editar ${user.name}` : "Novo usuário"}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending || reset.isPending}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form="user-form" loading={save.isPending} disabled={reset.isPending}>
            {technicianFlow ? "Cadastrar técnico" : "Salvar"}
          </Button>
        </>
      }
    >
      <form
        id="user-form"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="grid gap-4 sm:grid-cols-2"
      >
        <Field label="Nome" required>
          <Input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            required
            minLength={technicianFlow ? 3 : 2}
            maxLength={160}
            autoComplete="off"
            {...NO_AUTOFILL}
          />
        </Field>
        <Field label="E-mail" required hint={technicianFlow ? "É o login no app." : undefined}>
          <Input
            type="email"
            value={form.email}
            onChange={(e) => set("email", e.target.value)}
            required
            maxLength={255}
            autoComplete="off"
            {...NO_AUTOFILL}
          />
        </Field>
        <Field label="Papel" required hint={self ? "Você não pode tirar o próprio acesso." : ROLE_HELP[form.role].can}>
          <Select value={form.role} onChange={(e) => set("role", e.target.value as UserRole)} disabled={self}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE[r]}
              </option>
            ))}
          </Select>
        </Field>
        {isClient ? (
          <Field label="Empresa do cliente" required hint="No portal ele vê e abre as solicitações de todas as lojas dela.">
            <Select value={form.customer_id} onChange={(e) => set("customer_id", e.target.value)} required>
              <option value="">Escolha a empresa</option>
              {customerOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.is_active ? c.name : `${c.name} (inativo)`}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="Grupo técnico">
            <Select value={form.team_id} onChange={(e) => set("team_id", e.target.value)}>
              <option value="">Sem grupo</option>
              {teamOptions.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.is_active ? t.name : `${t.name} (inativo)`}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Cargo">
          <Input
            value={form.job_title}
            onChange={(e) => set("job_title", e.target.value)}
            maxLength={120}
            placeholder={technicianFlow ? "Técnico de campo" : undefined}
          />
        </Field>
        <Field label={technicianFlow ? "Celular (WhatsApp)" : "Telefone"} hint={!editing ? "Para mandar o acesso pelo WhatsApp." : undefined}>
          <Input value={form.phone} onChange={(e) => set("phone", e.target.value)} maxLength={40} inputMode="tel" />
        </Field>

        {technicianFlow ? (
          <p className="rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-sm text-ink-muted sm:col-span-2">
            O técnico recebe uma senha provisória e cria a dele no primeiro acesso ao app. Cidade, área de atendimento e
            convite pelo WhatsApp ficam em{" "}
            <Link href="/tecnicos" className="font-medium text-brand hover:underline">
              Técnicos
            </Link>
            .
          </p>
        ) : savedTechnician ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line px-3 py-2.5 sm:col-span-2">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">Senha do app</p>
              <p className="text-xs text-ink-muted">
                Gera uma senha provisória: as sessões abertas caem e ele cria uma nova no próximo acesso.
              </p>
            </div>
            <Button size="sm" loading={reset.isPending} onClick={askReset}>
              <KeyRound className="size-3.5" />
              Gerar senha provisória
            </Button>
          </div>
        ) : microsoftOnly ? (
          <p className="rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-sm text-ink-muted sm:col-span-2">
            Este e-mail entra com a conta Microsoft da empresa: a senha daqui não vale para ele.
          </p>
        ) : self ? (
          <p className="rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-sm text-ink-muted sm:col-span-2">
            Para trocar a sua senha, use <strong className="font-semibold text-ink">Trocar senha</strong> no menu da sua
            conta (no seu nome, no menu lateral): ela pede a senha atual e você continua conectado.
          </p>
        ) : changingPassword ? (
          <Field
            label={editing ? "Nova senha" : "Senha"}
            required={!editing}
            className="sm:col-span-2"
            hint={
              editing
                ? "Mínimo de 8 caracteres. Quem estiver conectado com esta conta sai na hora; depois de salvar, aparece a mensagem pronta para enviar."
                : "Mínimo de 8 caracteres. Depois de salvar, aparece a mensagem pronta para enviar."
            }
          >
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required={!editing}
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
              autoFocus={editing}
              {...NO_AUTOFILL}
            />
          </Field>
        ) : (
          <div className="sm:col-span-2">
            <Button size="sm" variant="ghost" onClick={() => setChangingPassword(true)}>
              <KeyRound className="size-3.5" />
              Definir nova senha
            </Button>
          </div>
        )}

        {editing ? (
          <div className="flex flex-col gap-1 sm:col-span-2">
            <Checkbox label="Usuário ativo" checked={form.is_active} onChange={(v) => set("is_active", v)} disabled={self} />
            <span className="text-xs text-ink-muted">
              {self ? "Você não pode desativar o próprio acesso." : "Desativado não entra mais no sistema e sai das sessões abertas."}
            </span>
          </div>
        ) : null}
        {deactivating && (asAssignee > 0 || asOwner > 0) ? (
          <div className="rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 sm:col-span-2 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            <p className="font-semibold">Ainda tem OS abertas: reatribua antes de desativar.</p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {asAssignee > 0 ? (
                <li>
                  <Link href={`/chamados?assignee_id=${user.id}&open_only=true`} className="underline underline-offset-2">
                    {plural(asAssignee, "OS aberta", "OS abertas")} como responsável pelo atendimento
                  </Link>
                </li>
              ) : null}
              {asOwner > 0 ? (
                <li>
                  <Link href={`/chamados?owner_id=${user.id}`} className="underline underline-offset-2">
                    {plural(asOwner, "OS aberta", "OS abertas")} na fila como analista responsável
                  </Link>
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}
        {sessionEnds && !self ? (
          <p className="text-xs text-ink-muted sm:col-span-2">
            Com a troca de e-mail, papel ou senha, a pessoa precisa entrar de novo.
          </p>
        ) : null}
        {sessionEnds && self ? (
          <p className="text-xs text-ink-muted sm:col-span-2">Com a troca de e-mail, você sai e entra de novo.</p>
        ) : null}
        {save.error ? (
          <div className="sm:col-span-2">
            <ErrorBox message={errorMessage(save.error)} />
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}

function TeamDialog({ team, onClose }: { team: Team | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [initial] = useState(() => ({
    name: team?.name ?? "",
    description: team?.description ?? "",
    active: team?.is_active ?? true,
  }));
  const [form, setForm] = useState(initial);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  const mutation = useMutation({
    mutationFn: () => {
      const body = { name: form.name.trim(), description: form.description.trim() || null };
      return team ? api.patch<Team>(`/teams/${team.id}`, { ...body, is_active: form.active }) : api.post<Team>("/teams", body);
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      // O nome do grupo aparece na lista de usuários, nos técnicos e na atribuição das OS.
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["technicians"] });
      queryClient.invalidateQueries({ queryKey: ["assignable"] });
      toast({ title: team ? `Grupo ${saved.name} atualizado` : `Grupo ${saved.name} criado`, tone: "success" });
      onClose();
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      dirty={dirty}
      busy={mutation.isPending}
      title={team ? `Editar ${team.name}` : "Novo grupo técnico"}
      footer={
        <>
          <Button onClick={onClose} disabled={mutation.isPending}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form="team-form" loading={mutation.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      <form
        id="team-form"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
        className="flex flex-col gap-4"
      >
        <Field label="Nome" required>
          <Input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            required
            minLength={2}
            maxLength={120}
            placeholder="Ex.: Campo - CFTV"
          />
        </Field>
        <Field label="Descrição">
          <Textarea rows={2} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
        </Field>
        {team ? (
          <Checkbox label="Grupo ativo" checked={form.active} onChange={(v) => setForm((f) => ({ ...f, active: v }))} />
        ) : null}
        {mutation.error ? <ErrorBox message={errorMessage(mutation.error)} /> : null}
      </form>
    </Dialog>
  );
}

export default function UsersPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <UsersView />
    </Suspense>
  );
}

function UsersView() {
  const { user: me } = useAuth();
  const params = useSearchParams();
  const manager = isManager(me?.role);
  // ?q= vem de outras telas (ex.: Homologação) para achar uma pessoa: aí vale olhar ativos e inativos.
  const [search, setSearch] = useState(() => params.get("q") ?? "");
  const [role, setRole] = useState("");
  const [situation, setSituation] = useState<Situation>(() => (params.get("q") ? "all" : "active"));
  const q = useDebounced(search.trim());
  const users = useQuery({
    queryKey: ["users", { q, role, situation }],
    queryFn: () =>
      api.get<User[]>("/users", {
        q: q || undefined,
        role: role || undefined,
        // A API lê "true"/"false" (o falso booleano nem iria na URL).
        active: situation === "active" ? "true" : situation === "inactive" ? "false" : undefined,
      }),
    placeholderData: keepPreviousData,
  });
  const teams = useTeams();
  const [editingUser, setEditingUser] = useState<User | null | undefined>(undefined);
  const [editingTeam, setEditingTeam] = useState<Team | null | undefined>(undefined);
  const list = useMemo(() => users.data ?? [], [users.data]);
  const filtered = Boolean(q || role || situation !== "active");
  // Lista longa (ex.: os técnicos inativos que vieram do Field Control) entra aos poucos; mudar a
  // busca ou os filtros volta ao começo.
  const filterKey = `${q}|${role}|${situation}`;
  const [shown, setShown] = useState({ key: filterKey, count: PAGE_SIZE });
  const visibleCount = shown.key === filterKey ? shown.count : PAGE_SIZE;
  const visible = list.slice(0, visibleCount);

  const description =
    me?.role === "admin"
      ? "Contas da central, dos técnicos e dos clientes do portal."
      : me?.role === "supervisor"
        ? "Você cria e edita analistas e clientes do portal; os outros papéis, só o administrador."
        : "Só administradores e supervisores criam e editam usuários.";

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Usuários e grupos"
        description={description}
        actions={
          manager ? (
            <Button variant="primary" onClick={() => setEditingUser(null)}>
              <Plus className="size-4" />
              Novo usuário
            </Button>
          ) : null
        }
      />

      <details className="group mb-4 rounded-xl border border-line bg-surface shadow-elev-1">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold text-ink focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-4 shrink-0 text-ink-muted transition-transform duration-150 group-open:rotate-90" />
          Quem pode o quê
          <span className="font-normal text-ink-muted">· o que cada papel acessa</span>
        </summary>
        <div className="border-t border-line">
          <Table>
            <thead>
              <tr>
                <Th>Papel</Th>
                <Th>Onde entra</Th>
                <Th>O que pode</Th>
              </tr>
            </thead>
            <tbody>
              {ROLE_ORDER.map((r) => (
                <tr key={r}>
                  <Td className="font-semibold whitespace-nowrap">{ROLE[r]}</Td>
                  <Td className="text-sm whitespace-nowrap text-ink-muted">{ROLE_HELP[r].where}</Td>
                  <Td className="min-w-72 text-sm">{ROLE_HELP[r].can}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      </details>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Card className="min-w-0">
          <div className="flex flex-col gap-2 border-b border-line p-3 lg:flex-row lg:items-center">
            <SearchField
              className="lg:max-w-xs lg:flex-1"
              value={search}
              onChange={setSearch}
              placeholder="Buscar por nome ou e-mail"
              label="Buscar usuário"
            />
            <Select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Papel" className="lg:w-48">
              <option value="">Todos os papéis</option>
              {ROLE_ORDER.map((r) => (
                <option key={r} value={r}>
                  {ROLE[r]}
                </option>
              ))}
            </Select>
            <Tabs<Situation>
              variant="segmented"
              ariaLabel="Situação"
              className="self-start lg:ml-auto lg:self-auto"
              value={situation}
              onChange={setSituation}
              items={[
                { key: "active", label: "Ativos" },
                { key: "inactive", label: "Inativos" },
                { key: "all", label: "Todos" },
              ]}
            />
          </div>
          {users.isLoading ? (
            <LoadingBlock />
          ) : users.error && !users.data ? (
            <div className="flex flex-col items-start gap-3 p-4">
              <ErrorBox message={errorMessage(users.error)} />
              <Button size="sm" loading={users.isFetching} onClick={() => users.refetch()}>
                Tentar de novo
              </Button>
            </div>
          ) : list.length === 0 ? (
            <EmptyState
              icon={<Users />}
              title={filtered ? "Nenhum usuário encontrado" : "Nenhum usuário ativo"}
              description={filtered ? "Confira a busca, o papel e a situação." : undefined}
              action={
                filtered ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      setSearch("");
                      setRole("");
                      setSituation("active");
                    }}
                  >
                    Limpar filtros
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              <p className="px-4 pt-3 pb-1 text-xs text-ink-muted" aria-live="polite">
                {situation === "active"
                  ? plural(list.length, "usuário ativo", "usuários ativos")
                  : situation === "inactive"
                    ? plural(list.length, "usuário inativo", "usuários inativos")
                    : plural(list.length, "usuário", "usuários")}
              </p>
              <Table>
                <thead>
                  <tr>
                    <Th>Usuário</Th>
                    <Th>Papel</Th>
                    <Th>Grupo / empresa</Th>
                    <Th>Último acesso</Th>
                    {manager ? <Th className="edit-col">Editar</Th> : null}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((u) => (
                    <tr key={u.id} className="transition-colors hover:bg-[var(--row-hover)]">
                      <Td className="min-w-64">
                        <div className="flex items-center gap-2.5">
                          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand-ink">
                            {initials(u.name)}
                          </div>
                          <div className="min-w-0">
                            <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-semibold text-ink">
                              <span className="min-w-0 truncate">{u.name}</span>
                              {u.id === me?.id ? <span className="text-xs font-normal text-ink-muted">(você)</span> : null}
                              {!u.is_active ? <InactiveChip /> : null}
                            </p>
                            <p className="truncate text-xs text-ink-muted">
                              {u.email}
                              {u.job_title ? ` · ${u.job_title}` : ""}
                            </p>
                          </div>
                        </div>
                      </Td>
                      <Td>
                        <RoleChip role={u.role} />
                      </Td>
                      <Td className="text-sm">
                        {u.role === "requester"
                          ? (u.customer?.name ?? <span className="text-ink-muted">Sem empresa</span>)
                          : (u.team?.name ?? <span className="text-ink-subtle">—</span>)}
                      </Td>
                      <Td className="text-xs whitespace-nowrap text-ink-muted">
                        <span className="block">{u.last_login_at ? formatDateTime(u.last_login_at) : "Nunca acessou"}</span>
                        {u.must_change_password ? <span className="block">Senha provisória</span> : null}
                      </Td>
                      {manager ? (
                        <Td className="edit-col">
                          {canManageRole(me?.role, u.role) ? (
                            <RowEditButton label={`Editar ${u.name}`} onClick={() => setEditingUser(u)} />
                          ) : u.role === "technician" ? (
                            // O cadastro do técnico (cidade, área, senha provisória) fica em Técnicos.
                            <RowEditLink label={`Editar ${u.name} em Técnicos`} href={`/tecnicos?q=${encodeURIComponent(u.email)}`} />
                          ) : (
                            <span className="inline-flex size-8 items-center justify-center text-ink-subtle" title="Só o administrador edita este papel">
                              <span aria-hidden>—</span>
                              <span className="sr-only">Só o administrador edita este papel</span>
                            </span>
                          )}
                        </Td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </Table>
              {list.length > visible.length ? (
                <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <span className="text-xs text-ink-muted">
                    Mostrando {visible.length.toLocaleString("pt-BR")} de {list.length.toLocaleString("pt-BR")}
                  </span>
                  <Button size="sm" onClick={() => setShown({ key: filterKey, count: visibleCount + PAGE_SIZE })}>
                    Mostrar mais {Math.min(PAGE_SIZE, list.length - visible.length)}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </Card>

        <Card className="self-start">
          <CardHeader
            title="Grupos técnicos"
            description="Filas de atendimento e roteamento por categoria"
            actions={
              manager ? (
                <Button size="sm" onClick={() => setEditingTeam(null)}>
                  <Plus className="size-3.5" />
                  Novo
                </Button>
              ) : null
            }
          />
          {teams.isLoading ? (
            <LoadingBlock rows={2} />
          ) : teams.error ? (
            <div className="flex flex-col items-start gap-3 p-4">
              <ErrorBox message={errorMessage(teams.error)} />
              <Button size="sm" loading={teams.isFetching} onClick={() => teams.refetch()}>
                Tentar de novo
              </Button>
            </div>
          ) : (teams.data ?? []).length === 0 ? (
            <EmptyState
              icon={<UsersRound />}
              title="Nenhum grupo"
              description="Grupos organizam as filas e o roteamento das categorias."
            />
          ) : (
            <ul className="divide-y divide-line">
              {teams.data?.map((t) => (
                <li key={t.id} className="flex items-start justify-between gap-2 px-4 py-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">
                      {t.name}
                      {!t.is_active ? <InactiveChip /> : null}
                    </p>
                    {t.description ? <p className="text-xs text-ink-muted">{t.description}</p> : null}
                  </div>
                  {manager ? <RowEditButton label={`Editar o grupo ${t.name}`} onClick={() => setEditingTeam(t)} /> : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {editingUser !== undefined ? <UserDialog user={editingUser} onClose={() => setEditingUser(undefined)} /> : null}
      {editingTeam !== undefined ? <TeamDialog team={editingTeam} onClose={() => setEditingTeam(undefined)} /> : null}
    </div>
  );
}
