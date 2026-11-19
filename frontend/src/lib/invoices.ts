"use client";

// Notas fiscais dos técnicos na central (Pagamentos › Notas fiscais). O técnico envia pelo app (aba
// Ganhos); a central confere, desfaz a conferência ou recusa com motivo e nunca apaga: é documento
// fiscal (backend/app/services/invoices.py). A nota não é obrigatória e nunca trava pagamento: o
// "Pagar" e o extrato do WhatsApp só informam se há nota.

import { keepPreviousData, type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/Toaster";
import { absoluteApiUrl, api, errorMessage } from "./api";
import { competenceLabel, INVOICE_STATUS } from "./constants";
import { formatDate, formatMoney } from "./format";
import type { InvoiceStatus, TechnicianInvoice, TechnicianInvoiceList, UUID } from "./types";

/**
 * O link do arquivo vale 30 min (LINK_MINUTES na API): com a lista mais velha que isso, ela é buscada de
 * novo antes de abrir o arquivo.
 */
export const INVOICE_LINK_FRESH_MS = 20 * 60_000;

/** As notas com os filtros do cabeçalho de Pagamentos (técnico e mês, que aqui é a competência), sem o da situação. */
export function invoicesQuery(month: string, technicianId: string) {
  return {
    queryKey: ["technician-invoices", month, technicianId] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api.get<TechnicianInvoiceList>(
        "/technician-invoices",
        { month: month || undefined, technician_id: technicianId || undefined },
        { signal },
      ),
  };
}

export function useTechnicianInvoices(month: string, technicianId: string, enabled: boolean) {
  return useQuery({ ...invoicesQuery(month, technicianId), placeholderData: keepPreviousData, enabled });
}

/** "nº 1234". */
export const invoiceNo = (invoice: { number: string }) => `nº ${invoice.number}`;

/** A situação no meio da frase: "aguardando conferência", "conferida", "recusada". */
export const invoiceStatusText = (status: InvoiceStatus) => INVOICE_STATUS[status].label.toLowerCase();

/** A competência como título: "Novembro de 2026". */
export function competenceTitle(month: string): string {
  const label = competenceLabel(month);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Quanto o valor da nota difere da soma das OS dela (sempre positivo); null quando bate ou quando a nota
 * não tem OS ligada (a ligação é opcional).
 */
export function invoiceDifference(invoice: Pick<TechnicianInvoice, "amount" | "payouts" | "payouts_total">): number | null {
  if (!invoice.payouts.length) return null;
  const cents = Math.abs(Math.round(invoice.amount * 100) - Math.round(invoice.payouts_total * 100));
  return cents > 0 ? cents / 100 : null;
}

/** "3 OS (R$ 850,00)" ou "sem OS". */
export function invoicePayoutsText(invoice: Pick<TechnicianInvoice, "payouts" | "payouts_total">): string {
  const count = invoice.payouts.length;
  return count ? `${count.toLocaleString("pt-BR")} OS (${formatMoney(invoice.payouts_total)})` : "sem OS";
}

const sentAt = (invoice: TechnicianInvoice) => Date.parse(invoice.created_at) || 0;

/**
 * Ordem da conferência: as que aguardam, da mais antiga para a mais nova (quem enviou primeiro é
 * conferido primeiro); depois as outras, da mais nova para a mais antiga.
 */
export function reviewOrder(items: TechnicianInvoice[]): TechnicianInvoice[] {
  const waiting = items.filter((i) => i.status === "pending").sort((a, b) => sentAt(a) - sentAt(b));
  const others = items.filter((i) => i.status !== "pending").sort((a, b) => sentAt(b) - sentAt(a));
  return [...waiting, ...others];
}

/** As notas de cada técnico, na ordem em que vieram. */
export function invoicesByTechnician(items: TechnicianInvoice[]): Map<UUID, TechnicianInvoice[]> {
  const map = new Map<UUID, TechnicianInvoice[]>();
  for (const invoice of items) {
    const list = map.get(invoice.technician.id);
    if (list) list.push(invoice);
    else map.set(invoice.technician.id, [invoice]);
  }
  return map;
}

/** As notas que valem (a recusada não conta: o técnico envia outra), pela emissão. */
function validInvoices(invoices: TechnicianInvoice[]): TechnicianInvoice[] {
  return invoices
    .filter((i) => i.status !== "rejected")
    .sort((a, b) => a.issue_date.localeCompare(b.issue_date) || a.number.localeCompare(b.number, "pt-BR", { numeric: true }));
}

/**
 * Aviso no "Pagar" (só informa, nunca trava): as notas do técnico no período ou, com um mês escolhido e
 * nenhuma nota que valha, "Sem nota fiscal de novembro de 2026.". `complete`: a lista de notas veio
 * inteira; sem isso, a falta de nota não é afirmada.
 */
export function payInvoiceNote(invoices: TechnicianInvoice[], month: string, complete: boolean): string | null {
  const valid = validInvoices(invoices);
  if (!valid.length) return month && complete ? `Sem nota fiscal de ${competenceLabel(month)}.` : null;
  const list = valid.map((i) => `${invoiceNo(i)} (${invoiceStatusText(i.status)})`).join(", ");
  return `${valid.length === 1 ? "Nota fiscal" : "Notas fiscais"}: ${list}.`;
}

/** No extrato do WhatsApp, logo depois do período: uma linha por nota que vale. */
export function statementInvoiceLines(invoices: TechnicianInvoice[]): string[] {
  return validInvoices(invoices).map((i) => `Nota fiscal: ${invoiceNo(i)} · ${formatMoney(i.amount)} (${invoiceStatusText(i.status)})`);
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** Mensagem do "Avisar no WhatsApp" da nota recusada: a conversa com o técnico é pelo WhatsApp, nunca pelo app. */
export function rejectedInvoiceText(invoice: TechnicianInvoice): string {
  const reason = (invoice.reject_reason ?? "").trim().replace(/[\s,;:]+$/, "");
  const tail = !reason ? "." : /[.!?…]$/.test(reason) ? `: ${reason}` : `: ${reason}.`;
  return (
    `Olá, ${firstName(invoice.technician.name)}. A nota fiscal ${invoiceNo(invoice)} (${formatMoney(invoice.amount)}) ` +
    `foi recusada${tail} Envie a nota corrigida pelo app, em Ganhos.`
  );
}

const csvMoney = (value: number) => value.toFixed(2).replace(".", ",");

/** "2026-11" → "11/2026", como a competência aparece na contabilidade. */
function csvCompetence(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  return match ? `${match[2]}/${match[1]}` : month;
}

/** O CSV da aba Notas fiscais, com o cabeçalho. */
export function invoiceCsvRows(items: TechnicianInvoice[]): string[][] {
  return [
    ["tecnico", "numero", "emissao", "competencia", "valor", "os", "soma_os", "situacao", "revisada_em", "motivo_recusa", "arquivo"],
    ...items.map((i) => [
      i.technician.name,
      i.number,
      formatDate(i.issue_date),
      csvCompetence(i.competence),
      csvMoney(i.amount),
      i.payouts.map((p) => p.code).join(", "),
      csvMoney(i.payouts_total),
      INVOICE_STATUS[i.status].label,
      i.reviewed_at ? formatDate(i.reviewed_at) : "",
      i.reject_reason ?? "",
      i.filename,
    ]),
  ];
}

/** A nota que a API devolveu entra nas listas já carregadas, antes de a lista voltar do servidor. */
function patchLists(queryClient: QueryClient, invoice: TechnicianInvoice) {
  queryClient.setQueriesData<TechnicianInvoiceList>({ queryKey: ["technician-invoices"] }, (list) =>
    list ? { ...list, items: list.items.map((i) => (i.id === invoice.id ? invoice : i)) } : list,
  );
}

/**
 * Conferir, desfazer a conferência e recusar (Pagamentos: Editar). Depois, as notas e o fechamento são
 * buscados de novo: a recusa solta as OS da nota, e o "NF" das linhas de pagamento muda junto.
 */
export function useInvoiceReview() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const settle = () => {
    void queryClient.invalidateQueries({ queryKey: ["technician-invoices"] });
    void queryClient.invalidateQueries({ queryKey: ["payouts"] });
  };
  const done = (invoice: TechnicianInvoice, title: string) => {
    patchLists(queryClient, invoice);
    toast({ title, tone: "success" });
  };
  const check = useMutation({
    mutationFn: (invoice: TechnicianInvoice) => api.post<TechnicianInvoice>(`/technician-invoices/${invoice.id}/check`),
    onSuccess: (invoice) => done(invoice, `Nota ${invoiceNo(invoice)} conferida`),
    onError: (error) => toast({ title: "Não foi possível conferir a nota", description: errorMessage(error), tone: "error" }),
    onSettled: settle,
  });
  const uncheck = useMutation({
    mutationFn: (invoice: TechnicianInvoice) => api.post<TechnicianInvoice>(`/technician-invoices/${invoice.id}/uncheck`),
    onSuccess: (invoice) => done(invoice, `Conferência da nota ${invoiceNo(invoice)} desfeita`),
    onError: (error) => toast({ title: "Não foi possível desfazer a conferência", description: errorMessage(error), tone: "error" }),
    onSettled: settle,
  });
  // O erro da recusa aparece no campo do motivo, no diálogo (que continua aberto).
  const reject = useMutation({
    mutationFn: ({ invoice, reason }: { invoice: TechnicianInvoice; reason: string }) =>
      api.post<TechnicianInvoice>(`/technician-invoices/${invoice.id}/reject`, { reason }),
    onSuccess: (invoice) => done(invoice, `Nota ${invoiceNo(invoice)} recusada`),
    onSettled: settle,
  });
  return { check, uncheck, reject };
}

export type InvoiceReview = ReturnType<typeof useInvoiceReview>;

/**
 * Abre o arquivo da nota em outra aba (a foto aparece na tela; PDF e XML baixam). A aba abre já no clique
 * (senão o navegador bloqueia) e recebe o link assinado depois, da lista dos mesmos filtros: buscada de
 * novo quando tem mais de 20 min.
 */
export function useOpenInvoiceFile(month: string, technicianId: string) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return async (invoice: TechnicianInvoice) => {
    const tab = window.open("", "_blank");
    if (!tab) {
      toast({ title: "O navegador bloqueou a nova aba", description: "Libere as janelas pop-up deste site para ver a nota.", tone: "error" });
      return;
    }
    tab.opener = null;
    try {
      const list = await queryClient.fetchQuery({ ...invoicesQuery(month, technicianId), staleTime: INVOICE_LINK_FRESH_MS });
      const url = absoluteApiUrl(list.items.find((i) => i.id === invoice.id)?.download_url);
      if (!url) throw new Error("A nota não está mais na lista. Atualize a tela.");
      tab.location.href = url;
    } catch (e) {
      tab.close();
      toast({ title: "Não foi possível abrir a nota", description: errorMessage(e), tone: "error" });
    }
  };
}
