import { useStyles, useTheme, type Palette } from "../../theme/theme";
import { useCallback, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { errorMessage } from "../../lib/api";
import { useLiveQuery } from "../../lib/changes";
import { isStaff } from "../../lib/constants";
import { listComments } from "../../lib/db";
import { formatDateTime } from "../../lib/format";
import { enqueueComment } from "../../lib/sync";
import type { LocalTicket } from "../../lib/syncTypes";
import type { User } from "../../lib/types";
import { Badge, Button, Card, EmptyState, ErrorBox, Input, SwitchRow } from "../ui";

export function CommentsPanel({ ticket, user }: { ticket: LocalTicket; user: User }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const load = useCallback(() => listComments(ticket.id), [ticket.id]);
  const comments = useLiveQuery(load);
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const closed = ticket.status === "closed" || ticket.status === "cancelled";

  async function send() {
    if (!body.trim()) return;
    setSending(true);
    setError(null);
    try {
      await enqueueComment(ticket.id, { body: body.trim(), is_internal: internal });
      setBody("");
      setInternal(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <View style={{ gap: 12 }}>
      {comments === undefined ? null : comments.length === 0 ? (
        <EmptyState title="Nenhum acompanhamento" description="Registre o que foi feito ou combinado com o cliente." />
      ) : (
        comments.map((comment) => (
          <Card key={comment.id} style={[comment.is_internal && styles.internal]}>
            <View style={styles.meta}>
              <Text style={styles.author}>{comment.author?.name ?? "Sistema"}</Text>
              <Text style={styles.date}>{formatDateTime(comment.created_at)}</Text>
            </View>
            <View style={styles.tags}>
              {comment.is_internal ? <Badge label="Nota interna" color={c.warning} /> : null}
              {comment.local_state === "pending" ? <Badge label="Aguardando envio" color={c.warning} /> : null}
              {comment.local_state === "sent" ? <Badge label="Enviado" color={c.success} /> : null}
            </View>
            <Text style={styles.body} selectable>
              {comment.body}
            </Text>
          </Card>
        ))
      )}

      {!closed ? (
        <Card style={{ gap: 10 }}>
          <Input value={body} onChangeText={setBody} multiline placeholder="Escreva um acompanhamento" />
          {isStaff(user.role) ? (
            <SwitchRow
              label="Nota interna"
              hint="Só a equipe vê; o solicitante não é avisado."
              value={internal}
              onValueChange={setInternal}
            />
          ) : null}
          {error ? <ErrorBox message={error} /> : null}
          <Button title="Enviar acompanhamento" variant="primary" onPress={send} loading={sending} disabled={!body.trim()} />
        </Card>
      ) : null}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
  internal: { backgroundColor: c.warningSoft, borderColor: c.warning + "44" },
  meta: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  author: { fontSize: 14, fontWeight: "600", color: c.ink, flexShrink: 1 },
  date: { fontSize: 12, color: c.inkMuted },
  tags: { flexDirection: "row", gap: 6, marginTop: 4 },
  body: { fontSize: 15, color: c.ink, marginTop: 6, lineHeight: 21 },
});
