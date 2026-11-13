/* eslint-disable jsx-a11y/alt-text -- <Image> do react-pdf não é <img> (não tem alt). */
import { Document, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { PublicReport, PublicReportPhoto } from "@/lib/types";

// PDF do relatório (gerado no navegador): mesma estrutura da página, em A4.
const C = {
  ink: "#1b1f26",
  muted: "#5d6676",
  subtle: "#7a8290",
  line: "#e5e7eb",
  soft: "#f4f5f7",
  brand: "#2447ff",
  brandSoft: "#eef1ff",
  green: "#047857",
  greenSoft: "#ecfdf5",
};

const s = StyleSheet.create({
  page: { paddingTop: 34, paddingBottom: 46, paddingHorizontal: 34, fontFamily: "Helvetica", fontSize: 9, color: C.ink },
  bar: { height: 3, backgroundColor: C.brand, marginBottom: 14, borderRadius: 2 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 },
  company: { fontSize: 13, fontFamily: "Helvetica-Bold" },
  small: { fontSize: 8, color: C.muted, marginTop: 2 },
  osLabel: { fontSize: 8, color: C.subtle, textAlign: "right" },
  osNumber: { fontSize: 18, fontFamily: "Helvetica-Bold", textAlign: "right" },
  pill: {
    marginTop: 4,
    alignSelf: "flex-end",
    backgroundColor: C.greenSoft,
    color: C.green,
    fontFamily: "Helvetica-Bold",
    fontSize: 8,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  section: { marginTop: 14 },
  sectionTitle: { fontSize: 10, fontFamily: "Helvetica-Bold", marginBottom: 6 },
  row: { flexDirection: "row", gap: 8 },
  card: { flex: 1, borderWidth: 1, borderColor: C.line, borderRadius: 6, padding: 9 },
  cardTitle: { fontSize: 7, color: C.subtle, textTransform: "uppercase", marginBottom: 4, letterSpacing: 0.5 },
  strong: { fontFamily: "Helvetica-Bold", fontSize: 10 },
  tile: { flex: 1, borderWidth: 1, borderColor: C.line, borderRadius: 6, paddingVertical: 7, paddingHorizontal: 9 },
  tileLabel: { fontSize: 7, color: C.subtle },
  tileValue: { fontSize: 10, fontFamily: "Helvetica-Bold", marginTop: 2 },
  solution: { backgroundColor: C.brandSoft, borderLeftWidth: 3, borderLeftColor: C.brand, padding: 9, borderRadius: 4, lineHeight: 1.45 },
  paragraph: { lineHeight: 1.45, color: C.muted },
  formRow: { flexDirection: "row", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: C.line, paddingVertical: 5 },
  formSection: { backgroundColor: C.soft, paddingVertical: 4, paddingHorizontal: 6, fontSize: 7, color: C.subtle, textTransform: "uppercase", marginTop: 4 },
  photos: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 5 },
  photo: { width: 166, height: 124, objectFit: "cover", borderRadius: 4, borderWidth: 1, borderColor: C.line },
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

const fmt = (value: string | null | undefined, withTime = true) => {
  if (!value) return "—";
  const d = new Date(value);
  const date = d.toLocaleDateString("pt-BR");
  return withTime ? `${date} ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}` : date;
};
const time = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "—";
const minutes = (m: number | null | undefined) => {
  if (!m) return "—";
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, "0")}min` : `${m}min`;
};

function Photos({ photos }: { photos: PublicReportPhoto[] }) {
  return (
    <View style={s.photos}>
      {photos.map((p, i) => (
        <View key={`${p.url}-${i}`} style={{ width: 166 }} wrap={false}>
          <Image src={p.url} style={s.photo} />
          {p.caption ? <Text style={{ fontSize: 7, color: C.muted, marginTop: 2 }}>{p.caption}</Text> : null}
        </View>
      ))}
    </View>
  );
}

export function ReportPdf({ report }: { report: PublicReport }) {
  const company = report.company;
  const loc = report.location;
  const address =
    report.service_address ||
    [loc?.address, [loc?.city, loc?.state].filter(Boolean).join("-"), loc?.zip_code].filter(Boolean).join(", ") ||
    "—";
  const number = report.number !== undefined ? String(report.number).padStart(6, "0") : report.code;
  return (
    <Document title={`Relatório ${report.code}`} author={company?.name ?? report.company_name} subject={report.title}>
      <Page size="A4" style={s.page}>
        <View style={s.bar} fixed />
        <View style={s.header}>
          <View style={{ maxWidth: 300 }}>
            <Text style={s.company}>{company?.name ?? report.company_name}</Text>
            {company?.email || company?.phone ? (
              <Text style={s.small}>{[company?.email, company?.phone].filter(Boolean).join("  ·  ")}</Text>
            ) : null}
            {company?.address ? <Text style={s.small}>{company.address}</Text> : null}
          </View>
          <View>
            <Text style={s.osLabel}>Relatório de atendimento · OS</Text>
            <Text style={s.osNumber}>{number}</Text>
            {report.service_type ? <Text style={[s.small, { textAlign: "right" }]}>{report.service_type}</Text> : null}
            <Text style={s.pill}>{report.status_label}</Text>
          </View>
        </View>

        <Text style={{ fontSize: 14, fontFamily: "Helvetica-Bold" }}>{report.title}</Text>
        <Text style={s.small}>OS aberta em {fmt(report.opened_at)}</Text>

        <View style={[s.section, s.row]}>
          <View style={s.card}>
            <Text style={s.cardTitle}>Cliente</Text>
            <Text style={s.strong}>{report.customer?.name ?? report.requester_name ?? "—"}</Text>
            {report.customer?.document ? <Text style={s.small}>CPF/CNPJ: {report.customer.document}</Text> : null}
            {report.customer?.phone ? <Text style={s.small}>Telefone: {report.customer.phone}</Text> : null}
            {report.customer?.email ? <Text style={s.small}>E-mail: {report.customer.email}</Text> : null}
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

        <View style={s.section}>
          <Text style={s.sectionTitle}>Atendimento</Text>
          <View style={s.row}>
            <View style={s.tile}>
              <Text style={s.tileLabel}>Técnico</Text>
              <Text style={s.tileValue}>{report.technician?.name ?? "—"}</Text>
              {report.helpers?.length ? (
                <Text style={s.tileLabel}>com {report.helpers.map((h) => h.name).join(", ")}</Text>
              ) : null}
            </View>
            <View style={s.tile}>
              <Text style={s.tileLabel}>Data</Text>
              <Text style={s.tileValue}>{fmt(report.arrived_at ?? report.scheduled_start ?? report.finished_at, false)}</Text>
            </View>
            <View style={s.tile}>
              <Text style={s.tileLabel}>Início</Text>
              <Text style={s.tileValue}>{time(report.arrived_at)}</Text>
            </View>
            <View style={s.tile}>
              <Text style={s.tileLabel}>Fim</Text>
              <Text style={s.tileValue}>{time(report.finished_at)}</Text>
            </View>
            <View style={s.tile}>
              <Text style={s.tileLabel}>Tempo no local</Text>
              <Text style={s.tileValue}>{minutes(report.on_site_minutes)}</Text>
            </View>
          </View>
          {report.arrival_minutes != null ? (
            <Text style={[s.small, { color: report.arrival_on_time === false ? "#b45309" : C.green }]}>
              Técnico chegou em {minutes(report.arrival_minutes)}
              {report.arrival_on_time ? " (dentro do prazo)" : report.arrival_on_time === false ? " (fora do prazo)" : ""}.
            </Text>
          ) : null}
          {report.check_in_gps ? (
            <Text style={[s.small, { color: C.green }]}>Presença no local confirmada por GPS no check-in.</Text>
          ) : null}
        </View>

        {report.resolution_notes ? (
          <View style={s.section} wrap={false}>
            <Text style={s.sectionTitle}>Solução aplicada</Text>
            <Text style={s.solution}>{report.resolution_notes}</Text>
          </View>
        ) : null}

        {report.description ? (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Descrição do serviço</Text>
            <Text style={s.paragraph}>{report.description}</Text>
          </View>
        ) : null}

        {report.timeline.length ? (
          <View style={s.section} wrap={false}>
            <Text style={s.sectionTitle}>Linha do tempo</Text>
            <View style={s.timeline}>
              {report.timeline.map((step, i) => (
                <View key={i} style={s.step}>
                  <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 8 }}>{step.label}</Text>
                  <Text style={s.small}>{fmt(step.at)}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {report.forms.map((form) => (
          <View key={form.name} style={s.section}>
            <Text style={s.sectionTitle}>{form.name}</Text>
            {form.items.map((item, i) =>
              item.type === "section" ? (
                <Text key={i} style={s.formSection}>
                  {item.label}
                </Text>
              ) : (
                <View key={i} wrap={false}>
                  <View style={s.formRow}>
                    <Text style={{ color: C.muted, maxWidth: 330 }}>{item.label}</Text>
                    {item.photos.length === 0 ? <Text style={{ fontFamily: "Helvetica-Bold" }}>{item.value || "—"}</Text> : null}
                  </View>
                  {item.photos.length ? <Photos photos={item.photos} /> : null}
                </View>
              ),
            )}
            {form.completed_at ? <Text style={s.small}>Preenchido em {fmt(form.completed_at)}</Text> : null}
          </View>
        ))}

        {report.photos.length ? (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Evidências</Text>
            <Photos photos={report.photos} />
          </View>
        ) : null}

        {report.signature ? (
          <View style={s.section} wrap={false}>
            <Text style={s.sectionTitle}>Assinatura do responsável no local</Text>
            <View style={[s.row, { alignItems: "flex-end" }]}>
              {report.signature.image_url ? (
                <Image src={report.signature.image_url} style={{ width: 170, height: 70, objectFit: "contain", borderBottomWidth: 1, borderBottomColor: C.ink }} />
              ) : null}
              <View>
                <Text style={s.strong}>{report.signature.name ?? "—"}</Text>
                {report.signature.role ? <Text style={s.small}>{report.signature.role}</Text> : null}
                <Text style={s.small}>Assinado no local em {fmt(report.signature.signed_at)}</Text>
              </View>
            </View>
          </View>
        ) : null}

        <View style={s.footer} fixed>
          <Text>
            {report.code} · gerado em {fmt(report.generated_at)} · {company?.name ?? report.company_name}
          </Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber}/${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
