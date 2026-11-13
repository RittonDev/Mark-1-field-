"use client";

import clsx from "clsx";
import {
  CalendarClock,
  CheckCircle2,
  Clock3,
  Download,
  FileText,
  FileWarning,
  Mail,
  MapPin,
  MessageCircle,
  MessageSquareText,
  PenLine,
  Phone,
  RotateCcw,
  XCircle,
} from "lucide-react";
import Image from "next/image";
import { useParams } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { Logo, ThemeToggle } from "@/components/Brand";
import { PdfFailed, PdfProgress } from "@/components/report/PdfStatus";
import { SignaturePad } from "@/components/SignaturePad";
import { Button, buttonClassName, Checkbox, ErrorBox, Input, SectionTitle, Skeleton, Textarea } from "@/components/ui";
import { ApiError, errorMessage, request } from "@/lib/api";
import { formatDate, formatDateTime, formatDocument, formatMoney, initials } from "@/lib/format";
import { useDocumentTitle } from "@/lib/hooks";
import { QUOTE_KIND, totalsByKind } from "@/lib/quotes";
import type { CompanyProfile, PublicQuote, QuoteItemKind, QuoteStatus } from "@/lib/types";
import { whatsappUrl } from "@/lib/whatsapp";

// Faixa da situação: fundo claro com texto escuro da mesma cor (contraste AA também no escuro); o
// verde, o vermelho e o âmbar só aparecem quando há decisão ou prazo vencido.
const BANNER: Record<QuoteStatus, { label: string; className: string; icon: typeof CheckCircle2 }> = {
  draft: { label: "Em revisão pela empresa", className: "bg-surface-2 text-ink-muted", icon: Clock3 },
  sent: { label: "Aguardando sua aprovação", className: "bg-brand-soft text-brand-ink", icon: PenLine },
  approved: {
    label: "Aprovado",
    className: "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300",
    icon: CheckCircle2,
  },
  rejected: { label: "Recusado", className: "bg-red-50 text-red-800 dark:bg-red-500/10 dark:text-red-300", icon: XCircle },
  expired: { label: "Vencido", className: "bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300", icon: CalendarClock },
  cancelled: { label: "Cancelado", className: "bg-surface-2 text-ink-muted", icon: XCircle },
};

// Limites da API (nome 160, motivo e comentário 2000, matrícula 40): passar deles daria erro em inglês.
const NAME_MAX = 160;
const TEXT_MAX = 2000;
const REGISTRATION_MAX = 40;

const qty = (value: number) => value.toLocaleString("pt-BR", { maximumFractionDigits: 3 });

function Box({ title, children, className }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={clsx("rounded-xl border border-line bg-surface p-4 print:break-inside-avoid", className)}>
      {title ? <p className="mb-2 text-xs font-semibold text-ink/80">{title}</p> : null}
      {children}
    </div>
  );
}

/** Como falar com a empresa (orçamento vencido ou em revisão): WhatsApp, telefone e e-mail. */
function CompanyContacts({ company, code, text }: { company: CompanyProfile | undefined; code: string; text: string }) {
  if (!company?.phone && !company?.email) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2 print:hidden">
      {company.phone ? (
        <>
          <a href={whatsappUrl(company.phone, text)} target="_blank" rel="noreferrer" className={buttonClassName("secondary", "sm")}>
            <MessageCircle className="size-3.5" />
            WhatsApp
          </a>
          <a href={`tel:${company.phone.replace(/[^\d+]/g, "")}`} className={buttonClassName("secondary", "sm")}>
            <Phone className="size-3.5" />
            Ligar
          </a>
        </>
      ) : null}
      {company.email ? (
        <a
          href={`mailto:${company.email}?subject=${encodeURIComponent(`Orçamento ${code}`)}&body=${encodeURIComponent(text)}`}
          className={buttonClassName("secondary", "sm")}
        >
          <Mail className="size-3.5" />
          E-mail
        </a>
      ) : null}
    </div>
  );
}

