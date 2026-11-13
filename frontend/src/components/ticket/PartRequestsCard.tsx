"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, FileText, ImageOff, Link2, PackageOpen, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { QuoteViewer } from "@/components/quotes/QuoteViewer";
import { useToast } from "@/components/Toaster";
import { Button, Card, CardHeader, Dialog, ErrorBox, Field, isTopLayer, lockScroll, Pill, restoreFocus, Select, Textarea, trapTab } from "@/components/ui";
import { absoluteApiUrl, api, errorMessage } from "@/lib/api";
import { formatMoney, formatShort } from "@/lib/format";
import { QUOTE_STATUS } from "@/lib/quotes";
import type { PartRequest, PartRequestStatus, Quote, TicketDetail } from "@/lib/types";
import { QuoteEditor, type QuotePrefill, ShareDialog } from "./QuotesCard";

// Âmbar só no que espera a central (montar o orçamento); o resto segue a decisão do cliente.
const STATUS: Record<PartRequestStatus, { label: string; color: string }> = {
  open: { label: "Aguardando orçamento", color: "#d97706" },
  quoted: { label: "Orçamento criado", color: "#2447ff" },
  approved: { label: "Aprovada: pode instalar", color: "#10b981" },
  rejected: { label: "Recusada", color: "#dc2626" },
  cancelled: { label: "Cancelada", color: "#64748b" },
};

const amount = (r: PartRequest) => `${r.quantity.toLocaleString("pt-BR", { maximumFractionDigits: 3 })} ${r.unit} · ${r.description}`;

