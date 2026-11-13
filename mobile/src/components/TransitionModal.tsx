import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { distanceMeters, formatDistance, siteCoords } from "../lib/address";
import { errorMessage } from "../lib/api";
import { useLiveQuery, useNow } from "../lib/changes";
import { STATUS } from "../lib/constants";
import { getAttachmentsCache, listPhotos, listSignatures, listTickets } from "../lib/db";
import { dayMonth, dayOffset } from "../lib/field";
import { haptic } from "../lib/haptics";
import { fieldActionLabel } from "../lib/progress";
import { useSession } from "../lib/session";
import { showSuccess } from "../lib/success";
import { enqueueTransition, isOnline, queuePhoto, useSyncStatus } from "../lib/sync";
import type { LocalTicket } from "../lib/syncTypes";
import { showToast } from "../lib/toast";
import type { TicketStatus, TicketTransitionPayload } from "../lib/types";
import { RADIUS, useStyles, useTheme, type Palette } from "../theme/theme";
import { BottomSheet } from "./ActionSheet";
import { StatusBadge } from "./badges";
import { Icon, type IconName } from "./Icon";
import { Text } from "./Text";
import { LocationLine, useLocationFix } from "./ticket/LocationLine";
import { capturePhotos } from "./ticket/photoCapture";
import { SheetScaffold } from "./ticket/SheetScaffold";
import { toneInk } from "./ticket/tones";
import { Button, ErrorBox, Field, Input } from "./ui";

/** O que a ação faz, em uma frase para o técnico. */
const FIELD_HINT: Partial<Record<TicketStatus, string>> = {
  en_route: "A central vê que você está a caminho. O prazo de chegada continua contando.",
  in_progress: "Registra sua chegada e começa a contar o tempo na loja.",
};
const RESUME_HINT = "Volta a contar o tempo do atendimento.";

/** Solução curta demais ("ok") não diz nada ao cliente no relatório. */
const MIN_RESOLUTION = 10;
/** Acima disso (descontada a imprecisão do GPS), o técnico provavelmente ainda não está na loja. */
const FAR_METERS = 1000;

// Texto da solução digitado e não enviado (o modal fechou pelo voltar): volta ao reabrir.
const resolutionDrafts = new Map<string, string>();

type Phase = "idle" | "locating" | "saving";

/**
 * Confirma a mudança de status do técnico. Sair e chegar são uma confirmação curta (folha inferior)
 * com a localização já buscada; concluir pede a solução que vai ao relatório e mostra o resumo do
 * que o cliente vai ver. O técnico nunca mexe no horário e não manda recado por aqui (a conversa com
 * a central é no grupo). A mudança entra na fila local e vale na hora, mesmo sem conexão.
 * `onDone` roda depois que a folha saiu da tela (para abrir a rota, por exemplo).
 */
