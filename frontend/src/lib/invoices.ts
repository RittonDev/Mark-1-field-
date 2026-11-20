"use client";

// Notas fiscais dos técnicos na central (Pagamentos › Notas fiscais). O técnico envia pelo app (aba
// Faturamento, no mês da nota); a central confere, desfaz a conferência ou recusa com motivo e nunca apaga: é
// documento fiscal (backend/app/services/invoices.py). A nota não é obrigatória e nunca trava pagamento: o
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

/**
 * As notas com os filtros do cabeçalho de Pagamentos (técnico e mês, que aqui é a competência). Sem `status`, a
 * lista geral: as 500 mais novas, de qualquer situação. Com "pending", a do "A conferir": as que aguardam, na
 * ordem da fila (as mais antigas primeiro), para a nota antiga não ficar de fora das 500 mais novas.
 */
export function invoicesQuery(month: string, technicianId: string, status?: InvoiceStatus) {
  return {
    queryKey: ["technician-invoices", month, technicianId, status ?? "all"] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api.get<TechnicianInvoiceList>(
        "/technician-invoices",
        { month: month || undefined, technician_id: technicianId || undefined, status },
        { signal },
      ),
  };
}

export function useTechnicianInvoices(month: string, technicianId: string, enabled: boolean, status?: InvoiceStatus) {
  return useQuery({ ...invoicesQuery(month, technicianId, status), placeholderData: keepPreviousData, enabled });
}

/**
 * Na exportação, cada página começa um pouco antes do fim da anterior: se uma nota sair da lista no meio (o
 * técnico apagou), a que vinha depois dela não fica de fora. As repetidas entram uma vez.
 */
const EXPORT_OVERLAP = 10;
/** Teto de páginas de uma exportação (a API manda até 500 notas por vez). */
const EXPORT_MAX_PAGES = 1000;

/**
 * Todas as notas dos filtros (técnico e competência, de qualquer situação), para o CSV: a API manda até 500 por
 * vez, as mais novas primeiro, e as páginas vêm uma depois da outra pelo `offset` até o total do filtro.
 * `onProgress`: quantas já vieram e o total.
 */
export async function fetchAllInvoices(
  month: string,
  technicianId: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<TechnicianInvoice[]> {
  const byId = new Map<UUID, TechnicianInvoice>();
  let offset = 0;
  for (let page = 0; page < EXPORT_MAX_PAGES; page += 1) {
    const chunk = await api.get<TechnicianInvoiceList>("/technician-invoices", {
      month: month || undefined,
      technician_id: technicianId || undefined,
      offset: offset || undefined,
    });
    const before = byId.size;
    for (const invoice of chunk.items) byId.set(invoice.id, invoice);
    onProgress?.(Math.min(byId.size, chunk.total_count), chunk.total_count);
    const end = offset + chunk.items.length;
    // Para no fim do filtro, numa página só com o trecho repetido ou sem nota nova (API que ignore o offset).
    if (end >= chunk.total_count || chunk.items.length <= EXPORT_OVERLAP || byId.size === before) break;
    offset = end - EXPORT_OVERLAP;
  }
  return [...byId.values()];
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
    `foi recusada${tail} Envie a nota corrigida pelo app, em Faturamento.`
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

/**
 * A nota que a API devolveu entra nas listas já carregadas (a geral e a do "A conferir", de qualquer filtro),
 * antes de elas voltarem do servidor.
 */
function patchLists(queryClient: QueryClient, invoice: TechnicianInvoice) {
  queryClient.setQueriesData<TechnicianInvoiceList>({ queryKey: ["technician-invoices"] }, (list) =>
    list ? { ...list, items: list.items.map((i) => (i.id === invoice.id ? invoice : i)) } : list,
  );
}

/**
 * Conferir, desfazer a conferência e recusar (Pagamentos: Editar). A nota que volta da API entra nas duas listas
 * e vai para `onChanged` (o diálogo aberto: a nota antiga do "A conferir", depois de recusada, não está em
 * nenhuma lista). Depois, as notas e o fechamento são buscados de novo: a recusa solta as OS da nota, e o "NF"
 * das linhas de pagamento muda junto.
 */
export function useInvoiceReview(onChanged?: (invoice: TechnicianInvoice) => void) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const settle = () => {
    void queryClient.invalidateQueries({ queryKey: ["technician-invoices"] });
    void queryClient.invalidateQueries({ queryKey: ["payouts"] });
  };
  const done = (invoice: TechnicianInvoice, title: string) => {
    patchLists(queryClient, invoice);
    onChanged?.(invoice);
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
 * O link da nota numa das listas dos filtros (buscada de novo quando tem mais de 20 min): primeiro a que já
 * mostra a nota, a de onde ela veio (a antiga do "A conferir" não está entre as 500 mais novas da geral); depois
 * a outra.
 */
async function listedDownloadUrl(queryClient: QueryClient, month: string, technicianId: string, id: UUID): Promise<string | null> {
  const queries = [invoicesQuery(month, technicianId), invoicesQuery(month, technicianId, "pending")];
  const shows = (query: (typeof queries)[number]) =>
    Boolean(queryClient.getQueryData<TechnicianInvoiceList>(query.queryKey)?.items.some((i) => i.id === id));
  queries.sort((a, b) => Number(shows(b)) - Number(shows(a)));
  for (const query of queries) {
    const list = await queryClient.fetchQuery({ ...query, staleTime: INVOICE_LINK_FRESH_MS });
    const url = absoluteApiUrl(list.items.find((i) => i.id === id)?.download_url);
    if (url) return url;
  }
  return null;
}

/**
 * Abre o arquivo da nota em outra aba (a foto aparece na tela; PDF e XML baixam). A aba abre já no clique
 * (senão o navegador bloqueia) e recebe o link assinado depois, da lista dos mesmos filtros que tem a nota.
 * `ownLinkAt`: quando a própria `invoice` veio da API (conferir, desfazer ou recusar no diálogo); o link dela vale
 * por 20 min a partir daí (a antiga do "A conferir", recusada há pouco, não está em nenhuma lista).
 */
export function useOpenInvoiceFile(month: string, technicianId: string) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return async (invoice: TechnicianInvoice, ownLinkAt?: number) => {
    const tab = window.open("", "_blank");
    if (!tab) {
      toast({ title: "O navegador bloqueou a nova aba", description: "Libere as janelas pop-up deste site para ver a nota.", tone: "error" });
      return;
    }
    tab.opener = null;
    try {
      const own = ownLinkAt !== undefined && Date.now() - ownLinkAt < INVOICE_LINK_FRESH_MS ? absoluteApiUrl(invoice.download_url) : null;
      const url = own ?? (await listedDownloadUrl(queryClient, month, technicianId, invoice.id));
      if (!url) throw new Error("A nota não está mais na lista. Atualize a tela.");
      tab.location.href = url;
    } catch (e) {
      tab.close();
      toast({ title: "Não foi possível abrir a nota", description: errorMessage(e), tone: "error" });
    }
  };
}
