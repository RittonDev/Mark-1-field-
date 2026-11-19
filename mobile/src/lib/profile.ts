// O cadastro do técnico (Configurações): GET/PATCH /me/profile, com o perfil técnico, e a foto (POST/DELETE
// /me/profile/photo).
//
// Fica só na memória: endereço e chave PIX nunca vão para o SQLite nem para o SecureStore, e somem ao sair da conta.
// Nada entra na fila offline (a senha pedida para e-mail e PIX não fica guardada, e o aviso à central sai na hora):
// abrir, salvar e trocar a foto pedem internet. Nome, e-mail e celular atualizam também o usuário da sessão
// (session.updateUser grava o e-mail novo para preencher o login).
//
// Gravações em fila (salvar, trocar e tirar a foto): uma só sai depois de a anterior responder. O "salvar ao tocar"
// do perfil técnico nunca corre junto de outra gravação, e cada resposta já inclui a anterior. Uma leitura durante a
// qual uma gravação saiu, voltou ou ficou no ar não é publicada: ela pode ser de antes da gravação e desfaria a
// mudança na tela (fica o que a gravação devolveu).

import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { useSyncExternalStore } from "react";
import { api, uploadFile } from "./api";
import { deletePhotoFile } from "./photoFiles";
import { session } from "./session";
import type { MyProfile, MyProfileUpdate } from "./types";

/** A foto vai quadrada, com 512 px de lado, em JPEG (poucos KB: o servidor aceita até 2 MB). */
const AVATAR_SIZE = 512;
const AVATAR_QUALITY = 0.85;
/** Foto já quadrada (recorte do seletor): decodifica no máximo com este lado, para caber na memória de aparelho simples. */
const DECODE_MAX = 1024;
/** O link da foto vale 12 h: o cadastro é relido quando passa da metade disso (ou quando falta). */
const STALE_MS = 6 * 60 * 60_000;

interface Snapshot {
  profile: MyProfile | null;
  /** Quando foi lido do servidor (ms), para saber se o link da foto ainda vale. */
  loadedAt: number;
}

const EMPTY: Snapshot = { profile: null, loadedAt: 0 };
let current: Snapshot = EMPTY;
const listeners = new Set<() => void>();

