"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { AlertTriangle, Hand, MapPin, Phone, Star, ThumbsUp, Users, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { LocationPicker } from "@/components/LocationPicker";
import { ConflictHint, ConflictList, scheduleConflicts } from "@/components/ScheduleConflict";
import { useToast } from "@/components/Toaster";
import { HelpersField, SuggestedTechnicians } from "@/components/new-ticket/SuggestedTechnicians";
import { PayoutLine } from "@/components/ticket/PayoutsCard";
import { busyTitle, isVersionConflict } from "@/components/ticket/useConflictHandler";
import { useNow } from "@/components/useNow";
import { Button, buttonClassName, Card, CardHeader, ErrorBox, Field, Input, SectionTitle, Select, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { PRIORITY, PRIORITY_ORDER, ROLE, STATUS, STATUS_ORDER } from "@/lib/constants";
import { formatDateTime, formatMinutes, formatMoney, fromLocalInput, toLocalInput } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { useProjects } from "@/lib/projects";
import { useAssignable, useCategories, useCustomers, useServiceTypes } from "@/lib/queries";
import type {
  ConflictItem,
  IntakeContext,
  Location,
  Tag,
  TechnicianSuggestion,
  TicketDetail,
  TicketPriority,
  TicketStatus,
  TicketUpdatePayload,
  User,
  UUID,
} from "@/lib/types";
import { copyText } from "@/lib/whatsapp";

/** Prefixo do id do formulário (o editor soma um id próprio: página e painel podem estar abertos juntos). */
export const GENERAL_FORM_ID = "ticket-general";

/** O que o rodapé do editor (fora do formulário) precisa para o botão Salvar. */
export interface SaveState {
  dirty: boolean;
  pending: boolean;
  /** A API barrou por conflito de agenda: o próximo Salvar confirma mesmo assim. */
  conflict: boolean;
}

const split = (iso: string | null | undefined) => {
  const local = toLocalInput(iso);
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
};
const join = (date: string, time: string) => (date && time ? fromLocalInput(`${date}T${time}`) : null);
const sameList = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** Situações com o técnico na OS: tirar ou trocar o técnico muda a situação. */
const FIELD_ACTIVE: TicketStatus[] = ["assigned", "scheduled", "en_route", "in_progress"];
/** Concluída, fechada ou cancelada: as sugestões de técnico ficam recolhidas. */
const FINISHED: TicketStatus[] = ["resolved", "closed", "cancelled"];
/** Limite de outros técnicos na visita (o mesmo da API). */
const MAX_HELPERS = 6;
/** Folga para o relógio do computador (a API aceita 1 minuto). */
const SKEW_MS = 60_000;

interface FormState {
  title: string;
  serviceTypeId: string;
  categoryId: string;
  priority: TicketPriority;
  tags: Tag[];
  customerId: string;
  locationId: string;
  locationLabel: string;
  serviceAddress: string;
  description: string;
  estimated: string;
  date: string;
  time: string;
  assigneeId: string;
  helperIds: UUID[];
  ownerId: string;
  projectId: string;
  visitNote: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  resolutionNotes: string;
  timesReason: string;
}

function initial(t: TicketDetail): FormState {
  const scheduled = split(t.scheduled_start);
  const start = split(t.arrived_at);
  const end = split(t.resolved_at);
  return {
    title: t.title,
    serviceTypeId: t.service_type?.id ?? "",
    categoryId: t.category?.id ?? "",
    priority: t.priority,
    tags: t.tags ?? [],
    customerId: t.customer?.id ?? "",
    locationId: t.location?.id ?? "",
    locationLabel: t.location ? [t.location.name, t.location.code].filter(Boolean).join(" - ") : "",
    serviceAddress: t.service_address ?? "",
    description: t.description ?? "",
    estimated: t.estimated_minutes ? String(t.estimated_minutes) : "",
    date: scheduled.date,
    time: scheduled.time,
    assigneeId: t.assignee?.id ?? "",
    helperIds: (t.helpers ?? []).map((h) => h.id),
    ownerId: t.owner?.id ?? "",
    projectId: t.project?.id ?? "",
    visitNote: t.visit_note ?? "",
    startDate: start.date,
    startTime: start.time,
    endDate: end.date,
    endTime: end.time,
    resolutionNotes: t.resolution_notes ?? "",
    timesReason: "",
  };
}

type Key = keyof FormState;

/** Textos comparados sem os espaços das pontas (a API grava aparado). */
const TEXT_KEYS: Key[] = ["title", "description", "serviceAddress", "visitNote", "resolutionNotes"];

/**
 * Campos que mudam juntos (a loja e o cliente dela, a agenda, os horários reais). Quando outra pessoa
 * muda a OS enquanto se edita, cada grupo entra inteiro ou fica como está aqui.
 */
const GROUPS: { keys: Key[]; label: string; schedule?: boolean }[] = [
  { keys: ["title"], label: "título" },
  { keys: ["serviceTypeId"], label: "tipo de OS" },
  { keys: ["categoryId"], label: "categoria" },
  { keys: ["priority"], label: "prioridade" },
  { keys: ["tags"], label: "etiquetas" },
  { keys: ["customerId", "locationId", "locationLabel"], label: "cliente e loja" },
  { keys: ["serviceAddress"], label: "endereço" },
  { keys: ["description"], label: "descrição" },
  { keys: ["estimated", "date", "time"], label: "agenda", schedule: true },
  { keys: ["assigneeId"], label: "técnico", schedule: true },
  { keys: ["helperIds"], label: "outros técnicos", schedule: true },
  { keys: ["ownerId"], label: "analista responsável" },
  { keys: ["projectId"], label: "projeto" },
  { keys: ["visitNote"], label: "observação da visita" },
  { keys: ["startDate", "startTime", "endDate", "endTime"], label: "horários reais" },
  { keys: ["resolutionNotes"], label: "descrição da conclusão" },
];

const SCHEDULE_KEYS: Key[] = ["date", "time", "estimated"];
const TIME_KEYS: Key[] = ["startDate", "startTime", "endDate", "endTime"];

function sameValue(key: Key, a: FormState, b: FormState): boolean {
  if (key === "helperIds") return sameList(a.helperIds, b.helperIds);
  if (key === "tags") return JSON.stringify(a.tags) === JSON.stringify(b.tags);
  if (TEXT_KEYS.includes(key)) return String(a[key]).trim() === String(b[key]).trim();
  return a[key] === b[key];
}

const sameGroup = (keys: Key[], a: FormState, b: FormState) => keys.every((k) => sameValue(k, a, b));

/** `target` com os campos `keys` copiados de `source`. */
function withKeys(target: FormState, source: FormState, keys: Key[]): FormState {
  const out = { ...target };
  for (const key of keys) Object.assign(out, { [key]: source[key] });
  return out;
}

/** Depois de salvar: o que não mudou desde o envio vira o que a API gravou; o que se digitou durante o envio fica. */
function adopt(current: FormState, sent: FormState, fresh: FormState): FormState {
  let out = current;
  for (const group of GROUPS) if (sameGroup(group.keys, current, sent)) out = withKeys(out, fresh, group.keys);
  return current.timesReason === sent.timesReason ? { ...out, timesReason: "" } : out;
}

/** A cópia `a` da OS é mais nova que `b`: a versão sobe a cada edição e a hora cobre o que não sobe a versão (outros técnicos). */
function isNewer(a: TicketDetail, b: TicketDetail) {
  return a.version > b.version || (a.version === b.version && Date.parse(a.updated_at) > Date.parse(b.updated_at));
}

function Counter({ value, max }: { value: string; max: number }) {
  return (
    <span className="self-end text-[11px] text-ink-subtle tabular-nums">
      {value.length.toLocaleString("pt-BR")} / {max.toLocaleString("pt-BR")}
    </span>
  );
}

/** Mensagem embaixo do campo com problema (aparece depois da primeira tentativa de salvar). */
function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <span id={id} className="text-xs font-medium text-red-700 dark:text-red-300">
      {message}
    </span>
  ) : null;
}

