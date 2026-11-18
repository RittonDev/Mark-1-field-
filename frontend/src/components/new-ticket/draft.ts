// Estado da Nova OS e as regras que valem em qualquer mudança (trocar cliente, localização ou tipo de OS).
// Fica num módulo próprio porque também vira o rascunho guardado na aba (sessionStorage).

import type { Category, FormTemplate, Location, Project, ServiceType, Tag, TicketPriority, TicketType, UUID } from "@/lib/types";

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
  /** A categoria veio do tipo de OS (não foi escolhida à mão): troca junto com o tipo. */
  categoryFromType: boolean;
  /** Formulários da OS, na ordem em que entram. */
  formIds: UUID[];
  /** Entraram pelo tipo de OS ou pela categoria e o analista não mexeu: saem se deixarem de casar. */
  autoFormIds: UUID[];
  /** Obrigatório ou opcional que o analista escolheu; sem escolha, vale o padrão do modelo. */
  formRequired: Record<UUID, boolean>;
}

// Versão 3: formulários pelo tipo e pela categoria, cada um obrigatório ou opcional (rascunhos da 2 não voltam).
export const DRAFT_VERSION = 3;
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
    categoryFromType: false,
    formIds: [],
    autoFormIds: [],
    formRequired: {},
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

/** "0123 · LOJA CENTRO": o código (quando há) e o nome da localização. */
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

/**
 * Tira o tipo de OS e, junto, a duração que veio dele. A categoria fica (os formulários que deixam de
 * casar saem em syncForms).
 */
function withoutServiceType(d: NewTicketDraft): NewTicketDraft {
  return {
    ...d,
    serviceType: null,
    minutesFromType: false,
    form: { ...d.form, estimated_minutes: d.minutesFromType ? "" : d.form.estimated_minutes },
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

/**
 * Tipo de OS escolhido: a duração e a categoria dele. A categoria acompanha o tipo quando estava vazia ou
 * tinha vindo do tipo anterior; a escolhida à mão fica (a mesma regra da API ao trocar o tipo). Os
 * formulários seguem em syncForms.
 */
export function withServiceType(d: NewTicketDraft, st: ServiceType | null): NewTicketDraft {
  const base = withoutServiceType(d);
  if (!st) return base;
  const follow = d.categoryFromType || !d.form.category_id;
  return {
    ...base,
    serviceType: st,
    minutesFromType: true,
    categoryFromType: follow && Boolean(st.category_id),
    form: {
      ...base.form,
      estimated_minutes: String(st.estimated_minutes),
      category_id: follow ? (st.category_id ?? "") : base.form.category_id,
      // Tipo do catálogo de um cliente: a OS é desse cliente.
      customer_id: base.form.customer_id || st.customer_id || "",
    },
  };
}

/** Categoria escolhida à mão: passa a ficar mesmo trocando o tipo de OS. */
export function withCategory(d: NewTicketDraft, categoryId: string): NewTicketDraft {
  return { ...d, categoryFromType: false, form: { ...d.form, category_id: categoryId } };
}

/**
 * A categoria com que a OS nasce: a escolhida ou, sem ela, a do tipo de OS (a API completa assim). É a que
 * decide os formulários que entram pela categoria.
 */
export function effectiveCategory(d: NewTicketDraft): string {
  return d.form.category_id || d.serviceType?.category_id || "";
}

/** As de cima valem até este nível (o mesmo limite da API e da tela de Categorias). */
const CATEGORY_LEVELS = 10;

/** A categoria e as de cima (pai, avô...), da mais próxima para a mais distante. */
export function categoryLine(categories: Category[] | undefined, id: string | null | undefined): Category[] {
  if (!id) return [];
  const byId = new Map((categories ?? []).map((c) => [c.id, c]));
  const line: Category[] = [];
  for (let node = byId.get(id); node && line.length <= CATEGORY_LEVELS; node = node.parent_id ? byId.get(node.parent_id) : undefined) {
    if (line.includes(node)) break;
    line.push(node);
  }
  return line;
}

/** Formulário que entra sozinho na OS: pelo tipo de OS (`label`: o nome do tipo) ou pela categoria (`label`: o nome completo dela). */
export interface MatchedForm {
  id: UUID;
  via: "type" | "category";
  label: string;
}

/**
 * Modelos ativos que entram sozinhos numa OS com este tipo e esta categoria, em ordem de nome (a regra da
 * API): o tipo está nos tipos do modelo, ou a categoria (ou uma acima dela) está nas categorias do modelo.
 * Quando os dois casam, vale o tipo; pela categoria, a ligada mais próxima.
 */
export function matchedForms(
  templates: FormTemplate[] | undefined,
  serviceType: Pick<ServiceType, "id" | "name"> | null,
  categoryId: string | null | undefined,
  categories: Category[] | undefined,
): MatchedForm[] {
  // Sem a lista de categorias, só a própria categoria conta (as de cima ficam para a API).
  const line = categoryLine(categories, categoryId);
  const ids = line.length ? line.map((c) => c.id) : categoryId ? [categoryId] : [];
  const out: (MatchedForm & { name: string })[] = [];
  for (const t of templates ?? []) {
    if (!t.is_active) continue;
    if (serviceType && t.service_type_ids.includes(serviceType.id)) {
      out.push({ id: t.id, via: "type", label: serviceType.name, name: t.name });
      continue;
    }
    const linked = new Set(t.category_ids ?? []);
    const at = ids.findIndex((id) => linked.has(id));
    if (at >= 0) out.push({ id: t.id, via: "category", label: line[at]?.full_name ?? "", name: t.name });
  }
  return out
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
    .map(({ id, via, label }) => ({ id, via, label }));
}

/**
 * Os formulários acompanham o tipo de OS e a categoria (`prev` -> `next`): saem os que tinham entrado
 * sozinhos e deixaram de casar; entram, marcados, os que passaram a casar. O que o analista marcou ou
 * desmarcou e continua casando fica como ele deixou. Sem os modelos carregados, nada muda.
 */
export function syncForms(
  prev: NewTicketDraft,
  next: NewTicketDraft,
  templates: FormTemplate[] | undefined,
  categories: Category[] | undefined,
): NewTicketDraft {
  if (!templates) return next;
  const before = { type: prev.serviceType?.id ?? "", category: effectiveCategory(prev) };
  const after = { type: next.serviceType?.id ?? "", category: effectiveCategory(next) };
  if (before.type === after.type && before.category === after.category) return next;
  const was = new Set(matchedForms(templates, prev.serviceType, before.category, categories).map((m) => m.id));
  const now = matchedForms(templates, next.serviceType, after.category, categories).map((m) => m.id);
  const leaving = next.autoFormIds.filter((id) => !now.includes(id));
  const entering = now.filter((id) => !was.has(id) && !next.formIds.includes(id));
  if (!leaving.length && !entering.length) return next;
  const formRequired = { ...next.formRequired };
  for (const id of leaving) delete formRequired[id];
  return {
    ...next,
    formIds: [...next.formIds.filter((id) => !leaving.includes(id)), ...entering],
    autoFormIds: [...next.autoFormIds.filter((id) => !leaving.includes(id)), ...entering],
    formRequired,
  };
}
