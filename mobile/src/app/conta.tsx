import NetInfo from "@react-native-community/netinfo";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, Platform, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "../components/Text";
import { Badge, Button, Card, EmptyState, InfoRow, SectionTitle, Segmented } from "../components/ui";
import {
  setThemePreference,
  useStyles,
  useTheme,
  useThemePreference,
  type Palette,
  type ThemePreference,
} from "../theme/theme";
import { locationConsentAt, revokeLocationConsent } from "../lib/account";
import { ApiError, errorMessage } from "../lib/api";
import { getDeviceRegistration, logout } from "../lib/auth";
import { stopTracking, useTracking } from "../lib/tracking";
import { useDataVersion, useLiveQuery } from "../lib/changes";
import { APP_VERSION } from "../lib/config";
import { confirmAction } from "../lib/dialogs";
import { ROLE } from "../lib/constants";
import { countPending, dismissNotice, listNotices, listPendingOps, type PendingOp } from "../lib/db";
import { formatDateTime, formatTime } from "../lib/format";
import { canEditServer, useSession } from "../lib/session";
import { describeOp, discardOp, isOnline, requestSync, resetCursor, useSyncStatus, type SyncStatus } from "../lib/sync";
import { showToast } from "../lib/toast";

/**
 * Depois de tantas tentativas com o servidor no ar, a ação provavelmente não vai passar sozinha: aí dá
 * para descartar. Esperando sinal não conta: a falta de rede também soma tentativas e grava o erro.
 */
const DISCARD_AFTER_ATTEMPTS = 3;

function networkLabel(s: SyncStatus): string {
  if (s.network === "offline") return "Sem internet";
  if (s.server === "unreachable") return "Internet ok, mas sem conexão com o servidor";
  if (s.server === "reachable") return "Conectado ao servidor";
  return "Verificando…";
}

const REALTIME_LABEL = { off: "Desligada", connecting: "Conectando…", online: "Ativa" } as const;

const itemsLabel = (n: number) => (n === 1 ? "1 item não enviado" : `${n} itens não enviados`);

type LogoutChoice = "send" | "leave" | "cancel";

/**
 * Confirmação do Sair. Com itens para enviar e internet, oferece mandar antes de sair. No navegador
 * (pré-visualização) o Alert de três botões não existe: fica só sair ou cancelar.
 */
function askLogout(pending: number, canSend: boolean): Promise<LogoutChoice> {
  const message = pending
    ? `Há ${itemsLabel(pending)}. Eles ficam guardados neste aparelho e vão quando você entrar de novo. Se outro técnico entrar aqui, serão apagados.`
    : "Você vai precisar da senha para entrar de novo. Se a jornada estiver aberta, ela é encerrada.";
  if (!pending || !canSend || Platform.OS === "web") {
    return confirmAction("Sair da conta?", message, { confirmText: "Sair", destructive: true }).then((ok) => (ok ? "leave" : "cancel"));
  }
  return new Promise((resolve) => {
    Alert.alert(
      "Sair da conta?",
      message,
      [
        { text: "Cancelar", style: "cancel", onPress: () => resolve("cancel") },
        { text: "Sair mesmo assim", style: "destructive", onPress: () => resolve("leave") },
        { text: "Enviar e sair", onPress: () => resolve("send") },
      ],
      { cancelable: true, onDismiss: () => resolve("cancel") },
    );
  });
}

/** Sem Wi-Fi e sem dados. Alcance incerto (teste de internet do sistema falhando) ainda vale tentar. */
async function noNetwork() {
  const net = await NetInfo.fetch();
  return net.isConnected === false;
}

