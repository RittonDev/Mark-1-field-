// A foto do cadastro (Configurações › Foto do perfil): tirar, escolher da galeria e remover, com os avisos de sempre.
// O que está acontecendo (enviando ou removendo) fica numa store do módulo: a linha de Configurações e a tela Foto do
// perfil mostram o mesmo, e o envio continua (com o aviso global) se a tela sair. No Android, a foto tirada antes de o
// sistema fechar o app com a câmera aberta é enviada quando uma das duas telas abre. Só online, como o cadastro.

import { useEffect, useSyncExternalStore } from "react";
import { capturePhotos, recoverCapture } from "../components/ticket/photoCapture";
import { errorMessage } from "./api";
import { confirmAction } from "./dialogs";
import { haptic } from "./haptics";
import { noNetwork, offlineFailure } from "./net";
import { removeAvatar, uploadAvatar, type AvatarPhoto } from "./profile";
import { session } from "./session";
import { showToast } from "./toast";

/** O que a foto está fazendo agora: enviando a nova, removendo ou nada. */
export type AvatarTask = "upload" | "remove" | null;

const NO_INTERNET = "Sem internet";
const OFFLINE_PHOTO = "Conecte o aparelho para trocar a foto.";

let uploads = 0;
let removals = 0;
let task: AvatarTask = null;
/** Um seletor por vez (câmera ou galeria abertos, ou a foto escolhida ainda indo). */
let picking = false;
/** A pergunta "Remover a foto?" na tela. */
let confirming = false;
const listeners = new Set<() => void>();

function publish() {
  const next: AvatarTask = removals > 0 ? "remove" : uploads > 0 ? "upload" : null;
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

/** "upload" | "remove" | null, o mesmo na linha de Configurações e na tela Foto do perfil. */
export function useAvatarTask(): AvatarTask {
  return useSyncExternalStore(subscribe, getTask, getTask);
}

const currentUserId = () => session.get().user?.id ?? null;

async function sendAvatar(photo: AvatarPhoto): Promise<void> {
  const userId = currentUserId();
  uploads += 1;
  publish();
  try {
    await uploadAvatar(photo);
    // Saiu da conta no meio do envio: nada de aviso para quem entrar depois.
    if (currentUserId() !== userId) return;
    haptic.success();
    showToast("Foto atualizada", { tone: "success" });
  } catch (error) {
    if (currentUserId() !== userId) return;
    if (await offlineFailure(error)) showToast(NO_INTERNET, { description: OFFLINE_PHOTO });
    else showToast("Não foi possível enviar a foto", { tone: "error", description: errorMessage(error) });
  } finally {
    uploads -= 1;
    publish();
  }
}

/** Tira (câmera) ou escolhe (galeria) a foto e envia. Sem rede, avisa antes de abrir o seletor. */
export async function changeAvatar(source: "camera" | "library"): Promise<void> {
  if (picking || confirming || removals > 0) return;
  picking = true;
  try {
    if (await noNetwork()) {
      showToast(NO_INTERNET, { description: OFFLINE_PHOTO });
      return;
    }
    const [photo] = await capturePhotos(source, { kind: "avatar" });
    if (photo) await sendAvatar(photo);
  } finally {
    picking = false;
  }
}

/** Tira a foto (também a que veio do Field Control), depois de confirmar: no lugar ficam as iniciais. */
export async function deleteAvatar(): Promise<void> {
  // Dois toques seguidos não abrem duas perguntas.
  if (picking || confirming || task !== null) return;
  confirming = true;
  let ok = false;
  try {
    ok = await confirmAction("Remover a foto?", "No lugar dela ficam as suas iniciais.", { confirmText: "Remover", destructive: true });
  } finally {
    confirming = false;
  }
  if (!ok) return;
  if (await noNetwork()) {
    showToast(NO_INTERNET, { description: OFFLINE_PHOTO });
    return;
  }
  const userId = currentUserId();
  removals += 1;
  publish();
  try {
    await removeAvatar();
    if (currentUserId() !== userId) return;
    showToast("Foto removida", { tone: "success" });
  } catch (error) {
    if (currentUserId() !== userId) return;
    if (await offlineFailure(error)) showToast(NO_INTERNET, { description: OFFLINE_PHOTO });
    else showToast("Não foi possível remover a foto", { tone: "error", description: errorMessage(error) });
  } finally {
    removals -= 1;
    publish();
  }
}

/**
 * Android: a foto tirada antes de o sistema fechar o app com a câmera aberta (aparelho com pouca memória) é enviada
 * quando Configurações ou a tela Foto do perfil abrem. A recuperação é uma por vez e consome o resultado
 * (photoCapture.ts), então as duas telas não disputam a foto; e ela vai mesmo se a tela sair no meio.
 */
export function useAvatarRecovery(): void {
  useEffect(() => {
    recoverCapture((target) => target.kind === "avatar")
      .then((found) => {
        const photo = found?.assets[0];
        if (photo) void sendAvatar(photo);
      })
      .catch((error: unknown) => console.warn("Não foi possível recuperar a foto do cadastro", error));
  }, []);
}
