// O cadastro do técnico (Configurações): GET/PATCH /me/profile, com o perfil técnico, a foto (POST/DELETE
// /me/profile/photo), as formas de recebimento (/me/profile/payout-methods, em lib/payoutMethods.ts) e o link de
// validação do e-mail (POST /me/profile/email/verification e DELETE /me/profile/email/pending). Toda rota do cadastro
// devolve o MyProfile inteiro: writeProfile põe o pedido na fila e guarda o que voltar.
//
// Fica só na memória: endereço, CPF e RG, a lista de documentos (pessoais, certificações e currículo, sem link: o link
// de cada arquivo é pedido na hora), chaves e contas nunca vão para o SQLite nem para o SecureStore, e somem ao sair da
// conta. Nada entra na fila offline (a senha pedida para o e-mail, os dados da empresa e as formas de recebimento não
// fica guardada, e o aviso à central sai na hora): abrir, salvar e trocar a foto pedem internet. Nome, e-mail e celular
// atualizam também o usuário da sessão, e o e-mail de login vira o último login (session.updateUser, para preencher o
// login). O e-mail novo só vira login depois do link, aberto fora do app: a leitura do cadastro (ou a renovação do token,
// session.setTokens) traz o novo.
//
// A central também muda o cadastro (o perfil profissional e os documentos, na ficha do técnico): o tempo real avisa só a
// ele (me.profile_changed, lib/sync.ts) e, com o cadastro na memória, ele é relido (profileChangedElsewhere).
//
// Gravações em fila (salvar, foto, formas de recebimento e e-mail): uma só sai depois de a anterior responder. O
// "salvar ao tocar" do perfil técnico nunca corre junto de outra gravação, e cada resposta já inclui a anterior. As
// listas que vão inteiras no PATCH (Aptidões, Formação e Indisponibilidade) montam o corpo na hora em que a gravação sai
// da fila (saveProfileWith), com o cadastro que a anterior devolveu: uma exclusão que esperou outra não devolve o item
// que a outra tirou. Uma leitura durante a qual uma gravação saiu, voltou ou ficou no ar não é publicada: ela pode ser
// de antes da gravação e desfaria a mudança na tela (fica o que a gravação devolveu).

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

/** A central mudou o cadastro: a releitura sai este tempo depois do último aviso (avisos seguidos viram uma leitura). */
const ELSEWHERE_MS = 400;
let elsewhereTimer: ReturnType<typeof setTimeout> | undefined;

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

// Saiu da conta (ou entrou outro técnico): o cadastro do anterior sai da memória, com a releitura que esperava a vez.
session.subscribe(() => {
  const owner = current.profile?.id;
  if (!owner) return;
  const { status, user } = session.get();
  if (status === "signedIn" && user?.id === owner) return;
  clearTimeout(elsewhereTimer);
  elsewhereTimer = undefined;
  publish(EMPTY);
});

/**
 * Guarda a resposta do servidor, se quem pediu ainda é quem está na sessão (o "Sair" no meio do pedido não pode
 * trazer o cadastro de volta), e leva nome, e-mail e celular para o usuário da sessão. O último login também segue o
 * e-mail do cadastro, mesmo com o usuário da sessão já igual (a renovação do token trouxe o e-mail novo antes).
 */
async function keep(profile: MyProfile, askedBy: string | null): Promise<MyProfile> {
  const { status, user, lastEmail } = session.get();
  if (status !== "signedIn" || !user || user.id !== askedBy || profile.id !== user.id) return profile;
  publish({ profile, loadedAt: Date.now() });
  if (user.name !== profile.name || user.email !== profile.email || user.phone !== profile.phone || lastEmail !== profile.email) {
    await session
      .updateUser({ ...user, name: profile.name, email: profile.email, phone: profile.phone })
      .catch((error: unknown) => console.warn("Falha ao guardar o usuário da sessão", error));
  }
  return profile;
}

/** O servidor já manda o perfil técnico (API nova): as telas do Perfil profissional só abrem com ele. */
export function hasTechnicalProfile(p: MyProfile | null | undefined): p is MyProfile {
  return (
    !!p &&
    Array.isArray(p.skills) &&
    Array.isArray(p.tool_ids) &&
    Array.isArray(p.availability) &&
    !!p.tech_profile_updated
  );
}

/**
 * O servidor já tem o cadastro V2 (documentos, endereço em partes, empresa, veículo, formas de recebimento,
 * indisponibilidade e validação do e-mail). O app novo pede a API nova, que sobe antes: sem ela, as telas do cadastro,
 * menos Foto e Senha, mostram UNAVAILABLE (lib/technicalProfile.ts) e não gravam nada. Não estreita o tipo: o cadastro
 * da API antiga também é um MyProfile, só sem os campos novos.
 */
export function hasCadastroV2(p: MyProfile | null | undefined): boolean {
  return (
    !!p &&
    p.cpf !== undefined &&
    p.address_number !== undefined &&
    p.email_pending !== undefined &&
    typeof p.mail_enabled === "boolean" &&
    Array.isArray(p.payout_methods) &&
    Array.isArray(p.unavailability)
  );
}

/**
 * O servidor já tem a gestão (Entrega 2): documentos, currículo, áreas de atuação e aptidões do catálogo (com o id).
 * Sem ela, Documentos, Currículo e Áreas de atuação mostram UNAVAILABLE e as Aptidões seguem pelo nome (`{name,
 * level}`). Não estreita o tipo, como hasCadastroV2.
 */
