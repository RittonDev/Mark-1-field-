import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ActionSheet, type SheetAction } from "../../components/ActionSheet";
import { ConnectionBar } from "../../components/ConnectionBar";
import { Icon, type IconName } from "../../components/Icon";
import { useListMotion } from "../../components/motion";
import { OfferLine } from "../../components/Offers";
import { DetailSkeleton } from "../../components/Skeleton";
import { Text } from "../../components/Text";
import { visitWindow } from "../../components/ticket/InfoPanel";
import { Badge, Button, Card, EmptyState, ErrorBox, InfoBox, SectionTitle } from "../../components/ui";
import { ApiError, errorMessage, getServerOffsetMs } from "../../lib/api";
import { useLiveQuery, useNow } from "../../lib/changes";
import { OFFER_CANCEL_REASON, OFFER_STATE } from "../../lib/constants";
import { getTicket } from "../../lib/db";
import { confirmAction } from "../../lib/dialogs";
import { formatBRL } from "../../lib/expenses";
import { haptic } from "../../lib/haptics";
import { deadlineInfo, loadOfferStore, offerState, placeLine } from "../../lib/offers";
import { useSession } from "../../lib/session";
import { showSuccess } from "../../lib/success";
import {
  acceptOffer,
  declineOffer,
  forgetOffer,
  isOnline,
  markOfferScopeRead,
  openOffer,
  refreshOffersNow,
  useSyncStatus,
} from "../../lib/sync";
import { showToast } from "../../lib/toast";
import type { FieldOffer, OfferErrorCode, OfferState } from "../../lib/types";
import { RADIUS, tint, useStyles, useTheme, type Palette } from "../../theme/theme";

/** Motivos da recusa (a central vê no histórico da OS). Não existe contraproposta. */
const DECLINE_REASONS = ["Agenda cheia", "Muito longe", "Valor não compensa", "Outro motivo"] as const;
const OFFLINE_TEXT = "Sem conexão. Conecte para responder a oferta.";
/** O prazo anda a cada 10 s: os botões somem quando ele vence. */
const TICK_MS = 10_000;
/**
 * Respostas do servidor que fecham a oferta para este técnico: outro aceitou, o prazo acabou, a central
 * cancelou, a OS não está mais livre ou ele já respondeu. Vale o texto do servidor, sem "Tentar de novo".
 */
const CLOSING = new Set<string>([
  "OFFER_TAKEN",
  "OFFER_EXPIRED",
  "OFFER_CANCELLED",
  "OFFER_UNAVAILABLE",
  "OFFER_ANSWERED",
] satisfies OfferErrorCode[]);

interface OpenResult {
  status: "ok" | "missing" | "offline" | "error";
  /** A oferta como o servidor devolveu (só com "ok"). */
  offer: FieldOffer | null;
  /** Texto do erro, quando a abertura falhou por outro motivo que não a falta de rede. */
  detail: string | null;
}

/** Abre a oferta no servidor (grava a leitura e traz a oferta atualizada) e diz como foi. */
async function openOnServer(id: string): Promise<OpenResult> {
  try {
    return { status: "ok", offer: await openOffer(id), detail: null };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      await forgetOffer(id).catch(() => undefined);
      return { status: "missing", offer: null, detail: null };
    }
    if (error instanceof ApiError && error.status === 0) return { status: "offline", offer: null, detail: null };
    return { status: "error", offer: null, detail: errorMessage(error) };
  }
}

function leave() {
  if (router.canGoBack()) router.back();
  else router.replace("/");
}

/** Por que a oferta não pode mais ser respondida. `hasNext`: a central mandou outra oferta da mesma OS. */
function situation(offer: FieldOffer, state: OfferState, mine: boolean, hasNext: boolean): string {
  if (state === "expired") return "O prazo para responder acabou.";
  if (state === "accepted") return "Você aceitou esta oferta. A OS está na sua agenda.";
  if (state === "declined") return "Você recusou esta oferta.";
  switch (offer.cancel_reason) {
    case "taken":
      return "Outro técnico aceitou esta OS.";
    case "central":
      return "A central cancelou esta oferta.";
    case "assigned":
      return mine ? "A central colocou você nesta OS." : "A central definiu o técnico desta OS.";
    case "ticket_closed":
      return "A OS foi encerrada pela central.";
    case "replaced":
      return hasNext
        ? "A central trocou esta oferta por uma nova."
        : "A central trocou esta oferta por uma nova. Veja em Ofertas para você, na tela inicial.";
    default:
      return "Esta oferta foi cancelada.";
  }
}

