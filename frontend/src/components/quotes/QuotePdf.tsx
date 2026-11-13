/* eslint-disable jsx-a11y/alt-text -- <Image> do react-pdf não é <img> (não tem alt). */
import { Document, Font, Image, Page, pdf, StyleSheet, Text, View } from "@react-pdf/renderer";
import { brandMark, imageDataUrl, saveBlob } from "@/components/report/pdfAssets";
import { brDateTime } from "@/components/report/shared";
import { formatDate, formatDocument, formatMoney } from "@/lib/format";
import { QUOTE_KIND, totalsByKind } from "@/lib/quotes";
import type { PublicQuote, QuoteItemKind, QuoteStatus } from "@/lib/types";

// Palavras inteiras: a hifenização padrão do react-pdf segue o inglês e partia o português.
Font.registerHyphenationCallback((word) => [word]);

// PDF do orçamento (gerado no navegador), na mesma linguagem do relatório de atendimento.
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
};

const STATUS: Record<QuoteStatus, { label: string; color: string; backgroundColor: string }> = {
  draft: { label: "Em revisão", color: C.muted, backgroundColor: C.soft },
  sent: { label: "Aguardando aprovação", color: C.brand, backgroundColor: C.brandSoft },
  approved: { label: "Aprovado", color: C.green, backgroundColor: C.greenSoft },
  rejected: { label: "Recusado", color: C.red, backgroundColor: C.redSoft },
  expired: { label: "Vencido", color: C.red, backgroundColor: C.redSoft },
  cancelled: { label: "Cancelado", color: C.muted, backgroundColor: C.soft },
};

