import { memo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { addressOf } from "../../lib/device-actions";
import { formatBRL } from "../../lib/expenses";
import { dayMonth, dayOffset } from "../../lib/field";
import { formatDay, formatTime } from "../../lib/format";
import type { LocalTicket } from "../../lib/syncTypes";
import { useStyles, type Palette } from "../../theme/theme";
import { Text } from "../Text";
import { Card, InfoRow, SectionTitle } from "../ui";
import { ExpensesCard } from "./ExpensesCard";

/** "Hoje · 21:30 às 22:10", "Amanhã · 09:00", "Qui., 12/11 · 21:30" (o fim só quando é no mesmo dia). */
export function visitWindow(ticket: Pick<LocalTicket, "scheduled_start" | "scheduled_end">, now: number = Date.now()): string | null {
  if (!ticket.scheduled_start) return null;
  const start = new Date(ticket.scheduled_start);
  const end = ticket.scheduled_end ? new Date(ticket.scheduled_end) : null;
  const offset = dayOffset(start, now);
  const day = offset === 0 ? "hoje" : offset === 1 ? "amanhã" : offset === -1 ? "ontem" : formatDay(start);
  const sameDay = end && end.toDateString() === start.toDateString();
  const dayLabel = day.charAt(0).toUpperCase() + day.slice(1);
  return `${dayLabel} · ${formatTime(start)}${sameDay ? ` às ${formatTime(end)}` : ""}`;
}

/** Descrição longa abre em 4 linhas, com "Ver tudo". */
const LONG_SCOPE = 220;

/**
 * Escopo da visita (tipo de serviço e o que fazer) e, depois de concluída, a solução aplicada. É o
 * que o técnico mais consulta ao chegar: fica logo abaixo do cabeçalho da OS.
 */
export const ScopeCard = memo(function ScopeCard({ ticket }: { ticket: LocalTicket }) {
  const styles = useStyles(makeStyles);
  const [expanded, setExpanded] = useState(false);
  const description = ticket.description?.trim() ?? "";
  const long = description.length > LONG_SCOPE || description.split("\n").length > 4;
  return (
    <Card style={{ gap: 6 }}>
      <SectionTitle accent>Escopo do serviço</SectionTitle>
      {ticket.service_type ? <Text style={styles.strong}>{ticket.service_type.name}</Text> : null}
      <Text style={styles.text} selectable numberOfLines={long && !expanded ? 4 : undefined}>
        {description || "Sem descrição."}
      </Text>
      {long ? (
        <Pressable onPress={() => setExpanded((e) => !e)} hitSlop={8} accessibilityRole="button" style={styles.more}>
          <Text style={styles.moreText}>{expanded ? "Ver menos" : "Ver tudo"}</Text>
        </Pressable>
      ) : null}
      {ticket.resolution_notes ? (
        <View style={styles.resolution}>
          <Text style={styles.label}>Solução aplicada</Text>
          <Text style={styles.text} selectable>
            {ticket.resolution_notes}
          </Text>
        </View>
      ) : null}
    </Card>
  );
});

/**
 * Detalhes da OS para o técnico. Ele é terceiro: só o básico para fazer a visita — quando, onde e
 * o escopo. Contato da loja, prazos de SLA, analista, solicitante e a classificação interna da OS
 * ficam com a central (e o servidor nem manda).
 *
 * O topo da OS já mostra cliente, loja, endereço, dia, hora e o escopo. Aqui entra o que acrescenta:
 * o valor da OS, o aviso de que ainda não há data, o endereço do atendimento quando é outro e os custos.
 */
export const InfoPanel = memo(function InfoPanel({ ticket, userId }: { ticket: LocalTicket; userId?: string }) {
  const styles = useStyles(makeStyles);
  const location = ticket.location;
  // OS baixadas antes da mudança no contrato não têm o campo; trata como vazio.
  const serviceAddress = ticket.service_address?.trim() || null;
  const registeredAddress = addressOf(location);
  const when = visitWindow(ticket);

  const payout = ticket.my_payout ?? null;
  const expenses = ticket.expenses ?? [];

  return (
    <View style={{ gap: 12 }}>
      {payout ? (
        <Card>
          <SectionTitle accent>Valor desta OS</SectionTitle>
          <Text style={styles.strong}>{formatBRL(payout.amount)}</Text>
          <Text style={styles.label}>
            {payout.status === "paid"
              ? `Pago${payout.paid_at ? ` em ${dayMonth(payout.paid_at)}` : ""}. Veja em Ganhos.`
              : "A central paga depois que a OS for concluída. Acompanhe em Ganhos."}
          </Text>
        </Card>
      ) : null}

      {when ? null : (
        <Card>
          <SectionTitle accent>Agendamento</SectionTitle>
          <Text style={styles.strong}>Sem data marcada: aguarde a central agendar.</Text>
        </Card>
      )}

      {serviceAddress ? (
        <Card>
          <SectionTitle accent>Local de atendimento</SectionTitle>
          {ticket.customer ? <Text style={styles.label}>{ticket.customer.name}</Text> : null}
          {location ? (
            <Text style={styles.strong}>{[location.code, location.name].filter(Boolean).join(" · ")}</Text>
          ) : null}
          <View style={styles.serviceAddress}>
            <Text style={styles.label}>Endereço do atendimento</Text>
            <Text style={[styles.text, { fontWeight: "600" }]} selectable>
              {serviceAddress}
            </Text>
            <Text style={styles.label}>Diferente do endereço cadastrado da loja. A Rota do topo já leva para cá.</Text>
          </View>
          {registeredAddress ? <InfoRow label="Endereço cadastrado da loja" value={registeredAddress} /> : null}
        </Card>
      ) : null}

      <ExpensesCard expenses={expenses} userId={userId} />

      {!payout && when && !serviceAddress && !expenses.length ? (
        <Text style={styles.empty}>Sem outros detalhes nesta OS. Endereço, horário e escopo estão no topo.</Text>
      ) : null}
    </View>
  );
});

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    strong: { fontSize: 16, fontWeight: "600", color: c.ink, marginBottom: 4 },
    text: { fontSize: 15, color: c.ink, lineHeight: 21 },
    label: { fontSize: 13, color: c.inkMuted, lineHeight: 18 },
    more: { alignSelf: "flex-start", paddingVertical: 4 },
    moreText: { fontSize: 14, fontWeight: "600", color: c.brandInk },
    resolution: { marginTop: 10, paddingTop: 10, gap: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
    empty: { fontSize: 13, color: c.inkMuted, lineHeight: 18, textAlign: "center", paddingVertical: 8 },
    serviceAddress: {
      marginTop: 8,
      padding: 10,
      gap: 2,
      borderRadius: 10,
      backgroundColor: c.primarySoft,
      borderWidth: 1,
      borderColor: c.primary + "33",
    },
  });
