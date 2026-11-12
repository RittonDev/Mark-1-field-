"use client";

import clsx from "clsx";
import {
  BadgeCheck,
  Building2,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  Download,
  FileWarning,
  HardHat,
  Images,
  MapPin,
  Navigation,
  PenLine,
  Timer,
  Wrench,
  X,
} from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Logo, ThemeToggle } from "@/components/Brand";
import { Button, Skeleton } from "@/components/ui";
import { ApiError, errorMessage, request } from "@/lib/api";
import { formatDateTime, formatMinutes } from "@/lib/format";
import type { PublicReport, PublicReportPhoto } from "@/lib/types";

function Fact({ icon: Icon, label, children }: { icon: React.ComponentType<{ className?: string }>; label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-3">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-subtle print:hidden">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="text-[11px] font-medium tracking-[0.04em] text-ink-subtle uppercase">{label}</p>
        <div className="mt-0.5 text-sm text-ink">{children}</div>
      </div>
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  children,
  className,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx("border-t border-line px-6 py-6 sm:px-8 print:break-inside-avoid", className)}>
      <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-ink">
        <Icon className="size-4 text-brand" />
        {title}
      </h2>
      {children}
    </section>
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
          {p.taken_at ? <figcaption className="mt-1 text-[11px] text-ink-subtle">{formatDateTime(p.taken_at)}</figcaption> : null}
        </figure>
      ))}
    </div>
  );
}

function ReportSkeleton() {
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface p-8 shadow-elev-2">
      <Skeleton className="h-3 w-40" />
      <Skeleton className="mt-4 h-7 w-2/3" />
      <Skeleton className="mt-2 h-3 w-1/3" />
      <div className="mt-8 grid grid-cols-2 gap-6">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex gap-3">
            <Skeleton className="size-8 rounded-lg" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-2.5 w-1/3" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          </div>
        ))}
      </div>
      <Skeleton className="mt-8 h-24 w-full rounded-xl" />
    </div>
  );
}

