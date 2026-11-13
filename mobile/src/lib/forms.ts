// Regras dos formulários da OS (espelho de backend/app/services/forms.py), sem dependências nativas.
//
// - Campo respondido: não vazio; "confirm" só conta se for true.
// - Foto: mínimo = max(min_photos, obrigatório ? 1 : 0), contando os anexos do campo.
// - Concluir a OS exige os formulários obrigatórios concluídos e, se pedida, a assinatura.
// - Depois da assinatura (ou com a OS concluída) o técnico não altera mais os formulários.

import type { Attachment, FormAnswer, FormField, TicketDetail, TicketForm, TicketStatus } from "./types";

export const isInputField = (f: FormField) => f.type !== "section" && f.type !== "photo";

export const photoNeed = (f: FormField) => Math.max(f.min_photos ?? 0, f.required ? 1 : 0);

export function isAnswered(field: FormField, value: FormAnswer | null | undefined): boolean {
  if (field.type === "confirm") return value === true;
  if (value === null || value === undefined || value === "") return false;
  return !(Array.isArray(value) && value.length === 0);
}

/** Valor pronto para enviar (tipo certo; vazio vira null, que remove a resposta no servidor). */
export function normalizeAnswer(field: FormField, raw: FormAnswer | null | undefined): FormAnswer | null {
  if (raw === null || raw === undefined) return null;
  switch (field.type) {
    case "text":
    case "textarea": {
      const text = String(raw).trim();
      return text || null;
    }
    case "number": {
      const text = String(raw).trim().replace(",", ".");
      if (!text) return null;
      const n = Number(text);
      return Number.isFinite(n) ? n : null;
    }
    case "yes_no":
      return typeof raw === "boolean" ? raw : null;
    case "confirm":
      return raw === true ? true : null;
    case "choice":
      return typeof raw === "string" && field.options.includes(raw) ? raw : null;
    case "multi_choice": {
      const list = Array.isArray(raw) ? raw : [];
      const kept = field.options.filter((o) => list.includes(o));
      return kept.length ? kept : null;
    }
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(String(raw)) ? String(raw) : null;
    default:
      return null;
  }
}

/** Fotos por campo: anexos já no servidor (último cache) + fotos ainda na fila do aparelho. */
export function photoCounts(
  formId: string,
  attachments: Pick<Attachment, "form_id" | "field_id">[],
  pending: { form_id: string | null; field_id: string | null }[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const a of [...attachments, ...pending]) {
    if (a.form_id === formId && a.field_id) counts[a.field_id] = (counts[a.field_id] ?? 0) + 1;
  }
  return counts;
}

/** O que falta para concluir, no mesmo texto do servidor ("Foto do rack antes (2 fotos)"). */
export function missingItems(
  form: Pick<TicketForm, "fields" | "answers">,
  counts: Record<string, number>,
  answers: Record<string, FormAnswer | null> = form.answers,
): string[] {
  const missing: string[] = [];
  for (const field of form.fields) {
    if (field.type === "section") continue;
    if (field.type === "photo") {
      const need = photoNeed(field);
      if ((counts[field.id] ?? 0) < need) missing.push(`${field.label} (${need} foto${need > 1 ? "s" : ""})`);
    } else if (field.required && !isAnswered(field, answers[field.id])) {
      missing.push(field.label);
    }
  }
  return missing;
}

/** Itens obrigatórios cumpridos / total (campos obrigatórios + fotos mínimas). */
export function formProgress(form: TicketForm, counts: Record<string, number>): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const field of form.fields) {
    if (field.type === "section") continue;
    if (field.type === "photo") {
      const need = photoNeed(field);
      if (!need) continue;
      total += 1;
      if ((counts[field.id] ?? 0) >= need) done += 1;
    } else if (field.required) {
      total += 1;
      if (isAnswered(field, form.answers[field.id])) done += 1;
    }
  }
  return { done, total };
}

const CLOSED: TicketStatus[] = ["resolved", "closed", "cancelled"];

/** Formulários travados para o técnico: assinatura colhida (ou na fila) ou OS concluída. */
export const formsLocked = (ticket: Pick<TicketDetail, "signed_at" | "status">, pendingSignature: boolean) =>
  Boolean(ticket.signed_at) || pendingSignature || CLOSED.includes(ticket.status);

export const pendingRequiredForms = (ticket: Pick<TicketDetail, "forms">) =>
  (ticket.forms ?? []).filter((f) => f.required && f.status !== "completed");