function QuoteSkeleton() {
  return (
    <div role="status" aria-label="Carregando o orçamento" className="overflow-hidden rounded-2xl border border-line bg-surface shadow-elev-2">
      <div className="flex justify-between p-8">
        <div className="flex gap-4">
          <Skeleton className="size-14 rounded-xl" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
        </div>
        <Skeleton className="h-10 w-32" />
      </div>
      <Skeleton className="h-10 rounded-none" />
      <div className="grid gap-4 p-8 md:grid-cols-2">
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-28 rounded-xl" />
      </div>
    </div>
  );
}

/** Rede fraca (3G do cliente): sem resposta nesse tempo, a página oferece tentar de novo. */
const LOAD_TIMEOUT_MS = 20_000;

/** "a, b e c". */
function listText(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}` : (items[0] ?? "");
}

const smoothScroll = (): ScrollBehavior => (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

export default function PublicQuotePage() {
  const { token } = useParams<{ token: string }>();
  const [quote, setQuote] = useState<PublicQuote | null>(null);
  // `gone`: o link não abre mais (trocado, cancelado), com a mensagem da API. `failed`: rede ou servidor,
  // com "Tentar de novo".
  const [gone, setGone] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<"approve" | "reject">("approve");
  const [name, setName] = useState("");
  const [registration, setRegistration] = useState("");
  const [signature, setSignature] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Resposta registrada: anuncia ao leitor de tela e leva o foco até o resultado.
  const [announce, setAnnounce] = useState("");
  const [answered, setAnswered] = useState(0);
  const [building, setBuilding] = useState<string | null>(null);
  const [pdfFailed, setPdfFailed] = useState(false);
  // A barra do celular (total + Responder) some quando a resposta já está na tela.
  const [answerVisible, setAnswerVisible] = useState(false);
  const answerRef = useRef<HTMLElement>(null);
  const approveRadio = useRef<HTMLButtonElement>(null);
  const rejectRadio = useRef<HTMLButtonElement>(null);
  const answerTitleId = useId();
  const commentId = useId();
  const commentCountId = useId();
  const reasonId = useId();
  const reasonCountId = useId();
  const path = `/public/quotes/${encodeURIComponent(token)}`;

  useEffect(() => {
    const controller = new AbortController();
    request<PublicQuote>(path, { auth: false, signal: controller.signal, timeoutMs: LOAD_TIMEOUT_MS })
      .then(setQuote)
      .catch((e) => {
        if (controller.signal.aborted) return;
        if (e instanceof ApiError && (e.status === 410 || e.status === 404)) setGone(errorMessage(e));
        else {
          setFailed(
            e instanceof ApiError && e.status === 408
              ? "A conexão está lenta e o orçamento não chegou. Tente de novo."
              : "Verifique a conexão e tente de novo.",
          );
        }
      });
    return () => controller.abort();
  }, [path, attempt]);

  const loaded = quote !== null;
  useEffect(() => {
    const node = answerRef.current;
    if (!loaded || !node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setAnswerVisible(entry.isIntersecting), { rootMargin: "0px 0px -15% 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [loaded]);

  useEffect(() => {
    if (!answered) return;
    answerRef.current?.scrollIntoView({ block: "start", behavior: smoothScroll() });
    answerRef.current?.focus({ preventScroll: true });
  }, [answered]);

  useDocumentTitle(quote ? `Orçamento ${quote.code}` : null);

  async function decide(kind: "approve" | "reject") {
    setError(null);
    if (kind === "approve") {
      if (!signature) return setError("Assine no quadro para aprovar.");
      if (name.trim().length < 3) return setError("Informe seu nome completo.");
      if (!agreed) return setError("Marque que leu e concorda com o orçamento.");
    } else if (reason.trim().length < 3) {
      return setError("Conte o motivo da recusa (pelo menos 3 letras).");
    }
    setSending(true);
    try {
      const body =
        kind === "approve"
          ? {
              name: name.trim(),
              registration: registration.trim() || null,
              signature,
              comment: comment.trim() || null,
              accept: agreed,
            }
          : { name: name.trim() || null, reason: reason.trim(), comment: comment.trim() || null };
      setQuote(await request<PublicQuote>(`${path}/${kind}`, { method: "POST", body, auth: false }));
      setAnnounce(kind === "approve" ? "Orçamento aprovado. Obrigado!" : "Recusa registrada. A empresa já foi avisada.");
      setAnswered((n) => n + 1);
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && e.status === 409) {
        // Mudou com a página aberta (a empresa editou, venceu, outra pessoa respondeu): mostra como está agora.
        try {
          setQuote(await request<PublicQuote>(path, { auth: false }));
        } catch {
          // Sem a releitura, fica a mensagem.
        }
      } else if (e instanceof ApiError && (e.status === 410 || e.status === 404)) {
        setGone(errorMessage(e));
      }
    } finally {
      setSending(false);
    }
  }

  // PDF de verdade, gerado no navegador (A4, com a assinatura quando aprovado).
  const downloadPdf = async () => {
    if (!quote) return;
    setPdfFailed(false);
    setBuilding("Gerando o PDF...");
    try {
      const { downloadQuotePdf } = await import("@/components/quotes/QuotePdf");
      await downloadQuotePdf(quote);
    } catch {
      setPdfFailed(true);
    } finally {
      setBuilding(null);
    }
  };

  const pick = (next: "approve" | "reject", focus = false) => {
    setMode(next);
    setError(null);
    if (focus) (next === "approve" ? approveRadio : rejectRadio).current?.focus();
  };
  // Grupo de opções: as setas trocam entre Aprovar e Recusar (um Tab entra e sai do grupo).
  const onRadioKey = (e: React.KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    pick(mode === "approve" ? "reject" : "approve", true);
  };
  const goToAnswer = () => {
    answerRef.current?.scrollIntoView({ block: "start", behavior: smoothScroll() });
    (mode === "approve" ? approveRadio : rejectRadio).current?.focus({ preventScroll: true });
  };

  const company = quote?.company;
  const customer = quote?.customer_info ?? (quote?.customer ? { name: quote.customer, document: null, email: null, phone: null } : null);
  const totals = quote ? totalsByKind(quote.items, quote.totals_by_kind) : null;
  const kinds = quote ? (Object.keys(QUOTE_KIND) as QuoteItemKind[]).filter((k) => quote.items.some((i) => (i.kind ?? "product") === k)) : [];
  const open = quote?.status === "sent";
  const missing = [!signature && "assine no quadro", name.trim().length < 3 && "informe seu nome", !agreed && "marque a concordância"].filter(
    (m): m is string => Boolean(m),
  );
  const banner = quote ? BANNER[quote.status] : null;

  return (
    <div className="min-h-screen bg-canvas print:bg-white">
      <header className="mx-auto flex max-w-5xl items-center justify-between gap-2 px-4 pt-6 print:hidden">
        <Logo />
        <div className="flex items-center gap-2">
          {quote ? (
            <Button onClick={downloadPdf} loading={building !== null}>
              {building !== null ? null : <Download className="size-4" />}
              {building !== null ? "Gerando PDF..." : "Baixar PDF"}
            </Button>
          ) : null}
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6 print:max-w-none print:p-0">
        <p role="status" className="sr-only">
          {announce}
        </p>
        {gone ? (
          <div className="mx-auto flex max-w-md animate-rise flex-col items-center gap-3 rounded-2xl border border-line bg-surface px-6 py-12 text-center shadow-elev-2">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400">
              <FileWarning className="size-6" />
            </span>
            <h1 className="text-base font-bold text-ink">Orçamento indisponível</h1>
            <p className="text-sm text-ink-muted">{gone}</p>
            <p className="text-xs text-ink-muted">Se ainda precisar dele, peça um novo link a quem enviou.</p>
          </div>
        ) : failed ? (
          <div className="mx-auto flex max-w-md animate-rise flex-col items-center gap-3 rounded-2xl border border-line bg-surface px-6 py-12 text-center shadow-elev-2">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400">
              <FileWarning className="size-6" />
            </span>
            <h1 className="text-base font-bold text-ink">Não foi possível abrir o orçamento</h1>
            <p className="text-sm text-ink-muted">{failed}</p>
            <Button
              className="mt-1"
              onClick={() => {
                setFailed(null);
                setAttempt((n) => n + 1);
              }}
            >
              <RotateCcw className="size-4" />
              Tentar de novo
            </Button>
          </div>
        ) : !quote || !banner ? (
          <QuoteSkeleton />
        ) : (
          <article className="animate-rise overflow-hidden rounded-2xl border border-line bg-surface shadow-elev-2 print:rounded-none print:border-0 print:shadow-none">
            <h1 className="sr-only">
              Orçamento {quote.code} · {quote.title}
            </h1>
            {/* Empresa e números */}
            <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4 px-5 py-6 sm:px-8">
              <div className="flex min-w-0 items-start gap-4">
                <span className="flex size-14 shrink-0 items-center justify-center rounded-xl border border-line bg-white">
                  <Image src="/brand/maxxfield-mark.png" alt="" width={36} height={18} />
                </span>
                <div className="min-w-0 text-xs leading-relaxed text-ink-muted">
                  <p className="text-base font-semibold text-ink">{company?.name ?? "Maxx Field"}</p>
                  {company?.document ? <p>CNPJ: {formatDocument(company.document)}</p> : null}
                  {company?.email ? <p>E-mail: {company.email}</p> : null}
                  {company?.phone ? <p>Telefone: {company.phone}</p> : null}
                  {company?.address ? <p>Endereço: {company.address}</p> : null}
                </div>
              </div>
              <dl className="grid grid-cols-[auto_auto] items-baseline gap-x-3 gap-y-1 text-left sm:text-right">
                <dt className="text-sm text-ink-muted">OS</dt>
                <dd className="font-mono text-lg font-semibold text-ink">
                  {quote.ticket_number !== undefined ? String(quote.ticket_number).padStart(6, "0") : quote.ticket_code}
                </dd>
                <dt className="text-sm text-ink-muted">Orçamento</dt>
                <dd className="font-mono text-lg font-semibold text-ink">{quote.code}</dd>
              </dl>
            </div>

            <div className={clsx("flex items-center justify-center gap-2 border-y border-line px-5 py-2.5 text-center text-sm font-semibold", banner.className)}>
              <banner.icon aria-hidden className="size-4 shrink-0" />
              {banner.label}
            </div>

            {/* Dados do orçamento */}
            <section className="px-5 py-6 sm:px-8">
              <SectionTitle
                as="h2"
                size="lg"
                wrap
                className="mb-3"
                aside={
                  <dl className="grid grid-cols-[auto_auto] gap-x-2 text-[11px] text-ink-muted sm:text-right">
                    <dt className="font-semibold text-ink">Emitido em:</dt>
                    <dd className="tabular-nums">{formatDate(quote.issued_at ?? quote.sent_at)}</dd>
                    {quote.valid_until ? (
                      <>
                        <dt className="font-semibold text-ink">Válido até:</dt>
                        <dd className="tabular-nums">{formatDate(quote.valid_until)}</dd>
                      </>
                    ) : null}
                  </dl>
                }
              >
                Dados do orçamento
              </SectionTitle>
              <div className="grid gap-4 md:grid-cols-2">
                <Box>
                  <div className="flex items-start gap-3">
                    <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-sm font-semibold text-ink ring-1 ring-line">
                      {initials(customer?.name ?? quote.location ?? "?")}
                    </span>
                    <div className="min-w-0 text-xs leading-relaxed text-ink-muted">
                      <p className="text-sm font-semibold text-ink">
                        {customer?.name ?? "—"}
                        {quote.location ? <span className="font-normal text-ink-muted"> · {quote.location}</span> : null}
                      </p>
                      {customer?.document ? <p>CPF/CNPJ: {formatDocument(customer.document)}</p> : null}
                      {customer?.email ? <p>E-mail: {customer.email}</p> : null}
                      {customer?.phone ? <p>Telefone: {customer.phone}</p> : null}
                    </div>
                  </div>
                </Box>
                <Box title="Endereço do atendimento">
                  <p className="flex items-start gap-1.5 text-sm text-ink">
                    <MapPin className="mt-0.5 size-4 shrink-0 text-ink-subtle" />
                    {quote.address?.full ?? quote.location ?? "—"}
                  </p>
                </Box>
              </div>
              <Box title="Nome do orçamento" className="mt-4">
                <p className="text-sm font-semibold text-ink">{quote.title}</p>
                <p className="mt-1 text-xs text-ink-muted">
                  Referente à OS {quote.ticket_code} · {quote.ticket_title}
                </p>
              </Box>
            </section>

            {/* Itens: no celular, um cartão por item (sem rolar para o lado); da largura média em diante, a tabela. */}
            <section className="border-t border-line px-5 py-6 sm:px-8">
              <SectionTitle
                as="h2"
                size="lg"
                className="mb-3"
                aside={
                  <span className="text-xs text-ink-muted">
                    {quote.items.length} {quote.items.length === 1 ? "item" : "itens"}
                  </span>
                }
              >
                Itens
              </SectionTitle>
              <ul className="divide-y divide-line rounded-xl border border-line md:hidden">
                {quote.items.map((item, i) => (
                  <li key={i} className="flex items-start justify-between gap-3 px-4 py-3 print:break-inside-avoid">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold break-words text-ink">{item.description}</p>
                      <p className="mt-0.5 text-xs text-ink-muted tabular-nums">
                        {qty(item.quantity)} {item.unit} × {formatMoney(item.unit_price)}
                      </p>
                      <p className="mt-1 text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
                        {QUOTE_KIND[item.kind ?? "product"].label}
                      </p>
                    </div>
                    <p className="shrink-0 text-sm font-semibold text-ink tabular-nums">{formatMoney(item.total)}</p>
                  </li>
                ))}
              </ul>
              <div className="hidden overflow-hidden rounded-xl border border-line md:block">
                <table className="w-full text-sm">
                  <thead className="bg-surface-2/70 text-left text-[11px] font-bold tracking-[0.05em] text-ink-muted uppercase">
                    <tr>
                      <th scope="col" className="px-4 py-2.5">
                        Item
                      </th>
                      <th scope="col" className="px-4 py-2.5">
                        Tipo
                      </th>
                      <th scope="col" className="px-4 py-2.5 text-right">
                        Quantidade
                      </th>
                      <th scope="col" className="px-4 py-2.5 text-right">
                        Valor unitário
                      </th>
                      <th scope="col" className="px-4 py-2.5 text-right">
                        Total
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {quote.items.map((item, i) => (
                      <tr key={i} className="print:break-inside-avoid">
                        <td className="px-4 py-3 font-semibold break-words text-ink">{item.description}</td>
                        <td className="px-4 py-3 whitespace-nowrap text-ink-muted">{QUOTE_KIND[item.kind ?? "product"].label}</td>
                        <td className="px-4 py-3 text-right whitespace-nowrap tabular-nums">
                          {qty(item.quantity)} {item.unit}
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap tabular-nums">{formatMoney(item.unit_price)}</td>
                        <td className="px-4 py-3 text-right font-medium whitespace-nowrap tabular-nums">{formatMoney(item.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Resumo: só o que existe no orçamento (sem linhas zeradas). */}
            <section className="border-t border-line px-5 py-6 sm:px-8 print:break-inside-avoid">
              <SectionTitle as="h2" size="lg" className="mb-3">
                Resumo do orçamento
              </SectionTitle>
              <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_20rem]">
                {quote.notes ? (
                  <Box title="Condições">
                    <p className="text-sm whitespace-pre-wrap text-ink">{quote.notes}</p>
                  </Box>
                ) : null}
                <dl className="rounded-xl border border-line bg-surface-2/60 p-4 text-sm tabular-nums md:col-start-2">
                  {kinds.length > 1 && totals
                    ? kinds.map((k) => (
                        <div key={k} className="flex justify-between gap-3 py-0.5 text-ink-muted">
                          <dt>Total em {QUOTE_KIND[k].plural.toLowerCase()}</dt>
                          <dd>{formatMoney(totals[k])}</dd>
                        </div>
                      ))
                    : null}
                  {quote.discount > 0 ? (
                    <>
                      <div className="flex justify-between gap-3 py-0.5 text-ink-muted">
                        <dt>Subtotal</dt>
                        <dd>{formatMoney(quote.subtotal)}</dd>
                      </div>
                      <div className="flex justify-between gap-3 py-0.5 text-ink-muted">
                        <dt>Desconto</dt>
                        <dd>−{formatMoney(quote.discount)}</dd>
                      </div>
                    </>
                  ) : null}
                  <div className={clsx("flex items-baseline justify-between gap-3", (kinds.length > 1 || quote.discount > 0) && "mt-2 border-t border-line pt-2.5")}>
                    <dt className="font-semibold text-ink">Valor total</dt>
                    <dd className="text-xl font-bold tracking-[-0.01em] text-ink">{formatMoney(quote.total)}</dd>
                  </div>
                </dl>
              </div>
            </section>

            {/* Resposta do cliente */}
            <section
              ref={answerRef}
              tabIndex={-1}
              aria-labelledby={answerTitleId}
              className="scroll-mt-4 border-t border-line px-5 py-6 outline-none sm:px-8 print:break-inside-avoid"
            >
              <SectionTitle as="h2" size="lg" className="mb-3">
                <span id={answerTitleId}>{open ? "Responder orçamento" : "Resposta do cliente"}</span>
              </SectionTitle>

              {/* Depois de uma resposta recusada pela API (ex.: o orçamento mudou), o motivo fica aqui. */}
              {error && !open ? (
                <div className="mb-4">
                  <ErrorBox message={error} />
                </div>
              ) : null}

              {quote.status === "approved" ? (
                <>
                  <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                    <div className="overflow-hidden rounded-xl border border-line">
                      <div className="flex h-40 items-center justify-center bg-white">
                        {quote.signature_url ? (
                          // Assinatura servida pela API com link assinado.
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={quote.signature_url} alt={`Assinatura de ${quote.approver_name ?? "cliente"}`} className="max-h-36 w-auto" />
                        ) : (
                          <PenLine className="size-6 text-ink-subtle" />
                        )}
                      </div>
                      <div className="border-t border-line px-4 py-3">
                        <p className="text-sm font-semibold text-ink uppercase">{quote.approver_name}</p>
                        {quote.approver_registration ? <p className="text-xs text-ink-muted">Matrícula: {quote.approver_registration}</p> : null}
                        <p className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                          <CheckCircle2 className="size-3.5" />
                          Aprovado em {formatDateTime(quote.decided_at)}
                        </p>
                      </div>
                    </div>
                    <Box title="Comentário para a empresa">
                      <p className="text-sm whitespace-pre-wrap text-ink">
                        {quote.client_comment || <span className="text-ink-subtle">Sem comentário.</span>}
                      </p>
                    </Box>
                  </div>
                  <p className="mt-3 text-xs text-ink-muted">
                    Aprovação eletrônica registrada com o nome, a assinatura, a data, a hora e o endereço IP de quem aprovou.
                  </p>
                </>
              ) : quote.status === "rejected" ? (
                <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
                  <XCircle className="mt-0.5 size-5 shrink-0" />
                  <div className="min-w-0">
                    <p className="font-bold">
                      Recusado{quote.approver_name ? ` por ${quote.approver_name}` : ""} em {formatDateTime(quote.decided_at)}
                    </p>
                    {quote.rejection_reason ? <p className="mt-1 break-words">Motivo: {quote.rejection_reason}</p> : null}
                    {quote.client_comment ? <p className="mt-2 break-words text-red-700 dark:text-red-200/85">“{quote.client_comment}”</p> : null}
                  </div>
                </div>
              ) : quote.status === "expired" ? (
                <div className="rounded-xl border border-line bg-surface-2/60 p-4 text-sm">
                  <p className="flex items-start gap-2 font-semibold text-ink">
                    <CalendarClock className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                    {quote.valid_until ? `Este orçamento venceu em ${formatDate(quote.valid_until)} sem resposta.` : "Este orçamento venceu sem resposta."}
                  </p>
                  <p className="mt-1 text-ink-muted">Peça uma versão atualizada: o novo envio chega por este mesmo link.</p>
                  <CompanyContacts
                    company={company}
                    code={quote.code}
                    text={`Olá! O orçamento ${quote.code} venceu: gostaria de uma versão atualizada.`}
                  />
                </div>
              ) : !open ? (
                <div className="rounded-xl border border-line bg-surface-2/60 p-4 text-sm">
                  <p className="flex items-start gap-2 font-semibold text-ink">
                    <FileText className="mt-0.5 size-4 shrink-0 text-ink-muted" />
                    {quote.status === "draft"
                      ? "Este orçamento está em revisão pela empresa."
                      : "Este orçamento foi cancelado pela empresa e não aceita resposta."}
                  </p>
                  {quote.status === "draft" ? (
                    <p className="mt-1 text-ink-muted">Os itens e valores podem mudar. Aguarde o novo envio para responder por este mesmo link.</p>
                  ) : null}
                  <CompanyContacts company={company} code={quote.code} text={`Olá! Tenho uma dúvida sobre o orçamento ${quote.code}.`} />
                </div>
              ) : (
                <div className="print:hidden">
                  <div role="radiogroup" aria-label="Sua resposta" className="mb-4 inline-flex rounded-lg bg-surface-3/70 p-0.5 text-[13px]">
                    {(["approve", "reject"] as const).map((m) => (
                      <button
                        key={m}
                        ref={m === "approve" ? approveRadio : rejectRadio}
                        type="button"
                        role="radio"
                        aria-checked={mode === m}
                        tabIndex={mode === m ? 0 : -1}
                        onClick={() => pick(m)}
                        onKeyDown={onRadioKey}
                        className={clsx(
                          "h-9 rounded-md px-4 transition-colors focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none",
                          mode === m ? "bg-surface font-semibold text-ink shadow-elev-1 ring-1 ring-line" : "text-ink-muted hover:text-ink",
                        )}
                      >
                        {m === "approve" ? "Aprovar" : "Recusar"}
                      </button>
                    ))}
                  </div>

                  <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                    {/* Os dois quadros ficam montados: ir a "Recusar" e voltar não apaga a assinatura desenhada. */}
                    <div className={clsx("flex flex-col gap-3 rounded-xl border border-line p-4", mode !== "approve" && "hidden")}>
                      <p className="text-xs font-semibold text-ink/80">
                        Assinatura <span className="text-red-600 dark:text-red-400">*</span>
                      </p>
                      <SignaturePad onChange={setSignature} />
                      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                        <label className="flex flex-col gap-1.5">
                          <span className="text-xs font-semibold text-ink/80">
                            Nome completo <span className="text-red-600 dark:text-red-400">*</span>
                          </span>
                          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={NAME_MAX} autoComplete="name" />
                        </label>
                        <label className="flex flex-col gap-1.5">
                          <span className="text-xs font-semibold text-ink/80">Matrícula (opcional)</span>
                          <Input value={registration} onChange={(e) => setRegistration(e.target.value)} maxLength={REGISTRATION_MAX} />
                        </label>
                      </div>
                    </div>
                    <div className={clsx("flex flex-col gap-3 rounded-xl border border-line p-4", mode !== "reject" && "hidden")}>
                      <div className="flex flex-col gap-1.5">
                        <label htmlFor={reasonId} className="text-xs font-semibold text-ink/80">
                          Motivo da recusa <span className="text-red-600 dark:text-red-400">*</span>
                        </label>
                        <Textarea
                          id={reasonId}
                          rows={4}
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          maxLength={TEXT_MAX}
                          aria-describedby={reasonCountId}
                        />
                        <span id={reasonCountId} className="text-xs text-ink-subtle tabular-nums">
                          {reason.length}/{TEXT_MAX} · pelo menos 3 letras
                        </span>
                      </div>
                      <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-semibold text-ink/80">Seu nome</span>
                        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={NAME_MAX} autoComplete="name" />
                      </label>
                    </div>
                    <div className="flex flex-col rounded-xl border border-line p-4 transition-[border-color,box-shadow] duration-150 focus-within:border-brand focus-within:ring-4 focus-within:ring-brand/15">
                      <label htmlFor={commentId} className="mb-2 inline-flex items-center gap-1.5 text-xs font-semibold text-ink/80">
                        <MessageSquareText className="size-3.5" />
                        Comentário para a empresa (opcional)
                      </label>
                      <textarea
                        id={commentId}
                        value={comment}
                        maxLength={TEXT_MAX}
                        onChange={(e) => setComment(e.target.value)}
                        aria-describedby={commentCountId}
                        placeholder="Escreva aqui uma mensagem sobre este orçamento."
                        className="min-h-32 flex-1 resize-none bg-transparent text-sm text-ink outline-none placeholder:text-ink-subtle"
                      />
                      <span id={commentCountId} className="mt-2 self-end text-[11px] text-ink-subtle tabular-nums">
                        {comment.length}/{TEXT_MAX}
                      </span>
                    </div>
                  </div>

                  {mode === "approve" ? (
                    <div className="mt-4 rounded-xl border border-line bg-surface-2/60 px-4 py-3">
                      <Checkbox
                        label={`Li e concordo com os itens, valores e condições deste orçamento (${quote.code}, ${formatMoney(quote.total)}).`}
                        checked={agreed}
                        onChange={setAgreed}
                      />
                    </div>
                  ) : null}

                  {error ? (
                    <div className="mt-4">
                      <ErrorBox message={error} />
                    </div>
                  ) : null}
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                    <p className="max-w-xl text-xs text-ink-muted">
                      {mode === "approve"
                        ? "Registramos seu nome, sua assinatura, a data, a hora e o endereço IP como comprovante desta aprovação."
                        : "Registramos o motivo, a data, a hora e o endereço IP como comprovante desta recusa. A empresa é avisada na hora."}
                    </p>
                    {mode === "approve" ? (
                      <Button variant="primary" size="lg" loading={sending} disabled={missing.length > 0} onClick={() => decide("approve")}>
                        {sending ? null : <CheckCircle2 className="size-4" />}
                        Aprovar orçamento
                      </Button>
                    ) : (
                      <Button variant="danger" size="lg" loading={sending} disabled={reason.trim().length < 3} onClick={() => decide("reject")}>
                        {sending ? null : <XCircle className="size-4" />}
                        Recusar orçamento
                      </Button>
                    )}
                  </div>
                  {mode === "approve" && missing.length ? (
                    <p className="mt-2 text-xs text-ink-muted sm:text-right">Para aprovar, {listText(missing)}.</p>
                  ) : null}
                </div>
              )}
            </section>

            <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-surface-2/60 px-5 py-4 text-[11px] text-ink-subtle sm:px-8">
              <span>Resposta eletrônica com registro de data, hora, endereço IP e assinatura · {company?.name ?? "Maxx Field"}</span>
              <span className="font-mono">{quote.code}</span>
            </footer>
          </article>
        )}
      </main>

      {/* Celular: o total e o atalho para responder ficam à mão enquanto o cliente lê os itens. */}
      {quote && open && !answerVisible ? (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 px-4 py-3 shadow-pop backdrop-blur-sm md:hidden print:hidden">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-medium text-ink-muted">Valor total</p>
              <p className="text-base font-bold text-ink tabular-nums">{formatMoney(quote.total)}</p>
            </div>
            <Button variant="primary" onClick={goToAnswer}>
              Responder
            </Button>
          </div>
        </div>
      ) : null}
      <PdfProgress text={building} />
      <PdfFailed open={pdfFailed} onClose={() => setPdfFailed(false)} />
    </div>
  );
}
