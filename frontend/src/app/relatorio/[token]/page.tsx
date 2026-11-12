"use client";

import clsx from "clsx";
import {
  BadgeCheck,
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  Download,
  FileWarning,
  Flag,
  Images,
  Loader2,
  MapPin,
  PenLine,
  Printer,
  Timer,
  X,
} from "lucide-react";
import Image from "next/image";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Logo, ThemeToggle } from "@/components/Brand";
import { Button, Skeleton } from "@/components/ui";
import { ApiError, errorMessage, request } from "@/lib/api";
import { formatDate, formatDateTime, formatDocument, formatMinutes, formatTime, initials } from "@/lib/format";
import type { PublicReport, PublicReportPhoto } from "@/lib/types";

const LONG_TEXT = 320;

function SectionHead({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
      <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">{children}</h2>
      {aside ? <div className="text-xs text-ink-muted">{aside}</div> : null}
    </div>
  );
}

function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={clsx("rounded-xl border border-line bg-surface p-4 print:break-inside-avoid", className)}>{children}</div>;
}

function Tile({ icon: Icon, label, children }: { icon: React.ComponentType<{ className?: string }>; label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-xl border border-line bg-surface px-3 py-4 text-center print:break-inside-avoid">
      <span className="flex items-center gap-1.5 text-xs text-ink-subtle">
        <Icon className="size-3.5" />
        {label}
      </span>
      <span className="text-sm font-semibold text-ink tabular-nums">{children}</span>
    </div>
  );
}

