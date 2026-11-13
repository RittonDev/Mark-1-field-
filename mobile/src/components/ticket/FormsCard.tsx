import { router } from "expo-router";
import { memo, useCallback } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useLiveQuery } from "../../lib/changes";
import { getAttachmentsCache, listPhotos, listSignatures } from "../../lib/db";
import { formatDateTime } from "../../lib/format";
import { formProgress, pendingRequiredForms, photoCounts, signatureBlock } from "../../lib/forms";
import type { LocalTicket } from "../../lib/syncTypes";
import { RADIUS, useStyles, useTheme, type Palette } from "../../theme/theme";
import { Icon } from "../Icon";
import { Text } from "../Text";
import { Badge, Button, Card, SectionTitle } from "../ui";
import { toneInk } from "./tones";

const STATUS_LABEL = { pending: "Não iniciado", in_progress: "Em preenchimento", completed: "Concluído" } as const;

// Um toque duplo abriria duas cópias da mesma tela (e a de baixo sobrescreveria as respostas).
let lastOpen = 0;
function openOnce(go: () => void) {
  const now = Date.now();
  if (now - lastOpen < 800) return;
  lastOpen = now;
  go();
}

export function openForm(ticketId: string, formId: string) {
  openOnce(() => router.push({ pathname: "/formulario/[ticketId]/[formId]", params: { ticketId, formId } }));
}

export function openSignature(ticketId: string) {
  openOnce(() => router.push({ pathname: "/assinatura/[ticketId]", params: { ticketId } }));
}

/** Formulários anexados pela central e a assinatura do responsável no local. */
export const FormsCard = memo(function FormsCard({ ticket }: { ticket: LocalTicket }) {
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
  const done = ["resolved", "closed", "cancelled"].includes(ticket.status);
  const signed = Boolean(ticket.signed_at || pendingSignature);
  // Formulário obrigatório incluído pela central depois da assinatura: o técnico não destrava sozinho.
  const addedAfterSignature = signed && !done && pendingRequiredForms(ticket).length > 0;
  const block = addedAfterSignature
    ? "A central incluiu um formulário depois da assinatura. Fale com a central no grupo."
    : signatureBlock(ticket);

  return (
    <Card style={{ gap: 10 }}>
      <SectionTitle>Formulários e assinatura</SectionTitle>
      {forms.map((form) => {
        const progress = formProgress(form, photoCounts(form.id, attachments, pendingPhotos));
        const completed = form.status === "completed";
        const spoken = [
          form.name,
          form.required ? "obrigatório" : "opcional",
          STATUS_LABEL[form.status].toLowerCase(),
          progress.total ? `${progress.done} de ${progress.total} itens` : null,
        ]
          .filter(Boolean)
          .join(", ");
        return (
          <Pressable
            key={form.id}
            onPress={() => openForm(ticket.id, form.id)}
            accessibilityRole="button"
            accessibilityLabel={spoken}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.surface3 }]}
          >
            <View style={[styles.dot, { backgroundColor: completed ? c.success : c.lineStrong }]} />
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={styles.name}>{form.name}</Text>
              <View style={styles.badges}>
                <Badge label={STATUS_LABEL[form.status]} color={completed ? toneInk(c, "success") : c.inkMuted} />
                {form.required ? <Badge label="Obrigatório" color={c.inkMuted} /> : null}
              </View>
              {progress.total ? (
                <Text style={styles.meta}>
                  {progress.done} de {progress.total} itens obrigatórios
                </Text>
              ) : null}
            </View>
            <Icon name="chevronRight" size={20} color={c.inkMuted} />
          </Pressable>
        );
      })}

      {ticket.signature_required || signed ? (
        <View style={styles.signature}>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={styles.name}>Assinatura do responsável</Text>
            {pendingSignature ? (
              <Text style={styles.meta}>{pendingSignature.signer_name} assinou · aguardando envio</Text>
            ) : ticket.signed_at ? (
              <Text style={styles.meta}>
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
              title={signed ? "Refazer" : "Colher assinatura"}
              variant={signed ? "secondary" : "primary"}
              disabled={Boolean(block)}
              onPress={() => openSignature(ticket.id)}
            />
          ) : null}
        </View>
      ) : null}
      {block && !done && (ticket.signature_required || forms.length) ? (
        <View style={styles.hintRow}>
          <Icon name="lock" size={14} color={c.inkMuted} />
          <Text style={styles.hint}>{block}</Text>
        </View>
      ) : null}
    </Card>
  );
});

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      minHeight: 56,
      padding: 12,
      borderRadius: RADIUS.control,
      backgroundColor: c.surface2,
    },
    dot: { width: 8, height: 8, borderRadius: 4 },
    name: { fontSize: 15, fontWeight: "600", color: c.ink },
    badges: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
    meta: { fontSize: 13, color: c.inkMuted, lineHeight: 18 },
    signature: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      padding: 12,
      borderRadius: RADIUS.control,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.lineStrong,
    },
    hintRow: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
    hint: { flex: 1, fontSize: 13, color: c.inkMuted, lineHeight: 18 },
  });
