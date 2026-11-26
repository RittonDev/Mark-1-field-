// O currículo (Configurações › Currículo): escolher o arquivo, tirar a foto ou pegar da galeria já envia, como a foto do
// perfil (lib/avatarFlow.ts); com um currículo gravado, o servidor troca o arquivo dele e guarda o anterior para a
// central. Excluir pede confirmação. O que está acontecendo (enviando ou excluindo) fica numa store do módulo: a linha
// do menu (resumeRowSummary com useResumeTask) e a tela mostram o mesmo, e o envio continua (com o aviso global) se a
// tela sair. No Android, a foto tirada antes de o sistema fechar o app com a câmera aberta é enviada quando a tela (ou o
// menu) abre (useResumeRecovery). Só online: sem rede, avisa antes de abrir o seletor e nada entra na fila.

import { randomUUID } from "expo-crypto";
import { useEffect, useSyncExternalStore } from "react";
import { capturePhotos, recoverCapture } from "../components/ticket/photoCapture";
import { ApiError, errorMessage } from "./api";
import { confirmAction } from "./dialogs";
import { discardDocumentFile, documentFromPhoto, pickDocumentFile, type PickedDocumentFile } from "./documentFile";
import { DOCUMENT_SEND_TEXT, FILE_PROBLEM_TEXT, resumeFields, type FileProblem, type ResumeTask } from "./documentRules";
import { deleteDocument, sendDocument } from "./documents";
import { haptic } from "./haptics";
import { noNetwork, offlineFailure } from "./net";
import { session } from "./session";
import { showToast } from "./toast";
import type { MyDocument } from "./types";

export type { ResumeTask };

/** De onde vem o currículo: o seletor de arquivos, a câmera ou a galeria. */
export type ResumeSource = "document" | "camera" | "library";

const NO_INTERNET = "Sem internet";
const OFFLINE_SEND = "Conecte o aparelho para enviar o currículo.";
const OFFLINE_DELETE = "Conecte o aparelho para excluir.";

let uploads = 0;
let removals = 0;
let task: ResumeTask = null;
/** Um seletor por vez (câmera, galeria ou arquivos abertos, ou o escolhido ainda indo). */
let picking = false;
/** A pergunta "Excluir o currículo?" na tela. */
let confirming = false;
const listeners = new Set<() => void>();

function publish() {
  const next: ResumeTask = removals > 0 ? "remove" : uploads > 0 ? "upload" : null;
  if (next === task) return;
  task = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getTask = () => task;

/** "upload" | "remove" | null, o mesmo na linha do menu e na tela Currículo. */
export function useResumeTask(): ResumeTask {
  return useSyncExternalStore(subscribe, getTask, getTask);
}

const currentUserId = () => session.get().user?.id ?? null;

/** O arquivo que não serve: o que fazer, num toast (o currículo não tem formulário). */
function warnFile(problem: FileProblem) {
  haptic.warning();
  showToast("Currículo não enviado", { tone: "error", description: FILE_PROBLEM_TEXT[problem] });
}

/** Envia o arquivo escolhido (com um currículo gravado, o servidor troca o arquivo dele) e apaga a cópia do app. */
async function sendResume(file: PickedDocumentFile): Promise<void> {
  const userId = currentUserId();
  uploads += 1;
  publish();
  try {
    // Um arquivo, um envio: o mesmo id só se repetiria se este arquivo fosse mandado de novo.
    await sendDocument(file, resumeFields(randomUUID()));
    // Saiu da conta no meio do envio: nada de aviso para quem entrar depois.
    if (currentUserId() !== userId) return;
    haptic.success();
    showToast("Currículo enviado", { tone: "success" });
  } catch (error) {
    if (currentUserId() !== userId) return;
    if (await offlineFailure(error)) showToast(NO_INTERNET, { description: OFFLINE_SEND });
    else {
      const message = error instanceof ApiError && error.status === 408 ? DOCUMENT_SEND_TEXT.timeout : errorMessage(error);
      showToast("Não foi possível enviar o currículo", { tone: "error", description: message });
    }
  } finally {
    discardDocumentFile(file);
    uploads -= 1;
    publish();
  }
}

/** Escolhe (arquivo ou galeria) ou tira (câmera) o currículo e envia. Sem rede, avisa antes de abrir o seletor. */
export async function changeResume(source: ResumeSource): Promise<void> {
  if (picking || confirming || task !== null) return;
  picking = true;
  try {
    if (await noNetwork()) {
      showToast(NO_INTERNET, { description: OFFLINE_SEND });
      return;
    }
    let file: PickedDocumentFile | null = null;
    if (source === "document") {
      file = await pickDocumentFile("resume", warnFile);
    } else {
      const [asset] = await capturePhotos(source, { kind: "document", slot: "resume" });
      if (asset) file = await documentFromPhoto(asset, "resume", warnFile);
    }
    if (file) await sendResume(file);
  } finally {
    picking = false;
  }
}

/** Exclui o currículo, depois de confirmar (o arquivo e as versões anteriores saem do cadastro). */
export async function deleteResume(resume: Pick<MyDocument, "id">): Promise<void> {
  // Dois toques seguidos não abrem duas perguntas.
  if (picking || confirming || task !== null) return;
  confirming = true;
  let ok = false;
  try {
    ok = await confirmAction("Excluir o currículo?", "Ele sai do seu cadastro.", { confirmText: "Excluir", destructive: true });
  } finally {
    confirming = false;
  }
  if (!ok) return;
  if (await noNetwork()) {
    showToast(NO_INTERNET, { description: OFFLINE_DELETE });
    return;
  }
  const userId = currentUserId();
  removals += 1;
  publish();
  try {
    await deleteDocument(resume.id);
    if (currentUserId() !== userId) return;
    haptic.success();
    showToast("Currículo excluído", { tone: "success" });
  } catch (error) {
    if (currentUserId() !== userId) return;
    if (await offlineFailure(error)) showToast(NO_INTERNET, { description: OFFLINE_DELETE });
    else showToast("Não foi possível excluir o currículo", { tone: "error", description: errorMessage(error) });
  } finally {
    removals -= 1;
    publish();
  }
}

/**
 * Android: a foto do currículo tirada antes de o sistema fechar o app com a câmera aberta (aparelho com pouca memória) é
 * enviada quando a tela Currículo (ou o menu de Configurações) abre. A recuperação é uma por vez e consome o resultado
 * (photoCapture.ts): as telas não disputam a foto, e ela vai mesmo se a tela sair no meio.
 */
export function useResumeRecovery(): void {
  useEffect(() => {
    recoverCapture((target) => target.kind === "document" && target.slot === "resume")
      .then(async (found) => {
        const asset = found?.assets[0];
        if (!asset) return;
        const file = await documentFromPhoto(asset, "resume", warnFile);
        if (file) await sendResume(file);
      })
      .catch((error: unknown) => console.warn("Não foi possível recuperar a foto do currículo", error));
  }, []);
}