export function TransitionModal({
  ticket,
  to,
  onClose,
  onDone,
}: {
  ticket: LocalTicket;
  to: TicketStatus;
  onClose: () => void;
  onDone?: (to: TicketStatus) => void;
}) {
  const styles = useStyles(makeStyles);
  const online = isOnline(useSyncStatus());
  const userId = useSession().user?.id;
  const now = useNow(60_000);
  const location = useLocationFix();
  const [open, setOpen] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [resolution, setResolution] = useState(() => resolutionDrafts.get(ticket.id) ?? "");
  const [others, setOthers] = useState<LocalTicket[]>([]);
  const finished = useRef(false);
  const cancelled = useRef(false);
  const skipWait = useRef<(() => void) | null>(null);
  const openAfter = useRef<string | null>(null);
  const concluding = to === "resolved";
  const fieldStep = to === "en_route" || to === "in_progress";
  const label = fieldActionLabel(to, ticket);

  // Outra OS do técnico ainda em deslocamento ou em atendimento: o tempo dela segue correndo.
  useEffect(() => {
    if (!fieldStep || !userId) return;
    let alive = true;
    void listTickets().then((list) => {
      if (!alive) return;
      setOthers(
        list.filter((t) => t.id !== ticket.id && t.assignee?.id === userId && (t.status === "en_route" || t.status === "in_progress")),
      );
    });
    return () => {
      alive = false;
    };
  }, [fieldStep, ticket.id, userId]);

  // Resumo do que vai ao cliente (só na conclusão).
  const loadPhotos = useCallback(() => listPhotos(ticket.id), [ticket.id]);
  const loadAttachments = useCallback(() => getAttachmentsCache(ticket.id), [ticket.id]);
  const loadSignatures = useCallback(() => listSignatures(ticket.id), [ticket.id]);
  const queued = useLiveQuery(loadPhotos) ?? [];
  const attachments = useLiveQuery(loadAttachments) ?? [];
  const pendingSignature = useLiveQuery(loadSignatures)?.[0] ?? null;

  const fix = location.fix;
  const site = siteCoords(ticket.location, ticket.service_address);
  const distance = site && fix?.status === "ok" ? distanceMeters(fix, site) : null;
  const checksPlace = to === "in_progress" || concluding;
  const far = checksPlace && distance !== null && distance - (fix?.status === "ok" ? (fix.accuracy ?? 0) : 0) > FAR_METERS;
  const place = checksPlace && distance !== null && !far ? `No local (a ${formatDistance(distance)} da loja)` : null;
  const futureVisit = fieldStep && ticket.scheduled_start && dayOffset(ticket.scheduled_start, now) > 0 ? ticket.scheduled_start : null;

  function close() {
    if (phase === "saving") return;
    if (phase === "locating") {
      // Voltar enquanto busca o GPS cancela: a ação não é registrada.
      cancelled.current = true;
      skipWait.current?.();
    }
    if (concluding && resolution.trim()) resolutionDrafts.set(ticket.id, resolution);
    setOpen(false);
  }

  function closed() {
    onClose();
    if (finished.current) onDone?.(to);
    const next = openAfter.current;
    if (next) router.push({ pathname: "/ticket/[id]", params: { id: next } });
  }

  function openOther(id: string) {
    openAfter.current = id;
    close();
  }

  async function confirm() {
    setError(null);
    const text = resolution.trim();
    if (concluding && text.length < MIN_RESOLUTION) {
      haptic.warning();
      setError(`Descreva a solução aplicada em uma frase (mínimo de ${MIN_RESOLUTION} letras).`);
      return;
    }
    cancelled.current = false;
    setPhase("locating");
    const position = await Promise.race([
      location.wait(),
      new Promise<null>((resolve) => {
        skipWait.current = () => resolve(null);
      }),
    ]);
    skipWait.current = null;
    if (cancelled.current) return;
    setPhase("saving");
    const payload: TicketTransitionPayload = { to_status: to };
    if (concluding) payload.resolution_notes = text;
    if (position?.status === "ok") {
      payload.latitude = position.latitude;
      payload.longitude = position.longitude;
    }
    try {
      await enqueueTransition(ticket.id, payload);
    } catch (e) {
      setError(errorMessage(e));
      setPhase("idle");
      return;
    }
    resolutionDrafts.delete(ticket.id);
    const noGps = position?.status === "ok" ? null : "Registrado sem localização.";
    const offline = online ? null : "Salvo no aparelho; vai para a central quando houver conexão.";
    if (concluding) {
      haptic.success();
      showSuccess("OS concluída", offline ?? `${ticket.code} enviada para a central.`);
      if (noGps) showToast(ticket.code, { description: noGps });
    } else {
      haptic.step();
      showToast(`${ticket.code} → ${STATUS[to].label}`, { tone: "success", description: noGps ?? offline ?? undefined });
    }
    finished.current = true;
    setOpen(false);
  }

  const busy = phase !== "idle";
  const confirmTitle =
    phase === "locating" ? "Obtendo localização…" : far ? (concluding ? "Concluir mesmo assim" : "Confirmar mesmo assim") : concluding ? label : "Confirmar";

  const warnings: ReactNode[] = [];
  if (others.length) {
    const other = others[0];
    warnings.push(
      <Notice key="other" icon="alert">
        <Text style={styles.noticeText}>
          {`A ${other.code} ainda está ${STATUS[other.status].label.toLowerCase()}`}
          {others.length > 1 ? ` (e mais ${others.length - 1})` : ""}. Conclua antes ou confirme mesmo assim.
        </Text>
        <Button title={`Abrir ${other.code}`} compact onPress={() => openOther(other.id)} style={{ alignSelf: "flex-start" }} />
      </Notice>,
    );
  }
  if (futureVisit) {
    warnings.push(
      <Notice key="date" icon="calendar">
        <Text style={styles.noticeText}>Esta visita está marcada para {dayMonth(futureVisit)}.</Text>
      </Notice>,
    );
  }
  if (far && distance !== null) {
    warnings.push(
      <Notice key="far" icon="pin">
        <Text style={styles.noticeText}>
          Você está a {formatDistance(distance)} da loja.{" "}
          {concluding ? "Conclua no local sempre que possível." : "Confirme só se já chegou."}
        </Text>
      </Notice>,
    );
  }

  const locationBlock = (
    <View style={{ gap: 4 }}>
      <LocationLine fix={fix} place={place} onAllow={() => void location.allow()} />
      {phase === "locating" ? (
        <Pressable onPress={() => skipWait.current?.()} hitSlop={8} accessibilityRole="button" style={styles.skip}>
          <Text style={styles.skipText}>Seguir sem localização</Text>
        </Pressable>
      ) : null}
    </View>
  );

  const actions = (
    <>
      <Button title="Voltar" onPress={close} disabled={phase === "saving"} style={{ flex: 1 }} />
      <Button title={confirmTitle} variant="primary" onPress={() => void confirm()} loading={busy} style={{ flex: concluding ? 1.4 : 1.6 }} />
    </>
  );

  if (!concluding) {
    return (
      <BottomSheet visible={open} onClose={close} onClosed={closed} locked={phase === "saving"}>
        <View style={styles.compact}>
          <View style={{ gap: 8 }}>
            <Text style={styles.title} accessibilityRole="header">
              {label}
            </Text>
            <Flow ticket={ticket} to={to} />
            <Text style={styles.description}>{to === "in_progress" && ticket.arrived_at ? RESUME_HINT : (FIELD_HINT[to] ?? STATUS[to].description)}</Text>
          </View>
          {warnings}
          {locationBlock}
          {error ? <ErrorBox message={error} /> : null}
          <View style={styles.compactActions}>{actions}</View>
        </View>
      </BottomSheet>
    );
  }

  // Conclusão: o que vai no relatório do cliente.
  const forms = ticket.forms ?? [];
  const formsDone = forms.filter((f) => f.status === "completed").length;
  const photosSent = attachments.filter((a) => a.kind === "photo").length;
  const photosQueued = queued.length;
  const photoTotal = photosSent + photosQueued;
  const partsWaiting = (ticket.part_requests ?? []).filter((p) => p.status === "open" || p.status === "quoted").length;

  async function takePhoto() {
    const assets = await capturePhotos("camera", { kind: "loose", ticketId: ticket.id });
    for (const asset of assets) await queuePhoto(ticket.id, asset.uri, asset.mimeType);
  }

  return (
    <SheetScaffold
      visible={open}
      title={label}
      code={ticket.code}
      header={<Flow ticket={ticket} to={to} />}
      onRequestClose={close}
      onClosed={closed}
      footer={actions}
    >
      <View style={styles.summary}>
        <Text style={styles.summaryTitle}>Antes de concluir</Text>
        {forms.length ? (
          <SummaryRow icon="note" text={`Formulários: ${formsDone} de ${forms.length} ${forms.length === 1 ? "concluído" : "concluídos"}`} />
        ) : null}
        {pendingSignature ? (
          <SummaryRow icon="checkCircle" text={`Assinatura: ${pendingSignature.signer_name} (aguardando envio)`} />
        ) : ticket.signed_at ? (
          <SummaryRow icon="checkCircle" text={`Assinatura: ${ticket.signer_name ?? "colhida"}`} />
        ) : null}
        {photoTotal ? (
          <SummaryRow
            icon="camera"
            text={`Fotos: ${photoTotal}${photosQueued ? ` (${photosQueued} na fila)` : ""}`}
          />
        ) : (
          <View style={{ gap: 8 }}>
            <SummaryRow icon="alert" tone="warning" text="Nenhuma foto do atendimento. O relatório do cliente vai sem fotos." />
            <Button title="Tirar foto" icon="camera" compact onPress={() => void takePhoto()} style={{ alignSelf: "flex-start" }} />
          </View>
        )}
        {partsWaiting ? (
          <SummaryRow
            icon="package"
            text={`Peças: ${partsWaiting} ${partsWaiting === 1 ? "pedido aguardando" : "pedidos aguardando"} orçamento ou aprovação`}
          />
        ) : null}
      </View>
      <Field label="Solução aplicada" required hint="O cliente vê este texto no relatório.">
        <Input
          value={resolution}
          onChangeText={setResolution}
          multiline
          editable={!busy}
          placeholder="O que foi feito? Ex.: troca da fonte do rack e teste das câmeras."
        />
      </Field>
      {warnings}
      {locationBlock}
      {error ? <ErrorBox message={error} /> : null}
    </SheetScaffold>
  );
}

