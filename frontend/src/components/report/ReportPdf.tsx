/* eslint-disable jsx-a11y/alt-text -- <Image> do react-pdf não é <img> (não tem alt). */
import { Document, Font, Image, Page, pdf, StyleSheet, Text, View } from "@react-pdf/renderer";
import { formatDocument } from "@/lib/format";
import type { PublicReport, PublicReportPhoto } from "@/lib/types";
import { brandMark, prepareImages, saveBlob } from "./pdfAssets";
import {
  brDate,
  brDateTime,
  brShort,
  brTime,
  captionText,
  FILE_KIND_LABEL,
  fileKind,
  groupByPhase,
  PHASE_LABEL,
  progressLine,
  progressSteps,
  reportStage,
} from "./shared";

// Palavras inteiras: a hifenização padrão do react-pdf segue o inglês e partia o português nos quadros estreitos.
Font.registerHyphenationCallback((word) => [word]);

// PDF do relatório (gerado no navegador): mesma estrutura da página, em A4.
const C = {
  ink: "#1b1f26",
  muted: "#525a68",
  subtle: "#687080",
  line: "#e5e7eb",
  soft: "#f4f5f7",
  brand: "#2447ff",
  brandSoft: "#eef1ff",
  green: "#047857",
  greenSoft: "#ecfdf5",
  red: "#b42318",
  redSoft: "#fef3f2",
  amber: "#b45309",
};

const s = StyleSheet.create({
  page: { paddingTop: 34, paddingBottom: 46, paddingHorizontal: 34, fontFamily: "Helvetica", fontSize: 9, color: C.ink },
  bar: { height: 3, backgroundColor: C.brand, marginBottom: 14, borderRadius: 2 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 16 },
  brand: { flexDirection: "row", alignItems: "center", gap: 10, maxWidth: 320 },
  mark: { width: 40, height: 20, objectFit: "contain" },
  company: { fontSize: 13, fontFamily: "Helvetica-Bold" },
  small: { fontSize: 8, color: C.muted, marginTop: 2 },
  osLabel: { fontSize: 8, color: C.subtle, textAlign: "right" },
  osNumber: { fontSize: 18, fontFamily: "Helvetica-Bold", textAlign: "right" },
  pill: {
    marginTop: 4,
    alignSelf: "flex-end",
    fontFamily: "Helvetica-Bold",
    fontSize: 8,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  section: { marginTop: 14 },
  sectionTitle: { fontSize: 10, fontFamily: "Helvetica-Bold", marginBottom: 6 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 },
  chip: { fontSize: 7, color: C.muted, backgroundColor: C.soft, paddingVertical: 2, paddingHorizontal: 6, borderRadius: 6 },
  row: { flexDirection: "row", gap: 8 },
  card: { flex: 1, borderWidth: 1, borderColor: C.line, borderRadius: 6, padding: 9 },
  cardTitle: { fontSize: 7, color: C.subtle, textTransform: "uppercase", marginBottom: 4, letterSpacing: 0.5 },
  strong: { fontFamily: "Helvetica-Bold", fontSize: 10 },
  tile: { flex: 1, borderWidth: 1, borderColor: C.line, borderRadius: 6, paddingVertical: 7, paddingHorizontal: 9 },
  tileLabel: { fontSize: 7, color: C.subtle },
  tileValue: { fontSize: 10, fontFamily: "Helvetica-Bold", marginTop: 2 },
  solution: { backgroundColor: C.brandSoft, borderLeftWidth: 3, borderLeftColor: C.brand, padding: 9, borderRadius: 4, lineHeight: 1.45 },
  paragraph: { lineHeight: 1.45, color: C.muted },
  notice: { backgroundColor: C.soft, borderRadius: 6, padding: 9, color: C.muted, fontFamily: "Helvetica-Bold" },
  progress: { borderWidth: 1, borderColor: C.line, borderRadius: 6, padding: 9, marginBottom: 8 },
  progressLine: { fontFamily: "Helvetica-Bold", fontSize: 9, marginBottom: 7 },
  steps: { flexDirection: "row", gap: 6 },
  stepDone: { flex: 1, borderTopWidth: 2, borderTopColor: C.brand, paddingTop: 4 },
  stepNext: { flex: 1, borderTopWidth: 2, borderTopColor: C.line, paddingTop: 4, color: C.subtle },
  formRow: { flexDirection: "row", gap: 12, borderBottomWidth: 1, borderBottomColor: C.line, paddingVertical: 5 },
  formLabel: { width: "45%", color: C.muted },
  formValue: { flex: 1, textAlign: "right", fontFamily: "Helvetica-Bold" },
  formStacked: { borderBottomWidth: 1, borderBottomColor: C.line, paddingVertical: 5 },
  formValueStacked: { marginTop: 2, fontFamily: "Helvetica-Bold", lineHeight: 1.4 },
  formSection: { backgroundColor: C.soft, paddingVertical: 4, paddingHorizontal: 6, fontSize: 7, color: C.subtle, textTransform: "uppercase", marginTop: 4 },
  group: { fontSize: 8, fontFamily: "Helvetica-Bold", color: C.muted, marginTop: 6 },
  photos: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 5 },
  photoBox: { width: 166 },
  photo: { width: 166, height: 124, objectFit: "cover", borderRadius: 4, borderWidth: 1, borderColor: C.line },
  missing: { width: 166, height: 124, borderRadius: 4, borderWidth: 1, borderColor: C.line, backgroundColor: C.soft, justifyContent: "center", padding: 10 },
  missingText: { fontSize: 7, color: C.muted, textAlign: "center" },
  caption: { fontSize: 7, color: C.ink, marginTop: 2 },
  captionTime: { fontSize: 6.5, color: C.subtle, marginTop: 1 },
  timeline: { flexDirection: "row", gap: 6 },
  step: { flex: 1, borderTopWidth: 2, borderTopColor: C.brand, paddingTop: 4 },
  footer: {
    position: "absolute",
    bottom: 20,
    left: 34,
    right: 34,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7,
    color: C.subtle,
    borderTopWidth: 1,
    borderTopColor: C.line,
    paddingTop: 6,
  },
});

