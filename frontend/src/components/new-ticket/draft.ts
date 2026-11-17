// Estado da Nova OS e as regras que valem em qualquer mudança (trocar cliente, localização ou tipo de OS).
// Fica num módulo próprio porque também vira o rascunho guardado na aba (sessionStorage).

import type { FormTemplate, Location, Project, ServiceType, Tag, TicketPriority, TicketType, UUID } from "@/lib/types";

export type OwnerMode = "me" | "none" | "other";
/** Por onde o chamado chegou ("web" = outro canal). */
export type Origin = "whatsapp" | "email" | "phone" | "web";
/** Padrão de etiquetas da OS: o da abertura ou o de OS de projeto. */
export type TagMode = "create" | "project";

export interface NewTicketForm {
  /** Opcional: em branco, a OS sai com o título automático (autoTitle). */
  title: string;
  /** O escopo: o que deve ser feito no atendimento. */
  description: string;
  type: TicketType;
  category_id: string;
  priority: "" | TicketPriority;
  customer_id: string;
  location_id: string;
  service_address: string;
  estimated_minutes: string;
  project_id: string;
  assignee_id: string;
  date: string;
  time: string;
  source: Origin;
  client_reference: string;
  requester_name: string;
  requester_contact: string;
  visit_note: string;
}

export interface NewTicketDraft {
  form: NewTicketForm;
  location: Location | null;
  serviceType: ServiceType | null;
  /** Atender em outro endereço (ou ponto de referência) que não o da localização. */
  otherAddress: boolean;
  helperIds: UUID[];
  ownerMode: OwnerMode;
  ownerId: string;
  /** A duração veio do tipo de OS (não foi digitada): sai junto com ele. */
  minutesFromType: boolean;
  /** As etiquetas seguem o padrão (abertura ou projeto) até o analista mexer nelas. */
  tagsAuto: boolean;
  /** Etiquetas escolhidas pelo analista (valem com tagsAuto false). */
  tags: Tag[];
  /** O padrão que valia quando o analista mexeu nas etiquetas: avisa se a OS entrar ou sair de projeto. */
  tagsMode: TagMode;
  formIds: UUID[];
  /** Formulários marcados sozinhos por serem do tipo de OS escolhido. */
  autoFormIds: UUID[];
  formsRequired: boolean;
}

// Versão 2: título opcional, localização obrigatória e etiquetas pelo padrão (rascunhos da 1 não voltam).
export const DRAFT_VERSION = 2;
export const draftKey = (userId: string) => `maxx.novaOs.rascunho.${userId}`;
export const ORIGIN_KEY = "maxx.novaOs.origem";

export interface StoredDraft {
  v: number;
  savedAt: number;
  draft: NewTicketDraft;
}

export function blankDraft(source: Origin, keep?: { location: Location | null; customerId: string }): NewTicketDraft {
  return {
    form: {
      title: "",
      description: "",
      type: "incident",
      category_id: "",
      priority: "",
      customer_id: keep?.customerId ?? "",
      location_id: keep?.location?.id ?? "",
      service_address: "",
      estimated_minutes: "",
      project_id: "",
      assignee_id: "",
      date: "",
      time: "",
      source,
      client_reference: "",
      requester_name: "",
      requester_contact: "",
      visit_note: "",
    },
    location: keep?.location ?? null,
    serviceType: null,
    otherAddress: false,
    helperIds: [],
    ownerMode: "me",
    ownerId: "",
    minutesFromType: false,
    tagsAuto: true,
    tags: [],
    tagsMode: "create",
    formIds: [],
    autoFormIds: [],
    formsRequired: true,
  };
}

/** Algo foi preenchido (vale guardar o rascunho e avisar antes de sair da tela). */
export function isFilled(d: NewTicketDraft): boolean {
  const f = d.form;
  return Boolean(
    f.location_id ||
      f.customer_id ||
      f.title.trim() ||
      f.description.trim() ||
      f.client_reference.trim() ||
      f.requester_name.trim() ||
      f.requester_contact.trim() ||
      f.visit_note.trim() ||
      f.service_address.trim() ||
      f.date ||
      f.assignee_id ||
      d.serviceType ||
      !d.tagsAuto ||
      d.formIds.length ||
      d.helperIds.length,
  );
}

