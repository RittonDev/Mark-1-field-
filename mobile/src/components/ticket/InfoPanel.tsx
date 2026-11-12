import { StyleSheet, Text, View } from "react-native";
import { ASSET_TYPE, LEVEL, SLA_STATUS, TICKET_SOURCE, TICKET_TYPE } from "../../lib/constants";
import { addressOf, callPhone, openInMaps } from "../../lib/device-actions";
import { formatDateTime, formatDocument, formatRelative } from "../../lib/format";
import { computeSlaStatus } from "../../lib/sla";
import type { LocalTicket } from "../../lib/syncTypes";
import { Button, Card, colors, InfoRow, SectionTitle } from "../ui";

export function InfoPanel({ ticket, now }: { ticket: LocalTicket; now: number }) {
  const location = ticket.location;
  const asset = ticket.asset;
  const sla = SLA_STATUS[computeSlaStatus(ticket, now)];
  const requesterContact = ticket.requester_contact;
  // OS baixadas antes da mudança no contrato não têm o campo; trata como vazio.
  const serviceAddress = ticket.service_address?.trim() || null;
  const registeredAddress = addressOf(location);
  const contactPhone = location?.contact_phone;

  return (
    <View style={{ gap: 12 }}>
      {location || serviceAddress ? (
        <Card>
          <SectionTitle>Local de atendimento</SectionTitle>
          {location ? (
            <Text style={styles.strong}>{[location.code, location.name].filter(Boolean).join(" · ")}</Text>
          ) : null}
          {location?.document ? (
            <InfoRow
              label={location.document.length === 14 ? "CNPJ da filial" : "Documento da filial"}
              value={formatDocument(location.document)}
            />
          ) : null}
          {serviceAddress ? (
            <View style={styles.serviceAddress}>
              <Text style={styles.label}>Endereço do atendimento</Text>
              <Text style={[styles.text, { fontWeight: "600" }]} selectable>
                {serviceAddress}
              </Text>
              <Text style={styles.label}>Diferente do endereço cadastrado da filial.</Text>
            </View>
          ) : null}
          {registeredAddress ? (
            <InfoRow label={serviceAddress ? "Endereço cadastrado da filial" : "Endereço"} value={registeredAddress} />
          ) : null}
          {location?.contact_name ? <InfoRow label="Contato no local" value={location.contact_name} /> : null}
          {contactPhone ? <InfoRow label="Telefone" value={contactPhone} onPress={() => void callPhone(contactPhone)} /> : null}
          <Button
            title={serviceAddress ? "Rota até o endereço do atendimento" : "Abrir no mapa"}
            onPress={() => void openInMaps(location, serviceAddress)}
            style={{ marginTop: 8 }}
          />
        </Card>
      ) : null}

      {asset ? (
        <Card>
          <SectionTitle>Equipamento</SectionTitle>
          <Text style={styles.strong}>{asset.name}</Text>
          <Text style={styles.text}>
            {[ASSET_TYPE[asset.asset_type], asset.brand, asset.model].filter(Boolean).join(" · ")}
          </Text>
          {asset.serial_number ? <InfoRow label="Nº de série" value={asset.serial_number} /> : null}
          {asset.asset_tag ? <InfoRow label="Patrimônio" value={asset.asset_tag} /> : null}
          {asset.ip_address ? <InfoRow label="IP" value={asset.ip_address} /> : null}
        </Card>
      ) : null}

      <Card>
        <SectionTitle>Descrição</SectionTitle>
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

      <Card>
        <SectionTitle>SLA</SectionTitle>
        <InfoRow label="Situação" value={<Text style={[styles.value, { color: sla.color, fontWeight: "600" }]}>{sla.label}</Text>} />
        {ticket.first_response_at ? (
          <InfoRow label="1ª resposta" value={formatDateTime(ticket.first_response_at)} />
        ) : ticket.response_due_at ? (
          <InfoRow
            label="Prazo da 1ª resposta"
            value={`${formatDateTime(ticket.response_due_at)} (${formatRelative(ticket.response_due_at, now)})`}
          />
        ) : null}
        {ticket.resolution_due_at ? (
          <InfoRow
            label="Prazo de solução"
            value={`${formatDateTime(ticket.resolution_due_at)}${ticket.resolved_at ? "" : ` (${formatRelative(ticket.resolution_due_at, now)})`}`}
          />
        ) : null}
        {ticket.sla_paused_at ? <InfoRow label="Pausado desde" value={formatDateTime(ticket.sla_paused_at)} /> : null}
      </Card>

      <Card>
        <SectionTitle>Ordem de serviço</SectionTitle>
        <InfoRow label="Tipo" value={TICKET_TYPE[ticket.type]} />
        {ticket.category ? <InfoRow label="Categoria" value={ticket.category.full_name} /> : null}
        <InfoRow label="Impacto / urgência" value={`${LEVEL[ticket.impact]} / ${LEVEL[ticket.urgency]}`} />
        {ticket.customer ? <InfoRow label="Cliente" value={ticket.customer.name} /> : null}
        <InfoRow label="Solicitante" value={ticket.requester?.name ?? ticket.requester_name ?? "—"} />
        {requesterContact ? (
          <InfoRow
            label="Contato do solicitante"
            value={requesterContact}
            onPress={/\d{8,}/.test(requesterContact.replace(/\D/g, "")) ? () => void callPhone(requesterContact) : undefined}
          />
        ) : null}
        <InfoRow label="Responsável" value={ticket.assignee?.name ?? "Sem responsável"} />
        {ticket.team ? <InfoRow label="Grupo" value={ticket.team.name} /> : null}
        <InfoRow label="Origem" value={TICKET_SOURCE[ticket.source]} />
        <InfoRow label="Aberta em" value={formatDateTime(ticket.created_at)} />
        {ticket.scheduled_start ? (
          <InfoRow
            label="Visita"
            value={`${formatDateTime(ticket.scheduled_start)}${ticket.scheduled_end ? ` até ${formatDateTime(ticket.scheduled_end)}` : ""}`}
          />
        ) : null}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  strong: { fontSize: 16, fontWeight: "600", color: colors.ink },
  text: { fontSize: 15, color: colors.ink, lineHeight: 21 },
  label: { fontSize: 12, color: colors.inkMuted },
  value: { fontSize: 15, color: colors.ink },
  serviceAddress: {
    marginTop: 8,
    padding: 10,
    gap: 2,
    borderRadius: 10,
    backgroundColor: "#eff6ff",
    borderWidth: 1,
    borderColor: "#bfdbfe",
  },
});