export default function PublicReportPage() {
  const { token } = useParams<{ token: string }>();
  const [report, setReport] = useState<PublicReport | null>(null);
  const [problem, setProblem] = useState<{ title: string; text: string } | null>(null);
  const [zoom, setZoom] = useState<PublicReportPhoto | null>(null);

  useEffect(() => {
    request<PublicReport>(`/public/reports/${encodeURIComponent(token)}`, { auth: false })
      .then(setReport)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 409) {
          setProblem({ title: "Relatório temporariamente indisponível", text: errorMessage(e) });
        } else if (e instanceof ApiError && e.status === 404) {
          setProblem({ title: "Link inválido ou expirado", text: "Peça um novo link a quem enviou o relatório." });
        } else {
          setProblem({ title: "Não foi possível abrir o relatório", text: "Verifique a conexão e tente de novo." });
        }
      });
  }, [token]);

  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setZoom(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom]);

  // "Baixar PDF": a impressão do navegador gera o PDF; o nome do arquivo sai do título da página.
  const savePdf = () => {
    if (!report) return;
    const previous = document.title;
    document.title = `Relatorio-${report.code}`;
    window.print();
    document.title = previous;
  };

  const place = report?.location;
  const address =
    report?.service_address ||
    [place?.address, [place?.city, place?.state].filter(Boolean).join("-")].filter(Boolean).join(", ") ||
    null;
  const formPhotos = report?.forms.reduce((n, f) => n + f.items.reduce((m, i) => m + i.photos.length, 0), 0) ?? 0;

  return (
    <div className="min-h-screen bg-canvas print:bg-white">
      <header className="mx-auto flex max-w-4xl items-center justify-between px-4 pt-6 print:hidden">
        <Logo />
        <div className="flex items-center gap-2">
          {report ? (
            <Button variant="primary" onClick={savePdf}>
              <Download className="size-4" />
              Baixar PDF
            </Button>
          ) : null}
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-6 print:max-w-none print:p-0">
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
            {/* Cabeçalho */}
            <div className="px-6 pt-7 pb-6 sm:px-8">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-xs font-medium tracking-[0.06em] text-brand uppercase">Relatório de atendimento</p>
                  <h1 className="mt-2 text-2xl leading-tight font-semibold tracking-[-0.02em] text-ink sm:text-[28px]">
                    {report.title}
                  </h1>
                  <p className="mt-1.5 text-sm text-ink-muted">
                    <span className="font-mono">{report.code}</span>
                    {report.finished_at ? ` · concluída em ${formatDateTime(report.finished_at)}` : null}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <span className="hidden print:block">
                    <Logo />
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200 ring-inset dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/25">
                    <CheckCircle2 className="size-3.5" />
                    {report.status_label}
                  </span>
                  <span className="text-xs text-ink-subtle">{report.company_name}</span>
                </div>
              </div>

              <div className="mt-7 grid gap-5 sm:grid-cols-2">
                <Fact icon={Building2} label="Cliente">
                  {report.customer?.name ?? report.requester_name ?? "—"}
                  {report.requester_name && report.customer ? (
                    <span className="block text-xs text-ink-muted">Solicitante: {report.requester_name}</span>
                  ) : null}
                </Fact>
                <Fact icon={MapPin} label="Local do atendimento">
                  {place ? (
                    <>
                      {place.code ? <span className="mr-1 font-mono text-xs text-ink-subtle">{place.code}</span> : null}
                      {place.name}
                    </>
                  ) : (
                    "—"
                  )}
                  {address ? <span className="block text-xs text-ink-muted">{address}</span> : null}
                </Fact>
                <Fact icon={HardHat} label="Técnico responsável">
                  {report.technician?.name ?? "—"}
                </Fact>
                <Fact icon={Wrench} label="Serviço">
                  {report.service_type ?? "Atendimento técnico"}
                </Fact>
              </div>

              <div className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-4">
                {[
                  { label: "Agendado", value: report.scheduled_start ? formatDateTime(report.scheduled_start) : "—", icon: CalendarClock },
                  { label: "Chegada ao local", value: report.arrived_at ? formatDateTime(report.arrived_at) : "—", icon: Navigation },
                  { label: "Conclusão", value: report.finished_at ? formatDateTime(report.finished_at) : "—", icon: CheckCircle2 },
                  {
                    label: "Tempo no local",
                    value: report.on_site_minutes ? formatMinutes(report.on_site_minutes) : "—",
                    icon: Timer,
                  },
                ].map((s) => (
                  <div key={s.label} className="bg-surface px-4 py-3">
                    <p className="flex items-center gap-1.5 text-[11px] text-ink-subtle">
                      <s.icon className="size-3.5" />
                      {s.label}
                    </p>
                    <p className="mt-1 text-sm font-semibold text-ink tabular-nums">{s.value}</p>
                  </div>
                ))}
              </div>
              {report.check_in_gps ? (
                <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
                  <BadgeCheck className="size-3.5" />
                  Presença no local confirmada por GPS no check-in
                </p>
              ) : null}
            </div>

            {report.resolution_notes ? (
              <Section icon={CheckCircle2} title="O que foi feito">
                <div className="rounded-xl border-l-4 border-brand bg-brand-soft/60 px-4 py-3.5 text-sm leading-relaxed whitespace-pre-wrap text-ink">
                  {report.resolution_notes}
                </div>
              </Section>
            ) : null}

            {report.description ? (
              <Section icon={FileWarning} title="Problema relatado">
                <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink-muted">{report.description}</p>
              </Section>
            ) : null}

            {report.timeline.length ? (
              <Section icon={CalendarClock} title="Linha do tempo">
                <ol className="relative grid gap-4 sm:grid-cols-[repeat(auto-fit,minmax(130px,1fr))]">
                  {report.timeline.map((step, i) => (
                    <li key={`${step.label}-${i}`} className="relative flex gap-3 sm:block">
                      <span className="relative z-10 mt-1 flex size-3 shrink-0 items-center justify-center rounded-full bg-brand ring-4 ring-brand-soft sm:mt-0" />
                      <div className="sm:mt-3">
                        <p className="text-sm font-medium text-ink">{step.label}</p>
                        <p className="text-xs text-ink-muted tabular-nums">{formatDateTime(step.at)}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </Section>
            ) : null}

            {report.forms.map((form) => (
              <Section key={form.name} icon={ClipboardCheck} title={form.name}>
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
                        {item.photos.length === 0 ? (
                          <dd className="text-sm font-medium text-ink">{item.value || "—"}</dd>
                        ) : null}
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
                {form.completed_at ? (
                  <p className="mt-2 text-xs text-ink-subtle">Preenchido em {formatDateTime(form.completed_at)}</p>
                ) : null}
              </Section>
            ))}

            {report.photos.length ? (
              <Section icon={Images} title={`Evidências (${report.photos.length + formPhotos} fotos)`}>
                <PhotoGrid photos={report.photos} onOpen={setZoom} />
              </Section>
            ) : null}

            {report.signature ? (
              <Section icon={PenLine} title="Assinatura do responsável no local">
                <div className="flex flex-wrap items-end gap-6">
                  <div className="rounded-xl border border-line bg-white px-6 py-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={report.signature.image_url} alt={`Assinatura de ${report.signature.name}`} className="h-24 w-auto" />
                  </div>
                  <div className="text-sm">
                    <p className="font-semibold text-ink">{report.signature.name}</p>
                    {report.signature.role ? <p className="text-ink-muted">{report.signature.role}</p> : null}
                    <p className="mt-1 text-xs text-ink-subtle">Assinado no local em {formatDateTime(report.signature.signed_at)}</p>
                  </div>
                </div>
              </Section>
            ) : null}

            <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-surface-2/60 px-6 py-4 text-[11px] text-ink-subtle sm:px-8">
              <span>
                Relatório gerado em {formatDateTime(report.generated_at)} · {report.company?.name ?? report.company_name}
                {report.company?.phone ? ` · ${report.company.phone}` : ""}
                {report.company?.email ? ` · ${report.company.email}` : ""}
              </span>
              <span className="font-mono">{report.code}</span>
            </footer>
          </article>
        )}
        {report ? (
          <p className="mt-4 text-center text-xs text-ink-subtle print:hidden">
            Para guardar, use &quot;Baixar PDF&quot; e escolha &quot;Salvar como PDF&quot; na janela que abrir.
          </p>
        ) : null}
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
    </div>
  );
}