const s = StyleSheet.create({
  page: { paddingTop: 34, paddingBottom: 46, paddingHorizontal: 34, fontFamily: "Helvetica", fontSize: 9, color: C.ink },
  bar: { height: 3, backgroundColor: C.brand, marginBottom: 14, borderRadius: 2 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 16 },
  brand: { flexDirection: "row", alignItems: "center", gap: 10, maxWidth: 320 },
  mark: { width: 40, height: 20, objectFit: "contain" },
  company: { fontSize: 13, fontFamily: "Helvetica-Bold" },
  small: { fontSize: 8, color: C.muted, marginTop: 2 },
  label: { fontSize: 8, color: C.subtle, textAlign: "right" },
  code: { fontSize: 18, fontFamily: "Helvetica-Bold", textAlign: "right" },
  pill: { marginTop: 4, alignSelf: "flex-end", fontFamily: "Helvetica-Bold", fontSize: 8, paddingVertical: 3, paddingHorizontal: 8, borderRadius: 8 },
  section: { marginTop: 14 },
  sectionTitle: { fontSize: 10, fontFamily: "Helvetica-Bold", marginBottom: 6 },
  row: { flexDirection: "row", gap: 8 },
  card: { flex: 1, borderWidth: 1, borderColor: C.line, borderRadius: 6, padding: 9 },
  cardTitle: { fontSize: 7, color: C.subtle, textTransform: "uppercase", marginBottom: 4, letterSpacing: 0.5 },
  strong: { fontFamily: "Helvetica-Bold", fontSize: 10 },
  kind: { flexDirection: "row", justifyContent: "space-between", marginTop: 8, marginBottom: 3 },
  kindLabel: { fontSize: 7, fontFamily: "Helvetica-Bold", color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 },
  table: { borderWidth: 1, borderColor: C.line, borderRadius: 6 },
  head: { flexDirection: "row", backgroundColor: C.soft, paddingVertical: 4, paddingHorizontal: 8 },
  headCell: { fontSize: 7, color: C.subtle, fontFamily: "Helvetica-Bold", textTransform: "uppercase" },
  line: { flexDirection: "row", paddingVertical: 5, paddingHorizontal: 8, borderTopWidth: 1, borderTopColor: C.line },
  colItem: { flex: 1, paddingRight: 8 },
  colQty: { width: 62, textAlign: "right" },
  colPrice: { width: 78, textAlign: "right" },
  colTotal: { width: 78, textAlign: "right" },
  totals: { marginTop: 10, alignSelf: "flex-end", width: 220, backgroundColor: C.soft, borderRadius: 6, padding: 9 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 2 },
  grandTotal: { flexDirection: "row", justifyContent: "space-between", marginTop: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: C.line },
  paragraph: { lineHeight: 1.45, color: C.muted },
  decision: { borderWidth: 1, borderColor: C.line, borderRadius: 6, padding: 9 },
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

const qty = (value: number) => value.toLocaleString("pt-BR", { maximumFractionDigits: 3 });

function Decision({ quote, signature }: { quote: PublicQuote; signature: string | null }) {
  if (quote.status === "approved") {
    return (
      <View style={{ ...s.decision, borderColor: "#a7f3d0" }} wrap={false}>
        <Text style={{ ...s.strong, color: C.green }}>
          Aprovado por {quote.approver_name ?? "cliente"} em {brDateTime(quote.decided_at)} (horário de Brasília)
        </Text>
        {quote.approver_registration ? <Text style={s.small}>Matrícula: {quote.approver_registration}</Text> : null}
        {signature ? (
          <Image src={signature} style={{ marginTop: 8, width: 190, height: 72, objectFit: "contain", borderBottomWidth: 1, borderBottomColor: C.ink }} />
        ) : null}
        {quote.client_comment ? <Text style={{ ...s.small, marginTop: 6 }}>Comentário: “{quote.client_comment}”</Text> : null}
        <Text style={{ ...s.small, marginTop: 6 }}>
          Aprovação eletrônica pelo link do orçamento, com registro de nome, assinatura, data, hora e endereço IP.
        </Text>
      </View>
    );
  }
  if (quote.status === "rejected") {
    return (
      <View style={{ ...s.decision, borderColor: "#fecdca" }} wrap={false}>
        <Text style={{ ...s.strong, color: C.red }}>
          Recusado{quote.approver_name ? ` por ${quote.approver_name}` : ""} em {brDateTime(quote.decided_at)} (horário de Brasília)
        </Text>
        {quote.rejection_reason ? <Text style={{ ...s.paragraph, marginTop: 4 }}>Motivo: {quote.rejection_reason}</Text> : null}
        {quote.client_comment ? <Text style={{ ...s.small, marginTop: 4 }}>Comentário: “{quote.client_comment}”</Text> : null}
      </View>
    );
  }
  const text: Partial<Record<QuoteStatus, string>> = {
    draft: "Orçamento em revisão pela empresa: os itens e valores podem mudar até o novo envio.",
    sent: "Para aprovar (com nome e assinatura) ou recusar, use o link do orçamento enviado pela empresa.",
    expired: `Este orçamento venceu${quote.valid_until ? ` em ${formatDate(quote.valid_until)}` : ""}. Peça uma versão atualizada à empresa.`,
    cancelled: "Orçamento cancelado pela empresa.",
  };
  return (
    <View style={s.decision} wrap={false}>
      <Text style={s.paragraph}>{text[quote.status]}</Text>
    </View>
  );
}

export function QuotePdf({
  quote,
  logo = null,
  signature = null,
  generatedAt,
}: {
  quote: PublicQuote;
  logo?: string | null;
  signature?: string | null;
  /** Momento da geração (vai no rodapé). */
  generatedAt: string;
}) {
  const company = quote.company;
  const companyName = company?.name ?? "Maxx Field";
  const customer = quote.customer_info ?? (quote.customer ? { name: quote.customer, document: null, email: null, phone: null } : null);
  const totals = totalsByKind(quote.items, quote.totals_by_kind);
  const kinds = (Object.keys(QUOTE_KIND) as QuoteItemKind[]).filter((k) => quote.items.some((i) => (i.kind ?? "product") === k));
  // "OS 000123" (número da OS) ou o código ("OS-000123") quando o número não veio.
  const ticket = quote.ticket_number !== undefined ? `OS ${String(quote.ticket_number).padStart(6, "0")}` : quote.ticket_code;
  const status = STATUS[quote.status];
  return (
    <Document title={`Orçamento ${quote.code}`} author={companyName} subject={quote.title} language="pt-BR">
      <Page size="A4" style={s.page}>
        <View style={s.bar} fixed />
        <View style={s.header}>
          <View style={s.brand}>
            {logo ? <Image src={logo} style={s.mark} /> : null}
            <View>
              <Text style={s.company}>{companyName}</Text>
              {company?.document ? <Text style={s.small}>CNPJ: {formatDocument(company.document)}</Text> : null}
              {company?.email || company?.phone ? (
                <Text style={s.small}>{[company?.email, company?.phone].filter(Boolean).join("  ·  ")}</Text>
              ) : null}
              {company?.address ? <Text style={s.small}>{company.address}</Text> : null}
            </View>
          </View>
          <View>
            <Text style={s.label}>Orçamento · {ticket}</Text>
            <Text style={s.code}>{quote.code}</Text>
            <Text style={{ ...s.pill, color: status.color, backgroundColor: status.backgroundColor }}>{status.label}</Text>
          </View>
        </View>

        <Text style={{ fontSize: 14, fontFamily: "Helvetica-Bold" }}>{quote.title}</Text>
        <Text style={s.small}>
          Referente à {quote.ticket_code}
          {quote.ticket_title ? ` · ${quote.ticket_title}` : ""}
        </Text>
        <Text style={s.small}>
          Emitido em {formatDate(quote.issued_at ?? quote.sent_at)}
          {quote.valid_until ? ` · Válido até ${formatDate(quote.valid_until)}` : ""}
        </Text>

        <View style={{ ...s.section, ...s.row }}>
          <View style={s.card}>
            <Text style={s.cardTitle}>Cliente</Text>
            <Text style={s.strong}>{customer?.name ?? "—"}</Text>
            {quote.location ? <Text style={s.small}>{quote.location}</Text> : null}
            {customer?.document ? <Text style={s.small}>CPF/CNPJ: {formatDocument(customer.document)}</Text> : null}
            {customer?.email ? <Text style={s.small}>E-mail: {customer.email}</Text> : null}
            {customer?.phone ? <Text style={s.small}>Telefone: {customer.phone}</Text> : null}
          </View>
          <View style={s.card}>
            <Text style={s.cardTitle}>Endereço do atendimento</Text>
            <Text style={{ lineHeight: 1.4 }}>{quote.address?.full ?? quote.location ?? "—"}</Text>
          </View>
        </View>

        <View style={s.section}>
          <Text style={s.sectionTitle} minPresenceAhead={80}>
            Itens
          </Text>
          {kinds.length === 0 ? <Text style={s.paragraph}>Sem itens.</Text> : null}
          {kinds.map((kind) => {
            const items = quote.items.filter((i) => (i.kind ?? "product") === kind);
            return (
              <View key={kind}>
                <View style={s.kind} minPresenceAhead={60}>
                  <Text style={s.kindLabel}>
                    {QUOTE_KIND[kind].plural} · {items.length}
                  </Text>
                  <Text style={s.kindLabel}>{formatMoney(totals[kind])}</Text>
                </View>
                <View style={s.table}>
                  <View style={s.head}>
                    <Text style={{ ...s.headCell, ...s.colItem }}>Item</Text>
                    <Text style={{ ...s.headCell, ...s.colQty }}>Qtd.</Text>
                    <Text style={{ ...s.headCell, ...s.colPrice }}>Valor unit.</Text>
                    <Text style={{ ...s.headCell, ...s.colTotal }}>Total</Text>
                  </View>
                  {items.map((item, i) => (
                    <View key={i} style={s.line} wrap={false}>
                      <Text style={s.colItem}>{item.description}</Text>
                      <Text style={s.colQty}>
                        {qty(item.quantity)} {item.unit}
                      </Text>
                      <Text style={s.colPrice}>{formatMoney(item.unit_price)}</Text>
                      <Text style={{ ...s.colTotal, fontFamily: "Helvetica-Bold" }}>{formatMoney(item.total)}</Text>
                    </View>
                  ))}
                </View>
              </View>
            );
          })}
          <View style={s.totals} wrap={false}>
            <View style={s.totalRow}>
              <Text style={{ color: C.muted }}>Subtotal</Text>
              <Text>{formatMoney(quote.subtotal)}</Text>
            </View>
            {quote.discount > 0 ? (
              <View style={s.totalRow}>
                <Text style={{ color: C.muted }}>Desconto</Text>
                <Text>- {formatMoney(quote.discount)}</Text>
              </View>
            ) : null}
            <View style={s.grandTotal}>
              <Text style={s.strong}>Total</Text>
              <Text style={{ ...s.strong, fontSize: 12 }}>{formatMoney(quote.total)}</Text>
            </View>
          </View>
        </View>

        {quote.notes ? (
          <View style={s.section}>
            <Text style={s.sectionTitle} minPresenceAhead={40}>
              Condições
            </Text>
            <Text style={s.paragraph}>{quote.notes}</Text>
          </View>
        ) : null}

        <View style={s.section} wrap={false}>
          <Text style={s.sectionTitle}>Resposta do cliente</Text>
          <Decision quote={quote} signature={signature} />
        </View>

        <View style={s.footer} fixed>
          <Text>
            {quote.code} · {quote.ticket_code} · gerado em {brDateTime(generatedAt)} · {companyName}
          </Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber}/${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

/** Gera e baixa o PDF do orçamento (a assinatura entra como imagem quando o orçamento foi aprovado). */
export async function downloadQuotePdf(quote: PublicQuote) {
  const [logo, signature] = await Promise.all([
    brandMark(),
    quote.status === "approved" && quote.signature_url
      ? imageDataUrl(quote.signature_url, { type: "image/png", maxSide: 900 })
      : Promise.resolve(null),
  ]);
  const blob = await pdf(<QuotePdf quote={quote} logo={logo} signature={signature} generatedAt={new Date().toISOString()} />).toBlob();
  saveBlob(blob, `Orcamento-${quote.code}.pdf`);
}
