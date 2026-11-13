"use client";

import clsx from "clsx";
import {
  BadgeCheck,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  ExternalLink,
  FileText,
  FileVideo,
  FileWarning,
  Flag,
  ImageOff,
  MapPin,
  PenLine,
  Printer,
  RotateCcw,
  Timer,
  X,
  XCircle,
} from "lucide-react";
import Image from "next/image";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Logo, ThemeToggle } from "@/components/Brand";
import { PdfFailed, PdfProgress } from "@/components/report/PdfStatus";
import {
  arrivedOnSite,
  captionText,
  FILE_KIND_LABEL,
  fileKind,
  formAnchor,
  groupByPhase,
  PHASE_LABEL,
  photoPhase,
  type ProgressStep,
  progressLine,
  progressSteps,
  reportStage,
} from "@/components/report/shared";
import { Button, isTopLayer, lockScroll, Pill, restoreFocus, SectionTitle, Skeleton, trapTab } from "@/components/ui";
import { ApiError, errorMessage, request } from "@/lib/api";
import { formatDate, formatDateTime, formatDocument, formatMinutes, formatShort, formatTime, initials } from "@/lib/format";
import { useDocumentTitle } from "@/lib/hooks";
import type { PublicReport, PublicReportPhoto } from "@/lib/types";

const LONG_TEXT = 320;
/** Rede fraca (3G na loja): sem resposta nesse tempo, a página oferece tentar de novo. */
const LOAD_TIMEOUT_MS = 20_000;

type ReportForm = PublicReport["forms"][number];
type ReportItem = ReportForm["items"][number];

/** Título de seção do relatório: o mesmo do orçamento público (negrito, com a marca da logo). */
function SectionHead({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <SectionTitle as="h2" size="lg" wrap className="mb-3" aside={aside ?? undefined}>
      {children}
    </SectionTitle>
  );
}

function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={clsx("rounded-xl border border-line bg-surface p-4 print:break-inside-avoid", className)}>{children}</div>;
}

function Tile({ icon: Icon, label, children }: { icon: React.ComponentType<{ className?: string }>; label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-xl border border-line bg-surface px-3 py-4 text-center print:break-inside-avoid">
      <span className="flex items-center gap-1.5 text-xs font-medium text-ink-muted">
        <Icon className="size-3.5" />
        {label}
      </span>
      <span className="text-sm font-semibold text-ink tabular-nums">{children}</span>
    </div>
  );
}

/** Foto do relatório. Link vencido (página aberta por muito tempo) ou arquivo fora do ar vira aviso. */
function ReportImage({ src, alt, className, eager = false }: { src: string; alt: string; className?: string; eager?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (failed === src) {
    return (
      <span
        role="img"
        aria-label={`${alt}: foto indisponível`}
        className={clsx("flex flex-col items-center justify-center gap-1 bg-surface-2 text-center text-xs text-ink-muted", className)}
      >
        <ImageOff className="size-5" />
        Foto indisponível. Recarregue a página.
      </span>
    );
  }
  return (
    // Fotos servidas pela API com link assinado (fora do otimizador do Next).
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} loading={eager ? "eager" : "lazy"} decoding="async" className={className} onError={() => setFailed(src)} />
  );
}

/** Legenda da foto: dentro do grupo "Antes"/"Depois" o marcador já está no título do grupo. */
const photoCaption = (p: PublicReportPhoto, grouped: boolean) => (grouped ? captionText(p.caption) : (p.caption ?? "").trim());

/** Texto alternativo: a legenda ou "Foto 3 – Checklist de instalação". */
const photoAlt = (p: PublicReportPhoto, index: number, context: string) => captionText(p.caption) || `Foto ${index + 1} – ${context}`;

