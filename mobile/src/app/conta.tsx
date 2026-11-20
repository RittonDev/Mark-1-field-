// Sincronização (a rota continua /conta; o título vem do _layout): a conversa com a central, os itens para enviar, as
// ações que a central não aceitou, o rastreamento da jornada, as notificações e o aparelho. `?secao=` abre a tela já
// rolada até um cartão (lib/navigation.ts, openSync): a OS abre as pendências e a faixa de Hoje, os avisos. A
// identidade e o Sair ficam no Perfil; a Aparência, nas Configurações.

import { router, useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import { ScrollView, StyleSheet, View, type LayoutChangeEvent, type ScrollViewInstance } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BackgroundSyncRow, NotificationsCard, PushRow } from "../components/NotificationsCard";
import { Text } from "../components/Text";
import { Badge, Button, Card, EmptyState, InfoRow, SectionTitle } from "../components/ui";
import { useStyles, useTheme, type Palette } from "../theme/theme";
import { locationConsentAt, revokeLocationConsent } from "../lib/account";
import { ApiError, errorMessage } from "../lib/api";
import { stopTracking, useTracking } from "../lib/tracking";
import { useLiveQuery } from "../lib/changes";
import { APP_VERSION } from "../lib/config";
import { confirmAction } from "../lib/dialogs";
import { countPending, dismissNotice, listNotices, listPendingOps, type PendingOp } from "../lib/db";
import { formatDateTime, formatTime } from "../lib/format";
import type { SyncSection } from "../lib/navigation";
import { noNetwork } from "../lib/net";
import { canEditServer, useSession } from "../lib/session";
import { describeOp, discardOp, isOnline, requestSync, resetCursor, useSyncStatus, type SyncStatus } from "../lib/sync";
import { showToast } from "../lib/toast";

/**
 * Depois de tantas falhas da própria ação com o servidor no ar, ela provavelmente não vai passar
 * sozinha: aí dá para descartar. Falta de rede e falha do envio inteiro não somam tentativas (o motor
 * só anota o erro), e com o servidor fora do ar nada se descarta.
 */
const DISCARD_AFTER_ATTEMPTS = 3;

/** Os cartões que abrem direto (`?secao=`). */
const SECTIONS: readonly string[] = ["pendencias", "avisos", "rastreamento"] satisfies SyncSection[];
const isSection = (value: unknown): value is SyncSection => typeof value === "string" && SECTIONS.includes(value);

function networkLabel(s: SyncStatus): string {
  if (s.network === "offline") return "Sem internet";
  if (s.server === "unreachable") return "Internet ok, mas sem conexão com o servidor";
  if (s.server === "reachable") return "Conectado ao servidor";
  return "Verificando…";
}

const REALTIME_LABEL = { off: "Desligada", connecting: "Conectando…", online: "Ativa" } as const;

export default function SyncScreen() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { user, apiUrl } = useSession();
  const sync = useSyncStatus();
  const pending = useLiveQuery(listPendingOps);
  const notices = useLiveQuery(listNotices);
  const [syncing, setSyncing] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const tracking = useTracking();
  const consentAt = locationConsentAt(user);
  // A última rodada falou com o servidor: uma ação que segue na fila depois disso não está só esperando sinal.
  const serverUp = sync.network !== "offline" && sync.server === "reachable";
  // `?secao=`: o cartão pedido fica no topo até o técnico mexer na tela, mesmo se o que vem antes dele crescer ao
  // carregar (as listas chegam do banco local depois do primeiro quadro).
  const { secao } = useLocalSearchParams<{ secao?: string }>();
  const target = isSection(secao) ? secao : null;
  const scrollRef = useRef<ScrollViewInstance>(null);
  const touched = useRef(false);

  if (!user) return null;

  /** onLayout do cartão de destino: rola até ele (8 pt de folga em cima). */
  function anchor(section: SyncSection) {
    if (section !== target) return undefined;
    return (event: LayoutChangeEvent) => {
      const y = Math.max(0, event.nativeEvent.layout.y - 8);
      requestAnimationFrame(() => {
        if (!touched.current) scrollRef.current?.scrollTo({ y, animated: false });
      });
    };
  }

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
    <ScrollView
      ref={scrollRef}
      onScrollBeginDrag={() => {
        touched.current = true;
      }}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
    >
      <Card style={{ gap: 4 }}>
        <SectionTitle accent>Sincronização</SectionTitle>
        <InfoRow label="Conexão" value={networkLabel(sync)} />
        <InfoRow label="Atualização automática" value={REALTIME_LABEL[sync.realtime]} />
        <InfoRow label="Última sincronização" value={sync.lastSyncAt ? formatDateTime(sync.lastSyncAt) : "Ainda não sincronizado"} />
        <InfoRow label="Ações para enviar" value={String(sync.pendingOps)} />
        <InfoRow label="Fotos e assinaturas para enviar" value={String(sync.pendingPhotos)} />
        <BackgroundSyncRow />
        {sync.lastError ? <InfoRow label="Último erro" value={sync.lastError} /> : null}
        <View style={styles.buttons}>
          <Button title="Sincronizar agora" variant="primary" onPress={() => void syncNow()} loading={syncing} style={styles.buttonGrow} />
          <Button title="Baixar tudo de novo" onPress={() => void syncNow(true)} disabled={syncing} style={styles.buttonGrow} />
        </View>
        <Text style={styles.hint}>“Baixar tudo de novo”: use se alguma OS estiver faltando no aparelho.</Text>
      </Card>

      <View onLayout={anchor("pendencias")}>
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
                  {stuck ? <Button compact variant="ghost" title="Descartar" onPress={() => confirmDiscard(op)} /> : null}
                </View>
              );
            })
          )}
        </Card>
      </View>

      <View onLayout={anchor("avisos")}>
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
      </View>

      <View onLayout={anchor("rastreamento")}>
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
              <Button compact title="Retirar aceite" onPress={() => void confirmRevoke()} loading={revoking} style={{ alignSelf: "flex-start" }} />
              <Text style={styles.hint}>Encerra a jornada e para o rastreamento. Para iniciar outra jornada, é preciso aceitar de novo.</Text>
            </View>
          ) : null}
        </Card>
      </View>

      <NotificationsCard />

      <Card style={{ gap: 4 }}>
        <SectionTitle accent>Aparelho</SectionTitle>
        <PushRow />
        {canEditServer ? <InfoRow label="Servidor" value={apiUrl} /> : null}
        <InfoRow label="Versão do app" value={APP_VERSION} />
      </Card>
    </ScrollView>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    content: { padding: 16, gap: 14 },
    muted: { fontSize: 13, color: c.inkMuted },
    hint: { fontSize: 12, color: c.inkMuted, lineHeight: 17, marginTop: 4 },
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
  });