/** "OS-0123  Agendado › Em deslocamento" */
function Flow({ ticket, to }: { ticket: LocalTicket; to: TicketStatus }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.flow}>
      <Text style={styles.code}>{ticket.code}</Text>
      <StatusBadge status={ticket.status} />
      <Icon name="chevronRight" size={14} color={c.inkMuted} />
      <StatusBadge status={to} />
    </View>
  );
}

/** Aviso que não bloqueia: o técnico lê e decide. */
function Notice({ icon, children }: { icon: IconName; children: ReactNode }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.notice}>
      <Icon name={icon} size={18} color={toneInk(c, "warning")} strokeWidth={2} />
      <View style={{ flex: 1, gap: 8 }}>{children}</View>
    </View>
  );
}

function SummaryRow({ icon, text, tone }: { icon: IconName; text: string; tone?: "warning" }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const color = tone ? toneInk(c, tone) : c.inkMuted;
  return (
    <View style={styles.summaryRow}>
      <Icon name={icon} size={18} color={color} strokeWidth={2} />
      <Text style={[styles.summaryText, tone && { color, fontWeight: "600" }]}>{text}</Text>
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    compact: { paddingHorizontal: 8, paddingTop: 4, gap: 14 },
    title: { fontSize: 20, fontWeight: "700", color: c.ink },
    flow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
    code: { fontSize: 13, fontWeight: "700", color: c.inkMuted, fontVariant: ["tabular-nums"] },
    description: { fontSize: 14, color: c.inkMuted, lineHeight: 20 },
    compactActions: { flexDirection: "row", gap: 12, paddingTop: 2 },
    notice: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 10,
      padding: 12,
      borderRadius: RADIUS.control,
      backgroundColor: c.warningSoft,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.lineStrong,
    },
    noticeText: { fontSize: 14, color: c.ink, lineHeight: 20 },
    skip: { alignSelf: "flex-start", paddingVertical: 4 },
    skipText: { fontSize: 14, fontWeight: "600", color: c.brandInk, textDecorationLine: "underline" },
    summary: {
      gap: 10,
      padding: 14,
      borderRadius: RADIUS.card,
      backgroundColor: c.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
    },
    summaryTitle: { fontSize: 12, fontWeight: "700", color: c.inkMuted, textTransform: "uppercase", letterSpacing: 0.6 },
    summaryRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
    summaryText: { flex: 1, fontSize: 14, color: c.ink, lineHeight: 20 },
  });