function PhotoGrid({ photos, onOpen }: { photos: PublicReportPhoto[]; onOpen: (p: PublicReportPhoto) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {photos.map((p, i) => (
        <figure key={`${p.url}-${i}`} className="group print:break-inside-avoid">
          <button
            type="button"
            onClick={() => onOpen(p)}
            className="block w-full overflow-hidden rounded-xl border border-line bg-surface-2"
            aria-label={`Ampliar ${p.filename}`}
          >
            {/* Fotos servidas pela API com link assinado (fora do otimizador do Next). */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={p.url}
              alt={p.filename}
              loading="lazy"
              className="aspect-[4/3] w-full object-cover transition-transform duration-500 ease-out-expo group-hover:scale-[1.03]"
            />
          </button>
          {p.caption || p.taken_at ? (
            <figcaption className="mt-1">
              {p.caption ? <span className="block text-xs text-ink">{p.caption}</span> : null}
              {p.taken_at ? <span className="block text-[11px] text-ink-subtle">{formatDateTime(p.taken_at)}</span> : null}
            </figcaption>
          ) : null}
        </figure>
      ))}
    </div>
  );
}

function ReportSkeleton() {
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface p-8 shadow-elev-2">
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

export default function PublicReportPage() {
  const { token } = useParams<{ token: string }>();
  const [report, setReport] = useState<PublicReport | null>(null);
  const [problem, setProblem] = useState<{ title: string; text: string } | null>(null);
  const [zoom, setZoom] = useState<PublicReportPhoto | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [building, setBuilding] = useState(false);
  // PDF de verdade, gerado no navegador (A4, com fotos e assinatura); se falhar, cai na impressão.
  const buildPdf = useCallback(async (data: PublicReport) => {
    setBuilding(true);
    try {
      const [{ pdf }, { ReportPdf }] = await Promise.all([import("@react-pdf/renderer"), import("@/components/report/ReportPdf")]);
      const blob = await pdf(<ReportPdf report={data} />).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Relatorio-${data.code}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 15_000);
    } catch {
      window.print();
    } finally {
      setBuilding(false);
    }
  }, []);

  useEffect(() => {
    request<PublicReport>(`/public/reports/${encodeURIComponent(token)}`, { auth: false })
      .then((data) => {
        setReport(data);
        // Link com ?pdf=1 (botão "Baixar PDF" da OS): baixa assim que o relatório carrega.
        if (new URLSearchParams(window.location.search).get("pdf") === "1") void buildPdf(data);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 409) {
          setProblem({ title: "Relatório temporariamente indisponível", text: errorMessage(e) });
        } else if (e instanceof ApiError && (e.status === 404 || e.status === 410)) {
          setProblem({ title: "Link inválido ou expirado", text: "Peça um novo link a quem enviou o relatório." });
        } else {
          setProblem({ title: "Não foi possível abrir o relatório", text: "Verifique a conexão e tente de novo." });
        }
      });
  }, [token, buildPdf]);

  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setZoom(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom]);

  const downloadPdf = () => {
    if (report) void buildPdf(report);
  };

  const loc = report?.location;
  const address =
    report?.service_address ||
    [loc?.address, [loc?.city, loc?.state].filter(Boolean).join("-"), loc?.zip_code].filter(Boolean).join(", ") ||
    null;
  const formPhotos = report?.forms.reduce((n, f) => n + f.items.reduce((m, i) => m + i.photos.length, 0), 0) ?? 0;
  const number = report?.number !== undefined ? String(report.number).padStart(6, "0") : report?.code;
  const longDescription = (report?.description.length ?? 0) > LONG_TEXT;

  return (
    <div className="min-h-screen bg-canvas print:bg-white">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-4 pt-6 print:hidden">
        <Logo />
        <div className="flex items-center gap-2">
          {report ? (
            <>
              <Button variant="ghost" onClick={() => window.print()} aria-label="Imprimir">
                <Printer className="size-4" />
              </Button>
              <Button variant="primary" onClick={downloadPdf} loading={building}>
                {building ? null : <Download className="size-4" />}
                {building ? "Gerando PDF..." : "Baixar PDF"}
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
            <p className="text-base font-semibold text-ink">{problem.title}</p>
            <p className="text-sm text-ink-muted">{problem.text}</p>
          </div>
        ) : !report ? (
          <ReportSkeleton />
        ) : (
          <article className="animate-rise overflow-hidden rounded-2xl border border-line bg-surface shadow-elev-2 print:rounded-none print:border-0 print:shadow-none">
            <div className="brand-gradient h-1" />

            {/* Empresa · número da OS */}
            <div className="flex flex-wrap items-start justify-between gap-6 border-b border-line px-6 py-6 sm:px-8">
              <div className="flex min-w-0 items-center gap-4">
                <span className="flex size-14 shrink-0 items-center justify-center rounded-xl border border-line bg-white">
                  <Image src="/brand/maxxfield-mark.png" alt="" width={36} height={18} />
                </span>
                <div className="min-w-0 text-xs leading-relaxed text-ink-muted">
                  <p className="text-base font-semibold text-ink">{report.company?.name ?? report.company_name}</p>
                  {report.company?.email || report.company?.phone ? (
                    <p>{[report.company?.email, report.company?.phone].filter(Boolean).join(" · ")}</p>
                  ) : null}
                  {report.company?.address ? <p>{report.company.address}</p> : null}
                </div>
              </div>
              <div className="text-right">
                <p className="text-[11px] font-medium tracking-[0.06em] text-ink-subtle uppercase">Relatório de atendimento</p>
                <p className="mt-0.5 font-mono text-2xl font-semibold tracking-tight text-ink">OS {number}</p>
                {report.service_type ? <p className="text-xs text-ink-muted">{report.service_type}</p> : null}
              </div>
            </div>

            {/* Título e situação */}
            <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-6 sm:px-8">
              <div className="min-w-0">
                <h1 className="text-xl leading-tight font-semibold tracking-[-0.015em] text-ink sm:text-2xl">{report.title}</h1>
                <p className="mt-1 text-xs text-ink-muted">OS aberta em {formatDateTime(report.opened_at)}</p>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200 ring-inset dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/25">
                <CheckCircle2 className="size-3.5" />
                {report.status_label}
              </span>
            </div>

            {/* Cliente e local */}
            <section className="px-6 py-6 sm:px-8">
              <SectionHead>Dados do cliente</SectionHead>
              <div className="grid gap-4 md:grid-cols-2">
                <Panel>
                  <div className="flex items-start gap-3">
                    <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-sm font-semibold text-brand-ink">
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
                  <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-subtle">
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
                  <p className="mb-1 text-xs font-medium text-ink-subtle">Descrição do serviço</p>
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

            {/* Atendimento */}
            <section className="border-t border-line px-6 py-6 sm:px-8">
              <SectionHead
                aside={
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    {report.arrival_minutes != null ? (
                      <span
                        className={clsx(
                          "inline-flex items-center gap-1",
                          report.arrival_on_time === false ? "text-amber-700 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400",
                        )}
                      >
                        <Clock3 className="size-3.5" />
                        Técnico chegou em {formatMinutes(report.arrival_minutes)}
                        {report.arrival_on_time ? " · dentro do prazo" : report.arrival_on_time === false ? " · fora do prazo" : ""}
                      </span>
                    ) : null}
                    {report.check_in_gps ? (
                      <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                        <BadgeCheck className="size-3.5" />
                        Presença confirmada por GPS
                      </span>
                    ) : null}
                  </span>
                }
              >
                Informações do atendimento
              </SectionHead>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-[1.4fr_1fr_1fr_1fr_1fr]">
                <div className="col-span-2 flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 md:col-span-1 print:break-inside-avoid">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-brand to-brand-cyan text-xs font-semibold text-white">
                    {report.technician ? initials(report.technician.name) : "?"}
                  </span>
                  <div className="min-w-0">
                    <p className="text-[11px] text-ink-subtle">Técnico responsável</p>
                    <p className="truncate text-sm font-semibold text-ink">{report.technician?.name ?? "Sem técnico"}</p>
                    {report.helpers?.length ? (
                      <p className="truncate text-xs text-ink-muted">com {report.helpers.map((h) => h.name).join(", ")}</p>
                    ) : null}
                  </div>
                </div>
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
              </div>

              {report.resolution_notes ? (
                <div className="mt-4 rounded-xl border-l-4 border-brand bg-brand-soft/60 px-4 py-3.5 print:break-inside-avoid">
                  <p className="mb-1 text-xs font-semibold text-brand-ink">Solução aplicada</p>
                  <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink">{report.resolution_notes}</p>
                </div>
              ) : null}

              {report.timeline.length ? (
                <ol className="mt-5 grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(120px,1fr))] print:break-inside-avoid">
                  {report.timeline.map((step, i) => (
                    <li key={`${step.label}-${i}`} className="border-t-2 border-brand/70 pt-2">
                      <p className="text-xs font-semibold text-ink">{step.label}</p>
                      <p className="text-[11px] text-ink-muted tabular-nums">{formatDateTime(step.at)}</p>
                    </li>
                  ))}
                </ol>
              ) : null}
            </section>

            {/* Checklists */}
            {report.forms.map((form) => (
              <section key={form.name} className="border-t border-line px-6 py-6 sm:px-8">
                <SectionHead aside={form.completed_at ? `Preenchido em ${formatDateTime(form.completed_at)}` : null}>
                  <span className="inline-flex items-center gap-2">
                    <ClipboardCheck className="size-4 text-brand" />
                    {form.name}
                  </span>
                </SectionHead>
                <dl className="divide-y divide-line rounded-xl border border-line">
                  {form.items.map((item, i) =>
                    item.type === "section" ? (
                      <dt
                        key={`${item.label}-${i}`}
                        className="bg-surface-2/70 px-4 py-2 text-[11px] font-semibold tracking-[0.06em] text-ink-subtle uppercase first:rounded-t-xl"
                      >
                        {item.label}
                      </dt>
                    ) : (
                      <div key={`${item.label}-${i}`} className="px-4 py-3 print:break-inside-avoid">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                          <dt className="text-sm text-ink-muted">{item.label}</dt>
                          {item.photos.length === 0 ? <dd className="text-sm font-medium text-ink">{item.value || "—"}</dd> : null}
                        </div>
                        {item.photos.length ? (
                          <dd className="mt-3">
                            <PhotoGrid photos={item.photos} onOpen={setZoom} />
                          </dd>
                        ) : null}
                      </div>
                    ),
                  )}
                </dl>
              </section>
            ))}

            {report.photos.length ? (
              <section className="border-t border-line px-6 py-6 sm:px-8">
                <SectionHead>
                  <span className="inline-flex items-center gap-2">
                    <Images className="size-4 text-brand" />
                    Evidências ({report.photos.length + formPhotos} fotos)
                  </span>
                </SectionHead>
                <PhotoGrid photos={report.photos} onOpen={setZoom} />
              </section>
            ) : null}

            {report.signature ? (
              <section className="border-t border-line px-6 py-6 sm:px-8 print:break-inside-avoid">
                <SectionHead>
                  <span className="inline-flex items-center gap-2">
                    <PenLine className="size-4 text-brand" />
                    Assinatura do responsável no local
                  </span>
                </SectionHead>
                <div className="flex flex-wrap items-end gap-6">
                  <div className="rounded-xl border border-line bg-white px-6 py-3">
                    {report.signature.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={report.signature.image_url} alt={`Assinatura de ${report.signature.name ?? "responsável"}`} className="h-24 w-auto" />
                    ) : (
                      <PenLine className="size-6 text-slate-300" />
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

            <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface-2/60 px-6 py-4 text-[11px] text-ink-subtle sm:px-8">
              <span className="inline-flex items-center gap-2">
                <Image src="/brand/maxxfield-mark.png" alt="" width={22} height={11} />
                Relatório gerado em {formatDateTime(report.generated_at)} · {report.company?.name ?? report.company_name}
              </span>
              <span className="font-mono">{report.code}</span>
            </footer>
          </article>
        )}
      </main>

      {zoom ? (
        <div
          className="fixed inset-0 z-50 flex animate-fade items-center justify-center bg-black/80 p-4 backdrop-blur-sm print:hidden"
          onClick={() => setZoom(null)}
        >
          <button
            type="button"
            onClick={() => setZoom(null)}
            className="absolute top-4 right-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
            aria-label="Fechar"
          >
            <X className="size-5" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoom.url} alt={zoom.filename} className="max-h-[90vh] max-w-full animate-pop rounded-xl object-contain shadow-pop" />
        </div>
      ) : null}
      {building ? (
        <div className="fixed right-4 bottom-4 z-50 inline-flex animate-toast items-center gap-2 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink shadow-pop print:hidden">
          <Loader2 className="size-4 animate-spin text-brand" />
          Preparando o PDF com as fotos...
        </div>
      ) : null}
    </div>
  );
}
