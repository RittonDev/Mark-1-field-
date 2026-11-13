// O que a página pública do relatório, o PDF e a aba Anexos da OS calculam do mesmo jeito: horários
// de Brasília, a fase da foto (antes/depois), o tipo de arquivo, a âncora de cada formulário e o
// andamento da OS antes da conclusão.

import type { PublicReport, TicketStatus } from "@/lib/types";

// ------------------------------------------------------------------ horários

/**
 * Horário de Brasília, o mesmo da central e dos textos do WhatsApp: o cliente em Manaus, Cuiabá ou no
 * Acre veria horas diferentes no fuso do próprio navegador.
 */
export const REPORT_TZ = "America/Sao_Paulo";

const dateTimeFmt = new Intl.DateTimeFormat("pt-BR", {
  timeZone: REPORT_TZ,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const dateFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: REPORT_TZ, day: "2-digit", month: "2-digit", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: REPORT_TZ, hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: REPORT_TZ, weekday: "short", day: "2-digit", month: "2-digit" });
const shortFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: REPORT_TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

const valid = (value: string | null | undefined): value is string => Boolean(value) && !Number.isNaN(Date.parse(value as string));

/** "14/11/2026 10:30" (Brasília). */
export function brDateTime(value: string | null | undefined): string {
  return valid(value) ? dateTimeFmt.format(new Date(value)) : "—";
}

/** "14/11/2026" (dia em Brasília de um instante). */
export function brDate(value: string | null | undefined): string {
  return valid(value) ? dateFmt.format(new Date(value)) : "—";
}

/** "10:30" (Brasília). */
export function brTime(value: string | null | undefined): string {
  return valid(value) ? timeFmt.format(new Date(value)) : "—";
}

/** "14/11 10:30" (Brasília). */
export function brShort(value: string | null | undefined): string {
  return valid(value) ? shortFmt.format(new Date(value)) : "—";
}

/** "qui., 14/11" (Brasília). */
export function brDay(value: string | null | undefined): string {
  return valid(value) ? dayFmt.format(new Date(value)) : "—";
}

function sameDay(a: string, b: string): boolean {
  return dateFmt.format(new Date(a)) === dateFmt.format(new Date(b));
}

/** Janela da visita: "qui., 14/11 entre 10:00 e 12:00" ou "qui., 14/11 às 10:00". */
export function visitWindow(start: string, end: string | null | undefined): string {
  const day = brDay(start);
  if (valid(end) && sameDay(start, end)) return `${day} entre ${brTime(start)} e ${brTime(end)}`;
  if (valid(end)) return `${day} às ${brTime(start)} (até ${brDay(end)} às ${brTime(end)})`;
  return `${day} às ${brTime(start)}`;
}

// ------------------------------------------------------------------ situação

export const FINISHED: TicketStatus[] = ["resolved", "closed"];

/** Concluída, cancelada ou ainda em andamento (o que o cliente precisa saber primeiro). */
export function reportStage(status: TicketStatus): "done" | "cancelled" | "progress" {
  if (FINISHED.includes(status)) return "done";
  return status === "cancelled" ? "cancelled" : "progress";
}

export interface ProgressStep {
  label: string;
  state: "done" | "current" | "next";
  /** Horário do passo (só dos passos feitos e do atual). */
  at: string | null;
}

/** Saída para o local da visita atual (a de uma visita anterior, improdutiva, não conta). */
function currentEnRoute(r: PublicReport): string | null {
  if (!valid(r.en_route_at)) return null;
  if (valid(r.arrived_at) && Date.parse(r.arrived_at) >= Date.parse(r.en_route_at)) return null;
  return r.en_route_at;
}

function currentStep(r: PublicReport): number {
  switch (r.status) {
    case "resolved":
    case "closed":
      return 4;
    case "in_progress":
      return 3;
    case "en_route":
      return 2;
    case "scheduled":
      return 1;
    case "on_hold_customer":
    case "on_hold_vendor":
      return r.arrived_at ? 3 : r.scheduled_start ? 1 : 0;
    default:
      // Nova, em triagem, atribuída ou reaberta: agendada só quando já tem horário marcado.
      return r.scheduled_start ? 1 : 0;
  }
}

/**
 * O técnico já está (ou esteve) no local na visita atual: em atendimento, pausado no local ou concluída.
 * Antes disso os quadros de horário (início, fim, tempo no local) ficariam vazios, ou mostrariam a
 * visita anterior, improdutiva, de uma OS reagendada.
 */
export function arrivedOnSite(r: PublicReport): boolean {
  return currentStep(r) >= 3;
}