/**
 * Por que a OS ainda não pode ser concluída (mesmas regras e textos do servidor), ou null.
 * `pendingSignature`: assinatura colhida no aparelho e ainda não enviada (vale para o fluxo offline).
 */
export function concludeBlock(
  ticket: Pick<TicketDetail, "forms" | "signature_required" | "signed_at">,
  pendingSignature: boolean,
): string | null {
  const pending = pendingRequiredForms(ticket);
  if (pending.length) return `Conclua o formulário obrigatório antes: ${pending.map((f) => f.name).join(", ")}`;
  if (ticket.signature_required && !ticket.signed_at && !pendingSignature) {
    return "Colete a assinatura do responsável no local antes de concluir a OS";
  }
  return null;
}

/** A assinatura só pode ser colhida com os formulários obrigatórios concluídos. */
export function signatureBlock(ticket: Pick<TicketDetail, "forms" | "status">): string | null {
  if (CLOSED.includes(ticket.status)) return "A OS já foi concluída";
  const pending = pendingRequiredForms(ticket);
  if (pending.length) return `Preencha o formulário antes de colher a assinatura: ${pending.map((f) => f.name).join(", ")}`;
  return null;
}

// ─────────────── uma pergunta por tela (como o "passo a passo" do Field Control) ───────────────

/** Cada campo que se responde (texto, escolha, foto…) vira um passo; a seção vira o título dele. */
export interface FormStep {
  field: FormField;
  section: string | null;
}

export function buildSteps(fields: FormField[]): FormStep[] {
  const steps: FormStep[] = [];
  let section: string | null = null;
  for (const field of fields) {
    if (field.type === "section") section = field.label;
    else steps.push({ field, section });
  }
  return steps;
}

/** O campo conta para concluir: obrigatório, ou foto com mínimo. */
export const isRequiredItem = (f: FormField) => f.type !== "section" && (f.required || (f.type === "photo" && photoNeed(f) > 0));

/** Número digitado que não é número (ex.: "12a"): seria descartado ao salvar. */
export function invalidNumber(field: FormField, raw: FormAnswer | null | undefined): boolean {
  if (field.type !== "number" || raw === null || raw === undefined) return false;
  return String(raw).trim() !== "" && normalizeAnswer(field, raw) === null;
}

/** O que falta neste passo para o formulário poder ser concluído, ou null. `value` já normalizado. */
export function stepProblem(field: FormField, value: FormAnswer | null | undefined, photos: number): string | null {
  if (field.type === "section") return null;
  if (field.type === "photo") {
    const left = photoNeed(field) - photos;
    if (left <= 0) return null;
    return left === 1 ? "Falta 1 foto" : `Faltam ${left} fotos`;
  }
  return field.required && !isAnswered(field, value) ? "Pergunta obrigatória" : null;
}

/** Passo com resposta (ou com ao menos uma foto). */
export function stepAnswered(field: FormField, value: FormAnswer | null | undefined, photos: number): boolean {
  return field.type === "photo" ? photos > 0 : isAnswered(field, value);
}

/**
 * Onde retomar o preenchimento: logo depois da última pergunta respondida; se a última já foi
 * respondida, a primeira obrigatória pendente; com tudo em ordem, a revisão (= steps.length).
 */
export function resumeStep(count: number, answered: (index: number) => boolean, pending: (index: number) => boolean): number {
  let last = -1;
  for (let i = 0; i < count; i++) if (answered(i)) last = i;
  if (last < count - 1) return last + 1;
  for (let i = 0; i < count; i++) if (pending(i)) return i;
  return count;
}

/** Resposta em texto curto para a revisão ("Sim", "12,5", "19/11/2026", "3 fotos"). `value` já normalizado. */
export function answerText(field: FormField, value: FormAnswer | null | undefined, photos: number): string | null {
  if (field.type === "photo") return photos ? `${photos} foto${photos > 1 ? "s" : ""}` : null;
  if (!isAnswered(field, value)) return null;
  switch (field.type) {
    case "yes_no":
      return value ? "Sim" : "Não";
    case "confirm":
      return "Confirmado";
    case "multi_choice":
      return Array.isArray(value) ? value.join(", ") : String(value);
    case "number":
      return String(value).replace(".", ",");
    case "date": {
      const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
      return day ? `${day[3]}/${day[2]}/${day[1]}` : String(value);
    }
    default:
      return String(value);
  }
}