/** Aviso do que vai acontecer ao salvar (ex.: a OS volta para Novo). */
function Caution({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p
      className={clsx(
        "flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200",
        className,
      )}
    >
      <AlertTriangle className="mt-px size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** Etiquetas da OS (ex.: "Adicional Noturno"): tira com o ×, inclui escolhendo ou digitando. */
function TagsField({ value, onChange }: { value: Tag[]; onChange: (tags: Tag[]) => void }) {
  const [draft, setDraft] = useState("");
  const listId = useId();
  const known = useQuery({ queryKey: ["ticket-tags"], queryFn: () => api.get<Tag[]>("/ticket-tags"), staleTime: 5 * 60_000 });
  const add = (name: string) => {
    const clean = name.trim();
    if (!clean || value.some((t) => t.name.toLowerCase() === clean.toLowerCase())) return setDraft("");
    const match = known.data?.find((t) => t.name.toLowerCase() === clean.toLowerCase());
    onChange([...value, match ?? { name: clean, color: null }]);
    setDraft("");
  };
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold text-ink/80">Etiquetas</span>
      <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1 shadow-elev-1">
        {value.map((t) => (
          <span key={t.name} className="inline-flex items-center gap-0.5 rounded-full bg-brand-soft py-px pr-0.5 pl-2.5 text-xs font-medium text-brand-ink">
            {t.name}
            <button
              type="button"
              onClick={() => onChange(value.filter((x) => x.name !== t.name))}
              className="inline-flex size-6 items-center justify-center rounded-full hover:bg-brand/15"
              aria-label={`Tirar a etiqueta ${t.name}`}
            >
              <X className="size-3.5" />
            </button>
          </span>
        ))}
        <input
          list={listId}
          value={draft}
          maxLength={60}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(draft);
            }
          }}
          onBlur={() => draft && add(draft)}
          placeholder={value.length ? "+ etiqueta" : "Incluir etiqueta (ex.: Adicional Noturno)"}
          className="h-7 min-w-44 flex-1 rounded-md bg-transparent px-1.5 text-sm text-ink outline-none placeholder:text-ink-subtle"
          aria-label="Incluir etiqueta"
        />
        <datalist id={listId}>
          {(known.data ?? []).map((t) => (
            <option key={t.name} value={t.name} />
          ))}
        </datalist>
      </div>
    </div>
  );
}

/** Corpo da correção de horários (PUT /times): o motivo e só o que mudou. */
interface TimesBody {
  reason: string;
  arrived_at?: string | null;
  resolved_at?: string | null;
}

/** O que o Salvar envia, em até três chamadas (dados da OS, técnico, horários reais). */
interface SavePlan {
  version: number;
  patch: TicketUpdatePayload | null;
  assign: { assignee_id: UUID | null } | null;
  times: TimesBody | null;
  /** Os conflitos de agenda já foram mostrados: o Salvar confirma mesmo assim. */
  confirmed: boolean;
  /** O formulário como foi enviado (o que mudar depois disso continua não salvo). */
  sent: FormState;
}

/**
 * Aba "Geral" da OS, no formato do "Editar atividade" do Field Control: tudo editável pela central a
 * qualquer momento (inclusive com a OS fechada), com os técnicos mais indicados para a loja.
 *
 * A edição se apoia numa cópia da OS (a `base`). Quando a OS muda por fora (o técnico conclui no app,
 * outro analista salva), os campos não mexidos passam a mostrar a versão nova e os mexidos ficam como
 * estão, com um aviso; nada do que foi digitado se perde.
 */
