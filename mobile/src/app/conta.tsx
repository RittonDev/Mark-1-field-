import { router } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { Badge, Button, Card, colors, EmptyState, InfoRow, SectionTitle } from "../components/ui";
import { getDeviceRegistration, logout } from "../lib/auth";
import { useDataVersion, useLiveQuery } from "../lib/changes";
import { APP_VERSION } from "../lib/config";
import { ROLE } from "../lib/constants";
import { dismissNotice, listNotices, listPendingOps, type PendingOp } from "../lib/db";
import { formatDateTime } from "../lib/format";
import { useSession } from "../lib/session";
import { describeOp, discardOp, requestSync, resetCursor, useSyncStatus, type SyncStatus } from "../lib/sync";

function networkLabel(s: SyncStatus): string {
  if (s.network === "offline") return "Sem internet";
  if (s.server === "unreachable") return "Internet ok, servidor inacessível";
  if (s.server === "reachable") return "Conectado ao servidor";
  return "Verificando…";
}

const REALTIME_LABEL = { off: "Desligado", connecting: "Conectando…", online: "Ativo" } as const;

export default function AccountScreen() {
  const { user, apiUrl } = useSession();
  const sync = useSyncStatus();
  const pending = useLiveQuery(listPendingOps);
  const notices = useLiveQuery(listNotices);
  useDataVersion(); // re-renderiza quando o registro do aparelho termina
  const registration = getDeviceRegistration();
  const [syncing, setSyncing] = useState(false);

  if (!user) return null;

  async function syncNow(full = false) {
    setSyncing(true);
    await (full ? resetCursor() : requestSync());
    setSyncing(false);
  }

  function confirmDiscard(op: PendingOp) {
    Alert.alert("Descartar operação?", `${describeOp(op)} em ${op.ticket_code ?? "OS"} não será enviada ao servidor.`, [
      { text: "Manter", style: "cancel" },
      { text: "Descartar", style: "destructive", onPress: () => void discardOp(op) },
    ]);
  }

  function confirmLogout() {
    const count = sync.pendingOps + sync.pendingPhotos;
    const warning = count
      ? `Há ${count} ${count === 1 ? "item" : "itens"} ainda não enviados. Eles ficam guardados e serão enviados quando você entrar de novo neste aparelho. Se outro usuário entrar aqui, serão descartados.`
      : "Você precisará da senha para entrar de novo.";
    Alert.alert("Sair do app?", warning, [
      { text: "Cancelar", style: "cancel" },
      // Com a sessão encerrada, o Stack.Protected do layout leva para o login.
      { text: "Sair", style: "destructive", onPress: () => void logout() },
    ]);
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Card>
        <SectionTitle>Técnico</SectionTitle>
        <Text style={styles.name}>{user.name}</Text>
        <Text style={styles.muted}>{user.email}</Text>
        <Text style={styles.muted}>
          {ROLE[user.role]}
          {user.team ? ` · ${user.team.name}` : ""}
        </Text>
      </Card>

      <Card style={{ gap: 4 }}>
        <SectionTitle>Sincronização</SectionTitle>
        <InfoRow label="Conexão" value={networkLabel(sync)} />
        <InfoRow label="Tempo real (WebSocket)" value={REALTIME_LABEL[sync.realtime]} />
        <InfoRow label="Última sincronização" value={sync.lastSyncAt ? formatDateTime(sync.lastSyncAt) : "Nunca"} />
        <InfoRow label="Operações na fila" value={String(sync.pendingOps)} />
        <InfoRow label="Fotos aguardando envio" value={String(sync.pendingPhotos)} />
        {sync.lastError ? <InfoRow label="Último erro" value={sync.lastError} /> : null}
        <View style={styles.buttons}>
          <Button title="Sincronizar agora" variant="primary" onPress={() => void syncNow()} loading={syncing} style={{ flex: 1 }} />
          <Button title="Baixar tudo" onPress={() => void syncNow(true)} disabled={syncing} style={{ flex: 1 }} />
        </View>
      </Card>

      <Card style={{ gap: 8 }}>
        <SectionTitle>Fila de envio</SectionTitle>
        {pending === undefined ? null : pending.length === 0 ? (
          <Text style={styles.muted}>Nada pendente: tudo foi enviado ao servidor.</Text>
        ) : (
          pending.map((op) => (
            <View key={op.client_op_id} style={styles.op}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.opTitle}>
                  {op.ticket_code ?? "OS"} · {describeOp(op)}
                </Text>
                <Text style={styles.muted}>
                  Feita em {formatDateTime(op.client_timestamp)}
                  {op.attempts ? ` · ${op.attempts} tentativa(s)` : ""}
                </Text>
                {op.last_error ? <Text style={styles.error}>{op.last_error}</Text> : null}
              </View>
              <Button compact variant="ghost" title="Descartar" onPress={() => confirmDiscard(op)} />
            </View>
          ))
        )}
      </Card>

      <Card style={{ gap: 8 }}>
        <SectionTitle>Avisos</SectionTitle>
        {notices === undefined ? null : notices.length === 0 ? (
          <EmptyState title="Nenhum aviso" description="Operações recusadas pelo servidor aparecem aqui." />
        ) : (
          notices.map((notice) => (
            <View key={notice.id} style={styles.op}>
              <View style={{ flex: 1, gap: 4 }}>
                <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
                  <Badge
                    label={notice.kind === "conflict" ? "Conflito" : notice.kind === "photo" ? "Foto" : "Recusada"}
                    color={notice.kind === "conflict" ? colors.warning : colors.danger}
                  />
                  <Text style={styles.muted}>
                    {notice.ticket_code ?? ""} · {formatDateTime(notice.created_at)}
                  </Text>
                </View>
                <Text style={styles.opTitle}>{notice.message}</Text>
                {notice.ticket_id ? (
                  <Button
                    compact
                    variant="ghost"
                    title="Abrir OS"
                    onPress={() => router.push({ pathname: "/ticket/[id]", params: { id: notice.ticket_id! } })}
                    style={{ alignSelf: "flex-start", paddingHorizontal: 0 }}
                  />
                ) : null}
              </View>
              <Button compact variant="ghost" title="OK" onPress={() => void dismissNotice(notice.id)} />
            </View>
          ))
        )}
      </Card>

      <Card style={{ gap: 4 }}>
        <SectionTitle>Aparelho</SectionTitle>
        <InfoRow
          label="Notificações push"
          value={
            registration === null
              ? "Verificando…"
              : registration.state === "registered"
                ? "Aparelho registrado no servidor"
                : registration.message
          }
        />
        <InfoRow label="Servidor" value={apiUrl} />
        <InfoRow label="Versão do app" value={APP_VERSION} />
      </Card>

      <Button title="Sair" variant="danger" onPress={confirmLogout} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 14, paddingBottom: 40 },
  name: { fontSize: 18, fontWeight: "700", color: colors.ink },
  muted: { fontSize: 13, color: colors.inkMuted },
  buttons: { flexDirection: "row", gap: 10, marginTop: 8 },
  op: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  opTitle: { fontSize: 14, color: colors.ink },
  error: { fontSize: 12, color: colors.danger },
});