export function hasCadastroE2(p: MyProfile | null | undefined): boolean {
  return hasCadastroV2(p) && hasTechnicalProfile(p) && Array.isArray(p.documents) && Array.isArray(p.area_ids);
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

/** `round`: a ordem da leitura (reads), para saber se ela saiu antes de um aviso da central. */
let inflight: { userId: string | null; promise: Promise<MyProfile>; round: number } | null = null;
/** Leituras que já saíram (sobe a cada GET /me/profile novo). */
let reads = 0;

/**
 * Lê o cadastro no servidor. Pedidos ao mesmo tempo dividem a mesma leitura. Se uma gravação saiu, voltou ou ainda está
 * no ar durante a leitura, a resposta não é publicada e volta o cadastro da memória (o que a gravação devolveu).
 */
export function loadProfile(): Promise<MyProfile> {
  const userId = session.get().user?.id ?? null;
  if (inflight?.userId === userId) return inflight.promise;
  const startedAt = writes;
  reads += 1;
  const round = reads;
  const promise = api.get<MyProfile>("/me/profile").then((profile) => {
    const shown = current.profile;
    const raced = writes !== startedAt || writes % 2 === 1;
    if (raced && shown && shown.id === profile.id) return shown;
    return keep(profile, userId);
  });
  inflight = { userId, promise, round };
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
 * A central mudou algo que o app mostra (tempo real me.profile_changed, lib/sync.ts): o perfil profissional, os
 * documentos. Com o cadastro na memória, relê 0,4 s depois do último aviso, sem aviso de erro (a tela segue com o da
 * memória); sem ele, nada (é lido ao abrir Configurações). Uma leitura que já estava no ar quando o aviso chegou pode
 * ser de antes da mudança: a releitura espera ela e lê de novo. Vale a regra de loadProfile: a leitura durante uma
 * gravação não é publicada (fica o que a gravação devolveu), e os formulários abertos seguem o cadastro novo sem perder
 * o que foi digitado (rebase).
 */
export function profileChangedElsewhere(): void {
  const owner = current.profile?.id;
  if (!owner) return;
  const readsAtNotice = reads;
  clearTimeout(elsewhereTimer);
  elsewhereTimer = setTimeout(() => {
    elsewhereTimer = undefined;
    // Saiu da conta (ou entrou outro técnico) enquanto esperava: nada sai.
    const mine = () => {
      const { status, user } = session.get();
      return status === "signedIn" && user?.id === owner && current.profile?.id === owner;
    };
    if (!mine()) return;
    const reread = () => (mine() ? loadProfile().then(() => undefined, () => undefined) : undefined);
    const before = inflight && inflight.round <= readsAtNotice ? inflight.promise : null;
    void (before ? before.then(reread, reread) : reread());
  }, ELSEWHERE_MS);
}

/**
 * Uma rota do cadastro que devolve o MyProfile (PATCH, foto, formas de recebimento, e-mail): sai na fila das gravações,
 * depois da anterior, e guarda o que voltar. `send` só roda quando chega a vez (com a sessão de quem pediu).
 */
export function writeProfile(send: () => Promise<MyProfile>): Promise<MyProfile> {
  const userId = session.get().user?.id ?? null;
  return queueWrite(userId, async () => keep(await send(), userId));
}

/**
 * PATCH /me/profile: só o que mudou (e-mail e dados da empresa com `current_password`; as partes do perfil técnico
 * inteiras). Sai depois da gravação anterior. Devolve o cadastro como ficou.
 */
export function saveProfile(body: MyProfileUpdate): Promise<MyProfile> {
  return writeProfile(() => api.patch<MyProfile>("/me/profile", body));
}

/**
 * Envia (ou reenvia) o link de validação: para o e-mail novo pendente ou, sem ele, para o de login ainda não validado.
 * Devolve o cadastro com o `email_link_sent_at` novo. Recusas do servidor: e-mail já validado (409), endereço que não
 * recebe (422), envio desligado (503) e pedidos demais na hora (429).
 */
export function sendEmailLink(): Promise<MyProfile> {
  return writeProfile(() => api.post<MyProfile>("/me/profile/email/verification"));
}

/** Cancela a troca de e-mail: o pendente sai, o link enviado para ele deixa de valer e o login continua o de hoje. */
export function cancelEmailChange(): Promise<MyProfile> {
  return writeProfile(() => api.delete<MyProfile>("/me/profile/email/pending"));
}

/**
 * PATCH /me/profile com o corpo montado na hora em que a gravação sai da fila, com o cadastro da memória (que já tem o
 * que a gravação anterior devolveu): as listas do perfil técnico, que vão inteiras. `build` pode recusar lançando um
 * erro, que volta para quem pediu (e nada sai). Sem o cadastro na memória (a sessão acabou no meio), nada sai.
 */
export function saveProfileWith(build: (profile: MyProfile) => MyProfileUpdate): Promise<MyProfile> {
  const userId = session.get().user?.id ?? null;
  return queueWrite(userId, async () => {
    const profile = current.profile;
    if (!hasTechnicalProfile(profile) || profile.id !== userId) throw new Error("Sessão encerrada");
    return keep(await api.patch<MyProfile>("/me/profile", build(profile)), userId);
  });
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
    // Quem pediu é quem tocou (antes de reduzir a foto), não quem estiver na sessão quando a redução acabar.
    return await queueWrite(userId, async () =>
      keep(await uploadFile<MyProfile>("/me/profile/photo", reduced, {}, "image/jpeg", "foto.jpg"), userId),
    );
  } finally {
    deletePhotoFile(reduced);
  }
}

/** Tira a foto (também a que veio do Field Control): no lugar ficam as iniciais. Sai na fila das gravações. */
export function removeAvatar(): Promise<MyProfile> {
  return writeProfile(() => api.delete<MyProfile>("/me/profile/photo"));
}