function publish(next: Snapshot) {
  current = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const getProfile = () => current.profile;

/** O cadastro na memória (null até a primeira leitura, sem internet ou depois de sair da conta). */
export function useProfile(): MyProfile | null {
  return useSyncExternalStore(subscribe, getProfile, getProfile);
}

// Saiu da conta (ou entrou outro técnico): o cadastro do anterior sai da memória.
session.subscribe(() => {
  const owner = current.profile?.id;
  if (!owner) return;
  const { status, user } = session.get();
  if (status !== "signedIn" || user?.id !== owner) publish(EMPTY);
});

/**
 * Guarda a resposta do servidor, se quem pediu ainda é quem está na sessão (o "Sair" no meio do pedido não pode
 * trazer o cadastro de volta), e leva nome, e-mail e celular para o usuário da sessão.
 */
async function keep(profile: MyProfile, askedBy: string | null): Promise<MyProfile> {
  const { status, user } = session.get();
  if (status !== "signedIn" || !user || user.id !== askedBy || profile.id !== user.id) return profile;
  publish({ profile, loadedAt: Date.now() });
  if (user.name !== profile.name || user.email !== profile.email || user.phone !== profile.phone) {
    await session
      .updateUser({ ...user, name: profile.name, email: profile.email, phone: profile.phone })
      .catch((error: unknown) => console.warn("Falha ao guardar o usuário da sessão", error));
  }
  return profile;
}

/** O servidor já manda o perfil técnico (API nova): as telas de Atendimento só abrem com ele. */
export function hasTechnicalProfile(p: MyProfile | null | undefined): p is MyProfile {
  return (
    !!p &&
    Array.isArray(p.skills) &&
    Array.isArray(p.tool_ids) &&
    Array.isArray(p.availability) &&
    !!p.tech_profile_updated
  );
}

/** Sobe quando uma gravação sai e quando ela volta (com ou sem erro): ímpar = gravação no ar. */
let writes = 0;
/** A última gravação da fila (nunca rejeita: a falha de uma não trava a seguinte). */
let writeChain: Promise<unknown> = Promise.resolve();

/**
 * Põe a gravação na fila: ela sai depois de a anterior responder. Se a sessão mudou enquanto esperava (saiu da conta ou
 * entrou outro técnico), ela não sai: o pedido levaria o token de outra pessoa.
 */
function queueWrite<T>(askedBy: string | null, task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(async () => {
    if ((session.get().user?.id ?? null) !== askedBy) throw new Error("Sessão encerrada");
    writes += 1;
    try {
      return await task();
    } finally {
      writes += 1;
    }
  });
  writeChain = run.catch(() => undefined);
  return run;
}

let inflight: { userId: string | null; promise: Promise<MyProfile> } | null = null;

/**
 * Lê o cadastro no servidor. Pedidos ao mesmo tempo dividem a mesma leitura. Se uma gravação saiu, voltou ou ainda está
 * no ar durante a leitura, a resposta não é publicada e volta o cadastro da memória (o que a gravação devolveu).
 */
export function loadProfile(): Promise<MyProfile> {
  const userId = session.get().user?.id ?? null;
  if (inflight?.userId === userId) return inflight.promise;
  const startedAt = writes;
  const promise = api.get<MyProfile>("/me/profile").then((profile) => {
    const shown = current.profile;
    const raced = writes !== startedAt || writes % 2 === 1;
    if (raced && shown && shown.id === profile.id) return shown;
    return keep(profile, userId);
  });
  inflight = { userId, promise };
  const settle = () => {
    if (inflight?.promise === promise) inflight = null;
  };
  promise.then(settle, settle);
  return promise;
}

/** Lê o cadastro quando ainda não está na memória ou ficou velho (o link da foto vence). Não avisa erro. */
export function ensureProfile(): void {
  if (session.get().status !== "signedIn") return;
  if (current.profile && Date.now() - current.loadedAt < STALE_MS) return;
  void loadProfile().catch(() => undefined);
}

/**
 * PATCH /me/profile: só o que mudou (e-mail e PIX com `current_password`; as partes do perfil técnico inteiras). Sai
 * depois da gravação anterior. Devolve o cadastro como ficou.
 */
export function saveProfile(body: MyProfileUpdate): Promise<MyProfile> {
  const userId = session.get().user?.id ?? null;
  return queueWrite(userId, async () => keep(await api.patch<MyProfile>("/me/profile", body), userId));
}

export interface AvatarPhoto {
  uri: string;
  /** Tamanho da foto escolhida (0 ou ausente quando o sistema não informa). */
  width?: number;
  height?: number;
}

type Square = { originX: number; originY: number; width: number; height: number };

/** Corta, reduz e grava em JPEG no cache; devolve o arquivo novo. */
async function renderAvatar(uri: string, square: Square | null, side: number): Promise<string> {
  const context = square ? ImageManipulator.manipulate(uri) : ImageManipulator.manipulate(uri, { maxWidth: DECODE_MAX });
  try {
    if (square) context.crop(square);
    const image = await context.resize({ width: Math.min(AVATAR_SIZE, side) }).renderAsync();
    try {
      const saved = await image.saveAsync({ compress: AVATAR_QUALITY, format: SaveFormat.JPEG });
      return saved.uri;
    } finally {
      image.release();
    }
  } finally {
    context.release();
  }
}

/**
 * Foto quadrada de no máximo 512 px. O seletor já entrega recortada (1:1); quando não recorta (pré-visualização
 * web), o quadrado é o centro da foto. Se o tamanho informado não bater com o arquivo, só reduz.
 */
async function reduceAvatar(photo: AvatarPhoto): Promise<string> {
  const width = photo.width ?? 0;
  const height = photo.height ?? 0;
  const known = width > 0 && height > 0;
  const side = known ? Math.min(width, height) : AVATAR_SIZE;
  if (known && width !== height) {
    const square = { originX: Math.floor((width - side) / 2), originY: Math.floor((height - side) / 2), width: side, height: side };
    try {
      return await renderAvatar(photo.uri, square, side);
    } catch (error) {
      console.warn("Falha ao recortar a foto do cadastro", error);
    }
  }
  return renderAvatar(photo.uri, null, side);
}

/**
 * Troca a foto do cadastro: reduz no aparelho (fora da fila) e envia na fila das gravações. O arquivo reduzido sai do
 * cache depois do envio, ou se ele não chegar a sair.
 */
export async function uploadAvatar(photo: AvatarPhoto): Promise<MyProfile> {
  const userId = session.get().user?.id ?? null;
  let reduced: string;
  try {
    reduced = await reduceAvatar(photo);
  } catch (error) {
    console.warn("Falha ao reduzir a foto do cadastro", error);
    throw new Error("Não foi possível preparar a foto. Escolha outra ou tire de novo.");
  }
  try {
    return await queueWrite(userId, async () =>
      keep(await uploadFile<MyProfile>("/me/profile/photo", reduced, {}, "image/jpeg", "foto.jpg"), userId),
    );
  } finally {
    deletePhotoFile(reduced);
  }
}

/** Tira a foto (também a que veio do Field Control): no lugar ficam as iniciais. Sai na fila das gravações. */
export function removeAvatar(): Promise<MyProfile> {
  const userId = session.get().user?.id ?? null;
  return queueWrite(userId, async () => keep(await api.delete<MyProfile>("/me/profile/photo"), userId));
}
