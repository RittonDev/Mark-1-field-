import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View, type ScrollViewInstance } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FieldInput, SectionLabel } from "../../../components/forms/FieldInput";
import { ReviewList, StepProgress, StepSlide, type StepDirection, type StepState } from "../../../components/forms/FormSteps";
import { Icon } from "../../../components/Icon";
import { DetailSkeleton } from "../../../components/Skeleton";
import { Text } from "../../../components/Text";
import { attachmentsStale, reloadAttachments } from "../../../components/ticket/attachments";
import { capturePhotos, recoverCapture } from "../../../components/ticket/photoCapture";
import { PhotoViewer, type ViewerPhoto } from "../../../components/ticket/PhotoViewer";
import { toneInk } from "../../../components/ticket/tones";
import { Badge, Button, Card, EmptyState, ErrorBox } from "../../../components/ui";
import { absoluteApiUrl, errorMessage } from "../../../lib/api";
import { useLiveQuery } from "../../../lib/changes";
import { getAttachmentsCache, getFormError, getKv, getTicket, listPhotos, listSignatures, setKv, type PendingPhoto } from "../../../lib/db";
import { confirmAction, notify } from "../../../lib/dialogs";
import {
  answerText,
  buildSteps,
  formsLocked,
  invalidNumber,
  isAnswered,
  isInputField,
  isRequiredItem,
  missingItems,
  normalizeAnswer,
  photoCounts,
  photoNeed,
  resumeStep,
  stepAnswered,
  stepProblem,
} from "../../../lib/forms";
import { haptic } from "../../../lib/haptics";
import { useSession } from "../../../lib/session";
import { deleteFormPhoto, discardPhoto, enqueueFormAnswers, isOnline, queuePhoto, useSyncStatus } from "../../../lib/sync";
import type { LocalTicket } from "../../../lib/syncTypes";
import { showToast } from "../../../lib/toast";
import type { Attachment, FormAnswer, FormField, TicketForm } from "../../../lib/types";
import { useStyles, useTheme, type Palette } from "../../../theme/theme";

const STATUS_LABEL = { pending: "Não iniciado", in_progress: "Em preenchimento", completed: "Concluído" } as const;

/** "steps": uma pergunta por tela (padrão, como no Field Control); "list": todas numa tela. */
type Mode = "steps" | "list";
const MODE_KEY = "form_mode";
let preferredMode: Mode = "steps";
let modeLoaded = false;

function rememberMode(mode: Mode) {
  preferredMode = mode;
  void setKv(MODE_KEY, mode).catch(() => undefined);
}

export default function FormScreen() {
  const { ticketId, formId } = useLocalSearchParams<{ ticketId: string; formId: string }>();
  const load = useCallback(() => getTicket(String(ticketId)), [ticketId]);
  const ticket = useLiveQuery(load);
  const [modeReady, setModeReady] = useState(modeLoaded);

  // Preferência do técnico (uma por tela ou todas), lida uma vez por sessão do app.
  useEffect(() => {
    if (modeLoaded) return;
    getKv(MODE_KEY)
      .then((value) => {
        if (value === "list" || value === "steps") preferredMode = value;
      })
      .catch(() => undefined)
      .finally(() => {
        modeLoaded = true;
        setModeReady(true);
      });
  }, []);

  if (ticket === undefined || !modeReady) return <DetailSkeleton />;
  const form = ticket?.forms?.find((f) => f.id === formId);
  if (!ticket || !form) {
    return (
      <View style={{ flex: 1, padding: 16 }}>
        <EmptyState icon="alert" title="Formulário não encontrado" description="Ele pode ter sido removido da OS pela central." />
        <Button
          title={ticket ? "Voltar para a OS" : "Voltar para a lista"}
          onPress={() => (ticket ? backToTicket(ticket.id) : router.replace("/"))}
        />
      </View>
    );
  }
  return <FormEditor key={form.id} ticket={ticket} form={form} />;
}

function backToTicket(ticketId: string) {
  // Aberto por link direto (sem histórico), volta para a OS.
  if (router.canGoBack()) router.back();
  else router.replace({ pathname: "/ticket/[id]", params: { id: ticketId } });
}

