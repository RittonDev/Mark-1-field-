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
import { Badge, Button, Card, colors, EmptyState, ErrorBox, Input, SwitchRow } from "../ui";

export function CommentsPanel({ ticket, user }: { ticket: LocalTicket; user: User }) {
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
        comments.map((c) => (
          <Card key={c.id} style={[c.is_internal && styles.internal]}>
            <View style={styles.meta}>
              <Text style={styles.author}>{c.author?.name ?? "Sistema"}</Text>
              <Text style={styles.date}>{formatDateTime(c.created_at)}</Text>
            </View>
            <View style={styles.tags}>
              {c.is_internal ? <Badge label="Nota interna" color="#a16207" /> : null}
              {c.local_state === "pending" ? <Badge label="Aguardando envio" color={colors.warning} /> : null}
              {c.local_state === "sent" ? <Badge label="Enviado" color={colors.success} /> : null}
            </View>
            <Text style={styles.body} selectable>
              {c.body}
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

const styles = StyleSheet.create({
  internal: { backgroundColor: "#fefce8", borderColor: "#fde68a" },
  meta: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  author: { fontSize: 14, fontWeight: "600", color: colors.ink, flexShrink: 1 },
  date: { fontSize: 12, color: colors.inkMuted },
  tags: { flexDirection: "row", gap: 6, marginTop: 4 },
  body: { fontSize: 15, color: colors.ink, marginTop: 6, lineHeight: 21 },
});
