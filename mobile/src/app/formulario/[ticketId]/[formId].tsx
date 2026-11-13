import * as ImagePicker from "expo-image-picker";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View, type ScrollViewInstance } from "react-native";
import { DetailSkeleton } from "../../../components/Skeleton";
import { Text } from "../../../components/Text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FieldInput } from "../../../components/forms/FieldInput";
import { ReviewList, StepProgress, StepSlide, type StepDirection, type StepState } from "../../../components/forms/FormSteps";
import { Icon } from "../../../components/Icon";
import { Badge, Button, Card, EmptyState, ErrorBox } from "../../../components/ui";
import { errorMessage } from "../../../lib/api";
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
import {
  deleteFormPhoto,
  discardPhoto,
  enqueueFormAnswers,
  isOnline,
  queuePhoto,
  refreshAttachments,
  useSyncStatus,
} from "../../../lib/sync";
import type { LocalTicket } from "../../../lib/syncTypes";
import { showToast } from "../../../lib/toast";
import type { Attachment, FormAnswer, TicketForm } from "../../../lib/types";
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
    return <EmptyState title="Formulário não encontrado" description="Ele pode ter sido removido da OS pelo analista." />;
  }
  return <FormEditor key={form.id} ticket={ticket} form={form} />;
}

function FormEditor({ ticket, form }: { ticket: LocalTicket; form: TicketForm }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const online = isOnline(useSyncStatus());
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
  const locked = formsLocked(ticket, pendingSignature);

  // Online, atualiza a lista de anexos (fotos já enviadas de cada campo) e guarda para usar offline.
  useEffect(() => {
    if (online) refreshAttachments(ticket.id).catch(() => undefined);
  }, [online, ticket.id]);

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
  const latest = useRef({ normalized, dirty, locked });
  useEffect(() => {
    latest.current = { normalized, dirty, locked };
  });
  /** Respostas que já estão na fila (evita salvar de novo o mesmo conteúdo). */
  const savedKey = useRef<string | null>(null);
  const autosave = useCallback(async () => {
    const { normalized: answers, dirty: changed, locked: blocked } = latest.current;
    const key = JSON.stringify(answers);
    if (!changed || blocked || key === savedKey.current) return;
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

  function goTo(index: number, dir: StepDirection) {
    setDirection(dir);
    setAttempted(false);
    setError(null);
    setStep(index);
    scrollRef.current?.scrollTo({ y: 0, animated: false });
    void autosave();
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
      // Uma por tela: leva direto à primeira pergunta pendente, já com o aviso do que falta.
      const first = mode === "steps" && !locked ? steps.findIndex((_, i) => problemAt(i) !== null) : -1;
      if (first >= 0) {
        goTo(first, "back");
        setAttempted(true);
        showToast(missing.length > 1 ? `Faltam ${missing.length} itens obrigatórios` : "Falta 1 item obrigatório", {
          tone: "error",
          description: missing.join("; "),
        });
        return;
      }
      setError(`Falta preencher: ${missing.join("; ")}`);
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
        description: online ? undefined : "Salvo no aparelho; será enviado quando houver conexão.",
      });
      if (complete) router.back();
    } catch (e) {
      savedKey.current = null;
      setError(errorMessage(e));
    } finally {
      setSaving(null);
    }
  }

  async function addPhoto(fieldId: string, source: "camera" | "library") {
    setPhotoBusy(true);
    try {
      const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.7, exif: false };
      let result: ImagePicker.ImagePickerResult;
      if (source === "camera") {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          notify("Câmera bloqueada", "Libere o acesso à câmera nas configurações do aparelho.");
          return;
        }
        result = await ImagePicker.launchCameraAsync(options);
      } else {
        result = await ImagePicker.launchImageLibraryAsync(options);
      }
      if (result.canceled) return;
      for (const asset of result.assets) await queuePhoto(ticket.id, asset.uri, asset.mimeType, { formId: form.id, fieldId });
      setAttempted(false);
    } catch (e) {
      notify("Não foi possível adicionar a foto", errorMessage(e));
    } finally {
      setPhotoBusy(false);
    }
  }

  async function removeServerPhoto(attachment: Attachment) {
    if (!online) {
      notify("Sem conexão", "Para remover uma foto já enviada é preciso estar online.");
      return;
    }
    const ok = await confirmAction("Remover foto?", "A foto será apagada da OS.", { confirmText: "Remover", destructive: true });
    if (!ok) return;
    try {
      await deleteFormPhoto(ticket.id, form.id, attachment.id);
    } catch (e) {
      notify("Não foi possível remover", errorMessage(e));
    }
  }

  async function removePendingPhoto(photo: PendingPhoto) {
    const ok = await confirmAction("Remover foto?", "Ela ainda não foi enviada e será apagada do aparelho.", {
      confirmText: "Remover",
      destructive: true,
    });
    if (ok) await discardPhoto(photo.id, photo.file_uri);
  }

  const fieldProps = (fieldId: string, type: string) => ({
    value: draft[fieldId],
    onChange: (value: FormAnswer | null) => {
      setDraft((d) => ({ ...d, [fieldId]: value }));
      setAttempted(false);
    },
    disabled: locked,
    photos:
      type === "photo"
        ? { server: attachments.filter((a) => a.field_id === fieldId), pending: pendingPhotos.filter((p) => p.field_id === fieldId) }
        : undefined,
    onAddPhoto: (source: "camera" | "library") => void addPhoto(fieldId, source),
    onRemoveServerPhoto: (a: Attachment) => void removeServerPhoto(a),
    onRemovePendingPhoto: (p: PendingPhoto) => void removePendingPhoto(p),
    photoBusy,
  });

  const requiredCount = form.fields.filter(isRequiredItem).length;
  const doneCount = requiredCount - missing.length;
  const view: "question" | "review" | "list" | "loading" =
    locked || mode === "list" ? "list" : at === null ? "loading" : at < steps.length ? "question" : "review";
  const canConclude = !saving && !(form.status === "completed" && !dirty);
  const concludeTitle = form.status === "completed" && !dirty ? "Concluído" : "Concluir";

  const summaryCard = (
    <Card style={{ gap: 8 }}>
      <View style={styles.cardTop}>
        <Text style={styles.code}>{ticket.code}</Text>
        {view === "list" && !locked ? (
          <Pressable onPress={() => switchMode("steps")} hitSlop={8} accessibilityRole="button" style={styles.modeLink}>
            <Text style={styles.modeLinkText}>Responder uma por vez</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.title}>{form.name}</Text>
      <View style={styles.badges}>
        <Badge
          label={STATUS_LABEL[form.status]}
          color={form.status === "completed" ? c.success : form.status === "in_progress" ? c.warning : c.inkMuted}
        />
        {form.required ? <Badge label="Obrigatório" color={c.danger} /> : <Badge label="Opcional" color={c.inkMuted} />}
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

  const notices = (
    <>
      {locked ? (
        <Card style={styles.lockedCard}>
          <Text style={styles.lockedText}>
            {ticket.signed_at || pendingSignature
              ? "A assinatura do responsável já foi colhida: o formulário não pode mais ser alterado."
              : "A OS foi concluída: o formulário não pode mais ser alterado."}
          </Text>
        </Card>
      ) : null}
      {serverError && form.status !== "completed" ? <ErrorBox message={`O servidor não concluiu: ${serverError}`} /> : null}
    </>
  );

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
            {current.section ? <Text style={styles.stepSection}>{current.section}</Text> : null}
            <Card style={styles.questionCard}>
              <FieldInput
                field={field}
                {...fieldProps(field.id, field.type)}
                prominent
                autoFocus={direction !== "none" && textLike && !isAnswered(field, value)}
                onSubmit={() => next()}
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
    const rows = steps.map((s) => {
      const photos = counts[s.field.id] ?? 0;
      return {
        answer: answerText(s.field, normalized[s.field.id], photos),
        problem: stepProblem(s.field, normalized[s.field.id], photos),
        required: isRequiredItem(s.field),
      };
    });
    body = (
      <>
        {summaryCard}
        {notices}
        <View style={{ gap: 2 }}>
          <Text style={styles.reviewTitle}>Revisão</Text>
          <Text style={styles.meta}>
            {missing.length
              ? "Os itens marcados ainda faltam. Toque numa pergunta para responder ou alterar."
              : "Tudo certo. Confira as respostas e conclua o formulário."}
          </Text>
        </View>
        <Card style={{ paddingVertical: 4 }}>
          <ReviewList steps={steps} rows={rows} onOpen={(i) => goTo(i, "back")} />
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
        <Card style={{ gap: 20 }}>
          {form.fields.map((field) => (
            <FieldInput key={field.id} field={field} {...fieldProps(field.id, field.type)} />
          ))}
        </Card>
        {error ? <ErrorBox message={error} /> : null}
      </>
    );
    footer = locked ? null : (
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
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 120 }]}
        keyboardShouldPersistTaps="handled"
      >
        {body}
      </ScrollView>
      {footer ? <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>{footer}</View> : null}
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
    lockedCard: { backgroundColor: c.surface2 },
    lockedText: { fontSize: 14, color: c.inkMuted, lineHeight: 20 },
    modeLink: { paddingVertical: 2 },
    modeLinkText: { fontSize: 14, fontWeight: "600", color: c.brandInk },
    listLink: { alignSelf: "center", paddingVertical: 6 },
    stepSection: { fontSize: 12, fontWeight: "700", color: c.primary, textTransform: "uppercase", letterSpacing: 0.5 },
    questionCard: { gap: 14, paddingVertical: 20 },
    problem: { flexDirection: "row", alignItems: "center", gap: 8 },
    problemText: { flex: 1, fontSize: 14, fontWeight: "600", color: c.danger, lineHeight: 19 },
    skip: { alignSelf: "flex-start", paddingVertical: 2 },
    skipText: { fontSize: 14, fontWeight: "600", color: c.brandInk, textDecorationLine: "underline" },
    hint: { fontSize: 13, color: c.inkSubtle, textAlign: "center" },
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
