"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Search, Users, UsersRound } from "lucide-react";
import { useState } from "react";
import { useToast } from "@/components/Toaster";
import {
  Button,
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
  Pill,
  Select,
  Table,
  Td,
  Textarea,
  Th,
} from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { isManager, ROLE } from "@/lib/constants";
import { formatDateTime, initials } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { useCustomers, useTeams, useUsers } from "@/lib/queries";
import { sessionStore } from "@/lib/session";
import type { Team, User, UserRole } from "@/lib/types";

const ROLE_COLOR: Record<UserRole, string> = {
  admin: "#7c3aed",
  supervisor: "#2563eb",
  analyst: "#0891b2",
  technician: "#ea580c",
  requester: "#64748b",
};

function UserDialog({ user, onClose }: { user: User | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user: me } = useAuth();
  const teams = useTeams();
  const editing = user !== null;
  const [form, setForm] = useState({
    name: user?.name ?? "",
    email: user?.email ?? "",
    password: "",
    role: (user?.role ?? "analyst") as UserRole,
    phone: user?.phone ?? "",
    job_title: user?.job_title ?? "",
    team_id: user?.team_id ?? "",
    customer_id: user?.customer_id ?? "",
    is_active: user?.is_active ?? true,
  });
  // Usuário do cliente fica ligado à empresa (o portal mostra as solicitações de todas as lojas dela).
  const isClient = form.role === "requester";
  const customers = useCustomers();
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const mutation = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        email: form.email.trim(),
        role: form.role,
        phone: form.phone.trim() || null,
        job_title: form.job_title.trim() || null,
        team_id: isClient ? null : form.team_id || null,
        customer_id: isClient ? form.customer_id || null : null,
      };
      if (form.password) body.password = form.password;
      if (editing) {
        body.is_active = form.is_active;
        return api.patch<User>(`/users/${user.id}`, body);
      }
      return api.post<User>("/users", body);
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["assignable"] });
      if (saved.id === me?.id) sessionStore.updateUser(saved);
      toast({ title: editing ? "Usuário atualizado" : `Usuário ${saved.name} criado`, tone: "success" });
      onClose();
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={editing ? `Editar ${user.name}` : "Novo usuário"}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" type="submit" form="user-form" loading={mutation.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      <form
        id="user-form"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
        className="grid gap-4 sm:grid-cols-2"
      >
        <Field label="Nome" required>
          <Input value={form.name} onChange={(e) => set("name", e.target.value)} required minLength={2} />
        </Field>
        <Field label="E-mail" required>
          <Input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} required />
        </Field>
        <Field
          label={editing ? "Nova senha" : "Senha"}
          required={!editing}
          hint={editing ? "Deixe em branco para manter a atual" : "Mínimo de 8 caracteres"}
        >
          <Input
            type="password"
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => set("password", e.target.value)}
            required={!editing}
            minLength={8}
          />
        </Field>
        <Field label="Papel" required>
          <Select value={form.role} onChange={(e) => set("role", e.target.value as UserRole)}>
            {Object.entries(ROLE).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        {isClient ? (
          <Field label="Empresa do cliente" required hint="No portal ele vê e abre as solicitações de todas as lojas dela.">
            <Select value={form.customer_id} onChange={(e) => set("customer_id", e.target.value)} required>
              <option value="">Escolha a empresa</option>
              {customers.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
        <Field label="Grupo técnico">
          <Select value={form.team_id} onChange={(e) => set("team_id", e.target.value)}>
            <option value="">Sem grupo</option>
            {teams.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        )}
        <Field label="Cargo">
          <Input value={form.job_title} onChange={(e) => set("job_title", e.target.value)} />
        </Field>
        <Field label="Telefone">
          <Input value={form.phone} onChange={(e) => set("phone", e.target.value)} />
        </Field>
        {editing ? (
          <div className="flex items-end pb-2">
            <Checkbox label="Usuário ativo" checked={form.is_active} onChange={(v) => set("is_active", v)} />
          </div>
        ) : null}
        {mutation.error ? (
          <div className="sm:col-span-2">
            <ErrorBox message={errorMessage(mutation.error)} />
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}

function TeamDialog({ team, onClose }: { team: Team | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(team?.name ?? "");
  const [description, setDescription] = useState(team?.description ?? "");
  const [active, setActive] = useState(team?.is_active ?? true);

  const mutation = useMutation({
    mutationFn: () =>
      team
        ? api.patch<Team>(`/teams/${team.id}`, { name: name.trim(), description: description.trim() || null, is_active: active })
        : api.post<Team>("/teams", { name: name.trim(), description: description.trim() || null }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      toast({ title: team ? "Grupo atualizado" : "Grupo criado", tone: "success" });
      onClose();
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={team ? `Editar ${team.name}` : "Novo grupo técnico"}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
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
          <Input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} placeholder="Ex.: Campo - CFTV" />
        </Field>
        <Field label="Descrição">
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {team ? <Checkbox label="Grupo ativo" checked={active} onChange={setActive} /> : null}
        {mutation.error ? <ErrorBox message={errorMessage(mutation.error)} /> : null}
      </form>
    </Dialog>
  );
}

export default function UsersPage() {
  const { user: me } = useAuth();
  const isAdmin = me?.role === "admin";
  const canManageTeams = isManager(me?.role);
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("");
  const q = useDebounced(search.trim());
  const users = useUsers({ q: q || undefined, role: role || undefined });
  const teams = useTeams();
  const [editingUser, setEditingUser] = useState<User | null | undefined>(undefined);
  const [editingTeam, setEditingTeam] = useState<Team | null | undefined>(undefined);

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Usuários e grupos"
        description="Analistas, técnicos de campo, supervisores e solicitantes"
        actions={
          isAdmin ? (
            <Button variant="primary" onClick={() => setEditingUser(null)}>
              <Plus className="size-4" />
              Novo usuário
            </Button>
          ) : null
        }
      />

      <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
        <Card>
          <div className="grid gap-2 border-b border-line p-3 sm:grid-cols-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-ink-muted" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por nome ou e-mail"
                className="pl-9"
              />
            </div>
            <Select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="">Todos os papéis</option>
              {Object.entries(ROLE).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
          {users.isLoading ? (
            <LoadingBlock />
          ) : users.error ? (
            <div className="p-4">
              <ErrorBox message={errorMessage(users.error)} />
            </div>
          ) : (users.data ?? []).length === 0 ? (
            <EmptyState icon={<Users className="size-8" />} title="Nenhum usuário encontrado" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Usuário</Th>
                  <Th>Papel</Th>
                  <Th>Grupo / empresa</Th>
                  <Th>Último acesso</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {users.data?.map((u) => (
                  <tr key={u.id} className={u.is_active ? "hover:bg-surface-2" : "opacity-60 hover:bg-surface-2"}>
                    <Td>
                      <div className="flex items-center gap-2.5">
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand-ink">
                          {initials(u.name)}
                        </div>
                        <div className="min-w-0">
                          <p className="truncate font-semibold">
                            {u.name}
                            {!u.is_active ? <span className="ml-1 text-xs font-normal text-ink-muted">(inativo)</span> : null}
                          </p>
                          <p className="truncate text-xs text-ink-muted">
                            {u.email}
                            {u.job_title ? ` · ${u.job_title}` : ""}
                          </p>
                        </div>
                      </div>
                    </Td>
                    <Td>
                      <Pill color={ROLE_COLOR[u.role]}>{ROLE[u.role]}</Pill>
                    </Td>
                    <Td>{u.role === "requester" ? (u.customer?.name ?? "Sem empresa") : (u.team?.name ?? "—")}</Td>
                    <Td className="text-xs text-ink-muted">{formatDateTime(u.last_login_at)}</Td>
                    <Td className="text-right">
                      {isAdmin ? (
                        <Button size="sm" variant="ghost" onClick={() => setEditingUser(u)}>
                          <Pencil className="size-3.5" />
                          Editar
                        </Button>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card className="self-start">
          <CardHeader
            title="Grupos técnicos"
            description="Filas de atendimento e roteamento por categoria"
            actions={
              canManageTeams ? (
                <Button size="sm" onClick={() => setEditingTeam(null)}>
                  <Plus className="size-3.5" />
                  Novo
                </Button>
              ) : null
            }
          />
          {teams.isLoading ? (
            <LoadingBlock />
          ) : (teams.data ?? []).length === 0 ? (
            <EmptyState icon={<UsersRound className="size-7" />} title="Nenhum grupo" />
          ) : (
            <ul className="divide-y divide-line">
              {teams.data?.map((t) => (
                <li key={t.id} className="flex items-start justify-between gap-2 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink">
                      {t.name}
                      {!t.is_active ? <span className="ml-1 text-xs font-normal text-ink-muted">(inativo)</span> : null}
                    </p>
                    {t.description ? <p className="text-xs text-ink-muted">{t.description}</p> : null}
                  </div>
                  {canManageTeams ? (
                    <button
                      type="button"
                      onClick={() => setEditingTeam(t)}
                      className="rounded p-1 text-ink-muted hover:bg-surface-2 hover:text-ink"
                      aria-label={`Editar ${t.name}`}
                    >
                      <Pencil className="size-3.5" />
                    </button>
                  ) : null}
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