function FormEditor({ ticket, form }: { ticket: LocalTicket; form: TicketForm }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const online = isOnline(useSyncStatus());
  const { user } = useSession();
  const scrollRef = useRef<ScrollViewInstance>(null);
  const [draft, setDraft] = useState<Record<string, FormAnswer | null>>(() => ({ ...form.answers }));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<"save" | "complete" | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [mode, setMode] = useState<Mode>(preferredMode);
  const [step, setStep] = useState<number | null>(null);
  const [direction, setDirection] = useState<StepDirection>("none");
  /** Tentou avançar com a pergunta atual pendente: mostra o aviso e o "Responder depois". */
  const [attempted, setAttempted] = useState(false);
  /** Lista: tentou concluir com obrigatórios faltando (cada um mostra o aviso sob a pergunta). */
  const [showMissing, setShowMissing] = useState(false);
  const [viewer, setViewer] = useState<{ fieldId: string; index: number } | null>(null);
  /** Esta tela mexeu nas respostas: só então ela salva sozinha (outra cópia aberta não sobrescreve). */
  const [touched, setTouched] = useState(false);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Posição de cada pergunta no modo lista, para rolar até a primeira pendente. */
  const fieldY = useRef<Record<string, number>>({});
  const listY = useRef(0);

  const loadPhotos = useCallback(() => listPhotos(ticket.id), [ticket.id]);
  const loadAttachments = useCallback(() => getAttachmentsCache(ticket.id), [ticket.id]);
  const loadSignatures = useCallback(() => listSignatures(ticket.id), [ticket.id]);
  const loadError = useCallback(() => getFormError(form.id), [form.id]);
  const photoRows = useLiveQuery(loadPhotos);
  const attachmentRows = useLiveQuery(loadAttachments);
  const pendingPhotos = (photoRows ?? []).filter((p) => p.form_id === form.id);
  const attachments = (attachmentRows ?? []).filter((a) => a.form_id === form.id);
  const pendingSignature = (useLiveQuery(loadSignatures) ?? []).length > 0;
  const serverError = useLiveQuery(loadError);
  // Só o responsável preenche (o auxiliar que abre por link vê as respostas, sem alterar).
  const canFill = ticket.assignee?.id === user?.id;
  const locked = formsLocked(ticket, pendingSignature) || !canFill;

  // Online, atualiza a lista de anexos (fotos já enviadas de cada campo) e guarda para usar offline:
  // ao abrir, ao voltar para a tela e quando a conexão volta.
  useFocusEffect(
    useCallback(() => {
      if (online) reloadAttachments(ticket.id).catch(() => undefined);
    }, [online, ticket.id]),
  );

  // Uma foto acabou de subir: a lista do servidor passa a trazê-la (a busca anterior pode ter
  // respondido antes do envio terminar e deixado o campo com uma foto a menos).
  const pendingCount = pendingPhotos.length;
  const previousPending = useRef(pendingCount);
  useEffect(() => {
    const before = previousPending.current;
    previousPending.current = pendingCount;
    if (online && pendingCount < before) reloadAttachments(ticket.id).catch(() => undefined);
  }, [pendingCount, online, ticket.id]);

  // Foto tirada antes de o Android fechar o app com a câmera aberta.
  useEffect(() => {
    recoverCapture((t) => t.kind === "form" && t.ticketId === ticket.id && t.formId === form.id)
      .then(async (found) => {
        if (!found || found.target.kind !== "form") return;
        const { fieldId } = found.target;
        for (const asset of found.assets) await queuePhoto(ticket.id, asset.uri, asset.mimeType, { formId: form.id, fieldId });
        showToast("Foto recuperada", { tone: "success", description: "A foto tirada antes de o app fechar foi guardada no formulário." });
      })
      .catch((e: unknown) => console.warn("Não foi possível recuperar a foto", e));
  }, [ticket.id, form.id]);

  useEffect(
    () => () => {
      if (advanceTimer.current) clearTimeout(advanceTimer.current);
    },
    [],
  );

  const steps = useMemo(() => buildSteps(form.fields), [form.fields]);
  const counts = photoCounts(form.id, attachments, pendingPhotos);
  const normalized = useMemo(() => {
    const out: Record<string, FormAnswer | null> = {};
    for (const field of form.fields) if (isInputField(field)) out[field.id] = normalizeAnswer(field, draft[field.id]);
    return out;
  }, [draft, form.fields]);
  const missing = missingItems(form, counts, normalized);
  const dirty = form.fields.some(
    (f) => isInputField(f) && JSON.stringify(normalized[f.id] ?? null) !== JSON.stringify(form.answers[f.id] ?? null),
  );
  const problemAt = (i: number) => stepProblem(steps[i].field, normalized[steps[i].field.id], counts[steps[i].field.id] ?? 0);

  // Onde abrir: formulário concluído vai direto para a revisão; senão, retoma de onde parou.
  // Espera as fotos do aparelho carregarem, para não tratar como vazio um campo de foto já feito.
  if (step === null && photoRows !== undefined && attachmentRows !== undefined) {
    setStep(
      form.status === "completed"
        ? steps.length
        : resumeStep(
            steps.length,
            (i) => stepAnswered(steps[i].field, normalized[steps[i].field.id], counts[steps[i].field.id] ?? 0),
            (i) => problemAt(i) !== null,
          ),
    );
  }
  const at = step === null ? null : Math.min(step, steps.length);

  // ── salvamento automático: ao trocar de pergunta, ao sair da tela e com o app em segundo plano ──
  const latest = useRef({ normalized, dirty, locked, touched });
  useEffect(() => {
    latest.current = { normalized, dirty, locked, touched };
  });
  /** Respostas que já estão na fila (evita salvar de novo o mesmo conteúdo). */
  const savedKey = useRef<string | null>(null);
  const autosave = useCallback(async () => {
    const { normalized: answers, dirty: changed, locked: blocked, touched: edited } = latest.current;
    const key = JSON.stringify(answers);
    if (!edited || !changed || blocked || key === savedKey.current) return;
    savedKey.current = key;
    try {
      await enqueueFormAnswers(ticket.id, { form_id: form.id, answers, complete: false });
    } catch {
      savedKey.current = null;
    }
  }, [ticket.id, form.id]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") void autosave();
    });
    return () => {
      sub.remove();
      void autosave();
    };
  }, [autosave]);
  // E 2 s depois da última mudança (no modo lista não há troca de pergunta para salvar).
  useEffect(() => {
    const timer = setTimeout(() => void autosave(), 2000);
    return () => clearTimeout(timer);
  }, [draft, autosave]);

  function cancelAdvance() {
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
    advanceTimer.current = null;
  }

  function goTo(index: number, dir: StepDirection) {
    cancelAdvance();
    setDirection(dir);
    setAttempted(false);
    setError(null);
    setStep(index);
    scrollRef.current?.scrollTo({ y: 0, animated: false });
    void autosave();
  }

  /**
   * Sim/Não ou escolha única respondida: avança sozinho em 250 ms (dá para ver a marcação). Confere
   * a pendência com o valor novo, não com o rascunho de antes do toque; e não avança se, nesse meio
   * tempo, o técnico desmarcou ou trocou a resposta.
   */
  function advanceAfter(from: number, field: FormField, value: FormAnswer) {
    cancelAdvance();
    const answer = normalizeAnswer(field, value);
    if (invalidNumber(field, value) || stepProblem(field, answer, counts[field.id] ?? 0)) return;
    advanceTimer.current = setTimeout(() => {
      advanceTimer.current = null;
      if (JSON.stringify(latest.current.normalized[field.id] ?? null) !== JSON.stringify(answer)) return;
      haptic.select();
      goTo(Math.min(from + 1, steps.length), "forward");
    }, 250);
  }

  function next(skip = false) {
    if (at === null) return;
    const current = steps[at];
    if (current) {
      const badNumber = invalidNumber(current.field, draft[current.field.id]);
      if (badNumber || (!skip && problemAt(at))) {
        setAttempted(true);
        haptic.warning();
        return;
      }
    }
    haptic.select();
    goTo(Math.min(at + 1, steps.length), "forward");
  }

  function back() {
    if (at === null || at === 0) return;
    haptic.select();
    goTo(at - 1, "back");
  }

  function switchMode(next: Mode) {
    rememberMode(next);
    setMode(next);
    setError(null);
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }

  async function submit(complete: boolean) {
    setError(null);
    const badNumber = steps.find((s) => invalidNumber(s.field, draft[s.field.id]));
    if (badNumber) {
      setError(`"${badNumber.field.label}": digite só números (ex.: 12,5).`);
      haptic.warning();
      return;
    }
    if (complete && missing.length) {
      haptic.warning();
      const summary = missing.length > 1 ? `Faltam ${missing.length} itens obrigatórios` : "Falta 1 item obrigatório";
      const first = steps.findIndex((_, i) => problemAt(i) !== null);
      // Uma por tela: leva direto à primeira pergunta pendente, já com o aviso do que falta.
      if (mode === "steps" && first >= 0) {
        goTo(first, "back");
        setAttempted(true);
        showToast(summary, { tone: "error", description: missing.join("; ") });
        return;
      }
      // Todas numa tela: marca cada pendente e rola até a primeira.
      setShowMissing(true);
      const firstId = first >= 0 ? steps[first].field.id : null;
      if (firstId && fieldY.current[firstId] !== undefined) {
        scrollRef.current?.scrollTo({ y: Math.max(0, listY.current + fieldY.current[firstId] - 12), animated: true });
      }
      showToast(summary, { tone: "error", description: missing.join("; ") });
      return;
    }
    setSaving(complete ? "complete" : "save");
    const key = JSON.stringify(normalized);
    try {
      savedKey.current = key;
      await enqueueFormAnswers(ticket.id, { form_id: form.id, answers: normalized, complete });
      if (complete) haptic.success();
      showToast(complete ? "Formulário concluído" : "Respostas salvas", {
        tone: "success",
        description: online ? undefined : "Salvo no aparelho; vai para a central quando houver conexão.",
      });
      if (complete) backToTicket(ticket.id);
    } catch (e) {
      savedKey.current = null;
      setError(errorMessage(e));
    } finally {
      setSaving(null);
    }
  }

  async function addPhoto(field: FormField, source: "camera" | "library") {
    const count = counts[field.id] ?? 0;
    const room = Math.max(1, (field.max_photos > 0 ? field.max_photos : 10) - count);
    setPhotoBusy(true);
    try {
      const assets = await capturePhotos(
        source,
        { kind: "form", ticketId: ticket.id, formId: form.id, fieldId: field.id },
        source === "library" ? room : 1,
      );
      const chosen = assets.slice(0, room);
      if (!chosen.length) return;
      for (const asset of chosen) await queuePhoto(ticket.id, asset.uri, asset.mimeType, { formId: form.id, fieldId: field.id });
      setTouched(true);
      setAttempted(false);
      const total = count + chosen.length;
      const need = photoNeed(field);
      if (source === "camera" && total < need) showToast(`Foto ${total} de ${need} salva`, { tone: "success" });
    } catch (e) {
      notify("Não foi possível guardar a foto", errorMessage(e));
    } finally {
      setPhotoBusy(false);
    }
  }

  async function removeServerPhoto(field: FormField, attachment: Attachment) {
    if (!online) {
      notify("Sem conexão", "Para remover uma foto já enviada é preciso estar online.");
      return;
    }
    const message = photoNeed(field) ? "A foto será apagada da OS. O campo pode voltar a ficar incompleto." : "A foto será apagada da OS.";
    const ok = await confirmAction("Remover foto?", message, { confirmText: "Remover", destructive: true });
    if (!ok) return;
    try {
      await deleteFormPhoto(ticket.id, form.id, attachment.id);
      setTouched(true);
    } catch (e) {
      notify("Não foi possível remover", errorMessage(e));
    }
  }

  async function removePendingPhoto(photo: PendingPhoto) {
    const ok = await confirmAction("Remover foto?", "Ela ainda não foi enviada e será apagada do aparelho.", {
      confirmText: "Remover",
      destructive: true,
    });
    if (!ok) return;
    await discardPhoto(photo.id, photo.file_uri);
    setTouched(true);
  }

  async function openPhoto(fieldId: string, index: number) {
    // Os links das fotos vencem: lista antiga é atualizada antes de abrir.
    if (online && attachmentsStale(ticket.id)) await reloadAttachments(ticket.id).catch(() => undefined);
    setViewer({ fieldId, index });
  }

  const viewerPhotos: ViewerPhoto[] = viewer
    ? [
        ...attachments
          .filter((a) => a.field_id === viewer.fieldId)
          .map((a) => ({
            key: a.id,
            uri: absoluteApiUrl(a.download_url) ?? "",
            caption: a.uploaded_by ? `Enviada por ${a.uploaded_by.name}` : "Foto enviada",
          })),
        ...pendingPhotos
          .filter((p) => p.field_id === viewer.fieldId)
          .map((p) => ({ key: p.id, uri: p.file_uri, caption: "Aguardando envio" })),
      ]
    : [];

  const fieldProps = (field: FormField) => ({
    value: draft[field.id],
    onChange: (value: FormAnswer | null) => {
      setTouched(true);
      setDraft((d) => ({ ...d, [field.id]: value }));
      setAttempted(false);
    },
    disabled: locked,
    photos:
      field.type === "photo"
        ? { server: attachments.filter((a) => a.field_id === field.id), pending: pendingPhotos.filter((p) => p.field_id === field.id) }
        : undefined,
    onAddPhoto: (source: "camera" | "library") => void addPhoto(field, source),
    onRemoveServerPhoto: (a: Attachment) => void removeServerPhoto(field, a),
    onRemovePendingPhoto: (p: PendingPhoto) => void removePendingPhoto(p),
    onOpenPhoto: (index: number) => void openPhoto(field.id, index),
    userId: user?.id,
    photoBusy,
  });

  const requiredCount = form.fields.filter(isRequiredItem).length;
  const doneCount = requiredCount - missing.length;
  const view: "question" | "review" | "list" | "locked" | "loading" = locked
    ? "locked"
    : mode === "list"
      ? "list"
      : at === null
        ? "loading"
        : at < steps.length
          ? "question"
          : "review";
  const completed = form.status === "completed";
  const canConclude = !saving && !(completed && !dirty);
  // Concluído e alterado: precisa concluir de novo (o servidor faz o mesmo).
  const concludeTitle = completed ? (dirty ? "Concluir de novo" : "Concluído") : "Concluir";
  const missingIds = showMissing ? new Set(steps.filter((_, i) => problemAt(i) !== null).map((s) => s.field.id)) : null;

  const summaryCard = (
    <Card style={{ gap: 8 }}>
      <View style={styles.cardTop}>
        <Text style={styles.code}>{ticket.code}</Text>
        {view === "list" ? (
          <Pressable onPress={() => switchMode("steps")} hitSlop={8} accessibilityRole="button" style={styles.modeLink}>
            <Text style={styles.modeLinkText}>Responder uma por vez</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.title} accessibilityRole="header">
        {form.name}
      </Text>
      <View style={styles.badges}>
        <Badge label={STATUS_LABEL[form.status]} color={completed ? toneInk(c, "success") : c.inkMuted} />
        <Badge label={form.required ? "Obrigatório" : "Opcional"} color={c.inkMuted} />
      </View>
      {requiredCount ? (
        <View style={{ gap: 6 }}>
          <Text style={styles.meta}>
            {doneCount} de {requiredCount} itens obrigatórios
          </Text>
          <View style={styles.progressTrack}>
            <View style={[styles.progressBar, { width: `${Math.round((doneCount / requiredCount) * 100)}%` }]} />
          </View>
        </View>
      ) : null}
    </Card>
  );

  const lockReason = !canFill
    ? `Só o técnico responsável (${ticket.assignee?.name ?? "definido pela central"}) preenche este formulário.`
    : ticket.signed_at || pendingSignature
      ? "A assinatura do responsável já foi colhida: o formulário não pode mais ser alterado."
      : ticket.status === "cancelled"
        ? "A OS foi cancelada: o formulário não pode mais ser alterado."
        : "A OS foi concluída: o formulário não pode mais ser alterado.";

  const notices = (
    <>
      {locked ? (
        <Card style={styles.lockedCard}>
          <Icon name="lock" size={16} color={c.inkMuted} />
          <Text style={styles.lockedText}>{lockReason}</Text>
        </Card>
      ) : null}
      {serverError && !completed ? <ErrorBox message={`O servidor não concluiu: ${serverError}`} /> : null}
    </>
  );

  const reviewRows = () =>
    steps.map((s) => {
      const photos = counts[s.field.id] ?? 0;
      return {
        answer: answerText(s.field, normalized[s.field.id], photos),
        problem: stepProblem(s.field, normalized[s.field.id], photos),
        required: isRequiredItem(s.field),
      };
    });

  let body: React.ReactNode = null;
  let footer: React.ReactNode = null;

  if (view === "question" && at !== null) {
    const current = steps[at];
    const field = current.field;
    const value = normalized[field.id];
    const badNumber = invalidNumber(field, draft[field.id]);
    const problem = badNumber ? "Digite só números (ex.: 12,5)" : problemAt(at);
    const states: StepState[] = steps.map((s, i) => {
      const photos = counts[s.field.id] ?? 0;
      const pending = problemAt(i) !== null;
      if (!pending && stepAnswered(s.field, normalized[s.field.id], photos)) return "answered";
      return pending && i < at ? "missing" : "empty";
    });
    const textLike = field.type === "text" || field.type === "textarea" || field.type === "number";
    body = (
      <>
        <StepProgress index={at} states={states} onReview={() => goTo(steps.length, "forward")} />
        {notices}
        <StepSlide key={at} direction={direction}>
          <View style={{ gap: 10 }}>
            {current.section ? <SectionLabel>{current.section}</SectionLabel> : null}
            <Card style={styles.questionCard}>
              <FieldInput
                field={field}
                {...fieldProps(field)}
                prominent
                autoFocus={direction !== "none" && textLike && !isAnswered(field, value)}
                onSubmit={() => next()}
                onAnswered={(answer) => advanceAfter(at, field, answer)}
              />
              {attempted && problem ? (
                <View style={styles.problem} accessibilityRole="alert">
                  <Icon name="alert" size={16} color={c.danger} />
                  <Text style={styles.problemText}>
                    {badNumber
                      ? problem
                      : field.type === "photo"
                        ? `${problem} para seguir.`
                        : "Pergunta obrigatória: responda para seguir."}
                  </Text>
                </View>
              ) : null}
              {attempted && problem && !badNumber ? (
                <Pressable onPress={() => next(true)} hitSlop={8} accessibilityRole="button" style={styles.skip}>
                  <Text style={styles.skipText}>Responder depois</Text>
                </Pressable>
              ) : null}
            </Card>
          </View>
        </StepSlide>
        {!attempted && (isRequiredItem(field) || field.type === "photo") ? (
          <Text style={styles.hint}>
            {field.type === "photo"
              ? photoNeed(field) > 0
                ? `Obrigatório: mínimo de ${photoNeed(field)} foto${photoNeed(field) > 1 ? "s" : ""}.`
                : "Opcional: se não tiver, toque em Próxima."
              : "Obrigatória."}
          </Text>
        ) : !attempted ? (
          <Text style={styles.hint}>Opcional: se não se aplica, toque em Próxima.</Text>
        ) : null}
        {error ? <ErrorBox message={error} /> : null}
      </>
    );
    footer = (
      <>
        <Button title="Anterior" onPress={back} disabled={at === 0 || !!saving} style={{ flex: 1 }} />
        <Button
          title={at === steps.length - 1 ? "Revisar" : "Próxima"}
          variant="primary"
          onPress={() => next()}
          disabled={!!saving}
          style={{ flex: 1.4 }}
        />
      </>
    );
  } else if (view === "review") {
    body = (
      <>
        {summaryCard}
        {notices}
        {completed ? (
          <Card style={styles.lockedCard}>
            <Icon name="checkCircle" size={16} color={c.inkMuted} />
            <Text style={styles.lockedText}>
              {dirty
                ? "Você mudou respostas deste formulário concluído. Toque em Concluir de novo para valer."
                : "Concluído. Se mudar alguma resposta ou foto, o formulário precisa ser concluído de novo."}
            </Text>
          </Card>
        ) : null}
        <View style={{ gap: 2 }}>
          <Text style={styles.reviewTitle}>Revisão</Text>
          <Text style={styles.meta}>
            {missing.length
              ? "Os itens marcados ainda faltam. Toque numa pergunta para responder ou alterar."
              : completed && !dirty
                ? "Toque numa pergunta para conferir ou alterar."
                : "Tudo certo. Confira as respostas e conclua o formulário."}
          </Text>
        </View>
        <Card style={{ paddingVertical: 4 }}>
          <ReviewList steps={steps} rows={reviewRows()} onOpen={(i) => goTo(i, "back")} />
        </Card>
        {error ? <ErrorBox message={error} /> : null}
        <Pressable onPress={() => switchMode("list")} hitSlop={8} accessibilityRole="button" style={styles.listLink}>
          <Text style={styles.modeLinkText}>Ver todas as perguntas numa tela</Text>
        </Pressable>
      </>
    );
    footer = (
      <>
        {steps.length ? (
          <Button title="Anterior" onPress={() => goTo(steps.length - 1, "back")} disabled={!!saving} style={{ flex: 1 }} />
        ) : null}
        <Button
          title={concludeTitle}
          variant="primary"
          onPress={() => void submit(true)}
          loading={saving === "complete"}
          disabled={!canConclude}
          style={{ flex: 1.4 }}
        />
      </>
    );
  } else if (view === "list") {
    body = (
      <>
        {summaryCard}
        {notices}
        <View
          onLayout={(e) => {
            listY.current = e.nativeEvent.layout.y;
          }}
        >
          <Card style={{ gap: 20 }}>
            {form.fields.map((field) => {
              const pending = missingIds?.has(field.id) ? stepProblem(field, normalized[field.id], counts[field.id] ?? 0) : null;
              return (
                <View
                  key={field.id}
                  onLayout={(e) => {
                    fieldY.current[field.id] = e.nativeEvent.layout.y;
                  }}
                >
                  <FieldInput
                    field={field}
                    {...fieldProps(field)}
                    error={pending ? (field.type === "photo" ? pending : "Obrigatória") : null}
                  />
                </View>
              );
            })}
          </Card>
        </View>
        {error ? <ErrorBox message={error} /> : null}
      </>
    );
    footer = (
      <>
        <Button title="Salvar" onPress={() => void submit(false)} loading={saving === "save"} disabled={!!saving || !dirty} style={{ flex: 1 }} />
        <Button
          title={concludeTitle}
          variant="primary"
          onPress={() => void submit(true)}
          loading={saving === "complete"}
          disabled={!canConclude}
          style={{ flex: 1 }}
        />
      </>
    );
  } else if (view === "locked") {
    // Travado: as respostas em leitura, legíveis (sem campos esmaecidos).
    body = (
      <>
        {summaryCard}
        {notices}
        <Card style={{ paddingVertical: 4 }}>
          <ReviewList steps={steps} rows={reviewRows()} />
        </Card>
      </>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      <Stack.Screen options={{ title: form.name }} />
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + (footer ? 120 : 32) }]}
        keyboardShouldPersistTaps="handled"
      >
        {body}
      </ScrollView>
      {footer ? <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>{footer}</View> : null}
      <PhotoViewer photos={viewerPhotos} index={viewer?.index ?? null} onChange={(i) => setViewer(i === null || !viewer ? null : { ...viewer, index: i })} />
    </KeyboardAvoidingView>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    content: { padding: 16, gap: 14, maxWidth: 720, width: "100%", alignSelf: "center" },
    cardTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
    code: { fontSize: 12, fontWeight: "700", color: c.inkMuted, letterSpacing: 0.3 },
    title: { fontSize: 20, fontWeight: "700", color: c.ink },
    badges: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
    meta: { fontSize: 13, color: c.inkMuted, lineHeight: 18 },
    progressTrack: { height: 6, borderRadius: 3, backgroundColor: c.segment, overflow: "hidden" },
    progressBar: { height: 6, borderRadius: 3, backgroundColor: c.primary },
    lockedCard: { backgroundColor: c.surface2, flexDirection: "row", alignItems: "flex-start", gap: 10 },
    lockedText: { flex: 1, fontSize: 14, color: c.inkMuted, lineHeight: 20 },
    modeLink: { paddingVertical: 2 },
    modeLinkText: { fontSize: 14, fontWeight: "600", color: c.brandInk },
    listLink: { alignSelf: "center", paddingVertical: 6 },
    questionCard: { gap: 14, paddingVertical: 20 },
    problem: { flexDirection: "row", alignItems: "center", gap: 8 },
    problemText: { flex: 1, fontSize: 14, fontWeight: "600", color: c.danger, lineHeight: 19 },
    skip: { alignSelf: "flex-start", paddingVertical: 2 },
    skipText: { fontSize: 14, fontWeight: "600", color: c.brandInk, textDecorationLine: "underline" },
    hint: { fontSize: 13, color: c.inkMuted, textAlign: "center" },
    reviewTitle: { fontSize: 17, fontWeight: "700", color: c.ink },
    footer: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      flexDirection: "row",
      gap: 12,
      paddingHorizontal: 16,
      paddingTop: 12,
      backgroundColor: c.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.line,
    },
  });
