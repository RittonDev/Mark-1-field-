import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View, type ScrollViewInstance } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ActionSheet, type SheetAction } from "../../components/ActionSheet";
import { StatusBadge } from "../../components/badges";
import { ConnectionBar } from "../../components/ConnectionBar";
import { FieldStepper } from "../../components/FieldStepper";
import { Icon, type IconName } from "../../components/Icon";
import { PressableScale, useListMotion, useSwapMotion } from "../../components/motion";
import { DetailSkeleton } from "../../components/Skeleton";
import { Text } from "../../components/Text";
import { reloadAttachments } from "../../components/ticket/attachments";
import { ArrivalResult, FieldClockLine, OnsiteTimer } from "../../components/ticket/FieldClock";
import { FormsCard, openForm, openSignature } from "../../components/ticket/FormsCard";
import { InfoPanel, ScopeCard, visitWindow } from "../../components/ticket/InfoPanel";
import { PartRequestSheet, PartRequestsCard, type PartPhoto } from "../../components/ticket/PartRequests";
import { capturePhotos, recoverCapture } from "../../components/ticket/photoCapture";
import { PhotosPanel } from "../../components/ticket/PhotosPanel";
import { hasRoute, routeAddress, RouteSheet } from "../../components/ticket/QuickActions";
import { ReportShareCard } from "../../components/ticket/ReportShareCard";
import { TimePanel } from "../../components/ticket/TimePanel";
import { HelperBadge, VisitNoteCard, VisitTeamCard } from "../../components/ticket/VisitInfo";
import { TransitionModal } from "../../components/TransitionModal";
import { Button, Card, EmptyState, Segmented } from "../../components/ui";
import { UnproductiveModal } from "../../components/UnproductiveModal";
import { api, ApiError, errorMessage } from "../../lib/api";
import { useLiveQuery } from "../../lib/changes";
import { dismissNotice, getAttachmentsCache, getTicket, listNotices, listPhotos, listSignatures, type Notice } from "../../lib/db";
import { notify } from "../../lib/dialogs";
import { concludeBlock, missingForConclusion, signatureBlock } from "../../lib/forms";
import { haptic } from "../../lib/haptics";
import { awaitingReschedule, isDone, isHelper } from "../../lib/lists";
import { UNPRODUCTIVE_FROM } from "../../lib/ops";
import { fieldActionLabel, takeConcludeIntent } from "../../lib/progress";
import { useSession } from "../../lib/session";
import { isOnline, queuePhoto, requestSync, storeServerTicket, useSyncStatus } from "../../lib/sync";
import type { LocalTicket } from "../../lib/syncTypes";
import { showToast } from "../../lib/toast";
import type { TicketDetail, TicketStatus, User } from "../../lib/types";
import { userCanTransition } from "../../lib/workflow";
import { RADIUS, useStyles, useTheme, type Palette } from "../../theme/theme";

type Tab = "info" | "time" | "photos";

/** Ordem das ações: o próximo passo do atendimento em campo vem primeiro. */
const ACTION_ORDER: TicketStatus[] = [
  "en_route",
  "in_progress",
  "resolved",
  "scheduled",
  "assigned",
  "on_hold_customer",
  "on_hold_vendor",
  "reopened",
  "triage",
  "closed",
  "new",
  "cancelled",
];
/** O técnico só anda com a visita: sai, inicia (ou retoma) e conclui. */
const PRIMARY: TicketStatus[] = ["en_route", "in_progress", "resolved"];
const STEP_ICON: Partial<Record<TicketStatus, IconName>> = {
  en_route: "navigate",
  in_progress: "pin",
  resolved: "checkCircle",
};
/** Antes de chegar, o atalho da barra é a rota; em atendimento, a câmera. */
const ROUTE_STATUSES: TicketStatus[] = ["assigned", "scheduled", "en_route", "reopened"];