/** Foto do pedido (link assinado da API): link vencido pede a OS de novo uma vez; se ainda falhar, avisa. */
function PartPhoto({ url, alt, ticketId, className }: { url: string; alt: string; ticketId: string; className?: string }) {
  const queryClient = useQueryClient();
  const src = absoluteApiUrl(url) ?? url;
  const [failed, setFailed] = useState<string | null>(null);
  const retried = useRef(false);
  if (failed === src) {
    return (
      <span role="img" aria-label={`${alt}: foto indisponível`} className={`flex items-center justify-center bg-surface-2 text-ink-muted ${className ?? ""}`}>
        <ImageOff className="size-4" />
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- link assinado da API
    <img
      src={src}
      alt={alt}
      className={className}
      onError={() => {
        if (!retried.current) {
          retried.current = true;
          void queryClient.invalidateQueries({ queryKey: ["ticket", ticketId], exact: true });
          return;
        }
        setFailed(src);
      }}
    />
  );
}

/** Recusar o pedido com o motivo (o técnico vê no app). */
function RejectDialog({ request, onClose, onDone }: { request: PartRequest; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const reject = useMutation({
    mutationFn: () => api.patch(`/part-requests/${request.id}`, { status: "rejected", response_note: reason.trim() }),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  const short = reason.trim().length < 3;
  return (
    <Dialog
      open
      onClose={onClose}
      title="Recusar pedido de peça"
      description={amount(request)}
      footer={
        <>
          <Button onClick={onClose}>Voltar</Button>
          <Button variant="danger" loading={reject.isPending} disabled={short} onClick={() => reject.mutate()}>
            Recusar pedido
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Motivo (o técnico vê no app)" required hint={`${reason.length}/2000 · pelo menos 3 letras`}>
          <Textarea
            rows={4}
            maxLength={2000}
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ex.: a loja já tem a peça em estoque; use a de lá."
          />
        </Field>
        {reject.error ? <ErrorBox message={errorMessage(reject.error)} /> : null}
      </div>
    </Dialog>
  );
}

/** Ligar o pedido a um orçamento que já existe na OS (o pedido passa a seguir a decisão dele). */
function LinkDialog({
  request,
  quotes,
  onClose,
  onLink,
  pending,
}: {
  request: PartRequest;
  quotes: Quote[];
  onClose: () => void;
  onLink: (quote: Quote) => void;
  pending: boolean;
}) {
  const [quoteId, setQuoteId] = useState(quotes[0]?.id ?? "");
  const chosen = quotes.find((q) => q.id === quoteId) ?? null;
  return (
    <Dialog
      open
      onClose={onClose}
      title="Ligar a um orçamento existente"
      description={amount(request)}
      footer={
        <>
          <Button onClick={onClose}>Voltar</Button>
          <Button variant="primary" disabled={!chosen} loading={pending} onClick={() => chosen && onLink(chosen)}>
            <Link2 className="size-4" />
            Ligar
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Orçamento da OS">
          <Select value={quoteId} onChange={(e) => setQuoteId(e.target.value)}>
            {quotes.map((q) => (
              <option key={q.id} value={q.id}>
                {q.code} · {q.title} · {formatMoney(q.total)} · {QUOTE_STATUS[q.status].label}
              </option>
            ))}
          </Select>
        </Field>
        <p className="text-xs text-ink-muted">
          {chosen?.status === "approved"
            ? "Este orçamento já foi aprovado: o pedido fica liberado e o técnico é avisado de que pode instalar."
            : "Quando o cliente responder o orçamento, o pedido segue a decisão e o técnico é avisado."}
        </p>
      </div>
    </Dialog>
  );
}

/** Peças pedidas pelo técnico em campo: viram orçamento, que o cliente aprova pelo link antes da instalação. */
export function PartRequestsCard({ ticket }: { ticket: TicketDetail }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const requests = ticket.part_requests ?? [];
  const openRequests = requests.filter((r) => r.status === "open");
  const canAct = ticket.can_assign;
  const [editor, setEditor] = useState<{ quote: Quote | null; prefill?: QuotePrefill; requests: PartRequest[] } | null>(null);
  const [rejecting, setRejecting] = useState<PartRequest | null>(null);
  const [linking, setLinking] = useState<PartRequest | null>(null);
  const [viewing, setViewing] = useState<Quote | null>(null);
  const [sharing, setSharing] = useState<Quote | null>(null);
  const [zoom, setZoom] = useState<{ request: PartRequest; index: number } | null>(null);
  const quotes = useQuery({
    queryKey: ["ticket", ticket.id, "quotes"],
    queryFn: () => api.get<Quote[]>(`/tickets/${ticket.id}/quotes`),
    enabled: canAct && requests.length > 0,
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id] });
    void queryClient.invalidateQueries({ queryKey: ["tickets"] });
    void queryClient.invalidateQueries({ queryKey: ["quotes"] });
  };
  const link = useMutation({
    mutationFn: ({ request, quote }: { request: PartRequest; quote: Quote }) => api.patch(`/part-requests/${request.id}`, { quote_id: quote.id }),
    onSuccess: (_, { quote }) => {
      refresh();
      setLinking(null);
      toast({ title: `Pedido ligado ao ${quote.code}`, tone: "success" });
    },
    onError: (e) => toast({ title: "Não foi possível ligar o pedido", description: errorMessage(e), tone: "error" }),
  });
  const send = useMutation({
    mutationFn: (q: Quote) => api.post<Quote>(`/quotes/${q.id}/send`),
    onSuccess: (q) => {
      refresh();
      setSharing(q);
    },
    onError: (e) => toast({ title: "Não foi possível enviar", description: errorMessage(e), tone: "error" }),
  });

  // Orçamento salvo a partir dos pedidos: cada pedido passa a "Orçamento criado", ligado a ele.
  const attach = async (items: PartRequest[], saved: Quote, sending: boolean) => {
    try {
      await Promise.all(items.map((r) => api.patch(`/part-requests/${r.id}`, { status: "quoted", quote_id: saved.id })));
      if (!sending) toast({ title: `${saved.code} criado a partir do pedido`, description: "Envie o link para o cliente aprovar.", tone: "success" });
    } catch (e) {
      toast({ title: `${saved.code} salvo, mas o pedido não foi ligado a ele`, description: errorMessage(e), tone: "error" });
    }
    refresh();
  };

  // Foto ampliada como camada: foco no Fechar ao abrir, Tab preso nela, Esc fecha só ela (o
  // preventDefault avisa o painel da OS) e o foco volta para a miniatura. Uma tecla que a camada de
  // cima já tratou (a busca Ctrl+K aberta sobre a foto) fica com ela.
  const zoomBox = useRef<HTMLDivElement>(null);
  const zoomClose = useRef<HTMLButtonElement>(null);
  const zoomOpen = zoom !== null;
  useEffect(() => {
    if (!zoomOpen) return;
    const opener = document.activeElement;
    const unlock = lockScroll();
    zoomClose.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      const node = zoomBox.current;
      if (e.defaultPrevented || !node || !isTopLayer(node)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        setZoom(null);
      } else if (e.key === "Tab") {
        trapTab(e, node);
      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const step = e.key === "ArrowRight" ? 1 : -1;
        setZoom((z) => (z ? { ...z, index: Math.min(z.request.attachments.length - 1, Math.max(0, z.index + step)) } : z));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      unlock();
      restoreFocus(opener);
    };
  }, [zoomOpen]);

  // Orçamentos em que o pedido pode entrar: os ainda abertos e os já aprovados pelo cliente.
  const linkable = (quotes.data ?? []).filter((q) => q.status === "draft" || q.status === "sent" || q.status === "approved");
  const zoomed = zoom ? zoom.request.attachments[zoom.index] : null;

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <PackageOpen className="size-4 text-ink-muted" />
            Pedidos de peça do técnico
            {openRequests.length ? (
              <span
                className="rounded-full bg-amber-100 px-1.5 text-[11px] leading-[18px] font-semibold text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
                aria-label={`${openRequests.length} aguardando orçamento`}
              >
                {openRequests.length}
              </span>
            ) : null}
          </span>
        }
        description="Peça só entra com orçamento aprovado e assinado pelo cliente."
        actions={
          canAct && openRequests.length > 1 ? (
            <Button size="sm" onClick={() => setEditor({ quote: null, requests: openRequests, prefill: prefillFrom(openRequests, ticket.code) })}>
              <FileText className="size-3.5" />
              Orçar os {openRequests.length} abertos
            </Button>
          ) : null
        }
      />
      {requests.length === 0 ? (
        <p className="px-5 py-4 text-sm text-ink-muted">Nenhum pedido de peça do técnico nesta OS. Quando ele pedir pelo app, aparece aqui.</p>
      ) : (
        <ul className="divide-y divide-line">
          {requests.map((r) => {
            const quote = r.quote_id ? (quotes.data ?? []).find((q) => q.id === r.quote_id) : undefined;
            return (
              <li key={r.id} className="flex flex-wrap items-start gap-3 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink">{amount(r)}</p>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {r.requested_by?.name ?? "Técnico"} · {formatShort(r.created_at)}
                    {r.quote_code ? " · " : ""}
                    {r.quote_code && quote ? (
                      <button type="button" onClick={() => setViewing(quote)} className="font-medium text-brand hover:underline">
                        {r.quote_code}
                      </button>
                    ) : (
                      (r.quote_code ?? "")
                    )}
                  </p>
                  {r.note ? <p className="mt-1 text-xs text-ink-muted italic">“{r.note}”</p> : null}
                  {r.response_note ? <p className="mt-1 text-xs text-ink-muted">Resposta: {r.response_note}</p> : null}
                  {r.attachments.length ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {r.attachments.map((a, i) => (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => setZoom({ request: r, index: i })}
                          className="size-12 overflow-hidden rounded-lg border border-line bg-surface-2 focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none"
                          aria-label={`Ampliar a foto ${i + 1} do pedido: ${r.description}`}
                        >
                          <PartPhoto url={a.url} alt={`Foto ${i + 1} do pedido: ${r.description}`} ticketId={ticket.id} className="size-full object-cover" />
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <Pill color={STATUS[r.status].color}>{STATUS[r.status].label}</Pill>
                  {r.status === "open" && canAct ? (
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <Button size="sm" variant="ghost" onClick={() => setRejecting(r)}>
                        Recusar
                      </Button>
                      {linkable.length ? (
                        <Button size="sm" variant="ghost" onClick={() => setLinking(r)}>
                          <Link2 className="size-3.5" />
                          Ligar a orçamento
                        </Button>
                      ) : null}
                      <Button size="sm" variant="primary" onClick={() => setEditor({ quote: null, requests: [r], prefill: prefillFrom([r], ticket.code) })}>
                        <FileText className="size-3.5" />
                        Montar orçamento
                      </Button>
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {rejecting ? (
        <RejectDialog
          request={rejecting}
          onClose={() => setRejecting(null)}
          onDone={() => {
            refresh();
            toast({ title: "Pedido recusado", description: "O técnico vê o motivo no app.", tone: "success" });
          }}
        />
      ) : null}
      {linking ? (
        <LinkDialog
          request={linking}
          quotes={linkable}
          pending={link.isPending}
          onClose={() => setLinking(null)}
          onLink={(quote) => link.mutate({ request: linking, quote })}
        />
      ) : null}
      {editor ? (
        <QuoteEditor
          ticket={ticket}
          quote={editor.quote}
          prefill={editor.prefill}
          onClose={() => setEditor(null)}
          onSaved={(saved, sending) => {
            if (editor.requests.length) void attach(editor.requests, saved, sending);
            else refresh();
          }}
          onSend={(saved) => send.mutate(saved)}
        />
      ) : null}
      {viewing ? (
        <QuoteViewer
          quote={viewing}
          ticket={{ id: ticket.id, code: ticket.code, customer: ticket.customer?.name ?? null, title: ticket.title }}
          inTicket
          sending={send.isPending}
          onClose={() => setViewing(null)}
          onEdit={() => {
            setViewing(null);
            setEditor({ quote: viewing, requests: [] });
          }}
          onSend={() => {
            setViewing(null);
            send.mutate(viewing);
          }}
          onShare={() => {
            setViewing(null);
            setSharing(viewing);
          }}
        />
      ) : null}
      {sharing ? <ShareDialog ticket={ticket} quote={sharing} onClose={() => setSharing(null)} onRotated={refresh} /> : null}
      {zoom && zoomed ? (
        <div
          ref={zoomBox}
          role="dialog"
          aria-modal="true"
          aria-label={`Foto ${zoom.index + 1} de ${zoom.request.attachments.length} do pedido: ${zoom.request.description}`}
          className="fixed inset-0 z-50 flex animate-fade items-center justify-center bg-black/80 p-4"
          onClick={() => setZoom(null)}
        >
          <button
            ref={zoomClose}
            type="button"
            onClick={() => setZoom(null)}
            className="absolute top-4 right-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
            aria-label="Fechar"
          >
            <X className="size-5" />
          </button>
          {zoom.index > 0 ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setZoom({ ...zoom, index: zoom.index - 1 });
              }}
              className="absolute top-1/2 left-4 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
              aria-label="Foto anterior"
            >
              <ChevronLeft className="size-6" />
            </button>
          ) : null}
          {zoom.index < zoom.request.attachments.length - 1 ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setZoom({ ...zoom, index: zoom.index + 1 });
              }}
              className="absolute top-1/2 right-4 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
              aria-label="Próxima foto"
            >
              <ChevronRight className="size-6" />
            </button>
          ) : null}
          <div onClick={(e) => e.stopPropagation()} className="flex max-h-full max-w-full">
            <PartPhoto
              key={zoomed.id}
              url={zoomed.url}
              alt={`Foto ${zoom.index + 1} do pedido: ${zoom.request.description}`}
              ticketId={ticket.id}
              className="max-h-[90vh] max-w-full animate-pop rounded-xl object-contain"
            />
          </div>
        </div>
      ) : null}
    </Card>
  );
}

/** Itens do orçamento a partir dos pedidos (o valor fica para a central preencher). */
function prefillFrom(items: PartRequest[], ticketCode: string): QuotePrefill {
  return {
    title: `Peças · ${ticketCode}`,
    items: items.map((r) => ({ description: r.description, quantity: r.quantity, unit: r.unit, kind: "product" })),
  };
}
