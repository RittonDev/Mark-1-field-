import { StyleSheet, View } from "react-native";
import { addressOf } from "../../lib/device-actions";
import { formatDay, formatTime } from "../../lib/format";
import type { LocalTicket } from "../../lib/syncTypes";
import { useStyles, type Palette } from "../../theme/theme";
import { Text } from "../Text";
import { Card, InfoRow, SectionTitle } from "../ui";
import { ExpensesCard } from "./ExpensesCard";

/** "Qui., 12/11 · 21:30 às 22:10" (o fim só quando é no mesmo dia). */
export function visitWindow(ticket: Pick<LocalTicket, "scheduled_start" | "scheduled_end">): string | null {
  if (!ticket.scheduled_start) return null;
  const start = new Date(ticket.scheduled_start);
  const end = ticket.scheduled_end ? new Date(ticket.scheduled_end) : null;
  const day = formatDay(start);
  const sameDay = end && end.toDateString() === start.toDateString();
  const dayLabel = day.charAt(0).toUpperCase() + day.slice(1);
  return `${dayLabel} · ${formatTime(start)}${sameDay ? ` às ${formatTime(end)}` : ""}`;
}

/**
 * Detalhes da OS para o técnico. Ele é terceiro: só o básico para fazer a visita — quando, onde e
 * o escopo. Contato da loja, prazos de SLA, analista, solicitante e a classificação interna da OS
 * ficam com a central (e o servidor nem manda).
 *
 * O topo da OS já mostra cliente, loja, endereço, dia e hora, com Rota e Copiar. Aqui entra só o que
 * acrescenta: o aviso de que ainda não há data, o endereço do atendimento quando é outro e o escopo.
 */
export function InfoPanel({ ticket }: { ticket: LocalTicket }) {
  const styles = useStyles(makeStyles);
  const location = ticket.location;
  // OS baixadas antes da mudança no contrato não têm o campo; trata como vazio.
  const serviceAddress = ticket.service_address?.trim() || null;
  const registeredAddress = addressOf(location);
  const when = visitWindow(ticket);

  return (
    <View style={{ gap: 12 }}>
      {when ? null : (
        <Card>
          <SectionTitle>Agendamento</SectionTitle>
          <Text style={styles.strong}>Sem data marcada: aguarde a central agendar.</Text>
        </Card>
      )}

      {serviceAddress ? (
        <Card>
          <SectionTitle>Local de atendimento</SectionTitle>
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

      <Card>
        <SectionTitle>Escopo do serviço</SectionTitle>
        {ticket.service_type ? <Text style={styles.strong}>{ticket.service_type.name}</Text> : null}
        <Text style={styles.text} selectable>
          {ticket.description?.trim() || "Sem descrição."}
        </Text>
        {ticket.resolution_notes ? (
          <>
            <Text style={[styles.label, { marginTop: 12 }]}>Solução aplicada</Text>
            <Text style={styles.text} selectable>
              {ticket.resolution_notes}
            </Text>
          </>
        ) : null}
      </Card>

      <ExpensesCard expenses={ticket.expenses ?? []} />
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    strong: { fontSize: 16, fontWeight: "600", color: c.ink, marginBottom: 4 },
    text: { fontSize: 15, color: c.ink, lineHeight: 21 },
    label: { fontSize: 12, color: c.inkMuted },
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
