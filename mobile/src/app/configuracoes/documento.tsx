// Documento (Configurações › Documentos): incluir (?grupo=certificacao | pessoal) e editar (?id=) uma certificação ou
// um documento pessoal. "Título" (até 80, com as sugestões enquanto está vazio), "Validade" (só na certificação,
// opcional, de 2000-01-01 a hoje + 20 anos) e "Arquivo" (PDF ou foto, até 10 MB: o seletor do sistema, a câmera ou a
// galeria). Incluir envia o arquivo com os dados (POST /me/profile/documents); editar com arquivo novo troca o arquivo
// (…/replace: a central guarda o anterior) e só com os dados manda o PATCH. O tipo não muda. Só online: nada entra na
// fila; sem rede, o formulário fica preenchido para tentar de novo, com o mesmo `client_upload_id` enquanto o arquivo
// for o mesmo (a resposta perdida não vira documento repetido). A cópia do arquivo fica no cache só enquanto a tela está
// aberta ou o envio corre (lib/documentFile.ts). Molde: nota-fiscal.tsx.

import { randomUUID } from "expo-crypto";
import { router, Stack, useLocalSearchParams, usePreventRemove } from "expo-router";
import { HeaderHeightContext } from "expo-router/react-navigation";
import { useContext, useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { DateField } from "../../components/forms/DateField";
import { CadastroUnavailable } from "../../components/settings/CadastroUnavailable";
import { FileField, shownPicked, shownStored, type FileSource, type ShownFile } from "../../components/settings/FileField";
import { FixedFooter } from "../../components/settings/FixedFooter";
import { OfflineNotice } from "../../components/settings/OfflineNotice";
import { ProfileGate } from "../../components/settings/ProfileGate";
import { Text } from "../../components/Text";
import { capturePhotos, recoverCapture } from "../../components/ticket/photoCapture";
import { Button, Card, EmptyState, ErrorBox, Field, InfoBox, Input } from "../../components/ui";
import { ApiError, errorMessage } from "../../lib/api";
import { DOCUMENT_LIMITS, DOCUMENT_TITLE_SUGGESTIONS, documentDue, documentDueText } from "../../lib/constants";
import { confirmAction } from "../../lib/dialogs";
import { discardDocumentFile, documentFromPhoto, pickDocumentFile, sweepDocumentFiles, type PickedDocumentFile } from "../../lib/documentFile";
import {
  DOCUMENT_GROUP_TEXT,
  DOCUMENT_SEND_TEXT,
  documentChanged,
  documentDraftOf,
  documentFields,
  documentGroupOf,
  documentPatch,
  documentProblem,
  documentsFull,
  DOCUMENTS_LIMIT_TEXT,
  editableDocument,
  EXPIRES_MIN,
  expiresMax,
  FILE_PROBLEM_TEXT,
  firstDocumentProblem,
  groupOfParam,
  replaceFields,
  type DocumentDraft,
  type DocumentGroup,
  type FileProblem,
} from "../../lib/documentRules";
import { openDocument, replaceDocument, sendDocument, updateDocument } from "../../lib/documents";
import { haptic } from "../../lib/haptics";
import { noNetwork, offlineFailure } from "../../lib/net";
import { hasCadastroE2, loadProfile } from "../../lib/profile";
import { rebase, todayIso } from "../../lib/profileForm";
import { useTechProfileScreen } from "../../lib/technicalProfile";
import { cleanText } from "../../lib/techProfileForm";
import { showToast } from "../../lib/toast";
import type { MyDocument } from "../../lib/types";
import { RADIUS, useStyles, useTheme, type Palette } from "../../theme/theme";

/** Envio em andamento: a cópia do arquivo só sai do cache depois que ele termina. */
let uploading: Promise<unknown> | null = null;

async function track<T>(job: Promise<T>): Promise<T> {
  uploading = job;
  try {
    return await job;
  } finally {
    if (uploading === job) uploading = null;
  }
}

/** Arquivo trocado ou tela fechada: apaga a cópia (esperando o envio que ainda a lê). */
function releaseFile(file: PickedDocumentFile) {
  const pending = uploading;
  const drop = () => discardDocumentFile(file);
  if (pending) void pending.then(drop, drop);
  else drop();
}

/** Volta para Documentos (sem histórico, abre Documentos). */
function leave() {
  if (router.canGoBack()) router.back();
  else router.replace("/configuracoes/documentos");
}

async function sendFailure(error: unknown, withFile: boolean): Promise<string> {
  if (await offlineFailure(error)) return withFile ? DOCUMENT_SEND_TEXT.offlineFile : DOCUMENT_SEND_TEXT.offlineData;
  if (error instanceof ApiError && error.status === 408) return DOCUMENT_SEND_TEXT.timeout;
  return errorMessage(error);
}

/** O arquivo escolhido agora; sem ele, o gravado (no editar). */
function shownFile(file: PickedDocumentFile | null, doc: MyDocument | null): ShownFile | null {
  if (file) return shownPicked(file);
  return doc ? shownStored(doc) : null;
}

export default function DocumentScreen() {
  const styles = useStyles(makeStyles);
  const params = useLocalSearchParams<{ grupo?: string; id?: string }>();
  const id = typeof params.id === "string" && params.id ? params.id : null;
  const { gate, stale, retry } = useTechProfileScreen(hasCadastroE2);
  const live = gate.status === "ready" && id ? editableDocument(gate.profile.documents, id) : null;
  // O documento gravado como a tela o viu por último: excluído com ela aberta (pela central, em outro aparelho), o
  // formulário fica com o que tinha e o envio diz que ele não existe mais.
  const [kept, setKept] = useState<MyDocument | null>(live);
  if (live && live !== kept) setKept(live);
  const doc = live ?? kept;
  const group: DocumentGroup | null = id ? (doc ? documentGroupOf(doc) : null) : groupOfParam(params.grupo);
  const title = group ? DOCUMENT_GROUP_TEXT[group][id ? "edit" : "create"] : "Documento";
  const header = <Stack.Screen options={{ title }} />;

  let body;
  if (gate.status === "unavailable") body = <CadastroUnavailable onRetry={retry} />;
  else if (gate.status !== "ready") body = <ProfileGate load={gate} onRetry={retry} />;
  else if (!group) {
    body = (
      <View style={styles.center}>
        <EmptyState icon="idCard" title="Documento não encontrado" description="Ele pode ter sido excluído." action={{ label: "Voltar", onPress: leave }} />
      </View>
    );
  } else {
    body = (
      <DocumentForm
        key={id ?? group}
        group={group}
        doc={id ? doc : null}
        full={!id && documentsFull(gate.profile.documents)}
        stale={stale}
      />
    );
  }
  return (
    <>
      {header}
      {body}
    </>
  );
}

function DocumentForm({ group, doc, full, stale }: { group: DocumentGroup; doc: MyDocument | null; full: boolean; stale: boolean }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  // O teclado sobe a partir do cabeçalho.
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const [today] = useState(() => todayIso());
  const text = DOCUMENT_GROUP_TEXT[group];
  const editing = doc !== null;
  // O documento de que o formulário partiu: mudou no servidor com a tela aberta (a central renomeou), o campo que o
  // técnico não mexeu acompanha; o que ele mexeu fica.
  const [shown, setShown] = useState<MyDocument | null>(doc);
  const [draft, setDraft] = useState<DocumentDraft>(() => documentDraftOf(doc));
  if (doc !== shown) {
    setShown(doc);
    if (doc && shown) setDraft((current) => rebase(current, documentDraftOf(shown), documentDraftOf(doc)));
  }
  const [file, setFile] = useState<PickedDocumentFile | null>(null);
  // O arquivo escolhido que não serve (tipo, tamanho ou leitura): fica no campo até outra escolha ou o envio.
  const [fileError, setFileError] = useState<string | null>(null);
  // Depois do primeiro "Enviar"/"Salvar", os erros aparecem nos campos e acompanham a digitação.
  const [attempted, setAttempted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // Enviou ou descartou: sai sem perguntar.
  const [done, setDone] = useState(false);
  const mounted = useRef(true);
  const busy = useRef(false);
  const picking = useRef(false);
  // Um por arquivo, repetido em cada tentativa do mesmo arquivo (criado no primeiro envio); trocar o arquivo zera.
  const uploadId = useRef<string | null>(null);

  const problems = documentProblem(group, draft, Boolean(file) || editing, today);
  const errors = attempted ? problems : {};
  const footerError = submitError ?? (attempted ? firstDocumentProblem(problems) : null);
  const changed = doc ? documentChanged(group, draft, doc, Boolean(file)) : true;
  const dirty = doc ? changed : Boolean(file || draft.title.trim() || draft.expiresOn);
  const due = group === "certification" && !errors.expiresOn ? documentDue(draft.expiresOn, today) : null;
  const dueText = due ? documentDueText(draft.expiresOn, today) : null;
  const dueColor = due?.state === "expired" ? c.dangerInk : due?.state === "soon" ? c.warningInk : c.inkMuted;
  const suggestions = DOCUMENT_TITLE_SUGGESTIONS[group];

  const allowLeave = usePreventRemove(dirty && !done, ({ repeat }) => {
    if (sending) {
      showToast(file ? "Enviando o arquivo" : "Salvando", { description: "Aguarde terminar para sair." });
      return;
    }
    const [title, message] = editing
      ? ["Descartar as alterações?", "O que você mudou não foi salvo."]
      : [text.discard, "O que você preencheu não foi enviado."];
    void confirmAction(title, message, { confirmText: "Descartar", destructive: true }).then((ok) => {
      if (!ok) return;
      setDone(true);
      repeat();
    });
  });

  useEffect(() => {
    mounted.current = true;
    // Cópias de uma tela que o sistema fechou no meio saem do cache.
    sweepDocumentFiles();
    return () => {
      mounted.current = false;
    };
  }, []);

  // A cópia do arquivo sai quando ele é trocado e quando a tela fecha.
  useEffect(() => {
    if (!file) return;
    return () => releaseFile(file);
  }, [file]);

  // Android: a foto tirada antes de o sistema fechar o app com a câmera aberta volta para o formulário.
  useEffect(() => {
    let alive = true;
    recoverCapture((target) => target.kind === "document" && target.slot === "document")
      .then(async (found) => {
        const asset = found?.assets[0];
        if (!asset) return;
        const picked = await documentFromPhoto(asset, "document", (problem) => {
          if (alive) setFileError(FILE_PROBLEM_TEXT[problem]);
        });
        if (!picked) return;
        if (!alive) {
          discardDocumentFile(picked);
          return;
        }
        uploadId.current = null;
        setFile(picked);
        setFileError(null);
        showToast("Foto recuperada", { tone: "success", description: "A foto tirada antes de o app fechar está no documento." });
      })
      .catch((error: unknown) => console.warn("Não foi possível recuperar a foto do documento", error));
    return () => {
      alive = false;
    };
  }, []);

  function update(patch: Partial<DocumentDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setSubmitError(null);
  }

  async function choose(source: FileSource) {
    // Um seletor por vez; durante o envio o arquivo não muda.
    if (picking.current || busy.current) return;
    picking.current = true;
    try {
      const seen: { problem: FileProblem | null } = { problem: null };
      const warn = (problem: FileProblem) => {
        seen.problem = problem;
      };
      let picked: PickedDocumentFile | null = null;
      if (source === "document") {
        picked = await pickDocumentFile("document", warn);
      } else {
        const [asset] = await capturePhotos(source, { kind: "document", slot: "document" });
        if (asset) picked = await documentFromPhoto(asset, "document", warn);
      }
      if (!mounted.current) {
        discardDocumentFile(picked);
        return;
      }
      if (seen.problem) {
        haptic.warning();
        setFileError(FILE_PROBLEM_TEXT[seen.problem]);
        return;
      }
      if (!picked) return;
      // Arquivo novo, envio novo: o id da tentativa anterior devolveria o arquivo de antes.
      uploadId.current = null;
      setFile(picked);
      setFileError(null);
      setSubmitError(null);
    } finally {
      picking.current = false;
    }
  }

  async function submit() {
    // Dois toques seguidos não mandam dois envios.
    if (busy.current || picking.current) return;
    setAttempted(true);
    setSubmitError(null);
    setFileError(null);
    if (firstDocumentProblem(problems)) {
      haptic.warning();
      return;
    }
    if (!changed || (!doc && !file)) return;
    busy.current = true;
    setSending(true);
    const withFile = Boolean(file);
    try {
      if (await noNetwork()) {
        setSubmitError(withFile ? DOCUMENT_SEND_TEXT.offlineFile : DOCUMENT_SEND_TEXT.offlineData);
        return;
      }
      if (file) {
        const clientUploadId = (uploadId.current ??= randomUUID());
        await track(
          doc
            ? replaceDocument(doc.id, file, replaceFields(group, draft, doc, clientUploadId))
            : sendDocument(file, documentFields(group, draft, clientUploadId)),
        );
      } else if (doc) {
        await updateDocument(doc.id, documentPatch(group, draft, doc));
      }
      haptic.success();
      showToast(editing ? text.updated : text.sent, { tone: "success", description: cleanText(draft.title) });
      // Saiu da tela enquanto enviava (descartou): o aviso basta, sem voltar mais uma tela.
      if (!mounted.current) return;
      setDone(true);
      allowLeave();
      leave();
    } catch (error) {
      // O documento que já saiu (a central excluiu): a lista é relida para quando o técnico voltar.
      if (error instanceof ApiError && error.status === 404) void loadProfile().catch(() => undefined);
      const message = await sendFailure(error, withFile);
      if (mounted.current) setSubmitError(message);
    } finally {
      busy.current = false;
      if (mounted.current) setSending(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="padding" keyboardVerticalOffset={headerHeight}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
      >
        <OfflineNotice text={editing ? undefined : "Sem internet: conecte o aparelho para enviar."} />
        {stale ? <InfoBox message="Não foi possível atualizar agora. Os dados podem estar desatualizados." /> : null}
        {full ? <InfoBox message={DOCUMENTS_LIMIT_TEXT} /> : null}

        <Card style={styles.card}>
          <Field label="Título" required error={errors.title}>
            <Input
              value={draft.title}
              onChangeText={(title) => update({ title })}
              accessibilityLabel="Título"
              autoCapitalize="sentences"
              maxLength={DOCUMENT_LIMITS.titleMax}
              editable={!sending}
              returnKeyType="done"
            />
            {!draft.title.trim() && !sending ? (
              <View style={styles.suggestions}>
                {suggestions.map((suggestion) => (
                  <Pressable
                    key={suggestion}
                    onPress={() => {
                      haptic.select();
                      update({ title: suggestion });
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Usar ${suggestion}`}
                    style={({ pressed }) => [styles.suggestion, pressed && { backgroundColor: c.surface2 }]}
                  >
                    <Text style={styles.suggestionText}>{suggestion}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </Field>

          {group === "certification" ? (
            <Field label="Validade" error={errors.expiresOn}>
              <DateField
                value={draft.expiresOn}
                onChange={(expiresOn) => update({ expiresOn })}
                label="Validade"
                min={EXPIRES_MIN}
                max={expiresMax(today)}
                initial={today}
                todayShortcut={false}
                disabled={sending}
              />
              {dueText ? <Text style={[styles.due, { color: dueColor }]}>{dueText}</Text> : null}
            </Field>
          ) : null}

          <FileField
            file={shownFile(file, doc)}
            onPick={(source) => void choose(source)}
            onOpen={!file && doc ? () => void openDocument(doc) : undefined}
            disabled={sending}
            error={fileError ?? errors.file ?? null}
          />
        </Card>
      </ScrollView>

      <FixedFooter>
        {footerError ? <ErrorBox message={footerError} /> : null}
        <Button
          title={editing ? "Salvar" : "Enviar"}
          variant="primary"
          onPress={() => void submit()}
          loading={sending}
          disabled={editing ? !changed : full}
        />
      </FixedFooter>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    content: { padding: 16, gap: 14 },
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: c.canvas },
    card: { gap: 16 },
    suggestions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    suggestion: {
      minHeight: 44,
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: RADIUS.chip,
      borderWidth: 1,
      borderColor: c.lineStrong,
      backgroundColor: c.surface,
      alignItems: "center",
      justifyContent: "center",
    },
    suggestionText: { fontSize: 15, fontWeight: "600", color: c.ink },
    due: { fontSize: 13, fontWeight: "600" },
  });
