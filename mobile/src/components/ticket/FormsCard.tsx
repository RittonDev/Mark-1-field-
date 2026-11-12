import { router } from "expo-router";
import { useCallback } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useLiveQuery } from "../../lib/changes";
import { getAttachmentsCache, listPhotos, listSignatures } from "../../lib/db";
import { formatDateTime } from "../../lib/format";
import { formProgress, photoCounts, signatureBlock } from "../../lib/forms";
import type { LocalTicket } from "../../lib/syncTypes";
import { useStyles, useTheme, type Palette } from "../../theme/theme";
import { Badge, Button, Card, SectionTitle } from "../ui";

const STATUS_LABEL = { pending: "Não iniciado", in_progress: "Em preenchimento", completed: "Concluído" } as const;

/** Formulários anexados pelo analista e a assinatura do responsável no local. */
export function FormsCard({ ticket }: { ticket: LocalTicket }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const loadAttachments = useCallback(() => getAttachmentsCache(ticket.id), [ticket.id]);
  const loadPhotos = useCallback(() => listPhotos(ticket.id), [ticket.id]);
  const loadSignatures = useCallback(() => listSignatures(ticket.id), [ticket.id]);
  const attachments = useLiveQuery(loadAttachments) ?? [];
  const pendingPhotos = useLiveQuery(loadPhotos) ?? [];
  const pendingSignature = useLiveQuery(loadSignatures)?.[0] ?? null;

  const forms = ticket.forms ?? [];
  if (!forms.length && !ticket.signature_required && !ticket.signed_at) return null;
  const block = signatureBlock(ticket);
  const done = ["resolved", "closed", "cancelled"].includes(ticket.status);

  return (
    <Card style={{ gap: 10 }}>
      <SectionTitle>Formulários e assinatura</SectionTitle>
      {forms.map((form) => {
        const progress = formProgress(form, photoCounts(form.id, attachments, pendingPhotos));
        const color = form.status === "completed" ? c.success : form.status === "in_progress" ? c.warning : c.inkMuted;
        return (
          <Pressable
            key={form.id}
            onPress={() => router.push({ pathname: "/formulario/[ticketId]/[formId]", params: { ticketId: ticket.id, formId: form.id } })}
            accessibilityRole="button"
            accessibilityLabel={`${form.name}, ${STATUS_LABEL[form.status]}`}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.surface2 }]}
          >
            <View style={[styles.dot, { backgroundColor: color }]} />
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={styles.name}>{form.name}</Text>
              <View style={styles.badges}>
                <Badge label={STATUS_LABEL[form.status]} color={color} />
                {form.required ? <Badge label="Obrigatório" color={c.danger} /> : null}
              </View>
              {progress.total ? (
                <Text style={styles.meta}>
                  {progress.done} de {progress.total} itens obrigatórios
                </Text>
              ) : null}
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        );
      })}

      {ticket.signature_required || ticket.signed_at || pendingSignature ? (
        <View style={styles.signature}>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={styles.name}>Assinatura do responsável</Text>
            {pendingSignature ? (
              <Text style={[styles.meta, { color: c.warning }]}>
                {pendingSignature.signer_name} assinou · aguardando envio
              </Text>
            ) : ticket.signed_at ? (
              <Text style={[styles.meta, { color: c.success }]}>
                {ticket.signer_name}
                {ticket.signer_role ? ` (${ticket.signer_role})` : ""} · {formatDateTime(ticket.signed_at)}
              </Text>
            ) : (
              <Text style={styles.meta}>{ticket.signature_required ? "Obrigatória para concluir a OS" : "Opcional"}</Text>
            )}
          </View>
          {!done ? (
            <Button
              compact
              title={ticket.signed_at || pendingSignature ? "Refazer" : "Colher assinatura"}
              variant={ticket.signed_at || pendingSignature ? "secondary" : "primary"}
              disabled={Boolean(block)}
              onPress={() => router.push({ pathname: "/assinatura/[ticketId]", params: { ticketId: ticket.id } })}
            />
          ) : null}
        </View>
      ) : null}
      {block && !done && (ticket.signature_required || forms.length) ? <Text style={styles.hint}>{block}</Text> : null}
    </Card>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", gap: 10, padding: 10, borderRadius: 12, backgroundColor: c.surface2 },
    dot: { width: 8, height: 8, borderRadius: 4 },
    name: { fontSize: 15, fontWeight: "600", color: c.ink },
    badges: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
    meta: { fontSize: 12, color: c.inkMuted },
    chevron: { fontSize: 22, color: c.inkSubtle },
    signature: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      padding: 10,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
    },
    hint: { fontSize: 12, color: c.inkMuted, lineHeight: 17 },
  });