const minutes = (m: number | null | undefined) => {
  if (!m) return "—";
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, "0")}min` : `${m}min`;
};

/** Fotos já preparadas (reduzidas, em JPEG): url -> data URL, ou null quando não deu para ler. */
export type PdfImages = Map<string, string | null>;

function source(url: string, images: PdfImages | undefined): string | null {
  if (!images) return url;
  return images.get(url) ?? null;
}

function Photos({ photos, images, grouped = false }: { photos: PublicReportPhoto[]; images?: PdfImages; grouped?: boolean }) {
  return (
    <View style={s.photos}>
      {photos.map((p, i) => {
        const kind = fileKind(p.filename);
        const src = kind === "image" ? source(p.url, images) : null;
        // Dentro do grupo "Antes"/"Depois" o marcador da legenda já está no título do grupo.
        const caption = grouped ? captionText(p.caption) : (p.caption ?? "").trim();
        return (
          <View key={`${p.url}-${i}`} style={s.photoBox} wrap={false}>
            {src ? (
              <Image src={src} style={s.photo} />
            ) : (
              <View style={s.missing}>
                <Text style={s.missingText}>
                  {kind === "image" ? "Foto disponível no link do relatório" : `${FILE_KIND_LABEL[kind]} disponível no link do relatório`}
                </Text>
              </View>
            )}
            {caption ? <Text style={s.caption}>{caption}</Text> : null}
            {p.taken_at ? <Text style={s.captionTime}>{brDateTime(p.taken_at)}</Text> : null}
          </View>
        );
      })}
    </View>
  );
}

/** Rótulo e cor da situação: verde só concluída; cancelada em vermelho; em andamento, neutro. */
function statusPill(report: PublicReport) {
  const stage = reportStage(report.status);
  if (stage === "done") return { label: "Concluído", color: C.green, backgroundColor: C.greenSoft };
  if (stage === "cancelled") return { label: "Cancelado", color: C.red, backgroundColor: C.redSoft };
  return { label: `Em andamento · ${report.status_label}`, color: C.muted, backgroundColor: C.soft };
}

export function ReportPdf({ report, images, logo = null }: { report: PublicReport; images?: PdfImages; logo?: string | null }) {
  const company = report.company;
  const companyName = company?.name ?? report.company_name;
  const loc = report.location;
  const address =
    report.service_address ||
    [loc?.address, [loc?.city, loc?.state].filter(Boolean).join("-"), loc?.zip_code].filter(Boolean).join(", ") ||
    "—";
  const number = report.number !== undefined ? String(report.number).padStart(6, "0") : report.code;
  const stage = reportStage(report.status);
  const pill = statusPill(report);
  // Antes de o técnico chegar, os quadros de horário ficariam vazios: entra o andamento no lugar.
  const showTiles = stage === "done" || (stage === "progress" && Boolean(report.arrived_at));
  const signature = report.signature?.image_url ? source(report.signature.image_url, images) : null;
  return (
    <Document title={`Relatório ${report.code}`} author={companyName} subject={report.title} language="pt-BR">
      <Page size="A4" style={s.page}>
        <View style={s.bar} fixed />
        <View style={s.header}>
          <View style={s.brand}>
            {logo ? <Image src={logo} style={s.mark} /> : null}
            <View>
              <Text style={s.company}>{companyName}</Text>
              {company?.email || company?.phone ? (
                <Text style={s.small}>{[company?.email, company?.phone].filter(Boolean).join("  ·  ")}</Text>
              ) : null}
              {company?.address ? <Text style={s.small}>{company.address}</Text> : null}
            </View>
          </View>
          <View>
            <Text style={s.osLabel}>Relatório de atendimento · OS</Text>
            <Text style={s.osNumber}>{number}</Text>
            {report.service_type ? <Text style={{ ...s.small, textAlign: "right" }}>{report.service_type}</Text> : null}
            <Text style={{ ...s.pill, color: pill.color, backgroundColor: pill.backgroundColor }}>{pill.label}</Text>
          </View>
        </View>

        <Text style={{ fontSize: 14, fontFamily: "Helvetica-Bold" }}>{report.title}</Text>
        <Text style={s.small}>OS aberta em {brDateTime(report.opened_at)} (horário de Brasília)</Text>

        <View style={{ ...s.section, ...s.row }}>
          <View style={s.card}>
            <Text style={s.cardTitle}>Cliente</Text>
            <Text style={s.strong}>{report.customer?.name ?? report.requester_name ?? "—"}</Text>
            {report.customer?.document ? <Text style={s.small}>CPF/CNPJ: {formatDocument(report.customer.document)}</Text> : null}
            {report.customer?.phone ? <Text style={s.small}>Telefone: {report.customer.phone}</Text> : null}
            {report.customer?.email ? <Text style={s.small}>E-mail: {report.customer.email}</Text> : null}
            {report.requester_name && report.customer ? <Text style={s.small}>Solicitante: {report.requester_name}</Text> : null}
          </View>
          <View style={s.card}>
            <Text style={s.cardTitle}>Local do atendimento</Text>
            <Text style={s.strong}>{loc ? `${loc.code ? `${loc.code} - ` : ""}${loc.name}` : "—"}</Text>
            <Text style={s.small}>{address}</Text>
            {loc?.contact_name ? (
              <Text style={s.small}>
                Contato: {loc.contact_name}
                {loc.contact_phone ? ` · ${loc.contact_phone}` : ""}
              </Text>
            ) : null}
          </View>
        </View>

        {report.description ? (
          <View style={s.section}>
            <Text style={s.sectionTitle} minPresenceAhead={40}>
              Descrição do serviço
            </Text>
            <Text style={s.paragraph}>{report.description}</Text>
          </View>
        ) : null}

        <View style={s.section}>
          <Text style={s.sectionTitle} minPresenceAhead={80}>
            Atendimento
          </Text>
          {stage === "cancelled" ? <Text style={s.notice}>Este atendimento foi cancelado.</Text> : null}
          {stage === "progress" ? (
            <View style={s.progress} wrap={false}>
              <Text style={s.progressLine}>{progressLine(report)}</Text>
              <View style={s.steps}>
                {progressSteps(report).map((step) => (
                  <View key={step.label} style={step.state === "next" ? s.stepNext : s.stepDone}>
                    <Text style={{ fontFamily: step.state === "current" ? "Helvetica-Bold" : "Helvetica", fontSize: 8 }}>{step.label}</Text>
                    {step.at ? <Text style={s.small}>{brShort(step.at)}</Text> : null}
                  </View>
                ))}
              </View>
            </View>
          ) : null}
          {stage !== "cancelled" ? (
            <View style={s.row} wrap={false}>
              <View style={s.tile}>
                <Text style={s.tileLabel}>Técnico</Text>
                <Text style={s.tileValue}>{report.technician?.name ?? "—"}</Text>
                {report.helpers?.length ? <Text style={s.tileLabel}>com {report.helpers.map((h) => h.name).join(", ")}</Text> : null}
              </View>
              {showTiles ? (
                <>
                  <View style={s.tile}>
                    <Text style={s.tileLabel}>Data</Text>
                    <Text style={s.tileValue}>{brDate(report.arrived_at ?? report.scheduled_start ?? report.finished_at)}</Text>
                  </View>
                  <View style={s.tile}>
                    <Text style={s.tileLabel}>Início</Text>
                    <Text style={s.tileValue}>{brTime(report.arrived_at)}</Text>
                  </View>
                  <View style={s.tile}>
                    <Text style={s.tileLabel}>Fim</Text>
                    <Text style={s.tileValue}>{brTime(report.finished_at)}</Text>
                  </View>
                  <View style={s.tile}>
                    <Text style={s.tileLabel}>Tempo no local</Text>
                    <Text style={s.tileValue}>{minutes(report.on_site_minutes)}</Text>
                  </View>
                </>
              ) : null}
            </View>
          ) : null}
          {stage !== "cancelled" && report.arrival_minutes != null ? (
            <Text style={{ ...s.small, color: report.arrival_on_time === false ? C.amber : C.green }}>
              Técnico chegou em {minutes(report.arrival_minutes)}
              {report.arrival_on_time ? " (dentro do prazo)" : report.arrival_on_time === false ? " (fora do prazo)" : ""}.
            </Text>
          ) : null}
          {stage !== "cancelled" && report.check_in_gps ? (
            <Text style={{ ...s.small, color: C.green }}>Presença no local confirmada por GPS no check-in.</Text>
          ) : null}
        </View>

        {report.resolution_notes ? (
          <View style={s.section} wrap={false}>
            <Text style={s.sectionTitle}>Solução aplicada</Text>
            <Text style={s.solution}>{report.resolution_notes}</Text>
          </View>
        ) : null}

        {report.timeline.length ? (
          <View style={s.section} wrap={false}>
            <Text style={s.sectionTitle}>Linha do tempo (horário de Brasília)</Text>
            <View style={s.timeline}>
              {report.timeline.map((step, i) => (
                <View key={i} style={s.step}>
                  <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 8 }}>{step.label}</Text>
                  <Text style={s.small}>{brDateTime(step.at)}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {report.forms.map((form, index) => (
          <View key={`${form.name}-${index}`} style={s.section}>
            <View style={s.titleRow} minPresenceAhead={80}>
              <Text style={{ fontSize: 10, fontFamily: "Helvetica-Bold" }}>{form.name}</Text>
              {form.completed_at ? null : <Text style={s.chip}>Em preenchimento</Text>}
            </View>
            {form.items.map((item, i) => {
              if (item.type === "section") {
                return (
                  <Text key={i} style={s.formSection} minPresenceAhead={40}>
                    {item.label}
                  </Text>
                );
              }
              // Resposta longa embaixo do rótulo; curta, alinhada à direita na mesma linha.
              const long = (item.value ?? "").length > 60;
              return (
                <View key={i} wrap={false}>
                  {item.photos.length === 0 && long ? (
                    <View style={s.formStacked}>
                      <Text style={{ color: C.muted }}>{item.label}</Text>
                      <Text style={s.formValueStacked}>{item.value}</Text>
                    </View>
                  ) : (
                    <View style={s.formRow}>
                      <Text style={s.formLabel}>{item.label}</Text>
                      {item.photos.length === 0 ? <Text style={s.formValue}>{item.value || "—"}</Text> : null}
                    </View>
                  )}
                  {item.photos.length ? <Photos photos={item.photos} images={images} /> : null}
                </View>
              );
            })}
            {form.completed_at ? <Text style={s.small}>Preenchido em {brDateTime(form.completed_at)}</Text> : null}
          </View>
        ))}

        {report.photos.length ? (
          <View style={s.section}>
            <Text style={s.sectionTitle} minPresenceAhead={130}>
              Evidências · {report.photos.length} {report.photos.length === 1 ? "foto" : "fotos"}
            </Text>
            {groupByPhase(report.photos).map((group) => (
              <View key={group.phase ?? "outras"}>
                {group.phase ? (
                  <Text style={s.group} minPresenceAhead={130}>
                    {PHASE_LABEL[group.phase]}
                  </Text>
                ) : null}
                <Photos photos={group.photos} images={images} grouped={group.phase !== null} />
              </View>
            ))}
          </View>
        ) : null}

        {report.signature ? (
          <View style={s.section} wrap={false}>
            <Text style={s.sectionTitle}>Assinatura do responsável no local</Text>
            <View style={{ ...s.row, alignItems: "flex-end" }}>
              {signature ? (
                <Image src={signature} style={{ width: 170, height: 70, objectFit: "contain", borderBottomWidth: 1, borderBottomColor: C.ink }} />
              ) : null}
              <View>
                <Text style={s.strong}>{report.signature.name ?? "—"}</Text>
                {report.signature.role ? <Text style={s.small}>{report.signature.role}</Text> : null}
                <Text style={s.small}>Assinado no local em {brDateTime(report.signature.signed_at)}</Text>
              </View>
            </View>
          </View>
        ) : null}

        <View style={s.footer} fixed>
          <Text>
            {report.code} · gerado em {brDateTime(report.generated_at)} · {companyName}
          </Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber}/${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

/** Fotos do relatório que entram no PDF (só imagens; PDF, vídeo e HEIC viram aviso). */
function pdfPhotoUrls(report: PublicReport): string[] {
  const photos = [...report.forms.flatMap((f) => f.items.flatMap((i) => i.photos)), ...report.photos];
  const urls = photos.filter((p) => fileKind(p.filename) === "image").map((p) => p.url);
  if (report.signature?.image_url) urls.push(report.signature.image_url);
  return urls;
}

/** Gera e baixa o PDF: prepara as fotos (avisando o progresso) e monta o documento. */
export async function downloadReportPdf(report: PublicReport, onProgress?: (done: number, total: number) => void) {
  const [images, logo] = await Promise.all([prepareImages(pdfPhotoUrls(report), onProgress), brandMark()]);
  const blob = await pdf(<ReportPdf report={report} images={images} logo={logo} />).toBlob();
  saveBlob(blob, `Relatorio-${report.code}.pdf`);
}