/**
 * Oferta de OS com preço: o técnico vê o recorte do convite (serviço, escopo, formulários, bairro e cidade,
 * data e valor; cliente, loja e endereço só depois de estar na OS) e responde "Aceitar por R$ X" ou "Recusar".
 * Não existe contraproposta. Abrir grava a leitura no servidor; o aceite pede também o escopo lido.
 */
export default function OfferRoute() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = String(params.id);
  // Uma tela por oferta: ir da antiga para a nova ("Ver a oferta nova") começa do zero.
  return <OfferScreen key={id} id={id} />;
}

function OfferScreen({ id }: { id: string }) {
  const { user } = useSession();
  const styles = useStyles(makeStyles);
  const store = useLiveQuery(loadOfferStore);
  const online = isOnline(useSyncStatus());
  // Cada abertura no servidor: ao entrar, com a conexão de volta, quando o aceite pede a leitura de novo e quando
  // a oferta pendente some da lista guardada.
  const [attempt, setAttempt] = useState(0);
  const [opened, setOpened] = useState<(OpenResult & { attempt: number }) | null>(null);
  // A oferta da última abertura no servidor: a tela segue com ela quando a lista guardada não a traz mais (a lista
  // do servidor não mostra a oferta que a central trocou por uma nova da mesma OS).
  const [served, setServed] = useState<FieldOffer | null>(null);

  const settle = useCallback((result: OpenResult, forAttempt: number) => {
    if (result.offer) setServed(result.offer);
    setOpened({ ...result, attempt: forAttempt });
  }, []);

  // Abrir grava a leitura no servidor (sem ela, o aceite é recusado) e atualiza a oferta guardada.
  useEffect(() => {
    if (!online) return;
    let alive = true;
    void openOnServer(id).then((result) => {
      if (alive) settle(result, attempt);
    });
    return () => {
      alive = false;
    };
  }, [id, online, attempt, settle]);

  const reopen = useCallback(() => setAttempt((n) => n + 1), []);
  const reload = useCallback(async () => {
    settle(await openOnServer(id), attempt);
  }, [id, attempt, settle]);

  const current = opened?.attempt === attempt ? opened : null;
  const opening = online && !current;
  const stored = store?.offers.find((o) => o.id === id) ?? null;

  // A oferta que esperava a resposta saiu da lista guardada (a central trocou por uma nova, por exemplo): abre de
  // novo para saber como ela ficou, em vez de seguir com o aceite de uma oferta que já não vale.
  const storedState = stored?.state ?? null;
  const [prevState, setPrevState] = useState(storedState);
  if (storedState !== prevState) {
    setPrevState(storedState);
    if (storedState === null && prevState === "pending" && current?.status !== "missing") setAttempt((n) => n + 1);
  }

  const offer = stored ?? served;
  // Outra oferta pendente da mesma OS (a central trocou o valor ou mandou de novo): a tela leva até ela.
  const replacement = offer
    ? (store?.offers.find((o) => o.id !== offer.id && o.ticket.id === offer.ticket.id && o.state === "pending") ?? null)
    : null;

  if (!user) return null;
  if (current?.status === "missing") {
    return (
      <View style={styles.screen}>
        <ConnectionBar />
        <View style={styles.missing}>
          <EmptyState
            icon="alert"
            title="Oferta não encontrada"
            description="Ela não está mais disponível para você. Em caso de dúvida, fale com a central no grupo."
          />
          <Button title="Voltar" onPress={leave} />
        </View>
      </View>
    );
  }
  if (!offer) {
    if (store === undefined || opening) return <DetailSkeleton />;
    return (
      <View style={styles.screen}>
        <ConnectionBar />
        <View style={styles.missing}>
          {!online || current?.status === "offline" ? (
            <EmptyState icon="wifiOff" title="Sem conexão" description="A oferta abre quando a conexão voltar." />
          ) : (
            <EmptyState icon="alert" title="Não foi possível abrir a oferta" description={current?.detail ?? undefined} />
          )}
          <View style={styles.missingActions}>
            {online ? <Button title="Tentar de novo" icon="repeat" variant="primary" onPress={reopen} /> : null}
            <Button title="Voltar" onPress={leave} />
          </View>
        </View>
      </View>
    );
  }

  const openProblem =
    current?.status === "offline"
      ? OFFLINE_TEXT
      : current?.status === "error"
        ? `Não foi possível abrir a oferta: ${current.detail ?? "erro inesperado"}`
        : null;
  return (
    <OfferView
      offer={offer}
      replacement={replacement}
      scopeRead={Boolean(store?.scope.includes(offer.id))}
      userId={user.id}
      online={online}
      opening={opening}
      openProblem={openProblem}
      onReopen={reopen}
      onReload={reload}
    />
  );
}