/** Etapas do atendimento (Aberta, Agendada, A caminho, Em atendimento, Concluída) para o cliente acompanhar. */
export function progressSteps(r: PublicReport): ProgressStep[] {
  const current = currentStep(r);
  const times = [r.opened_at, r.scheduled_start, currentEnRoute(r), r.arrived_at, r.finished_at];
  return ["Aberta", "Agendada", "Técnico a caminho", "Em atendimento", "Concluída"].map((label, i) => {
    const state = i < current ? "done" : i === current ? "current" : "next";
    return { label, state, at: state === "next" ? null : (times[i] ?? null) };
  });
}

/** A frase do momento: quando é a visita, desde quando o técnico está a caminho ou no local. */
export function progressLine(r: PublicReport): string {
  const tz = " (horário de Brasília)";
  switch (r.status) {
    case "en_route": {
      const since = currentEnRoute(r);
      return since ? `Técnico a caminho desde ${brTime(since)}${tz}` : "Técnico a caminho do local";
    }
    case "in_progress":
      return r.arrived_at ? `Em atendimento desde ${brTime(r.arrived_at)}${tz}` : "Técnico em atendimento no local";
    case "on_hold_customer":
      return "Atendimento pausado: aguardando retorno do cliente";
    case "on_hold_vendor":
      return "Atendimento pausado: aguardando peça ou fornecedor";
    default:
      if (r.scheduled_start) return `Visita agendada para ${visitWindow(r.scheduled_start, r.scheduled_end)}${tz}`;
      if (r.status === "scheduled") return "Visita agendada: o horário será confirmado";
      return r.technician
        ? "Técnico definido: o horário da visita será agendado"
        : "Solicitação recebida: o atendimento será agendado em breve";
  }
}

// ------------------------------------------------------------------ fotos e arquivos

export type PhotoPhase = "antes" | "depois";

export const PHASE_LABEL: Record<PhotoPhase, string> = { antes: "Antes", depois: "Depois" };

// "Antes", "Antes: rack" ou "Antes - rack" (marcador); "Antes da troca" é frase e fica inteira.
const MARKER = /^\s*(antes|depois)\s*(?:[:\-–—]\s*|$)/i;
const WORD = /^\s*(antes|depois)\b/i;

/** Fase da foto pela legenda ("Antes: rack", "Depois", "Depois da troca"). */
export function photoPhase(caption: string | null | undefined): PhotoPhase | null {
  const match = WORD.exec(caption ?? "");
  return match ? (match[1].toLowerCase() as PhotoPhase) : null;
}

/** Legenda sem o marcador "Antes:" / "Depois:" (vira etiqueta); a frase "Depois da troca" fica inteira. */
export function captionText(caption: string | null | undefined): string {
  return (caption ?? "").replace(MARKER, "").trim();
}

/** Legenda com a fase escolhida (troca o marcador anterior; `null` tira). */
export function withPhase(caption: string, phase: PhotoPhase | null): string {
  const rest = caption.replace(MARKER, "").trim();
  if (!phase) return rest;
  return rest ? `${PHASE_LABEL[phase]}: ${rest}` : PHASE_LABEL[phase];
}

/** Separa as fotos em Antes, Depois e as demais (só quando alguma tem fase). */
export function groupByPhase<T extends { caption?: string | null }>(photos: T[]): { phase: PhotoPhase | null; photos: T[] }[] {
  const groups: Record<PhotoPhase | "none", T[]> = { antes: [], depois: [], none: [] };
  for (const p of photos) groups[photoPhase(p.caption) ?? "none"].push(p);
  if (!groups.antes.length && !groups.depois.length) return [{ phase: null, photos }];
  return [
    { phase: "antes" as const, photos: groups.antes },
    { phase: "depois" as const, photos: groups.depois },
    { phase: null, photos: groups.none },
  ].filter((g) => g.photos.length > 0);
}

export type FileKind = "image" | "heic" | "pdf" | "video" | "other";

/** O que o arquivo é (o navegador não mostra HEIC; PDF e vídeo abrem fora da página). */
export function fileKind(filename: string, contentType?: string | null): FileKind {
  const type = (contentType ?? "").toLowerCase();
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() ?? "";
  if (/^image\/hei[cf]/.test(type) || ext === "heic" || ext === "heif") return "heic";
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  if (type.startsWith("video/") || ["mp4", "mov", "m4v", "webm", "3gp", "avi"].includes(ext)) return "video";
  if (type.startsWith("image/") || ["jpg", "jpeg", "png", "webp", "gif", "bmp"].includes(ext)) return "image";
  return "other";
}

export const FILE_KIND_LABEL: Record<Exclude<FileKind, "image">, string> = {
  heic: "Foto HEIC",
  pdf: "PDF",
  video: "Vídeo",
  other: "Arquivo",
};

// ------------------------------------------------------------------ formulários

/** Âncora do formulário no relatório ("#form-checklist-de-instalacao"): a OS abre direto nele. */
export function formAnchor(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `form-${slug || "formulario"}`;
}