const NOTICE_TITLE: Record<Notice["kind"], string> = {
  rejected: "A central não aceitou",
  conflict: "A OS mudou na central",
  photo: "Foto não enviada",
};

/** Próximo passo da barra fixa: o que falta para concluir (formulário, assinatura) vem antes do "Concluir OS". */
type NextStep =
  | { kind: "form"; formId: string; started: boolean }
  | { kind: "signature" }
  | { kind: "transition"; to: TicketStatus; blocked: string | null };

/** "2 fotos, a assinatura e 1 ação aguardando envio" (null quando nada espera). */
function pendingLabel(photos: number, signature: boolean, ops: number): string | null {
  const parts = [
    photos ? (photos === 1 ? "1 foto" : `${photos} fotos`) : null,
    signature ? "a assinatura" : null,
    ops ? (ops === 1 ? "1 ação" : `${ops} ações`) : null,
  ].filter((part): part is string => Boolean(part));
  if (!parts.length) return null;
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}` : parts[0];
  return `${list.charAt(0).toUpperCase()}${list.slice(1)} aguardando envio`;
}

export default function TicketScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = String(params.id);
  const { user } = useSession();
  const load = useCallback(() => getTicket(id), [id]);
  const ticket = useLiveQuery(load);
  if (!user) return null;
  if (ticket === undefined) return <DetailSkeleton />;
  if (ticket === null) return <MissingTicket id={id} />;
  return <TicketView key={ticket.id} ticket={ticket} user={user} />;
}

/**
 * A OS no aparelho do técnico: o básico da visita (cliente, endereço, quando e o escopo), o relógio de
 * campo e, na barra fixa, o próximo passo: "A caminho" → "Iniciar atendimento" → formulários e
 * assinatura que faltam → "Concluir OS". Tudo funciona sem sinal e sobe no próximo sync.
 */
function TicketView({ ticket: current, user }: { ticket: LocalTicket; user: User }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const motion = useListMotion();
  const swap = useSwapMotion();
  const online = isOnline(useSyncStatus());
  const scrollRef = useRef<ScrollViewInstance>(null);
  const ticketId = current.id;
  const loadSignatures = useCallback(() => listSignatures(ticketId), [ticketId]);
  const loadPhotos = useCallback(() => listPhotos(ticketId), [ticketId]);
  const loadAttachments = useCallback(() => getAttachmentsCache(ticketId), [ticketId]);
  // Lidos uma vez aqui e repassados aos cartões (formulários, fotos): cada mudança no aparelho não
  // repete as mesmas consultas em cada cartão.
  const pendingSignature = useLiveQuery(loadSignatures)?.[0] ?? null;
  const queuedRows = useLiveQuery(loadPhotos);
  const queued = queuedRows ?? [];
  const attachments = useLiveQuery(loadAttachments);
  const notices = (useLiveQuery(listNotices) ?? []).filter((n) => n.ticket_id === ticketId);
  const [tab, setTab] = useState<Tab>("info");
  const [target, setTarget] = useState<TicketStatus | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [routeOpen, setRouteOpen] = useState(false);
  const [unproductiveOpen, setUnproductiveOpen] = useState(false);
  /** Folha "Pedir peça" aberta (com as fotos já escolhidas, quando recuperadas). */
  const [part, setPart] = useState<PartPhoto[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [barHeight, setBarHeight] = useState(0);
  const [concludeAsked, setConcludeAsked] = useState(false);

  // Assinatura colhida com a OS em atendimento: ao voltar, a conclusão abre direto se nada mais faltar.
  useFocusEffect(
    useCallback(() => {
      if (!takeConcludeIntent(ticketId)) return;
      // Espera a volta da tela de assinatura terminar antes de abrir a folha; a tela leva um instante
      // para enxergar a assinatura na fila e, se ainda faltar algo, desiste.
      const start = setTimeout(() => setConcludeAsked(true), 400);
      const stop = setTimeout(() => setConcludeAsked(false), 2400);
      return () => {
        clearTimeout(start);
        clearTimeout(stop);
      };
    }, [ticketId]),
  );

  // Anexos da OS atualizados ao abrir (e quando a conexão volta): a contagem de fotos dos formulários
  // e da aba Fotos fica certa mesmo com fotos enviadas por outro aparelho.
  useEffect(() => {
    if (online) reloadAttachments(ticketId).catch(() => undefined);
  }, [online, ticketId]);

  // Foto tirada antes de o Android fechar o app com a câmera aberta (aparelho com pouca memória).
  useEffect(() => {
    let alive = true;
    recoverCapture((shot) => shot.ticketId === ticketId)
      .then(async (found) => {
        if (!found) return;
        const { target: shot, assets } = found;
        if (shot.kind === "part" && alive) {
          setPart(assets.map((asset) => ({ uri: asset.uri, mimeType: asset.mimeType })));
          showToast("Foto recuperada", { tone: "success", description: "O app fechou com a câmera aberta. Complete o pedido de peça." });
          return;
        }
        const field = shot.kind === "form" ? { formId: shot.formId, fieldId: shot.fieldId } : undefined;
        for (const asset of assets) await queuePhoto(ticketId, asset.uri, asset.mimeType, field);
        showToast("Foto recuperada", {
          tone: "success",
          description: field
            ? "A foto tirada antes de o app fechar foi guardada no formulário."
            : "A foto tirada antes de o app fechar foi guardada nas fotos da OS.",
        });
      })
      .catch((error: unknown) => console.warn("Não foi possível recuperar a foto", error));
    return () => {
      alive = false;
    };
  }, [ticketId]);

  // O que o servidor liberou, conferido também pela regra do técnico (OS guardada no aparelho antes de
  // uma mudança de regra pode trazer a lista antiga): ele só sai, inicia e conclui.
  const actions = current.allowed_transitions
    .filter((to) => userCanTransition(user, current, to))
    .sort((a, b) => ACTION_ORDER.indexOf(a) - ACTION_ORDER.indexOf(b));
  const primary = actions.find((s) => PRIMARY.includes(s)) ?? null;
  // O técnico só trabalha nas OS atribuídas a ele pelo analista (não há "assumir").
  const isMine = current.assignee?.id === user.id;
  // Auxiliar da visita: vê a OS e manda fotos; status, formulários e assinatura são do responsável.
  const helping = isHelper(current, user);
  const hasPendingSignature = Boolean(pendingSignature);
  const signed = Boolean(current.signed_at) || hasPendingSignature;
  const missing = missingForConclusion(current, hasPendingSignature);
  // Formulário obrigatório incluído pela central depois da assinatura: o técnico não destrava sozinho.
  const formAfterSignature = signed && missing.forms.length > 0;
  // Concluir espera os formulários obrigatórios e, se pedida, a assinatura.
  const conclude = formAfterSignature
    ? "A central incluiu um formulário depois da assinatura: fale com a central no grupo."
    : concludeBlock(current, hasPendingSignature);
  const blockedFor = (to: TicketStatus) => ((to === "resolved" || to === "closed") && conclude ? conclude : null);
  const canRequestPart = isMine && !isDone(current.status);
  // Visita improdutiva: só o responsável, com a OS atribuída, agendada, em deslocamento ou em atendimento.
  const canUnproductive = isMine && UNPRODUCTIVE_FROM.includes(current.status);
  const showBar = isMine && (actions.length > 0 || canUnproductive || canRequestPart);

  // A barra leva ao que falta, na ordem do atendimento, em vez de mostrar "Concluir" travado.
  let next: NextStep | null = null;
  if (primary === "resolved" && !formAfterSignature && missing.forms.length) {
    next = { kind: "form", formId: missing.forms[0].id, started: missing.forms[0].status === "in_progress" };
  } else if (primary === "resolved" && missing.signature && !signatureBlock(current)) {
    next = { kind: "signature" };
  } else if (primary) {
    next = { kind: "transition", to: primary, blocked: blockedFor(primary) };
  }
  const blocked = next?.kind === "transition" ? next.blocked : null;
  const missingNames = [...missing.forms.map((f) => f.name), ...(missing.signature ? ["Assinatura"] : [])];
  const barNote = blocked ?? (primary === "resolved" && missingNames.length ? `Falta: ${missingNames.join(" · ")}` : null);

  // Voltou da assinatura com a intenção de concluir: abre a conclusão assim que ela estiver liberada.
  if (concludeAsked && next?.kind === "transition" && next.to === "resolved" && !next.blocked && !target) {
    setConcludeAsked(false);
    setTarget("resolved");
  }

  const routable = hasRoute(current);
  const shortcut: { label: string; icon: IconName; hint: string; busy: boolean; onPress: () => void } | null =
    ROUTE_STATUSES.includes(current.status) && routable
      ? { label: "Rota", icon: "navigate", hint: "Abre a rota no app de mapas", busy: false, onPress: () => setRouteOpen(true) }
      : current.status === "in_progress"
        ? { label: "Foto", icon: "camera", hint: "Tira uma foto do atendimento", busy: photoBusy, onPress: () => void takePhoto() }
        : null;

  const site = current.location ? [current.location.code, current.location.name].filter(Boolean).join(" · ") : null;
  const client = [current.customer?.name, site].filter(Boolean).join(" · ");
  const address = routeAddress(current);
  const when = visitWindow(current);
  const waitingReschedule = awaitingReschedule(current);
  const pending = pendingLabel(queued.length, hasPendingSignature, current.pending_ops);
  // Pendência só ganha cor quando o envio já falhou (o normal é esperar a conexão).
  const failing = queued.some((p) => p.attempts > 0 && Boolean(p.last_error)) || Boolean(pendingSignature?.last_error);
  const photoCount = (attachments ?? []).filter((a) => a.kind === "photo").length + queued.length;

  async function refresh() {
    setRefreshing(true);
    await requestSync({ manual: true }).catch(() => undefined);
    setRefreshing(false);
    if (!isOnline()) {
      showToast("Sem conexão", { description: "Tudo o que você fez fica salvo no aparelho e vai para a central quando a conexão voltar." });
    }
  }

  function open(to: TicketStatus) {
    if (blockedFor(to)) {
      haptic.warning();
      return;
    }
    setTarget(to);
  }

  function runNext() {
    if (!next) return;
    if (next.kind === "form") openForm(ticketId, next.formId);
    else if (next.kind === "signature") openSignature(ticketId);
    else open(next.to);
  }

  async function takePhoto() {
    setPhotoBusy(true);
    try {
      const assets = await capturePhotos("camera", { kind: "loose", ticketId });
      for (const asset of assets) await queuePhoto(ticketId, asset.uri, asset.mimeType);
      if (assets.length) {
        showToast("Foto guardada", {
          tone: "success",
          description: isOnline() ? "Vai para a central em seguida. Ela aparece na aba Fotos." : "Vai para a central quando houver conexão.",
        });
      }
    } catch (error) {
      notify("Não foi possível guardar a foto", errorMessage(error));
    } finally {
      setPhotoBusy(false);
    }
  }

  /** Saiu para o atendimento: a rota já abre. Concluiu: o relatório para o cliente aparece no topo. */
  function afterTransition(to: TicketStatus) {
    if (to === "en_route" && routable) setRouteOpen(true);
    if (to === "resolved") scrollRef.current?.scrollTo({ y: 0, animated: true });
  }

  const others = actions.filter((to) => to !== primary);
  const sheetActions: SheetAction[] = [
    ...others.map((to) => ({
      key: to,
      label: fieldActionLabel(to, current),
      icon: STEP_ICON[to] ?? ("chevronRight" as IconName),
      disabledReason: blockedFor(to),
      right: <StatusBadge status={to} />,
      onPress: () => open(to),
    })),
    ...(canRequestPart ? [{ key: "part", label: "Pedir peça", icon: "package" as IconName, onPress: () => setPart([]) }] : []),
    ...(canUnproductive
      ? [
          {
            key: "unproductive",
            label: "Visita improdutiva",
            icon: "alert" as IconName,
            tone: "danger" as const,
            onPress: () => setUnproductiveOpen(true),
          },
        ]
      : []),
  ];

  const primaryTitle =
    next?.kind === "form"
      ? next.started
        ? "Continuar formulário"
        : "Preencher formulário"
      : next?.kind === "signature"
        ? "Colher assinatura"
        : next
          ? fieldActionLabel(next.to, current)
          : "";
  // Com o atalho ao lado (que já tem ícone), o botão principal fica só com o texto e cabe em telas estreitas.
  const primaryIcon: IconName | undefined =
    shortcut || !next ? undefined : next.kind === "form" ? "note" : next.kind === "signature" ? "user" : STEP_ICON[next.to];

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: current.code }} />
      <ConnectionBar />
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: showBar ? (barHeight || 120 + insets.bottom) + 16 : insets.bottom + 24 },
        ]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} colors={[c.primary]} tintColor={c.primary} />}
      >
        <Animated.View entering={motion.entering(0)}>
          <Card style={{ gap: 12 }}>
            <View style={styles.topRow}>
              <Text style={styles.code} numberOfLines={1}>
                {current.code}
              </Text>
              <Animated.View key={current.status} entering={swap.entering} exiting={swap.exiting}>
                <StatusBadge status={current.status} />
              </Animated.View>
            </View>
            <Text style={styles.title} selectable accessibilityRole="header">
              {current.title}
            </Text>
            {client || address || when ? (
              <View style={{ gap: 6 }}>
                {client ? (
                  <View style={styles.line}>
                    <Icon name="building" size={16} color={c.inkMuted} />
                    <Text style={styles.lineStrong} numberOfLines={2}>
                      {client}
                    </Text>
                  </View>
                ) : null}
                {address ? (
                  // Tocar no endereço abre a rota (Google Maps, Waze, o app do aparelho ou copiar).
                  <Pressable
                    onPress={() => setRouteOpen(true)}
                    accessibilityRole="button"
                    accessibilityLabel={`Endereço: ${address}`}
                    accessibilityHint="Abre a rota no app de mapas"
                    style={({ pressed }) => [styles.addressRow, pressed && { backgroundColor: c.surface2 }]}
                  >
                    <Icon name="pin" size={16} color={c.inkMuted} />
                    <Text style={styles.lineText} numberOfLines={2}>
                      {address}
                    </Text>
                    <View style={styles.addressGo}>
                      <Icon name="navigate" size={16} color={c.brandInk} strokeWidth={2} />
                    </View>
                  </Pressable>
                ) : null}
                {when ? (
                  <View style={styles.line}>
                    <Icon name="clock" size={16} color={c.inkMuted} />
                    <Text style={[styles.lineText, styles.tabular]}>{when}</Text>
                  </View>
                ) : null}
              </View>
            ) : null}
            {helping ? (
              <View style={styles.badges}>
                <HelperBadge />
              </View>
            ) : null}
            {/* Promessa de campo: prazo de chegada e resultado do check-in (sem prazo enquanto espera a central reagendar). */}
            {current.arrived_at ? (
              <ArrivalResult ticket={current} />
            ) : waitingReschedule ? null : (
              <FieldClockLine ticket={current} size={14} />
            )}
            <View style={styles.divider} />
            <FieldStepper ticket={current} />
            <OnsiteTimer ticket={current} />
            {waitingReschedule ? (
              <View style={styles.statusLine}>
                <Icon name="calendar" size={16} color={c.inkMuted} />
                <Text style={styles.statusText}>Visita improdutiva: aguardando a central reagendar.</Text>
              </View>
            ) : null}
            {pending ? (
              <Pressable
                onPress={() => router.push("/conta")}
                accessibilityRole="button"
                accessibilityHint="Abre as pendências na tela Conta"
                hitSlop={6}
                style={styles.statusLine}
              >
                <Icon name={failing ? "alert" : "repeat"} size={16} color={failing ? c.warningInk : c.inkMuted} />
                <Text style={[styles.statusText, failing && styles.statusFailing]}>
                  {pending}
                  {online ? "" : " (sem conexão)"}
                </Text>
                <Icon name="chevronRight" size={16} color={c.inkMuted} />
              </Pressable>
            ) : null}
          </Card>
        </Animated.View>

        {/* Ação que a central não aceitou: explica por que a OS "voltou". */}
        {notices.map((notice) => (
          <NoticeRow key={notice.id} notice={notice} />
        ))}

        {/* Concluída: o próximo passo é mandar o relatório ao cliente. */}
        {isMine && (current.status === "resolved" || current.status === "closed") ? (
          <Animated.View entering={motion.entering(1)}>
            <ReportShareCard ticket={current} />
          </Animated.View>
        ) : null}

        {/* Recado do analista e o que fazer na visita: o que o técnico mais consulta ao chegar. */}
        <VisitNoteCard note={current.visit_note} />
        <Animated.View entering={motion.entering(1)}>
          <ScopeCard ticket={current} />
        </Animated.View>
        <VisitTeamCard ticket={current} userId={user.id} />

        {isMine ? (
          <Animated.View entering={motion.entering(2)} style={{ gap: 12 }}>
            <FormsCard ticket={current} attachments={attachments ?? []} pendingPhotos={queued} pendingSignature={pendingSignature} />
            <PartRequestsCard ticket={current} canRequest={canRequestPart} onRequest={() => setPart([])} />
          </Animated.View>
        ) : helping ? (
          <>
            <Card>
              <Text style={styles.meta}>
                Você vai junto nesta visita. Iniciar, concluir, formulários e assinatura ficam com{" "}
                {current.assignee?.name ?? "o responsável"}. Aqui você vê a OS e manda fotos.
              </Text>
            </Card>
            <PartRequestsCard ticket={current} canRequest={false} onRequest={() => undefined} />
          </>
        ) : (
          <Card>
            <Text style={styles.meta}>Esta OS não está atribuída a você. Só o responsável definido pelo analista pode atualizá-la.</Text>
          </Card>
        )}

        <Animated.View entering={motion.entering(3)} style={{ gap: 12 }}>
          <Segmented<Tab>
            value={tab}
            onChange={setTab}
            options={[
              { value: "info", label: "Detalhes" },
              { value: "time", label: "Tempo" },
              { value: "photos", label: "Fotos", count: photoCount || undefined },
            ]}
          />
          {tab === "info" ? <InfoPanel ticket={current} userId={user.id} /> : null}
          {tab === "time" ? <TimePanel ticket={current} /> : null}
          {tab === "photos" ? <PhotosPanel ticket={current} pending={queuedRows} cached={attachments} /> : null}
        </Animated.View>
      </ScrollView>

      {showBar ? (
        <View style={[styles.bar, { paddingBottom: insets.bottom + 12 }]} onLayout={(e) => setBarHeight(e.nativeEvent.layout.height)}>
          {barNote ? (
            <View style={styles.barNote}>
              <Icon name={blocked ? "lock" : "note"} size={14} color={c.inkMuted} />
              <Text style={styles.barNoteText}>{barNote}</Text>
            </View>
          ) : null}
          <View style={styles.barRow}>
            {next && sheetActions.length > 0 ? (
              <PressableScale
                onPress={() => setSheetOpen(true)}
                accessibilityRole="button"
                accessibilityLabel="Mais ações"
                style={styles.more}
                pressedStyle={{ backgroundColor: c.surface2 }}
              >
                <Icon name="more" size={22} color={c.ink} strokeWidth={2.4} />
              </PressableScale>
            ) : null}
            {shortcut ? (
              <PressableScale
                onPress={shortcut.onPress}
                disabled={shortcut.busy}
                accessibilityRole="button"
                accessibilityLabel={shortcut.label}
                accessibilityHint={shortcut.hint}
                accessibilityState={{ disabled: shortcut.busy }}
                style={[styles.shortcut, shortcut.busy && styles.shortcutBusy]}
                pressedStyle={{ backgroundColor: c.surface2 }}
              >
                <Icon name={shortcut.icon} size={20} color={c.ink} strokeWidth={2.2} />
                <Text style={styles.shortcutText}>{shortcut.label}</Text>
              </PressableScale>
            ) : null}
            {next ? (
              // Travado: o leitor de tela anuncia o motivo junto com o botão.
              <View
                style={{ flex: 1 }}
                accessible={blocked ? true : undefined}
                accessibilityRole={blocked ? "button" : undefined}
                accessibilityLabel={blocked ? primaryTitle : undefined}
                accessibilityHint={blocked ?? undefined}
                accessibilityState={blocked ? { disabled: true } : undefined}
              >
                <Button title={primaryTitle} icon={primaryIcon} variant="primary" onPress={runNext} disabled={Boolean(blocked)} />
              </View>
            ) : (
              <Button title="Ações da OS" onPress={() => setSheetOpen(true)} style={{ flex: 1 }} />
            )}
          </View>
        </View>
      ) : null}

      <ActionSheet visible={sheetOpen} title={`Ações · ${current.code}`} actions={sheetActions} onClose={() => setSheetOpen(false)} />
      <RouteSheet ticket={current} visible={routeOpen} onClose={() => setRouteOpen(false)} />
      {target ? (
        <TransitionModal key={target} ticket={current} to={target} onClose={() => setTarget(null)} onDone={afterTransition} />
      ) : null}
      {unproductiveOpen ? <UnproductiveModal ticket={current} onClose={() => setUnproductiveOpen(false)} /> : null}
      {part ? <PartRequestSheet ticket={current} initialPhotos={part} onClose={() => setPart(null)} /> : null}
    </View>
  );
}

/** Aviso de uma ação desta OS que a central não aceitou (fica até o técnico tocar em OK). */
function NoticeRow({ notice }: { notice: Notice }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.notice} accessibilityRole="alert">
      <Icon name="alert" size={18} color={c.dangerInk} strokeWidth={2} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.noticeTitle}>{NOTICE_TITLE[notice.kind] ?? "Aviso"}</Text>
        <Text style={styles.noticeText}>{notice.message}</Text>
      </View>
      <Button compact variant="ghost" title="OK" onPress={() => void dismissNotice(notice.id)} />
    </View>
  );
}

/**
 * A OS ainda não está no aparelho (aberta por um aviso antes do sync, por exemplo): sincroniza e, se
 * ainda faltar, busca direto na central. Sem conexão, espera ela voltar.
 */
function MissingTicket({ id }: { id: string }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const online = isOnline(useSyncStatus());
  const [attempt, setAttempt] = useState(0);
  /** Resultado da busca: `message` null = a OS não está disponível para este técnico. */
  const [outcome, setOutcome] = useState<{ attempt: number; message: string | null } | null>(null);

  useEffect(() => {
    if (!online) return;
    let alive = true;
    void (async () => {
      await requestSync({ manual: attempt > 0 }).catch(() => undefined);
      if (!alive || (await getTicket(id))) return;
      try {
        await storeServerTicket(await api.get<TicketDetail>(`/tickets/${id}`));
        if (alive && !(await getTicket(id))) setOutcome({ attempt, message: null });
      } catch (error) {
        if (!alive) return;
        const gone = error instanceof ApiError && (error.status === 403 || error.status === 404);
        setOutcome({ attempt, message: gone ? null : errorMessage(error) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, online, attempt]);

  const searching = online && outcome?.attempt !== attempt;
  return (
    <View style={styles.screen}>
      <ConnectionBar />
      <View style={styles.missing}>
        {searching ? (
          <View style={styles.searching} accessibilityLiveRegion="polite">
            <ActivityIndicator color={c.inkMuted} />
            <Text style={styles.searchingTitle}>Buscando a OS…</Text>
            <Text style={styles.meta}>Ela ainda não estava neste aparelho.</Text>
          </View>
        ) : !online ? (
          <EmptyState
            icon="wifiOff"
            title="A OS ainda não chegou ao aparelho"
            description="Sem conexão. Ela aparece aqui assim que o aparelho sincronizar."
          />
        ) : outcome?.message ? (
          <EmptyState icon="alert" title="Não foi possível buscar a OS" description={outcome.message} />
        ) : (
          <EmptyState
            icon="alert"
            title="OS não disponível para você"
            description="Ela pode ter sido reatribuída a outro técnico ou cancelada. Em caso de dúvida, fale com a central no grupo."
          />
        )}
        <View style={styles.missingActions}>
          {online && !searching ? <Button title="Tentar de novo" icon="repeat" variant="primary" onPress={() => setAttempt((n) => n + 1)} /> : null}
          <Button title="Voltar para a lista" onPress={() => router.replace("/")} />
        </View>
      </View>
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
    line: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
    lineStrong: { fontSize: 14, fontWeight: "600", color: c.ink, flex: 1, lineHeight: 20 },
    lineText: { fontSize: 14, color: c.inkMuted, flex: 1, lineHeight: 20 },
    // Linha do endereço tocável: área de 44 pt sem mudar o alinhamento das outras linhas.
    addressRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      minHeight: 44,
      marginVertical: -6,
      marginHorizontal: -6,
      paddingHorizontal: 6,
      borderRadius: RADIUS.control,
    },
    addressGo: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: c.primarySoft,
      alignItems: "center",
      justifyContent: "center",
    },
    tabular: { fontVariant: ["tabular-nums"] },
    badges: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: c.line, marginVertical: 4 },
    meta: { fontSize: 14, color: c.inkMuted, lineHeight: 20 },
    statusLine: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32 },
    statusText: { flex: 1, fontSize: 13, color: c.inkMuted, lineHeight: 18 },
    statusFailing: { color: c.warningInk, fontWeight: "600" },
    notice: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 10,
      padding: 12,
      borderRadius: RADIUS.card,
      backgroundColor: c.dangerSoft,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.lineStrong,
    },
    noticeTitle: { fontSize: 14, fontWeight: "700", color: c.dangerInk, lineHeight: 20 },
    noticeText: { fontSize: 14, color: c.ink, lineHeight: 20 },
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
    more: {
      width: 48,
      height: 48,
      borderRadius: RADIUS.control,
      borderWidth: 1,
      borderColor: c.lineStrong,
      backgroundColor: c.surface,
      alignItems: "center",
      justifyContent: "center",
    },
    shortcut: {
      minWidth: 60,
      height: 48,
      paddingHorizontal: 10,
      borderRadius: RADIUS.control,
      borderWidth: 1,
      borderColor: c.lineStrong,
      backgroundColor: c.surface,
      alignItems: "center",
      justifyContent: "center",
      gap: 1,
    },
    shortcutBusy: { opacity: 0.5 },
    shortcutText: { fontSize: 12, fontWeight: "700", color: c.ink },
    barNote: { flexDirection: "row", gap: 6, alignItems: "flex-start" },
    barNoteText: { fontSize: 13, color: c.inkMuted, lineHeight: 18, flex: 1 },
    missing: { flex: 1, justifyContent: "center", paddingHorizontal: 16, paddingVertical: 24, gap: 8 },
    searching: { alignItems: "center", gap: 8, paddingVertical: 32 },
    searchingTitle: { fontSize: 16, fontWeight: "700", color: c.ink },
    missingActions: { gap: 10 },
  });