function OfferView({
  offer,
  replacement,
  scopeRead,
  userId,
  online,
  opening,
  openProblem,
  onReopen,
  onReload,
}: {
  offer: FieldOffer;
  /** Oferta pendente mais nova da mesma OS, para levar o técnico a ela quando esta fecha. */
  replacement: FieldOffer | null;
  scopeRead: boolean;
  userId: string;
  online: boolean;
  /** A abertura no servidor (que grava a leitura) ainda está a caminho. */
  opening: boolean;
  /** Por que a abertura no servidor falhou (sem conexão, erro). */
  openProblem: string | null;
  onReopen: () => void;
  onReload: () => Promise<void>;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const motion = useListMotion();
  const now = useNow(TICK_MS);
  const at = now + getServerOffsetMs();
  const ticket = offer.ticket;
  const ticketId = ticket.id;
  const loadTicket = useCallback(() => getTicket(ticketId), [ticketId]);
  const local = useLiveQuery(loadTicket);
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  /** Recusa do servidor ao aceite ou à recusa (409/422): o texto dele, sem "Tentar de novo". */
  const [problem, setProblem] = useState<{ code: string | null; message: string } | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [barHeight, setBarHeight] = useState(0);

  const state = offerState(offer, at);
  const closedByServer = Boolean(problem?.code && CLOSING.has(problem.code));
  const answerable = state === "pending" && !closedByServer;
  const viewed = Boolean(offer.viewed_at);
  // A OS da oferta já é dele (aceitou, ou a central o colocou nela): o próximo passo é abri-la.
  const mine = local?.assignee?.id === userId;
  const goesToTicket = !answerable && (state === "accepted" || mine);
  // Esta fechou e a central mandou outra da mesma OS (valor trocado, envio de novo): o próximo passo é a nova.
  const next = !answerable && !goesToTicket && replacement && offerState(replacement, at) === "pending" ? replacement : null;
  const amount = formatBRL(offer.amount);
  const acceptTitle = `Aceitar por ${amount}`;
  const place = placeLine(ticket);
  const when = visitWindow(ticket, at) ?? "Data a combinar";
  const deadline = state === "pending" ? deadlineInfo(offer, at) : null;
  const note = offer.note?.trim() || null;
  const description = ticket.description?.trim() || null;
  const badge =
    state === "pending"
      ? null
      : state === "cancelled" && offer.cancel_reason
        ? { label: OFFER_CANCEL_REASON[offer.cancel_reason], color: OFFER_STATE.cancelled.color }
        : { label: OFFER_STATE[state].label, color: OFFER_STATE[state].color };
  // O texto do servidor vale enquanto a oferta guardada ainda não diz como ela fechou (a lista vem logo depois).
  const situationText = answerable
    ? null
    : problem && closedByServer && offer.state === "pending"
      ? problem.message
      : situation(offer, state, mine, Boolean(next));
  const situationIcon: IconName = state === "accepted" || mine ? "checkCircle" : state === "expired" ? "hourglass" : "alert";

  // O que segura o aceite, na ordem: conexão, a leitura gravada no servidor e o escopo lido no app.
  const acceptBlock = !online
    ? OFFLINE_TEXT
    : !viewed
      ? opening
        ? "Abrindo a oferta…"
        : (openProblem ?? "Puxe a tela para baixo para abrir a oferta de novo.")
      : !scopeRead
        ? "Leia o escopo para aceitar"
        : null;
  const blockIcon: IconName = !online ? "wifiOff" : !viewed ? (opening ? "hourglass" : "alert") : "lock";
  // Aceite sem a leitura gravada: some quando a oferta é aberta de novo.
  const showProblem = Boolean(problem && !closedByServer && !(problem.code === "OFFER_NOT_VIEWED" && viewed));
  const showBar = answerable || goesToTicket || next !== null;

  async function refresh() {
    setRefreshing(true);
    await onReload();
    setRefreshing(false);
  }

  function toggleScope() {
    const show = !scopeOpen;
    setScopeOpen(show);
    if (show && !scopeRead) {
      haptic.select();
      void markOfferScopeRead(offer.id).catch(() => undefined);
    }
  }

  /** O servidor recusou a resposta ou ela não chegou. */
  function answerFailed(error: unknown) {
    if (error instanceof ApiError && (error.status === 409 || error.status === 422)) {
      // Decisão do servidor (outro técnico aceitou, prazo, cancelada): vale o motivo dele.
      haptic.warning();
      setProblem({ code: error.code, message: error.message });
      // Aceite sem a leitura gravada: abre de novo (o servidor grava) e o técnico tenta outra vez.
      if (error.code === "OFFER_NOT_VIEWED") onReopen();
      void refreshOffersNow(offer.id).catch(() => undefined);
      return;
    }
    const offline = error instanceof ApiError && error.status === 0;
    showToast(offline ? "Sem conexão" : "A resposta não foi enviada", {
      tone: "error",
      description: offline ? "Conecte para responder a oferta." : errorMessage(error),
    });
  }

  async function accept() {
    if (acceptBlock || busy) return;
    const ok = await confirmAction(`Aceitar esta OS por ${amount}?`, "Ela vai para a sua agenda.", { confirmText: "Aceitar" });
    if (!ok) return;
    setProblem(null);
    setBusy("accept");
    try {
      const accepted = await acceptOffer(offer.id, ticketId);
      haptic.success();
      showSuccess("OS aceita", `${accepted.code} está na sua agenda.`);
      router.replace({ pathname: "/ticket/[id]", params: { id: accepted.id } });
    } catch (error) {
      setBusy(null);
      answerFailed(error);
    }
  }

  async function decline(reason: string) {
    setProblem(null);
    setBusy("decline");
    try {
      await declineOffer(offer.id, reason);
      haptic.step();
      showToast("Oferta recusada", { description: `${ticket.code} · ${reason}` });
      leave();
    } catch (error) {
      setBusy(null);
      answerFailed(error);
    }
  }

  function openTicket() {
    router.replace({ pathname: "/ticket/[id]", params: { id: ticketId } });
  }

  function openNext(nextId: string) {
    router.replace({ pathname: "/oferta/[id]", params: { id: nextId } });
  }

  const declineActions: SheetAction[] = DECLINE_REASONS.map((reason) => ({
    key: reason,
    label: reason,
    onPress: () => void decline(reason),
  }));

  return (
    <View style={styles.screen}>
      <ConnectionBar />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: showBar ? (barHeight || 140 + insets.bottom) + 16 : insets.bottom + 24 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} colors={[c.primary]} tintColor={c.primary} />}
      >
        <Animated.View entering={motion.entering(0)}>
          <Card style={{ gap: 12 }}>
            <View style={styles.topRow}>
              <Text style={styles.code} numberOfLines={1}>
                {ticket.code}
              </Text>
              {badge ? <Badge label={badge.label} color={badge.color} /> : null}
            </View>
            <View style={{ gap: 4 }}>
              <Text style={styles.title} selectable accessibilityRole="header">
                {ticket.title}
              </Text>
              {ticket.service_type ? <Text style={styles.service}>{ticket.service_type.name}</Text> : null}
            </View>
            <View style={styles.amountBox} accessible accessibilityLabel={`${answerable ? "Você recebe se aceitar" : "Valor da oferta"}: ${amount}`}>
              <Text style={styles.amountLabel}>{answerable ? "Você recebe se aceitar" : "Valor da oferta"}</Text>
              <Text style={styles.amount}>{amount}</Text>
            </View>
            {deadline ? (
              <OfferLine
                icon="hourglass"
                text={`Responder até ${deadline.due} · faltam ${deadline.left}`}
                tone={deadline.urgent ? "warning" : "muted"}
                strong
              />
            ) : null}
            <View style={styles.divider} />
            <View style={{ gap: 6 }}>
              {place ? <OfferLine icon="pin" text={place} /> : null}
              <OfferLine icon="calendar" text={when} />
            </View>
          </Card>
        </Animated.View>

        {situationText ? <InfoBox icon={situationIcon} message={situationText} /> : null}

        {note ? (
          <View style={styles.note} accessibilityRole="summary">
            <View style={styles.noteHead}>
              <Icon name="note" size={18} color={c.brandInk} strokeWidth={2} />
              <Text style={styles.noteTitle}>Recado da central</Text>
            </View>
            <Text style={styles.noteText} selectable>
              {note}
            </Text>
          </View>
        ) : null}

        {/* O escopo começa recolhido: abrir é o "Escopo lido" que libera o aceite (guardado por oferta). */}
        {answerable ? (
          <Animated.View entering={motion.entering(1)}>
            <Card style={{ gap: 10 }}>
              <Pressable
                onPress={toggleScope}
                accessibilityRole="button"
                accessibilityLabel={`Escopo do serviço${scopeRead ? ", lido" : ""}`}
                accessibilityHint={scopeOpen ? "Esconde o escopo" : "Mostra o que deve ser feito na visita"}
                accessibilityState={{ expanded: scopeOpen }}
                style={({ pressed }) => [styles.scopeHead, pressed && { opacity: 0.7 }]}
              >
                <SectionTitle
                  accent
                  right={
                    <View style={styles.scopeRight}>
                      {scopeRead ? <Badge label="Escopo lido" color={c.success} /> : null}
                      <Icon name={scopeOpen ? "chevronUp" : "chevronDown"} size={20} color={c.inkMuted} />
                    </View>
                  }
                >
                  Escopo do serviço
                </SectionTitle>
                {!scopeOpen ? (
                  <Text style={styles.scopeHint}>
                    {scopeRead ? "Toque para ler de novo." : "Toque para ler o que deve ser feito. O aceite libera depois da leitura."}
                  </Text>
                ) : null}
              </Pressable>
              {scopeOpen ? (
                <Text style={styles.scopeText} selectable>
                  {description ?? "A central não escreveu o escopo. Tire as dúvidas no grupo antes de aceitar."}
                </Text>
              ) : null}
            </Card>
          </Animated.View>
        ) : null}

        {ticket.forms.length ? (
          <Animated.View entering={motion.entering(2)}>
            <Card style={{ gap: 8 }}>
              <SectionTitle accent>Formulários da OS</SectionTitle>
              <Text style={styles.cardHint}>Você preenche no app durante a visita.</Text>
              {ticket.forms.map((form, index) => (
                <View key={`${index}-${form.name}`} style={styles.formRow}>
                  <Icon name="note" size={16} color={c.inkMuted} />
                  <Text style={styles.formName}>{form.name}</Text>
                  <Badge label={form.required ? "Obrigatório" : "Opcional"} color={c.inkMuted} />
                </View>
              ))}
            </Card>
          </Animated.View>
        ) : null}

        {answerable ? <Text style={styles.help}>Dúvida no escopo? Fale com a central no grupo.</Text> : null}
      </ScrollView>

      {showBar ? (
        <View style={[styles.bar, { paddingBottom: insets.bottom + 12 }]} onLayout={(e) => setBarHeight(e.nativeEvent.layout.height)}>
          {answerable ? (
            <>
              {showProblem && problem ? <ErrorBox message={problem.message} /> : null}
              {acceptBlock ? (
                <View style={styles.barNote}>
                  <Icon name={blockIcon} size={14} color={c.inkMuted} />
                  <Text style={styles.barNoteText}>{acceptBlock}</Text>
                </View>
              ) : null}
              <View style={styles.barRow}>
                <Button
                  title="Recusar"
                  variant="ghost"
                  onPress={() => setDeclineOpen(true)}
                  disabled={!online || busy !== null}
                  loading={busy === "decline"}
                />
                {/* Travado: o leitor de tela anuncia o motivo junto com o botão. */}
                <View
                  style={{ flex: 1 }}
                  accessible={acceptBlock ? true : undefined}
                  accessibilityRole={acceptBlock ? "button" : undefined}
                  accessibilityLabel={acceptBlock ? acceptTitle : undefined}
                  accessibilityHint={acceptBlock ?? undefined}
                  accessibilityState={acceptBlock ? { disabled: true } : undefined}
                >
                  <Button
                    title={acceptTitle}
                    variant="primary"
                    onPress={() => void accept()}
                    disabled={Boolean(acceptBlock) || busy !== null}
                    loading={busy === "accept"}
                  />
                </View>
              </View>
            </>
          ) : goesToTicket ? (
            <Button title="Abrir a OS" variant="primary" onPress={openTicket} />
          ) : next ? (
            <Button title={`Ver a oferta nova · ${formatBRL(next.amount)}`} variant="primary" onPress={() => openNext(next.id)} />
          ) : null}
        </View>
      ) : null}

      <ActionSheet visible={declineOpen} title="Por que recusar?" actions={declineActions} onClose={() => setDeclineOpen(false)} />
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    content: { padding: 16, gap: 12 },
    topRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
    code: { flexShrink: 1, fontSize: 13, fontWeight: "700", color: c.inkMuted, fontVariant: ["tabular-nums"], letterSpacing: 0.3 },
    title: { fontSize: 20, fontWeight: "700", color: c.ink, lineHeight: 26, letterSpacing: -0.2 },
    service: { fontSize: 15, fontWeight: "600", color: c.inkMuted, lineHeight: 20 },
    amountBox: { backgroundColor: c.surface2, borderRadius: RADIUS.control, paddingHorizontal: 14, paddingVertical: 12, gap: 2 },
    amountLabel: { fontSize: 12, fontWeight: "700", color: c.inkMuted, textTransform: "uppercase", letterSpacing: 0.6 },
    amount: { fontSize: 30, fontWeight: "700", color: c.ink, letterSpacing: -0.5, fontVariant: ["tabular-nums"] },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: c.line },
    note: {
      gap: 6,
      padding: 14,
      borderRadius: RADIUS.card,
      backgroundColor: c.primarySoft,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: tint(c.primary, "40"),
    },
    noteHead: { flexDirection: "row", alignItems: "center", gap: 8 },
    noteTitle: { fontSize: 13, fontWeight: "700", color: c.brandInk, letterSpacing: 0.2 },
    noteText: { fontSize: 15, color: c.ink, lineHeight: 21 },
    scopeHead: { borderRadius: RADIUS.control, minHeight: 44 },
    scopeRight: { flexDirection: "row", alignItems: "center", gap: 8 },
    scopeHint: { fontSize: 13, color: c.inkMuted, lineHeight: 18 },
    scopeText: { fontSize: 15, color: c.ink, lineHeight: 21 },
    cardHint: { fontSize: 13, color: c.inkMuted, lineHeight: 18, marginTop: -4 },
    formRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      minHeight: 44,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: RADIUS.control,
      backgroundColor: c.surface2,
    },
    formName: { flex: 1, fontSize: 15, fontWeight: "600", color: c.ink },
    help: { fontSize: 13, color: c.inkMuted, lineHeight: 18, textAlign: "center", paddingVertical: 4 },
    bar: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      paddingHorizontal: 16,
      paddingTop: 12,
      gap: 8,
      backgroundColor: c.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.line,
      boxShadow: c.scheme === "dark" ? undefined : "0px -1px 3px rgba(0, 0, 0, 0.04)",
    },
    barRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    barNote: { flexDirection: "row", gap: 6, alignItems: "flex-start" },
    barNoteText: { fontSize: 13, color: c.inkMuted, lineHeight: 18, flex: 1 },
    missing: { flex: 1, justifyContent: "center", paddingHorizontal: 16, paddingVertical: 24, gap: 8 },
    missingActions: { gap: 10 },
  });