/** "21795 · BOT - SH. PIEDADE": o código (quando há) e o nome da localização. */
export function locationLabel(location: Pick<Location, "code" | "name">): string {
  return [location.code, location.name].filter(Boolean).join(" · ");
}

/**
 * Título da OS quando o analista deixa o campo em branco: "<Tipo de OS> · <Localização>", como as OS
 * aparecem no Field Control; sem os dois, a primeira linha do escopo.
 */
export function autoTitle(d: NewTicketDraft): string {
  const joined = [d.serviceType?.name.trim(), d.location?.name.trim()].filter(Boolean).join(" · ");
  if (joined.length >= 3) return joined.slice(0, 200);
  const firstLine = d.form.description.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  return firstLine.slice(0, 200);
}

/** Tira o tipo de OS e, junto, a duração e os formulários que vieram dele. */
function withoutServiceType(d: NewTicketDraft): NewTicketDraft {
  return {
    ...d,
    serviceType: null,
    minutesFromType: false,
    form: { ...d.form, estimated_minutes: d.minutesFromType ? "" : d.form.estimated_minutes },
    formIds: d.formIds.filter((id) => !d.autoFormIds.includes(id)),
    autoFormIds: [],
  };
}

/** Projeto de outro cliente não vale para a OS. */
function projectFits(projectId: string, customerId: string, projects: Project[] | undefined): boolean {
  if (!projectId || !projects) return true;
  const project = projects.find((p) => p.id === projectId);
  return !project || !project.customer || !customerId || project.customer.id === customerId;
}

/** Troca de cliente: limpa o que é do cliente anterior (localização, tipo de OS do catálogo dele, projeto). */
export function withCustomer(d: NewTicketDraft, customerId: string, projects: Project[] | undefined): NewTicketDraft {
  let next: NewTicketDraft = { ...d, form: { ...d.form, customer_id: customerId } };
  if (next.location && next.location.customer_id !== customerId) {
    next = { ...next, location: null, otherAddress: false, form: { ...next.form, location_id: "", service_address: "" } };
  }
  const st = next.serviceType;
  if (st?.customer_id && st.customer_id !== customerId) next = withoutServiceType(next);
  if (!projectFits(next.form.project_id, customerId, projects)) next = { ...next, form: { ...next.form, project_id: "" } };
  return next;
}

/** Localização escolhida (ou tirada): ela define o cliente; o "outro endereço" era da anterior. */
export function withLocation(d: NewTicketDraft, location: Location | null, projects: Project[] | undefined): NewTicketDraft {
  const base: NewTicketDraft = {
    ...d,
    location,
    otherAddress: false,
    form: { ...d.form, location_id: location?.id ?? "", service_address: "" },
  };
  return location ? withCustomer(base, location.customer_id, projects) : base;
}

/** Tipo de OS escolhido: a duração, a categoria e os formulários dele. */
export function withServiceType(d: NewTicketDraft, st: ServiceType | null, templates: FormTemplate[] | undefined): NewTicketDraft {
  const base = withoutServiceType(d);
  if (!st) return base;
  const suggested = (templates ?? []).filter((t) => t.service_type_ids.includes(st.id)).map((t) => t.id);
  const added = suggested.filter((id) => !base.formIds.includes(id));
  return {
    ...base,
    serviceType: st,
    minutesFromType: true,
    form: {
      ...base.form,
      estimated_minutes: String(st.estimated_minutes),
      category_id: base.form.category_id || st.category_id || "",
      // Tipo do catálogo de um cliente: a OS é desse cliente.
      customer_id: base.form.customer_id || st.customer_id || "",
    },
    formIds: [...base.formIds, ...added],
    autoFormIds: added,
  };
}