export function GeneralTab({
  ticket,
  formId = GENERAL_FORM_ID,
  onSaveState,
  onTransition,
}: {
  ticket: TicketDetail;
  /** Id do formulário (o botão Salvar do rodapé fica fora dele e aponta para este id). */
  formId?: string;
  /** Para o botão Salvar do rodapé (fora do formulário). */
  onSaveState: (state: SaveState) => void;
  /** Mudar a situação: o editor abre a confirmação com o que o destino pede. */
  onTransition: (to: TicketStatus) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const now = useNow(30_000);
  const formRef = useRef<HTMLFormElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const conflictRef = useRef<HTMLDivElement>(null);

  // `server`: a cópia mais nova da OS que se conhece (a da lista em cache ou a resposta do último
  // Salvar, que pode chegar antes do cache). `snap.base` é o que ela dizia quando a edição se apoiou nela.
  const [snap, setSnap] = useState(() => ({ server: ticket, base: initial(ticket) }));
  const [saved, setSaved] = useState<TicketDetail | null>(null);
  const [form, setForm] = useState<FormState>(() => initial(ticket));
  // A OS mudou por fora durante a edição: os grupos que as duas pessoas mexeram.
  const [notice, setNotice] = useState<string[] | null>(null);
  const [conflicts, setConflicts] = useState<ConflictItem[] | null>(null);
  const [tried, setTried] = useState(false);
  // Um passo do Salvar gravou e outro falhou: o aviso diz que o resto já foi salvo.
  const [partial, setPartial] = useState(false);
  const [changingLocation, setChangingLocation] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const base = snap.base;
  const server = saved && isNewer(saved, ticket) ? saved : ticket;

  const set = <K extends Key>(key: K, value: FormState[K]) => {
    if (key === "date" || key === "time" || key === "estimated" || key === "helperIds") setConflicts(null);
    setForm((f) => ({ ...f, [key]: value }));
  };
  // Quem passa a ser o técnico responsável deixa de ser "outro técnico" da visita.
  const setAssignee = (id: string) => {
    setConflicts(null);
    setForm((f) => ({ ...f, assigneeId: id, helperIds: f.helperIds.filter((h) => h !== id) }));
  };

  const customers = useCustomers();
  const categories = useCategories();
  const serviceTypes = useServiceTypes({ customerId: form.customerId || null, active: true });
  const assignable = useAssignable(null);
  const projects = useProjects({ enabled: true });
  // Analistas e gestores (quem pode ser o analista responsável): lista estável, fora das chaves que o
  // tempo real recarrega a cada evento.
  const staff = useQuery({
    queryKey: ["users", "managers"],
    queryFn: () => api.get<User[]>("/users", { active: true }),
    staleTime: 5 * 60_000,
  });
  const intake = useQuery({
    queryKey: ["intake", form.locationId || null, form.locationId ? null : form.customerId || null],
    queryFn: () =>
      api.get<IntakeContext>("/intake/context", {
        location_id: form.locationId || undefined,
        customer_id: form.locationId ? undefined : form.customerId || undefined,
      }),
    enabled: Boolean(form.locationId || form.customerId),
    staleTime: 30_000,
  });

  const estimatedNumber = form.estimated ? Number(form.estimated) : null;
  const estimatedValid =
    estimatedNumber === null || (Number.isInteger(estimatedNumber) && estimatedNumber >= 1 && estimatedNumber <= 10080);
  const minutes = estimatedValid ? estimatedNumber : null;
  const startIso = join(form.date, form.time);
  // Os técnicos indicados e o aviso de agenda esperam a digitação parar (uma consulta, não uma por tecla).
  const lazyStart = useDebounced(startIso, 400);
  const lazyMinutes = useDebounced(minutes, 400);
  const lazyTitle = useDebounced(form.title.trim(), 400);
  // Com técnico na OS, ou com ela concluída, as sugestões ficam recolhidas (a consulta só roda se abrir).
  const suggestionsShown = suggestOpen || (!form.assigneeId && !FINISHED.includes(server.status));
  // Os 5 técnicos mais indicados para a loja, o serviço e o horário (o mesmo ranking da abertura). A
  // própria OS não conta como "ocupado" para o técnico dela (exclude_ticket_id).
  const suggestions = useQuery({
    queryKey: ["technician-suggest", form.locationId, form.serviceTypeId, form.categoryId, form.projectId, lazyStart, lazyMinutes, lazyTitle, ticket.id],
    queryFn: () =>
      api.get<TechnicianSuggestion[]>("/technicians/suggest", {
        location_id: form.locationId,
        service_type_id: form.serviceTypeId || undefined,
        category_id: form.categoryId || undefined,
        project_id: form.projectId || undefined,
        title: lazyTitle || undefined,
        start: lazyStart ?? undefined,
        estimated_minutes: lazyMinutes ?? undefined,
        exclude_ticket_id: ticket.id,
        limit: 5,
      }),
    enabled: Boolean(form.locationId) && suggestionsShown,
    staleTime: 30_000,
    // Mudou só o horário ou o serviço: a lista anterior fica à vista até a nova chegar (sem piscar).
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === form.locationId ? previous : undefined),
  });

  const people = useMemo(
    () =>
      [...(assignable.data ?? [])].sort(
        (a, b) => (a.role === "technician" ? 0 : 1) - (b.role === "technician" ? 0 : 1) || a.name.localeCompare(b.name),
      ),
    [assignable.data],
  );
  const technicians = people.filter((p) => p.role === "technician");
  const internal = people.filter((p) => p.role !== "technician");
  const names = useMemo(() => {
    const map: Record<UUID, string> = {};
    for (const p of people) map[p.id] = p.name;
    for (const h of server.helpers ?? []) map[h.id] ??= h.name;
    if (server.assignee) map[server.assignee.id] ??= server.assignee.name;
    return map;
  }, [people, server.helpers, server.assignee]);
  const analysts = useMemo(() => {
    const list = (staff.data ?? [])
      .filter((u) => u.role === "admin" || u.role === "supervisor" || u.role === "analyst")
      .map((u) => ({ id: u.id, name: u.name }));
    // O analista atual (mesmo desativado) e quem está logado (o "Assumir") sempre aparecem.
    for (const person of [server.owner, user]) {
      if (person && !list.some((u) => u.id === person.id)) list.push({ id: person.id, name: person.name });
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }, [staff.data, server.owner, user]);

  // ── o que mudou ──
  const schedChanged = !sameGroup(SCHEDULE_KEYS, form, base);
  const timesChanged = !sameGroup(TIME_KEYS, form, base);
  const assigneeChanged = form.assigneeId !== base.assigneeId;
  const helpersChanged = !sameList(form.helperIds, base.helperIds);
  const dirty = GROUPS.some((group) => !sameGroup(group.keys, form, base));

  // Tirar ou trocar o técnico muda a situação da OS na API: avisa antes.
  const currentTech = server.assignee;
  const assigneeWarning =
    assigneeChanged && currentTech
      ? !form.assigneeId && FIELD_ACTIVE.includes(server.status)
        ? { title: "Tirar o técnico da OS?", text: `Sem técnico, a OS volta para Novo e sai do app de ${currentTech.name}.` }
        : form.assigneeId && (server.status === "en_route" || server.status === "in_progress")
          ? { title: "Trocar o técnico em campo?", text: `A OS volta para Atribuído e o atendimento de ${currentTech.name} é interrompido.` }
          : null
      : null;

  // ── validação (as mesmas regras da API, com a mensagem ao lado do campo) ──
  const startAt = join(form.startDate, form.startTime);
  const endAt = join(form.endDate, form.endTime);
  const errors: Partial<Record<"title" | "estimated" | "schedule" | "start" | "end" | "reason", string>> = {};
  if (form.title.trim().length < 3) errors.title = "O título precisa de pelo menos 3 letras";
  if (!estimatedValid) errors.estimated = "Use minutos inteiros, de 1 a 10080";
  if (Boolean(form.date) !== Boolean(form.time)) errors.schedule = "Informe a data e a hora do agendamento";
  if (timesChanged) {
    const created = Date.parse(server.created_at);
    const problem = (at: string) => {
      const t = Date.parse(at);
      if (t > now + SKEW_MS) return "O horário não pode ficar no futuro";
      if (t < created - SKEW_MS) return `Não pode ser antes da abertura da OS (${formatDateTime(server.created_at)})`;
      return undefined;
    };
    if (server.arrived_at && !startAt) errors.start = "Informe a data e a hora do início";
    else if (startAt) errors.start = problem(startAt);
    if (server.resolved_at && !endAt) errors.end = "Informe a data e a hora da conclusão";
    else if (endAt) errors.end = problem(endAt);
    if (!errors.end && startAt && endAt && Date.parse(startAt) > Date.parse(endAt)) errors.end = "A conclusão deve ser depois do início";
    if (!errors.end && endAt && server.closed_at && Date.parse(endAt) > Date.parse(server.closed_at) + SKEW_MS) {
      errors.end = `A conclusão não pode ser depois do fechamento (${formatDateTime(server.closed_at)})`;
    }
    if (form.timesReason.trim().length < 3) errors.reason = "Explique o motivo da correção (pelo menos 3 letras)";
  }
  const invalid = Object.values(errors).some(Boolean);
  // A mensagem aparece depois da primeira tentativa de salvar; o aria-invalid vale sempre.
  const shown = (key: keyof typeof errors) => (tried ? errors[key] : undefined);
  const errorId = (key: string) => `${formId}-${key}`;
  const today = toLocalInput(new Date(now).toISOString()).slice(0, 10);

  function buildPatch(): TicketUpdatePayload {
    const p: TicketUpdatePayload = {};
    if (!sameValue("title", form, base)) p.title = form.title.trim();
    if (!sameValue("description", form, base)) p.description = form.description.trim();
    if (form.categoryId !== base.categoryId) p.category_id = form.categoryId || null;
    if (form.priority !== base.priority) p.priority = form.priority;
    if (form.serviceTypeId !== base.serviceTypeId) p.service_type_id = form.serviceTypeId || null;
    if (form.estimated !== base.estimated) p.estimated_minutes = minutes;
    if (form.customerId !== base.customerId) p.customer_id = form.customerId || null;
    if (form.locationId !== base.locationId) p.location_id = form.locationId || null;
    if (!sameValue("serviceAddress", form, base)) p.service_address = form.serviceAddress.trim() || null;
    if (!sameValue("visitNote", form, base)) p.visit_note = form.visitNote.trim() || null;
    if (helpersChanged) p.helper_ids = form.helperIds;
    if (form.ownerId !== base.ownerId) p.owner_id = form.ownerId || null;
    if (form.projectId !== base.projectId) p.project_id = form.projectId || null;
    if (!sameValue("resolutionNotes", form, base)) p.resolution_notes = form.resolutionNotes.trim() || null;
    if (!sameValue("tags", form, base)) p.tags = form.tags;
    if (schedChanged && startIso) {
      // Fim = início + duração (estimada ou a da agenda atual), para não sobrar um fim antigo.
      const current =
        server.scheduled_start && server.scheduled_end
          ? Math.round((Date.parse(server.scheduled_end) - Date.parse(server.scheduled_start)) / 60000)
          : null;
      const duration = minutes ?? current ?? 60;
      p.scheduled_start = startIso;
      p.scheduled_end = new Date(Date.parse(startIso) + duration * 60000).toISOString();
    } else if (schedChanged && !form.date && !form.time && (base.date || base.time)) {
      // Data e hora apagadas: a OS fica sem agenda.
      p.scheduled_start = null;
      p.scheduled_end = null;
    }
    return p;
  }

  function buildTimes(): TimesBody {
    const body: TimesBody = { reason: form.timesReason.trim() };
    if (form.startDate !== base.startDate || form.startTime !== base.startTime) body.arrived_at = startAt;
    if (form.endDate !== base.endDate || form.endTime !== base.endTime) body.resolved_at = endAt;
    return body;
  }

  const save = useMutation({
    mutationFn: async (plan: SavePlan) => {
      let current = server;
      let version = plan.version;
      // Cada chamada grava sozinha: a edição passa a se apoiar no que já foi gravado, e se a seguinte
      // falhar, só ela fica pendente (o próximo Salvar não repete o que já foi).
      const step = (next: TicketDetail) => {
        current = next;
        version = next.version;
        queryClient.setQueryData(["ticket", ticket.id], next);
        setSaved(next);
        setSnap({ server: next, base: initial(next) });
        setPartial(true);
      };
      if (plan.patch) {
        // Trocando o técnico junto, o conflito de agenda é conferido na troca (com o técnico novo):
        // aqui a API olharia o técnico que está saindo.
        step(
          await api.patch<TicketDetail>(`/tickets/${ticket.id}`, {
            ...plan.patch,
            expected_version: version,
            allow_conflict: plan.assign ? true : plan.confirmed,
          }),
        );
      }
      if (plan.assign) {
        step(
          await api.post<TicketDetail>(`/tickets/${ticket.id}/assign`, {
            ...plan.assign,
            expected_version: version,
            allow_conflict: plan.confirmed,
          }),
        );
      }
      if (plan.times) step(await api.put<TicketDetail>(`/tickets/${ticket.id}/times`, { ...plan.times, expected_version: version }));
      return current;
    },
    onMutate: () => setPartial(false),
    onSuccess: (updated, plan) => {
      const fresh = initial(updated);
      setSaved(updated);
      setSnap({ server: updated, base: fresh });
      setForm((f) => adopt(f, plan.sent, fresh));
      setPartial(false);
      setConflicts(null);
      setNotice(null);
      setTried(false);
      void queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id] });
      void queryClient.invalidateQueries({ queryKey: ["tickets"] });
      void queryClient.invalidateQueries({ queryKey: ["assignable"] });
      toast({ title: `${updated.code} salva`, tone: "success" });
    },
    onError: (error) => {
      const found = scheduleConflicts(error);
      if (found) {
        setConflicts(found);
        requestAnimationFrame(() => conflictRef.current?.scrollIntoView({ block: "nearest" }));
        return;
      }
      // A OS mudou enquanto se salvava: recarrega (as alterações daqui ficam no formulário).
      if (isVersionConflict(error)) void queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id] });
      toast({ title: "Não foi possível salvar a OS", description: errorMessage(error), tone: "error" });
      requestAnimationFrame(() => errorRef.current?.scrollIntoView({ block: "nearest" }));
    },
  });

  // A OS mudou por fora (tempo real, outro analista, a volta do Salvar): os grupos que ninguém mexeu
  // aqui passam a mostrar a versão nova; os mexidos ficam, e o aviso diz quais mudaram dos dois lados.
  if (!save.isPending && server !== snap.server && isNewer(server, snap.server)) {
    const fresh = initial(server);
    let next = form;
    let touched = false;
    let remote = false;
    let schedule = false;
    const overlap: string[] = [];
    for (const group of GROUPS) {
      const mine = !sameGroup(group.keys, form, base);
      touched ||= mine;
      if (sameGroup(group.keys, fresh, base)) continue;
      remote = true;
      schedule ||= Boolean(group.schedule);
      if (!mine) next = withKeys(next, fresh, group.keys);
      else if (!sameGroup(group.keys, form, fresh)) overlap.push(group.label);
    }
    setSnap({ server, base: fresh });
    if (remote) {
      setForm(next);
      if (touched) setNotice((current) => [...new Set([...(current ?? []), ...overlap])]);
      if (schedule) setConflicts(null);
    }
  }

  useEffect(() => {
    onSaveState({ dirty, pending: save.isPending, conflict: Boolean(conflicts) });
  }, [dirty, save.isPending, conflicts, onSaveState]);

  const discard = () => {
    const fresh = initial(server);
    setSnap({ server, base: fresh });
    setForm(fresh);
    setNotice(null);
    setConflicts(null);
    setTried(false);
    setChangingLocation(false);
  };

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!dirty || save.isPending) return;
    if (invalid) {
      setTried(true);
      // Leva ao primeiro campo com problema (pode estar lá embaixo, em "Situação e horários").
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      return;
    }
    if (
      notice?.length &&
      !(await confirm({
        title: "Gravar por cima?",
        description: `Também mudaram por fora: ${notice.join(", ")}. Ao salvar, fica o que está aqui.`,
        confirmLabel: "Gravar por cima",
      }))
    ) {
      return;
    }
    if (assigneeWarning && !(await confirm({ title: assigneeWarning.title, description: assigneeWarning.text, confirmLabel: "Salvar assim", tone: "danger" }))) {
      return;
    }
    const patch = buildPatch();
    save.mutate({
      version: server.version,
      patch: Object.keys(patch).length ? patch : null,
      assign: assigneeChanged ? { assignee_id: form.assigneeId || null } : null,
      times: timesChanged ? buildTimes() : null,
      confirmed: Boolean(conflicts),
      sent: form,
    });
  }

  const intakeCustomer = intake.data?.customer ?? null;
  const intakeLocation = intake.data?.location ?? null;
  // Convite pelo WhatsApp: só o básico (o técnico é parceiro), o bastante para ele topar ou não.
  const chosenType = serviceTypes.data?.find((s) => s.id === form.serviceTypeId) ?? null;
  // Valor do convite: o que o técnico já tem na OS; senão o do responsável atual (o valor não pago
  // acompanha quem assume); senão o padrão do tipo de serviço.
  const payoutOf = (id: UUID | undefined) => (id ? (server.payouts ?? []).find((p) => p.technician.id === id) : undefined);
  const feeFor = (technicianId?: UUID) => {
    const own = payoutOf(technicianId);
    if (own) return own.amount;
    const moving = payoutOf(server.assignee?.id);
    return moving && moving.status === "pending" ? moving.amount : (chosenType?.technician_fee ?? null);
  };
  const invite = (name?: string, technicianId?: UUID) => {
    const city = [intakeLocation?.city, intakeLocation?.state].filter(Boolean).join(" - ");
    const place = [intakeLocation?.district, city].filter(Boolean).join(", ");
    const fee = feeFor(technicianId);
    return [
      name ? `Olá, ${name.split(" ")[0]}! Temos um chamado da Maxx para você:` : "Pessoal, temos um chamado da Maxx:",
      `• ${chosenType?.name ?? form.title.trim()}`,
      `• ${place || "local a confirmar"}`,
      `• ${startIso ? formatDateTime(startIso) : "data a combinar"}`,
      fee != null ? `• Valor: ${formatMoney(fee)}` : null,
      name ? "Topa? Responda aqui que eu te coloco na OS." : "Quem pega? Responda aqui.",
    ]
      .filter(Boolean)
      .join("\n");
  };
  const copyInvite = async () => {
    const ok = await copyText(invite());
    toast(
      ok
        ? { title: "Convite copiado: cole no grupo de técnicos do WhatsApp", tone: "success" }
        : { title: "Não deu para copiar o convite", description: "O navegador não liberou a área de transferência. Tente de novo.", tone: "error" },
    );
  };
  const toggleHelper = (t: TechnicianSuggestion) => {
    if (form.helperIds.includes(t.id)) return set("helperIds", form.helperIds.filter((h) => h !== t.id));
    if (form.helperIds.length >= MAX_HELPERS) return toast({ title: `No máximo ${MAX_HELPERS} técnicos junto na visita`, tone: "error" });
    set("helperIds", [...form.helperIds, t.id]);
  };
  const address =
    form.serviceAddress.trim() ||
    (intakeLocation
      ? [intakeLocation.address_line, intakeLocation.district, [intakeLocation.city, intakeLocation.state].filter(Boolean).join(" - "), intakeLocation.zip_code]
          .filter(Boolean)
          .join(", ")
      : "");
  const statusOptions = [server.status, ...[...server.allowed_transitions].sort((a, b) => STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b))];
  // Tipo de serviço gravado que não está na lista (desativado, ou do catálogo de outro cliente).
  const typeListed = Boolean(serviceTypes.data?.some((t) => t.id === form.serviceTypeId));
  const typeName = form.serviceTypeId === server.service_type?.id ? server.service_type.name : null;
  const missingType = form.serviceTypeId && !typeListed ? form.serviceTypeId : null;
  const assigneeListed = people.some((p) => p.id === form.assigneeId);
  const assigneeName = form.assigneeId ? (names[form.assigneeId] ?? null) : null;
  const unscheduledWarning = schedChanged && !form.date && !form.time && (base.date || base.time) && server.status === "scheduled";
  const conflictsTitle = conflicts
    ? `${busyTitle(conflicts, assigneeName ?? "O técnico")}. Para agendar assim mesmo, use "Salvar mesmo assim".`
    : "";
  const saveError = save.error
    ? `${isVersionConflict(save.error) ? "Esta OS mudou enquanto você salvava. Atualizamos os dados e suas alterações continuam aqui: confira e salve de novo." : errorMessage(save.error)}${partial ? " O restante das alterações já foi salvo." : ""}`
    : null;

  return (
    <form ref={formRef} id={formId} onSubmit={onSubmit} noValidate className="@container flex flex-col gap-4">
      {notice && dirty ? (
        <div
          role="status"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <p className="flex items-center gap-1.5 font-semibold">
            <AlertTriangle className="size-4 shrink-0" />
            Esta OS foi atualizada enquanto você editava.
          </p>
          <p className="mt-0.5">
            Suas alterações continuam aqui; o resto já mostra a versão nova.
            {notice.length ? ` Também mudaram por fora: ${notice.join(", ")}.` : ""}
          </p>
          <button type="button" onClick={discard} className="mt-1.5 text-xs font-semibold underline underline-offset-2 hover:no-underline">
            Descartar minhas alterações
          </button>
        </div>
      ) : null}
      {saveError && !conflicts ? (
        <div ref={errorRef}>
          <ErrorBox message={saveError} />
        </div>
      ) : null}

      <Card>
        <CardHeader title="Dados da OS" />
        <div className="grid grid-cols-12 gap-4 p-5">
          <Field label="Identificador" className="col-span-12 @xl:col-span-3">
            <Input value={ticket.code} readOnly className="bg-surface-2 font-mono text-ink-muted" />
          </Field>
          <Field label="Tipo de OS" className="col-span-12 @xl:col-span-6">
            <Select
              value={form.serviceTypeId}
              onChange={(e) => {
                const st = serviceTypes.data?.find((t) => t.id === e.target.value);
                set("serviceTypeId", e.target.value);
                if (st) set("estimated", String(st.estimated_minutes));
              }}
            >
              <option value="">Sem tipo de serviço</option>
              {serviceTypes.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} · {formatMinutes(t.estimated_minutes)}
                </option>
              ))}
              {missingType ? (
                <option value={missingType}>
                  {typeName ?? "Tipo escolhido"}
                  {serviceTypes.data ? " (inativo ou de outro cliente)" : ""}
                </option>
              ) : null}
            </Select>
          </Field>
          <Field label="Categoria" className="col-span-12 @xl:col-span-3">
            <Select value={form.categoryId} onChange={(e) => set("categoryId", e.target.value)}>
              <option value="">Sem categoria</option>
              {(categories.data ?? [])
                .filter((c) => c.is_active || c.id === form.categoryId)
                .sort((a, b) => a.full_name.localeCompare(b.full_name))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.full_name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Título" required className="col-span-12 @xl:col-span-8">
            <Input
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              maxLength={200}
              aria-required="true"
              aria-invalid={errors.title ? true : undefined}
              aria-describedby={shown("title") ? errorId("title") : undefined}
            />
            <FieldError id={errorId("title")} message={shown("title")} />
          </Field>
          <Field label="Contrato de prazo (prioridade)" className="col-span-12 @xl:col-span-4">
            <Select value={form.priority} onChange={(e) => set("priority", e.target.value as TicketPriority)}>
              {PRIORITY_ORDER.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY[p].code} - {PRIORITY[p].label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="col-span-12">
            <TagsField value={form.tags} onChange={(tags) => set("tags", tags)} />
          </div>
          <div className="col-span-12 flex flex-col gap-1">
            <Field label="Descrição da ordem de serviço">
              <Textarea rows={3} value={form.description} onChange={(e) => set("description", e.target.value)} maxLength={20000} />
            </Field>
            <Counter value={form.description} max={20000} />
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Cliente e local" />
        <div className="grid grid-cols-12 gap-4 p-5">
          <div className="col-span-12 flex flex-col gap-1.5">
            <Field label="Cliente">
              <Select
                value={form.customerId}
                onChange={(e) => {
                  const id = e.target.value;
                  setForm((f) => ({ ...f, customerId: id, locationId: "", locationLabel: "" }));
                  setChangingLocation(Boolean(id));
                }}
              >
                <option value="">Sem cliente</option>
                {(customers.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            {intakeCustomer ? (
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
                <span>
                  Total de OS: <b className="text-ink">{intakeCustomer.total_tickets}</b>
                </span>
                {intakeCustomer.rating_average != null ? (
                  <span className="inline-flex items-center gap-1">
                    <Star className="size-3" /> Média de avaliação: <b className="text-ink">{intakeCustomer.rating_average}</b>
                  </span>
                ) : null}
                {intakeCustomer.rating_last != null ? (
                  <span className="inline-flex items-center gap-1">
                    <ThumbsUp className="size-3" /> Última avaliação: <b className="text-ink">{intakeCustomer.rating_last}</b>
                  </span>
                ) : null}
                {intakeLocation?.contact_phone ? (
                  <span className="inline-flex items-center gap-1">
                    <Phone className="size-3" /> {intakeLocation.contact_phone}
                    {intakeLocation.contact_name ? ` · ${intakeLocation.contact_name}` : ""}
                  </span>
                ) : null}
                <Link href={`/clientes/${intakeCustomer.id}`} className="font-medium text-brand hover:underline">
                  Ver cliente
                </Link>
              </p>
            ) : null}
          </div>

          {/* A busca de loja é um campo dentro do formulário: Enter não salva a OS e Esc fecha só os
              resultados (o painel continua aberto). */}
          <div
            className="col-span-12 flex flex-col gap-1.5"
            onKeyDown={(e) => {
              if (!(e.target instanceof HTMLInputElement)) return;
              if (e.key === "Enter") e.preventDefault();
              if (e.key === "Escape") {
                e.preventDefault();
                e.target.blur();
              }
            }}
          >
            <span className="text-xs font-semibold text-ink/80">Localização</span>
            {changingLocation || !form.locationId ? (
              <>
                <LocationPicker
                  customerId={form.customerId || null}
                  value={null}
                  onChange={(loc: Location | null) => {
                    if (!loc) return;
                    setForm((f) => ({
                      ...f,
                      locationId: loc.id,
                      locationLabel: [loc.name, loc.code].filter(Boolean).join(" - "),
                      customerId: loc.customer_id ?? f.customerId,
                    }));
                    setChangingLocation(false);
                  }}
                />
                {form.locationId ? (
                  <button type="button" onClick={() => setChangingLocation(false)} className={buttonClassName("ghost", "sm", "self-start")}>
                    Manter {form.locationLabel}
                  </button>
                ) : null}
              </>
            ) : (
              <div className="flex h-9 items-center gap-2 rounded-lg border border-line bg-surface pr-1 pl-3 text-sm shadow-elev-1">
                <MapPin className="size-4 shrink-0 text-ink-subtle" />
                <span className="min-w-0 flex-1 truncate text-ink">{form.locationLabel}</span>
                <button
                  type="button"
                  onClick={() => setChangingLocation(true)}
                  className={buttonClassName("ghost", "sm", "h-7 px-2")}
                  aria-label={`Trocar a loja (${form.locationLabel})`}
                >
                  Trocar
                </button>
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, locationId: "", locationLabel: "" }))}
                  className="inline-flex size-7 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
                  aria-label="Tirar a loja"
                >
                  <X className="size-4" />
                </button>
              </div>
            )}
          </div>

          <div className="col-span-12 rounded-lg border border-line px-3 py-2.5">
            <p className="text-xs font-semibold text-ink/80">Endereço da ordem de serviço</p>
            <p className="mt-1 flex items-start gap-1.5 text-sm text-ink">
              <MapPin className="mt-0.5 size-4 shrink-0 text-ink-subtle" />
              {address || <span className="text-ink-subtle">Sem endereço (escolha a loja)</span>}
            </p>
            <Input
              value={form.serviceAddress}
              onChange={(e) => set("serviceAddress", e.target.value)}
              placeholder="Outro endereço para este atendimento (opcional)"
              aria-label="Outro endereço para este atendimento"
              maxLength={255}
              className="mt-2"
            />
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Agenda e técnicos" />
        <div className="grid grid-cols-12 gap-4 p-5">
          <Field
            label="Duração estimada (min)"
            className="col-span-12 @xl:col-span-4"
            hint={!shown("estimated") && minutes ? formatMinutes(minutes) : undefined}
          >
            <Input
              type="number"
              inputMode="numeric"
              step="any"
              value={form.estimated}
              onChange={(e) => set("estimated", e.target.value)}
              aria-invalid={errors.estimated ? true : undefined}
              aria-describedby={shown("estimated") ? errorId("estimated") : undefined}
            />
            <FieldError id={errorId("estimated")} message={shown("estimated")} />
          </Field>
          <Field label="Data do agendamento" className="col-span-6 @xl:col-span-4">
            <Input
              type="date"
              value={form.date}
              onChange={(e) => set("date", e.target.value)}
              aria-invalid={errors.schedule && !form.date ? true : undefined}
              aria-describedby={shown("schedule") ? errorId("schedule") : undefined}
            />
          </Field>
          <Field label="Hora do agendamento" className="col-span-6 @xl:col-span-4">
            <Input
              type="time"
              value={form.time}
              onChange={(e) => set("time", e.target.value)}
              aria-invalid={errors.schedule && !form.time ? true : undefined}
              aria-describedby={shown("schedule") ? errorId("schedule") : undefined}
            />
          </Field>
          {shown("schedule") ? (
            <p id={errorId("schedule")} className="col-span-12 -mt-2 text-xs font-medium text-red-700 dark:text-red-300">
              {errors.schedule}
            </p>
          ) : null}
          {unscheduledWarning ? <Caution className="col-span-12">A OS fica Agendado sem data: mude a situação para Atribuído.</Caution> : null}

          <Field label="Colaborador" className="col-span-12 @xl:col-span-6">
            <Select value={form.assigneeId} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Sem colaborador</option>
              {technicians.length ? (
                <optgroup label="Técnicos">
                  {technicians.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.open_tickets} em aberto
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {internal.length ? (
                <optgroup label="Equipe interna">
                  {internal.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({ROLE[p.role]}) · {p.open_tickets} em aberto
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {form.assigneeId && !assigneeListed ? <option value={form.assigneeId}>{assigneeName ?? "Técnico atual"}</option> : null}
            </Select>
          </Field>
          <div className="col-span-12 flex flex-col gap-1.5 @xl:col-span-6">
            <span className="text-xs font-semibold text-ink/80">Outros colaboradores</span>
            <HelpersField
              hideLabel
              options={technicians.map((p) => ({ id: p.id, name: p.name }))}
              assigneeId={form.assigneeId as UUID | ""}
              helperIds={form.helperIds}
              names={names}
              onChange={(ids) => set("helperIds", ids)}
            />
          </div>
          {assigneeWarning ? <Caution className="col-span-12">{assigneeWarning.text}</Caution> : null}
          {server.assignee ? (
            <div className="col-span-12">
              <PayoutLine ticket={server} />
            </div>
          ) : null}

          <div className="col-span-12">
            {suggestionsShown ? (
              <div className="rounded-xl border border-line bg-surface-2/40 p-3">
                <SectionTitle
                  wrap
                  className="mb-2"
                  aside={
                    <>
                      {form.locationId ? (
                        <button type="button" onClick={() => void copyInvite()} className={buttonClassName("ghost", "sm", "h-7 px-2")}>
                          Copiar convite para o grupo
                        </button>
                      ) : null}
                      {suggestOpen ? (
                        <button type="button" onClick={() => setSuggestOpen(false)} className={buttonClassName("ghost", "sm", "h-7 px-2")}>
                          Recolher
                        </button>
                      ) : null}
                    </>
                  }
                >
                  Técnicos mais indicados para esta loja
                </SectionTitle>
                <SuggestedTechnicians
                  items={suggestions.data}
                  loading={suggestions.isLoading}
                  hasPlace={Boolean(form.locationId)}
                  scheduled={Boolean(lazyStart)}
                  assigneeId={form.assigneeId as UUID | ""}
                  helperIds={form.helperIds}
                  onAssign={(t) => setAssignee(t?.id ?? "")}
                  onToggleHelper={toggleHelper}
                  invite={(t) => invite(t.name, t.id)}
                />
                {suggestions.error ? (
                  <p className="mt-2 text-xs text-red-700 dark:text-red-300">
                    Não foi possível carregar as sugestões: {errorMessage(suggestions.error)}
                  </p>
                ) : null}
              </div>
            ) : (
              <button type="button" onClick={() => setSuggestOpen(true)} className={buttonClassName("secondary", "sm")}>
                <Users className="size-3.5" />
                Ver técnicos indicados para esta loja
              </button>
            )}
          </div>

          {conflicts ? (
            <div ref={conflictRef} className="col-span-12">
              <ConflictList tone="error" items={conflicts} title={conflictsTitle} />
            </div>
          ) : lazyStart && (form.assigneeId || form.helperIds.length) && (assigneeChanged || schedChanged || helpersChanged) ? (
            <div className="col-span-12 flex flex-col gap-2">
              {form.assigneeId ? (
                <ConflictHint
                  assigneeId={form.assigneeId}
                  assigneeName={names[form.assigneeId]}
                  start={lazyStart}
                  estimatedMinutes={lazyMinutes}
                  excludeId={ticket.id}
                />
              ) : null}
              {form.helperIds.map((id) => (
                <ConflictHint key={id} assigneeId={id} assigneeName={names[id]} start={lazyStart} estimatedMinutes={lazyMinutes} excludeId={ticket.id} />
              ))}
            </div>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHeader title="Central" description="Quem acompanha a OS na central e o recado para o técnico." />
        <div className="grid grid-cols-12 gap-4 p-5">
          <div className="col-span-12 flex flex-col gap-1.5 @xl:col-span-6">
            <span id={errorId("owner")} className="text-xs font-semibold text-ink/80">
              Analista responsável
            </span>
            <div className="flex items-center gap-2">
              <Select value={form.ownerId} onChange={(e) => set("ownerId", e.target.value)} className="flex-1" aria-labelledby={errorId("owner")}>
                <option value="">Sem analista (fila geral)</option>
                {analysts.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
              {user && form.ownerId !== user.id ? (
                <Button onClick={() => set("ownerId", user.id)}>
                  <Hand className="size-3.5" />
                  Assumir
                </Button>
              ) : null}
            </div>
          </div>
          <Field label="Projeto" className="col-span-12 @xl:col-span-6">
            <Select value={form.projectId} onChange={(e) => set("projectId", e.target.value)}>
              <option value="">Não é de projeto (OS avulsa)</option>
              {(projects.data ?? [])
                .filter((p) => p.status === "active" || p.status === "planning" || p.id === form.projectId)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} · {p.name}
                  </option>
                ))}
            </Select>
          </Field>
          <div className="col-span-12 flex flex-col gap-1">
            <Field label="Observação da visita" hint="Recado para o técnico (aparece em destaque no app)">
              <Textarea rows={2} value={form.visitNote} onChange={(e) => set("visitNote", e.target.value)} maxLength={5000} />
            </Field>
            <Counter value={form.visitNote} max={5000} />
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Situação e horários" description="Os horários reais vêm do app do técnico; aqui a central corrige, com o motivo." />
        <div className="grid grid-cols-12 gap-4 p-5">
          <Field
            label="Situação"
            className="col-span-12 @xl:col-span-4"
            hint={dirty && statusOptions.length > 1 ? "Salve as alterações para mudar a situação" : undefined}
          >
            <Select
              value={server.status}
              onChange={(e) => e.target.value !== server.status && onTransition(e.target.value as TicketStatus)}
              disabled={statusOptions.length <= 1 || dirty}
            >
              {statusOptions.map((s) => (
                <option key={s} value={s}>
                  {STATUS[s].label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Data de início" className="col-span-6 @xl:col-span-2">
            <Input
              type="date"
              value={form.startDate}
              max={today}
              disabled={!server.arrived_at}
              onChange={(e) => set("startDate", e.target.value)}
              aria-invalid={errors.start ? true : undefined}
              aria-describedby={shown("start") ? errorId("start") : undefined}
            />
          </Field>
          <Field label="Hora de início" className="col-span-6 @xl:col-span-2">
            <Input
              type="time"
              value={form.startTime}
              disabled={!server.arrived_at}
              onChange={(e) => set("startTime", e.target.value)}
              aria-invalid={errors.start ? true : undefined}
              aria-describedby={shown("start") ? errorId("start") : undefined}
            />
          </Field>
          <Field label="Data de conclusão" className="col-span-6 @xl:col-span-2">
            <Input
              type="date"
              value={form.endDate}
              max={today}
              disabled={!server.resolved_at}
              onChange={(e) => set("endDate", e.target.value)}
              aria-invalid={errors.end ? true : undefined}
              aria-describedby={shown("end") ? errorId("end") : undefined}
            />
          </Field>
          <Field label="Hora de conclusão" className="col-span-6 @xl:col-span-2">
            <Input
              type="time"
              value={form.endTime}
              disabled={!server.resolved_at}
              onChange={(e) => set("endTime", e.target.value)}
              aria-invalid={errors.end ? true : undefined}
              aria-describedby={shown("end") ? errorId("end") : undefined}
            />
          </Field>
          {shown("start") || shown("end") ? (
            <div className="col-span-12 -mt-2 flex flex-col gap-0.5">
              <FieldError id={errorId("start")} message={shown("start") ? `Início: ${errors.start}` : undefined} />
              <FieldError id={errorId("end")} message={shown("end") ? `Conclusão: ${errors.end}` : undefined} />
            </div>
          ) : null}
          {timesChanged ? (
            <Field
              label="Motivo da correção do horário"
              required
              className="col-span-12"
              hint={shown("reason") ? undefined : "Fica no histórico da OS (o técnico não vê)"}
            >
              <Input
                value={form.timesReason}
                onChange={(e) => set("timesReason", e.target.value)}
                placeholder="Ex.: técnico esqueceu de concluir no app; confirmado com a loja"
                maxLength={500}
                aria-required="true"
                aria-invalid={errors.reason ? true : undefined}
                aria-describedby={shown("reason") ? errorId("reason") : undefined}
              />
              <FieldError id={errorId("reason")} message={shown("reason")} />
            </Field>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHeader title="Conclusão" />
        <div className="flex flex-col gap-1 p-5">
          <Field label="Descrição da conclusão" hint="O que foi feito. Aparece no relatório do cliente.">
            <Textarea rows={5} value={form.resolutionNotes} onChange={(e) => set("resolutionNotes", e.target.value)} maxLength={20000} />
          </Field>
          <Counter value={form.resolutionNotes} max={20000} />
        </div>
      </Card>
    </form>
  );
}