export default function AccountScreen() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { user, apiUrl } = useSession();
  const sync = useSyncStatus();
  const pending = useLiveQuery(listPendingOps);
  const notices = useLiveQuery(listNotices);
  useDataVersion(); // re-renderiza quando o registro do aparelho termina
  const registration = getDeviceRegistration();
  const [syncing, setSyncing] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const themePreference = useThemePreference();
  const tracking = useTracking();
  const consentAt = locationConsentAt(user);
  // A última rodada falou com o servidor: uma ação que segue na fila depois disso não está só esperando sinal.
  const serverUp = sync.network !== "offline" && sync.server === "reachable";

  if (!user) return null;

  async function syncNow(full = false) {
    setSyncing(true);
    try {
      if (await noNetwork()) {
        showToast("Sem internet", { description: "Seus itens continuam salvos no aparelho e vão quando o sinal voltar." });
        return;
      }
      await (full ? resetCursor() : requestSync({ manual: true }));
      const { ops, photos } = await countPending();
      if (!isOnline()) {
        showToast("Sem conexão com o servidor", { tone: "error", description: "Tente de novo em alguns minutos." });
      } else if (ops + photos > 0) {
        showToast("Sincronizado", { description: `Ainda ${ops + photos === 1 ? "falta enviar 1 item" : `faltam enviar ${ops + photos} itens`}.` });
      } else {
        showToast("Tudo certo", { tone: "success", description: full ? "Suas OS foram baixadas de novo." : "Tudo enviado e atualizado." });
      }
    } catch (e) {
      showToast("Não foi possível sincronizar", { tone: "error", description: errorMessage(e) });
    } finally {
      setSyncing(false);
    }
  }

  function confirmDiscard(op: PendingOp) {
    void confirmAction(
      "Descartar esta ação?",
      `${describeOp(op)} em ${op.ticket_code ?? "OS"} não será enviada à central. Isso não pode ser desfeito.`,
      { confirmText: "Descartar", cancelText: "Manter", destructive: true },
    ).then((ok) => {
      if (ok) void discardOp(op);
    });
  }

  async function confirmLogout() {
    if (leaving) return;
    const count = sync.pendingOps + sync.pendingPhotos;
    const choice = await askLogout(count, sync.network !== "offline");
    if (choice === "cancel") return;
    setLeaving(true);
    if (choice === "send") {
      await requestSync({ manual: true });
      // Sem conseguir conferir, vale o que havia antes: pergunta de novo em vez de sair calado.
      const { ops, photos } = await countPending().catch(() => ({ ops: count, photos: 0 }));
      const left = ops + photos;
      if (left > 0) {
        setLeaving(false);
        const again = await confirmAction(
          "Ainda há itens para enviar",
          `${itemsLabel(left)} não ${left === 1 ? "foi enviado" : "foram enviados"} agora. Eles ficam guardados neste aparelho e vão quando você entrar de novo.`,
          { confirmText: "Sair mesmo assim", destructive: true },
        );
        if (!again) return;
        setLeaving(true);
      }
    }
    // Com a sessão encerrada, o Stack.Protected do layout leva para o login.
    try {
      await logout();
    } catch (e) {
      setLeaving(false);
      showToast("Não foi possível sair agora", { tone: "error", description: errorMessage(e) });
    }
  }

  /** LGPD: o aceite do termo sai quando o técnico quiser, pelo app, e a jornada aberta termina junto. */
  async function confirmRevoke() {
    if (revoking) return;
    const ok = await confirmAction(
      "Retirar o aceite?",
      tracking.shift
        ? "A jornada em andamento é encerrada e o rastreamento para agora. Para iniciar outra jornada, você vai precisar aceitar o termo de novo."
        : "Para iniciar uma jornada, você vai precisar aceitar o termo de novo.",
      { confirmText: "Retirar aceite", destructive: true },
    );
    if (!ok) return;
    setRevoking(true);
    try {
      // O servidor encerra a jornada e apaga o aceite; só depois disso o aparelho para a coleta.
      await revokeLocationConsent();
      await stopTracking({ endOnServer: false });
      showToast("Aceite retirado", {
        tone: "success",
        description: "O rastreamento da jornada parou. Para iniciar outra jornada, aceite o termo de novo.",
      });
    } catch (e) {
      showToast("Não foi possível retirar o aceite", {
        tone: "error",
        description:
          e instanceof ApiError && e.status === 0
            ? "Sem internet: a retirada precisa chegar à central. Tente de novo quando tiver sinal."
            : errorMessage(e),
      });
    } finally {
      setRevoking(false);
    }
  }

  const situation = !tracking.shift
    ? "Jornada não iniciada"
    : tracking.mode === "background"
      ? "Ativa, inclusive com o app em segundo plano"
      : tracking.mode === "foreground"
        ? "Ativa só com o app aberto"
        : "Iniciando o rastreamento…";

  return (
    <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
      <Card style={{ gap: 4 }}>
        <SectionTitle accent>Técnico</SectionTitle>
        <Text style={styles.name}>{user.name}</Text>
        <Text style={styles.muted}>{user.email}</Text>
        <Text style={styles.muted}>
          {ROLE[user.role]}
          {user.team ? ` · ${user.team.name}` : ""}
        </Text>
        <View style={styles.divider} />
        <InfoRow label="Senha" value="Trocar senha" onPress={() => router.push("/trocar-senha")} />
      </Card>

      <Card style={{ gap: 4 }}>
        <SectionTitle accent>Sincronização</SectionTitle>
        <InfoRow label="Conexão" value={networkLabel(sync)} />
        <InfoRow label="Atualização automática" value={REALTIME_LABEL[sync.realtime]} />
        <InfoRow label="Última sincronização" value={sync.lastSyncAt ? formatDateTime(sync.lastSyncAt) : "Ainda não sincronizado"} />
        <InfoRow label="Ações para enviar" value={String(sync.pendingOps)} />
        <InfoRow label="Fotos e assinaturas para enviar" value={String(sync.pendingPhotos)} />
        {sync.lastError ? <InfoRow label="Último erro" value={sync.lastError} /> : null}
        <View style={styles.buttons}>
          <Button
            title="Sincronizar agora"
            variant="primary"
            onPress={() => void syncNow()}
            loading={syncing}
            disabled={leaving}
            style={styles.buttonGrow}
          />
          <Button title="Baixar tudo de novo" onPress={() => void syncNow(true)} disabled={syncing || leaving} style={styles.buttonGrow} />
        </View>
        <Text style={styles.hint}>“Baixar tudo de novo”: use se alguma OS estiver faltando no aparelho.</Text>
      </Card>

      <Card style={{ gap: 8 }}>
        <SectionTitle accent>Itens para enviar</SectionTitle>
        {pending === undefined ? null : pending.length === 0 ? (
          <Text style={styles.muted}>Nada pendente: tudo foi enviado à central.</Text>
        ) : (
          pending.map((op) => {
            const stuck = serverUp && op.attempts >= DISCARD_AFTER_ATTEMPTS;
            return (
              <View key={op.client_op_id} style={styles.op}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.opTitle}>
                    {op.ticket_code ?? "OS"} · {describeOp(op)}
                  </Text>
                  <Text style={styles.muted}>
                    Feita em {formatDateTime(op.client_timestamp)}
                    {op.attempts ? ` · ${op.attempts === 1 ? "1 tentativa" : `${op.attempts} tentativas`}` : " · na fila"}
                  </Text>
                  {/* Erro em vermelho só quando a ação está travada; esperando sinal, é informação. */}
                  {op.last_error ? <Text style={stuck ? styles.error : styles.muted}>{op.last_error}</Text> : null}
                </View>
                {/* Só esperando sinal não se descarta: um toque errado apagaria uma conclusão ou um formulário. */}
                {stuck ? <Button compact variant="ghost" title="Descartar" onPress={() => confirmDiscard(op)} disabled={leaving} /> : null}
              </View>
            );
          })
        )}
      </Card>

      <Card style={{ gap: 8 }}>
        <SectionTitle accent>Ações que a central não aceitou</SectionTitle>
        {notices === undefined ? null : notices.length === 0 ? (
          <EmptyState title="Nenhum aviso" description="Quando a central não aceitar uma ação sua, o motivo aparece aqui." />
        ) : (
          notices.map((notice) => (
            <View key={notice.id} style={styles.op}>
              <View style={{ flex: 1, gap: 4 }}>
                <View style={styles.noticeHead}>
                  <Badge
                    label={notice.kind === "conflict" ? "Conflito" : notice.kind === "photo" ? "Foto" : "Recusada"}
                    color={notice.kind === "conflict" ? c.warning : c.danger}
                  />
                  <Text style={styles.muted}>
                    {notice.ticket_code ? `${notice.ticket_code} · ` : ""}
                    {formatDateTime(notice.created_at)}
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
        <SectionTitle accent>Rastreamento da jornada</SectionTitle>
        <InfoRow
          label="Termo de uso da localização"
          value={consentAt ? `Aceito em ${formatDateTime(consentAt)}` : "Ainda não aceito"}
          onPress={() => router.push("/termo-rastreamento")}
        />
        <InfoRow label="Situação" value={situation} />
        {tracking.shift ? (
          <InfoRow
            label="Última posição"
            value={
              tracking.lastSentAt
                ? `Enviada às ${formatTime(tracking.lastSentAt)}`
                : tracking.lastFixAt
                  ? `Registrada às ${formatTime(tracking.lastFixAt)}`
                  : "Aguardando o GPS"
            }
          />
        ) : null}
        <InfoRow label="Posições aguardando envio" value={String(tracking.queued)} />
        {tracking.error ? <InfoRow label="Último erro" value={tracking.error} /> : null}
        {consentAt ? (
          <View style={styles.revoke}>
            <Button
              compact
              title="Retirar aceite"
              onPress={() => void confirmRevoke()}
              loading={revoking}
              disabled={leaving}
              style={{ alignSelf: "flex-start" }}
            />
            <Text style={styles.hint}>Encerra a jornada e para o rastreamento. Para iniciar outra jornada, é preciso aceitar de novo.</Text>
          </View>
        ) : null}
      </Card>

      <Card style={{ gap: 10 }}>
        <SectionTitle accent>Aparência</SectionTitle>
        <Segmented<ThemePreference>
          value={themePreference}
          onChange={(value) => void setThemePreference(value)}
          options={[
            { value: "system", label: "Sistema" },
            { value: "light", label: "Claro" },
            { value: "dark", label: "Escuro" },
          ]}
        />
        <Text style={styles.muted}>Em “Sistema”, o app acompanha o modo claro ou escuro do celular.</Text>
      </Card>

      <Card style={{ gap: 4 }}>
        <SectionTitle accent>Aparelho</SectionTitle>
        <InfoRow
          label="Notificações"
          value={
            registration === null
              ? "Verificando…"
              : registration.state === "registered"
                ? "Ativas neste aparelho"
                : registration.message
          }
        />
        {canEditServer ? <InfoRow label="Servidor" value={apiUrl} /> : null}
        <InfoRow label="Versão do app" value={APP_VERSION} />
      </Card>

      {leaving ? (
        <Text style={styles.leaving} accessibilityLiveRegion="polite">
          Encerrando a jornada e saindo…
        </Text>
      ) : null}
      <Button title="Sair da conta" variant="danger" onPress={() => void confirmLogout()} loading={leaving} disabled={revoking} />
    </ScrollView>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    content: { padding: 16, gap: 14 },
    name: { fontSize: 18, fontWeight: "700", color: c.ink },
    muted: { fontSize: 13, color: c.inkMuted },
    hint: { fontSize: 12, color: c.inkMuted, lineHeight: 17, marginTop: 4 },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: c.line, marginTop: 10, marginBottom: 2 },
    buttons: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 8 },
    buttonGrow: { flexGrow: 1, flexBasis: 140 },
    op: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 8,
      paddingVertical: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.line,
    },
    noticeHead: { flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" },
    opTitle: { fontSize: 14, color: c.ink },
    error: { fontSize: 12, color: c.danger },
    revoke: { gap: 6, marginTop: 8, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
    leaving: { fontSize: 13, fontWeight: "600", color: c.inkMuted, textAlign: "center" },
  });