function PhotoGrid({
  photos,
  context,
  onOpen,
  grouped = false,
}: {
  photos: PublicReportPhoto[];
  /** De onde são as fotos (campo do checklist, "Evidências"): entra no texto alternativo. */
  context: string;
  onOpen: (p: PublicReportPhoto) => void;
  grouped?: boolean;
}) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {photos.map((p, i) => {
        const kind = fileKind(p.filename);
        const caption = photoCaption(p, grouped);
        const alt = photoAlt(p, i, context);
        return (
          <li key={`${p.url}-${i}`} className="print:break-inside-avoid">
            {kind === "image" ? (
              <button
                type="button"
                onClick={() => onOpen(p)}
                className="block w-full overflow-hidden rounded-xl border border-line bg-surface-2 transition-colors hover:border-line-strong focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus-visible:outline-none"
                aria-label={`Ampliar: ${alt}`}
              >
                <ReportImage src={p.url} alt={alt} className="aspect-[4/3] w-full object-cover" />
              </button>
            ) : (
              // Vídeo, PDF ou foto HEIC: o navegador não mostra como miniatura; abre o arquivo.
              <a
                href={p.url}
                target="_blank"
                rel="noreferrer"
                className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-line bg-surface-2 text-xs font-semibold text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
                aria-label={`Abrir ${FILE_KIND_LABEL[kind].toLowerCase()}: ${alt}`}
              >
                {kind === "video" ? <FileVideo className="size-5" /> : <FileText className="size-5" />}
                {FILE_KIND_LABEL[kind]}
                <span className="inline-flex items-center gap-1 font-medium">
                  Abrir <ExternalLink className="size-3" />
                </span>
              </a>
            )}
            {caption || p.taken_at ? (
              <div className="mt-1">
                {caption ? <p className="text-xs text-ink">{caption}</p> : null}
                {p.taken_at ? <p className="text-[11px] text-ink-subtle tabular-nums">{formatDateTime(p.taken_at)}</p> : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Foto ampliada: passa pelas fotos do relatório (setas), com a legenda e o horário. */
function PhotoViewer({
  photos,
  index,
  onMove,
  onClose,
}: {
  photos: PublicReportPhoto[];
  index: number;
  onMove: (index: number) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const count = photos.length;
  // Foco no Fechar ao abrir e de volta na miniatura ao fechar; a página atrás não rola.
  useEffect(() => {
    const opener = document.activeElement;
    const unlock = lockScroll();
    closeButton.current?.focus();
    return () => {
      unlock();
      restoreFocus(opener);
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const node = box.current;
      if (e.defaultPrevented || !node || !isTopLayer(node)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Tab") {
        trapTab(e, node);
      } else if (e.key === "ArrowRight" && index < count - 1) {
        onMove(index + 1);
      } else if (e.key === "ArrowLeft" && index > 0) {
        onMove(index - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, count, onMove, onClose]);
  const photo = photos[index];
  if (!photo) return null;
  const phase = photoPhase(photo.caption);
  const caption = captionText(photo.caption);
  const alt = photoAlt(photo, index, "relatório");
  const arrow = "absolute top-1/2 z-10 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20";
  return createPortal(
    <div
      ref={box}
      role="dialog"
      aria-modal="true"
      aria-label={`Foto ${index + 1} de ${count}${caption ? `: ${caption}` : ""}`}
      className="fixed inset-0 z-50 flex animate-fade flex-col bg-black/85 backdrop-blur-sm print:hidden"
      onClick={onClose}
    >
      <div className="flex items-center gap-2 px-4 py-3 text-white" onClick={(e) => e.stopPropagation()}>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">
            {phase ? <span className="mr-1.5 rounded bg-white/15 px-1.5 py-0.5 text-[11px]">{PHASE_LABEL[phase]}</span> : null}
            {caption || `Foto ${index + 1}`}
          </p>
          <p className="truncate text-xs text-white/75 tabular-nums">
            {index + 1} de {count}
            {photo.taken_at ? ` · ${formatDateTime(photo.taken_at)}` : ""}
          </p>
        </div>
        <a
          href={photo.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-white/90 transition-colors hover:bg-white/10 hover:text-white"
          aria-label="Abrir a foto original em outra aba"
        >
          <ExternalLink className="size-4" />
          <span className="hidden sm:inline">Abrir original</span>
        </a>
        <button ref={closeButton} type="button" onClick={onClose} className="ml-1 rounded-full bg-white/10 p-2 text-white hover:bg-white/20" aria-label="Fechar">
          <X className="size-5" />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-6 sm:px-16">
        {index > 0 ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onMove(index - 1);
            }}
            className={`${arrow} left-3`}
            aria-label="Foto anterior"
          >
            <ChevronLeft className="size-6" />
          </button>
        ) : null}
        {index < count - 1 ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onMove(index + 1);
            }}
            className={`${arrow} right-3`}
            aria-label="Próxima foto"
          >
            <ChevronRight className="size-6" />
          </button>
        ) : null}
        <div onClick={(e) => e.stopPropagation()} className="flex max-h-full max-w-full">
          <ReportImage
            key={photo.url}
            src={photo.url}
            alt={alt}
            eager
            className="max-h-[calc(100vh-7rem)] max-w-full animate-pop rounded-xl bg-surface-2 object-contain shadow-pop"
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Etapas do atendimento: feitas (com o horário), a atual em destaque e as próximas apagadas. */
function ProgressSteps({ steps }: { steps: ProgressStep[] }) {
  const stateText: Record<ProgressStep["state"], string> = { done: "concluída", current: "etapa atual", next: "próxima etapa" };
  return (
    <ol className="mt-4 grid gap-2.5 sm:grid-cols-5 sm:gap-2">
      {steps.map((step) => (
        <li
          key={step.label}
          aria-current={step.state === "current" ? "step" : undefined}
          className={clsx(
            "flex items-baseline justify-between gap-3 border-l-[3px] pl-3 sm:flex-col sm:justify-start sm:gap-0.5 sm:border-t-[3px] sm:border-l-0 sm:pt-2 sm:pl-0",
            step.state === "next" ? "border-line" : "border-brand",
          )}
        >
          <span
            className={clsx(
              "inline-flex items-center gap-1.5 text-sm",
              step.state === "current" ? "font-bold text-ink" : step.state === "done" ? "font-medium text-ink" : "font-medium text-ink-subtle",
            )}
          >
            {step.state === "done" ? <Check aria-hidden className="size-3.5 shrink-0 text-ink-muted" /> : null}
            {step.label}
            <span className="sr-only"> ({stateText[step.state]})</span>
          </span>
          {step.at ? <span className="text-xs text-ink-muted tabular-nums">{formatShort(step.at)}</span> : null}
        </li>
      ))}
    </ol>
  );
}

/** Perguntas do checklist agrupadas pelas seções do formulário (a seção vira o título do bloco). */
function formBlocks(items: ReportItem[]): { title: string | null; items: ReportItem[] }[] {
  const blocks: { title: string | null; items: ReportItem[] }[] = [];
  for (const item of items) {
    if (item.type === "section") blocks.push({ title: item.label, items: [] });
    else if (blocks.length) blocks[blocks.length - 1].items.push(item);
    else blocks.push({ title: null, items: [item] });
  }
  return blocks.filter((b) => b.items.length > 0);
}

/** Âncoras dos checklists (o "Ver no relatório do cliente" da OS abre direto no formulário). */
function formAnchors(forms: ReportForm[]): string[] {
  const seen = new Map<string, number>();
  return forms.map((form) => {
    const base = formAnchor(form.name);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
}

function ReportSkeleton() {
  return (
    <div role="status" aria-label="Carregando o relatório" className="overflow-hidden rounded-2xl border border-line bg-surface p-8 shadow-elev-2">
      <div className="flex justify-between">
        <div className="flex gap-3">
          <Skeleton className="size-12 rounded-xl" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
        </div>
        <Skeleton className="h-10 w-36" />
      </div>
      <div className="mt-8 grid grid-cols-2 gap-4">
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-28 rounded-xl" />
      </div>
      <div className="mt-6 grid grid-cols-4 gap-3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
    </div>
  );
}

/** Situação ao lado do título: verde só concluída; cancelada em vermelho; em andamento, neutra. */
function StatusPill({ report }: { report: PublicReport }) {
  const stage = reportStage(report.status);
  if (stage === "done") {
    return (
      <Pill color="#10b981">
        <CheckCircle2 className="size-3.5" />
        Concluído
      </Pill>
    );
  }
  if (stage === "cancelled") {
    return (
      <Pill color="#dc2626">
        <XCircle className="size-3.5" />
        Cancelado
      </Pill>
    );
  }
  return (
    <Pill color="#64748b">
      <Clock3 className="size-3.5" />
      Em andamento · {report.status_label}
    </Pill>
  );
}

/** Elemento da âncora do endereço (#form-...), se houver; um "#" malformado não derruba a página. */
function hashTarget(): HTMLElement | null {
  const hash = window.location.hash.slice(1);
  if (!hash) return null;
  try {
    return document.getElementById(decodeURIComponent(hash));
  } catch {
    return null;
  }
}

export default function PublicReportPage() {
  const { token } = useParams<{ token: string }>();
  const [report, setReport] = useState<PublicReport | null>(null);
  const [problem, setProblem] = useState<{ title: string; text: string; retry: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [zoom, setZoom] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  // Geração do PDF: o passo atual ("Preparando as fotos (12 de 40)...") ou null; e se falhou.
  const [building, setBuilding] = useState<string | null>(null);
  const [pdfFailed, setPdfFailed] = useState(false);

  // PDF de verdade, gerado no navegador (A4, com as fotos reduzidas e a assinatura).
  const buildPdf = useCallback(async (data: PublicReport) => {
    setPdfFailed(false);
    setBuilding("Preparando o PDF...");
    try {
      const { downloadReportPdf } = await import("@/components/report/ReportPdf");
      await downloadReportPdf(data, (done, total) =>
        setBuilding(done < total ? `Preparando as fotos (${done} de ${total})...` : "Montando o PDF..."),
      );
    } catch {
      // Celular sem memória ou foto que o gerador não lê: a impressão do navegador salva em PDF.
      setPdfFailed(true);
    } finally {
      setBuilding(null);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // Sem login vale como visita do cliente; com a sessão da central (a gestão conferindo, o técnico
    // da OS), a API não conta a abertura.
    request<PublicReport>(`/public/reports/${encodeURIComponent(token)}`, { signal: controller.signal, timeoutMs: LOAD_TIMEOUT_MS })
      .then((data) => {
        setReport(data);
        // Link com ?pdf=1 (botão "Baixar PDF" da OS): baixa assim que carrega. O parâmetro sai do
        // endereço: copiado de lá e enviado ao cliente, cada abertura baixaria um PDF.
        const url = new URL(window.location.href);
        if (url.searchParams.get("pdf") === "1") {
          url.searchParams.delete("pdf");
          window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
          void buildPdf(data);
        }
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        if (e instanceof ApiError && (e.status === 404 || e.status === 410)) {
          setProblem({ title: "Link inválido ou expirado", text: "Peça um novo link a quem enviou o relatório.", retry: false });
        } else if (e instanceof ApiError && e.status === 409) {
          setProblem({ title: "Relatório temporariamente indisponível", text: errorMessage(e), retry: true });
        } else {
          setProblem({
            title: "Não foi possível abrir o relatório",
            text:
              e instanceof ApiError && e.status === 408
                ? "A conexão está lenta e o relatório não chegou. Tente de novo."
                : "Verifique a conexão e tente de novo.",
            retry: true,
          });
        }
      });
    return () => controller.abort();
  }, [token, attempt, buildPdf]);

  // Link com âncora (o "Ver no relatório do cliente" de um formulário): o conteúdo chega depois do
  // carregamento da página, então a rolagem até ele acontece aqui.
  useEffect(() => {
    if (report) hashTarget()?.scrollIntoView({ block: "start" });
  }, [report]);

  const number = report ? (report.number !== undefined ? String(report.number).padStart(6, "0") : report.code) : null;
  useDocumentTitle(number ? `Relatório OS ${number}` : null);

  const retry = () => {
    setProblem(null);
    setAttempt((n) => n + 1);
  };

  const loc = report?.location;
  const address =
    report?.service_address ||
    [loc?.address, [loc?.city, loc?.state].filter(Boolean).join("-"), loc?.zip_code].filter(Boolean).join(", ") ||
    null;
  const longDescription = (report?.description.length ?? 0) > LONG_TEXT;
  const stage = report ? reportStage(report.status) : "progress";
  const onSite = report ? stage !== "cancelled" && arrivedOnSite(report) : false;
  const anchors = report ? formAnchors(report.forms) : [];
  const evidence = report ? groupByPhase(report.photos) : [];
  // Fotos que abrem ampliadas, na ordem da página: as dos checklists e depois as evidências.
  const viewable = report
    ? [...report.forms.flatMap((f) => f.items.flatMap((i) => i.photos)), ...evidence.flatMap((g) => g.photos)].filter(
        (p) => fileKind(p.filename) === "image",
      )
    : [];
  const openPhoto = (p: PublicReportPhoto) => {
    const index = viewable.indexOf(p);
    if (index >= 0) setZoom(index);
  };
  const companyName = report ? (report.company?.name ?? report.company_name) : "";
  const companyContact = report?.company?.phone || report?.company?.email || null;

  return (
    <div className="min-h-screen bg-canvas print:bg-white">
      <header className="mx-auto flex max-w-5xl items-center justify-between gap-2 px-4 pt-6 print:hidden">
        <Logo />
        <div className="flex items-center gap-2">
          {report ? (
            <>
              <Button variant="ghost" onClick={() => window.print()} aria-label="Imprimir" title="Imprimir">
                <Printer className="size-4" />
              </Button>
              <Button variant="primary" onClick={() => void buildPdf(report)} loading={building !== null}>
                {building !== null ? null : <Download className="size-4" />}
                {building !== null ? "Gerando PDF..." : "Baixar PDF"}
              </Button>
            </>
          ) : null}
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6 print:max-w-none print:p-0">
        {problem ? (
          <div className="mx-auto flex max-w-md animate-rise flex-col items-center gap-3 rounded-2xl border border-line bg-surface px-6 py-12 text-center shadow-elev-2">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400">
              <FileWarning className="size-6" />
            </span>
            <h1 className="text-base font-bold text-ink">{problem.title}</h1>
            <p className="text-sm text-ink-muted">{problem.text}</p>
            {problem.retry ? (
              <Button className="mt-1" onClick={retry}>
                <RotateCcw className="size-4" />
                Tentar de novo
              </Button>
            ) : null}
          </div>
        ) : !report ? (
          <ReportSkeleton />
        ) : (
          <article className="animate-rise overflow-hidden rounded-2xl border border-line bg-surface shadow-elev-2 print:rounded-none print:border-0 print:shadow-none">
            <div className="brand-gradient h-1" />

            {/* Empresa · número da OS */}
            <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4 border-b border-line px-5 py-6 sm:px-8">
              <div className="flex min-w-0 items-center gap-4">
                <span className="flex size-14 shrink-0 items-center justify-center rounded-xl border border-line bg-white">
                  <Image src="/brand/maxxfield-mark.png" alt="" width={36} height={18} />
                </span>
                <div className="min-w-0 text-xs leading-relaxed text-ink-muted">
                  <p className="text-base font-semibold text-ink">{companyName}</p>
                  {report.company?.email || report.company?.phone ? (
                    <p>{[report.company?.email, report.company?.phone].filter(Boolean).join(" · ")}</p>
                  ) : null}
                  {report.company?.address ? <p>{report.company.address}</p> : null}
                </div>
              </div>
              {/* No celular o bloco desce para baixo da empresa: alinhado à esquerda, como ela. */}
              <div className="text-left sm:text-right">
                <p className="text-[11px] font-bold tracking-[0.06em] text-ink-muted uppercase">Relatório de atendimento</p>
                <p className="mt-0.5 font-mono text-2xl font-semibold tracking-tight text-ink">OS {number}</p>
                {report.service_type ? <p className="text-xs text-ink-muted">{report.service_type}</p> : null}
              </div>
            </div>

            {/* Título e situação */}
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-6 sm:px-8">
              <div className="min-w-0">
                <h1 className="text-xl leading-tight font-bold tracking-[-0.02em] text-ink sm:text-2xl">{report.title}</h1>
                <p className="mt-1 text-xs text-ink-muted">OS aberta em {formatDateTime(report.opened_at)}</p>
              </div>
              <StatusPill report={report} />
            </div>

            {stage === "cancelled" ? (
              <div className="mx-5 mt-5 flex items-start gap-3 rounded-xl border border-line bg-surface-2/60 p-4 sm:mx-8 print:break-inside-avoid">
                <XCircle className="mt-0.5 size-5 shrink-0 text-ink-muted" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink">Este atendimento foi cancelado.</p>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    Em caso de dúvida, fale com {companyName}
                    {companyContact ? ` (${companyContact})` : ""}.
                  </p>
                </div>
              </div>
            ) : null}

            {/* Antes da conclusão: onde o atendimento está e o que vem depois. */}
            {stage === "progress" ? (
              <section aria-label="Andamento do atendimento" className="px-5 pt-5 sm:px-8">
                <div className="rounded-xl border border-line bg-surface-2/60 p-4 print:break-inside-avoid">
                  <p className="flex items-start gap-2 text-sm font-semibold text-ink">
                    <Clock3 className="mt-0.5 size-4 shrink-0 text-ink-muted" />
                    {progressLine(report)}
                  </p>
                  <ProgressSteps steps={progressSteps(report)} />
                  <p className="mt-4 text-xs text-ink-muted">
                    Ao concluir, este mesmo link mostra o resultado: a solução aplicada, as fotos, o checklist e a assinatura.
                  </p>
                </div>
              </section>
            ) : null}

            {/* Cliente e local */}
            <section className="px-5 py-6 sm:px-8">
              <SectionHead>Dados do cliente</SectionHead>
              <div className="grid gap-4 md:grid-cols-2">
                <Panel>
                  <div className="flex items-start gap-3">
                    <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-sm font-semibold text-ink ring-1 ring-line">
                      {initials(report.customer?.name ?? report.requester_name ?? "?")}
                    </span>
                    <div className="min-w-0 text-xs leading-relaxed text-ink-muted">
                      <p className="text-sm font-semibold text-ink">{report.customer?.name ?? report.requester_name ?? "—"}</p>
                      {report.customer?.document ? <p>CPF/CNPJ: {formatDocument(report.customer.document)}</p> : null}
                      {report.customer?.phone ? <p>Telefone: {report.customer.phone}</p> : null}
                      {report.customer?.email ? <p>E-mail: {report.customer.email}</p> : null}
                      {report.requester_name && report.customer ? <p>Solicitante: {report.requester_name}</p> : null}
                    </div>
                  </div>
                </Panel>
                <Panel>
                  <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-ink/80">
                    <MapPin className="size-3.5" />
                    Local do atendimento
                  </p>
                  <p className="text-sm font-semibold text-ink">
                    {loc ? (
                      <>
                        {loc.code ? <span className="mr-1 font-mono text-xs font-normal text-ink-subtle">{loc.code}</span> : null}
                        {loc.name}
                      </>
                    ) : (
                      "—"
                    )}
                  </p>
                  {address ? <p className="mt-0.5 text-xs text-ink-muted">{address}</p> : null}
                  {loc?.contact_name ? (
                    <p className="mt-0.5 text-xs text-ink-muted">
                      Contato: {loc.contact_name}
                      {loc.contact_phone ? ` · ${loc.contact_phone}` : ""}
                    </p>
                  ) : null}
                </Panel>
              </div>
              {report.description ? (
                <Panel className="mt-4">
                  <p className="mb-1 text-xs font-semibold text-ink/80">Descrição do serviço</p>
                  <p
                    className={clsx(
                      "text-sm leading-relaxed whitespace-pre-wrap text-ink-muted print:line-clamp-none",
                      longDescription && !expanded && "line-clamp-4",
                    )}
                  >
                    {report.description}
                  </p>
                  {longDescription ? (
                    <button
                      type="button"
                      onClick={() => setExpanded((v) => !v)}
                      className="mt-2 text-xs font-medium text-brand hover:underline print:hidden"
                    >
                      {expanded ? "Ver menos" : "Ver mais"}
                    </button>
                  ) : null}
                </Panel>
              ) : null}
            </section>

            {/* Atendimento (cancelada: só o aviso acima) */}
            {stage !== "cancelled" ? (
              <section className="border-t border-line px-5 py-6 sm:px-8">
                <SectionHead
                  aside={
                    report.arrival_minutes != null || report.check_in_gps ? (
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                        {report.arrival_minutes != null ? (
                          <span
                            className={clsx(
                              "inline-flex items-center gap-1",
                              report.arrival_on_time === false ? "font-medium text-amber-700 dark:text-amber-400" : "text-ink-muted",
                            )}
                          >
                            <Clock3 className="size-3.5" />
                            Técnico chegou em {formatMinutes(report.arrival_minutes)}
                            {report.arrival_on_time ? " · dentro do prazo" : report.arrival_on_time === false ? " · fora do prazo" : ""}
                          </span>
                        ) : null}
                        {report.check_in_gps ? (
                          <span className="inline-flex items-center gap-1 text-ink-muted">
                            <BadgeCheck className="size-3.5" />
                            Presença confirmada por GPS
                          </span>
                        ) : null}
                      </span>
                    ) : null
                  }
                >
                  Informações do atendimento
                </SectionHead>
                <div className={clsx("grid grid-cols-2 gap-3", onSite && "md:grid-cols-[1.4fr_1fr_1fr_1fr_1fr]")}>
                  <div
                    className={clsx(
                      "col-span-2 flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 print:break-inside-avoid",
                      onSite && "md:col-span-1",
                    )}
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-ink ring-1 ring-line">
                      {report.technician ? initials(report.technician.name) : "?"}
                    </span>
                    <div className="min-w-0">
                      <p className="text-[11px] font-medium text-ink-muted">Técnico responsável</p>
                      <p className="truncate text-sm font-semibold text-ink">{report.technician?.name ?? "A definir"}</p>
                      {report.helpers?.length ? (
                        <p className="truncate text-xs text-ink-muted">com {report.helpers.map((h) => h.name).join(", ")}</p>
                      ) : null}
                    </div>
                  </div>
                  {/* Os horários aparecem a partir da chegada do técnico (antes ficariam vazios). */}
                  {onSite ? (
                    <>
                      <Tile icon={CalendarDays} label="Data">
                        {formatDate(report.arrived_at ?? report.scheduled_start ?? report.finished_at)}
                      </Tile>
                      <Tile icon={Clock3} label="Início">
                        {report.arrived_at ? formatTime(report.arrived_at) : "—"}
                      </Tile>
                      <Tile icon={Flag} label="Fim">
                        {report.finished_at ? formatTime(report.finished_at) : "—"}
                      </Tile>
                      <Tile icon={Timer} label="Tempo no local">
                        {report.on_site_minutes ? formatMinutes(report.on_site_minutes) : "—"}
                      </Tile>
                    </>
                  ) : null}
                </div>

                {report.resolution_notes ? (
                  <div className="mt-4 rounded-xl border-l-4 border-brand bg-brand-soft/60 px-4 py-3.5 print:break-inside-avoid">
                    <p className="mb-1 text-xs font-bold text-brand-ink">Solução aplicada</p>
                    <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink">{report.resolution_notes}</p>
                  </div>
                ) : null}

                {/* Em andamento, as etapas lá em cima já trazem os horários. */}
                {stage === "done" && report.timeline.length ? (
                  <div className="mt-5 print:break-inside-avoid">
                    <p className="mb-2 text-xs font-semibold text-ink/80">
                      Linha do tempo <span className="font-normal text-ink-muted">· horário de Brasília</span>
                    </p>
                    <ol className="grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(120px,1fr))]">
                      {report.timeline.map((step, i) => (
                        <li key={`${step.label}-${i}`} className="border-l-2 border-brand/70 pl-3 sm:border-t-2 sm:border-l-0 sm:pt-2 sm:pl-0">
                          <p className="text-xs font-semibold text-ink">{step.label}</p>
                          <p className="text-[11px] text-ink-muted tabular-nums">{formatDateTime(step.at)}</p>
                        </li>
                      ))}
                    </ol>
                  </div>
                ) : null}
              </section>
            ) : null}

            {/* Checklists (com âncora: a OS abre o relatório direto em cada um) */}
            {report.forms.map((form, index) => (
              <section key={anchors[index]} id={anchors[index]} className="scroll-mt-6 border-t border-line px-5 py-6 sm:px-8">
                <SectionHead
                  aside={
                    form.completed_at ? (
                      <span className="text-xs text-ink-muted">Preenchido em {formatDateTime(form.completed_at)}</span>
                    ) : (
                      <Pill color="#64748b">Em preenchimento</Pill>
                    )
                  }
                >
                  {form.name}
                </SectionHead>
                <div className="overflow-hidden rounded-xl border border-line">
                  {formBlocks(form.items).map((block, b) => (
                    <div key={b} className={clsx(b > 0 && "border-t border-line")}>
                      {block.title ? (
                        <h3 className="border-b border-line bg-surface-2/70 px-4 py-2 text-[11px] font-bold tracking-[0.06em] text-ink-muted uppercase">
                          {block.title}
                        </h3>
                      ) : null}
                      <dl className="divide-y divide-line">
                        {block.items.map((item, i) => {
                          // Resposta curta na mesma linha, à direita; longa (ou fotos), embaixo da pergunta.
                          const long = (item.value ?? "").length > 60;
                          const inline = item.photos.length === 0 && !long;
                          return (
                            <div
                              key={`${item.label}-${i}`}
                              className={clsx(
                                "grid gap-x-6 gap-y-1 px-4 py-3 print:break-inside-avoid",
                                inline && "sm:grid-cols-[minmax(0,1fr)_auto] sm:items-baseline",
                              )}
                            >
                              <dt className="text-sm text-ink-muted">{item.label}</dt>
                              {item.photos.length ? (
                                <dd className="mt-2">
                                  <PhotoGrid photos={item.photos} context={`${form.name}, ${item.label}`} onOpen={openPhoto} />
                                </dd>
                              ) : (
                                <dd className={clsx("text-sm font-medium break-words whitespace-pre-wrap text-ink", inline && "sm:text-right")}>
                                  {item.value || "—"}
                                </dd>
                              )}
                            </div>
                          );
                        })}
                      </dl>
                    </div>
                  ))}
                </div>
              </section>
            ))}

            {/* Fotos soltas (fora dos checklists): primeiro as de antes, depois as de depois, quando marcadas. */}
            {report.photos.length ? (
              <section className="border-t border-line px-5 py-6 sm:px-8">
                <SectionHead>
                  Evidências · {report.photos.length} {report.photos.length === 1 ? "foto" : "fotos"}
                </SectionHead>
                <div className="flex flex-col gap-5">
                  {evidence.map((group) => (
                    <div key={group.phase ?? "outras"}>
                      {group.phase || evidence.length > 1 ? (
                        <h3 className="mb-2 text-xs font-bold tracking-[0.06em] text-ink-muted uppercase">
                          {group.phase ? PHASE_LABEL[group.phase] : "Outras fotos"}
                        </h3>
                      ) : null}
                      <PhotoGrid
                        photos={group.photos}
                        context={group.phase ? `Evidências, ${PHASE_LABEL[group.phase].toLowerCase()}` : "Evidências"}
                        onOpen={openPhoto}
                        grouped={group.phase !== null}
                      />
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {report.signature ? (
              <section className="border-t border-line px-5 py-6 sm:px-8 print:break-inside-avoid">
                <SectionHead>Assinatura do responsável no local</SectionHead>
                <div className="flex flex-wrap items-end gap-6">
                  <div className="rounded-xl border border-line bg-white px-6 py-3">
                    {report.signature.image_url ? (
                      <ReportImage
                        src={report.signature.image_url}
                        alt={`Assinatura de ${report.signature.name ?? "responsável"}`}
                        eager
                        className="h-24 w-auto"
                      />
                    ) : (
                      <PenLine className="size-6 text-ink-subtle" />
                    )}
                  </div>
                  <div className="text-sm">
                    <p className="font-semibold text-ink uppercase">{report.signature.name}</p>
                    {report.signature.role ? <p className="text-ink-muted">{report.signature.role}</p> : null}
                    <p className="mt-1 text-xs text-ink-subtle">Assinado no local em {formatDateTime(report.signature.signed_at)}</p>
                  </div>
                </div>
              </section>
            ) : null}

            <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface-2/60 px-5 py-4 text-[11px] text-ink-subtle sm:px-8">
              <span className="inline-flex items-center gap-2">
                <Image src="/brand/maxxfield-mark.png" alt="" width={22} height={11} />
                Relatório gerado em {formatDateTime(report.generated_at)} (horário de Brasília) · {companyName}
              </span>
              <span className="font-mono">{report.code}</span>
            </footer>
          </article>
        )}
      </main>

      {zoom !== null ? <PhotoViewer photos={viewable} index={zoom} onMove={setZoom} onClose={() => setZoom(null)} /> : null}
      <PdfProgress text={building} />
      <PdfFailed open={pdfFailed} onClose={() => setPdfFailed(false)} />
    </div>
  );
}
