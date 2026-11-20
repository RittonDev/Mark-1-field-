// Salvar ao tocar (Configurações › Disponibilidade, Transporte e Ferramental): o toque muda a tela na hora e os toques
// de perto vão juntos num PATCH /me/profile só, depois de 0,6 s sem toque, um envio por vez (a fila de gravações de
// lib/profile.ts). Sem rede, o app avisa e não muda nada. Se o envio falhar, a tela volta ao que está gravado e avisa.
// A decisão fica no redutor puro `autoSaveStep` (lib/techProfileForm.ts, com sonda); aqui ficam os relógios, o envio e
// os avisos.
//
// Um salvador por parte, criado no módulo da tela (createAutoSave), não dentro dela: sair da tela com o envio agendado
// manda na hora e o pedido continua depois de a tela sair (o aviso é global); voltar à tela no meio do envio mostra o
// que está indo. Saiu da conta ou entrou outro técnico: o que estava pendente é descartado em silêncio.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { errorMessage } from "./api";
import { haptic } from "./haptics";
import { offlineFailure } from "./net";
import { getProfile, hasTechnicalProfile, saveProfile } from "./profile";
import { session } from "./session";
import { useSyncStatus } from "./sync";
import {
  AUTO_SAVE_START,
  autoSaveStep,
  type AutoSaveEffect,
  type AutoSaveEvent,
  type AutoSaveState,
  type AutoSaveStatus,
} from "./techProfileForm";
import { showToast } from "./toast";
import type { MyProfile, MyProfileUpdate } from "./types";

/** Espera sem toque antes de enviar: os toques de perto vão juntos (uma linha no histórico da central). */
const WAIT_MS = 600;
/** Quanto tempo o "Salvo" fica no cabeçalho. */
const SAVED_MS = 2000;
const NO_INTERNET = "Sem internet";

export interface AutoSaveConfig<T> {
  /** A parte gravada, tirada do cadastro (só é chamado com o perfil técnico). */
  select: (profile: MyProfile) => T;
  equals: (a: T, b: T) => boolean;
  /** O corpo do PATCH, com a parte inteira. */
  body: (value: T) => MyProfileUpdate;
  /** A descrição do aviso "Sem internet". */
  offlineHint: string;
  /** O título do aviso de erro (a descrição é a mensagem do servidor). */
  errorTitle: string;
  /** Gravou: o que foi enviado e o que o servidor guardou (ele ignora a ferramenta desativada). */
  onSaved?: (sent: T, saved: T) => void;
  /** Falhou por outro motivo que não a falta de rede (o aviso já saiu). */
  onFailed?: (error: unknown) => void;
}

interface AutoSaveView<T> {
  desired: T | null;
  status: AutoSaveStatus;
}

export interface AutoSaver<T> {
  readonly offlineHint: string;
  subscribe: (listener: () => void) => () => void;
  view: () => AutoSaveView<T>;
  /** Um toque (a tela já conferiu a rede): o valor novo ou uma função do valor que a tela mostra. */
  change: (next: T | ((current: T) => T)) => void;
  /** A tela saiu: o envio agendado sai na hora. */
  flush: () => void;
}

/** O salvador de uma parte do perfil técnico. Chame no módulo da tela (um por parte, vive enquanto o app vive). */
export function createAutoSave<T>(config: AutoSaveConfig<T>): AutoSaver<T> {
  let state: AutoSaveState<T> = AUTO_SAVE_START;
  let view: AutoSaveView<T> = { desired: null, status: "idle" };
  /** Quem fez a mudança pendente: o envio é dele, e a troca de sessão o descarta. */
  let owner: string | null = null;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();

  /** O que está gravado agora (null: o cadastro com o perfil técnico não está na memória). */
  function savedNow(): T | null {
    const profile = getProfile();
    return hasTechnicalProfile(profile) ? config.select(profile) : null;
  }

  function dispatch(event: AutoSaveEvent<T>) {
    const step = autoSaveStep(state, event, config.equals);
    state = step.state;
    if (state.desired !== view.desired || state.status !== view.status) {
      view = { desired: state.desired, status: state.status };
      listeners.forEach((listener) => listener());
    }
    run(step.effect);
  }

  function run(effect: AutoSaveEffect<T>) {
    if (!effect) return;
    switch (effect.kind) {
      case "schedule":
        clearTimeout(waitTimer);
        waitTimer = setTimeout(due, WAIT_MS);
        return;
      case "send":
        void send(effect.value, effect.epoch);
        return;
      case "saved":
        clearTimeout(savedTimer);
        savedTimer = setTimeout(() => dispatch({ type: "settled" }), SAVED_MS);
        return;
      case "cancel":
        clearTimeout(waitTimer);
        clearTimeout(savedTimer);
        return;
    }
  }

  function due() {
    clearTimeout(waitTimer);
    const saved = savedNow();
    // O cadastro saiu da memória (saiu da conta): não há o que comparar nem para quem enviar.
    if (saved === null) dispatch({ type: "reset" });
    else dispatch({ type: "due", saved });
  }

  async function send(value: T, epoch: number) {
    const askedBy = owner;
    try {
      const profile = await saveProfile(config.body(value));
      const saved = hasTechnicalProfile(profile) ? config.select(profile) : value;
      dispatch({ type: "done", epoch, saved });
      if (epoch === state.epoch) config.onSaved?.(value, saved);
    } catch (error) {
      // Resposta de um envio de antes da troca de sessão: não muda nada nem avisa.
      if (epoch !== state.epoch) return;
      dispatch({ type: "failed", epoch });
      if ((session.get().user?.id ?? null) !== askedBy) return;
      haptic.warning();
      if (await offlineFailure(error)) {
        showToast(NO_INTERNET, { description: config.offlineHint });
        return;
      }
      showToast(config.errorTitle, { tone: "error", description: errorMessage(error) });
      config.onFailed?.(error);
    }
  }

  // Saiu da conta ou entrou outro técnico: o que estava pendente sai em silêncio.
  session.subscribe(() => {
    if (owner === null) return;
    const { status, user } = session.get();
    if (status === "signedIn" && user?.id === owner) return;
    owner = null;
    dispatch({ type: "reset" });
  });

  return {
    offlineHint: config.offlineHint,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    view: () => view,
    change(next) {
      const saved = savedNow();
      if (saved === null) return;
      const current = state.desired ?? saved;
      owner = session.get().user?.id ?? null;
      dispatch({ type: "change", value: typeof next === "function" ? (next as (current: T) => T)(current) : next });
    },
    flush() {
      if (state.phase === "waiting") due();
    },
  };
}

export interface AutoSave<T> {
  /** O que a tela mostra: o que o técnico marcou ou, sem nada pendente, o que está gravado. */
  value: T;
  /**
   * Um toque: o valor novo ou uma função do valor atual (toques rápidos não se perdem). Sem rede, avisa e não muda nada.
   * `feedback`: a vibração do toque (padrão: a da seleção).
   */
  change: (next: T | ((current: T) => T), feedback?: () => void) => void;
  /** Dá para mudar agora? Sem rede, avisa e devolve false (para conferir antes de perguntar algo ao técnico). */
  ready: () => boolean;
  /** O cabeçalho: "Salvando…", "Salvo" ou nada. */
  status: AutoSaveStatus;
}

/** A tela de uma parte com salvar ao tocar. `saved`: a parte no cadastro da memória (o que a tela mostra sem toque). */
export function useAutoSave<T>(saver: AutoSaver<T>, saved: T): AutoSave<T> {
  const { network } = useSyncStatus();
  const view = useSyncExternalStore(saver.subscribe, saver.view, saver.view);
  // Saiu da tela com o envio agendado: manda na hora (o pedido continua depois de a tela sair).
  useEffect(() => () => saver.flush(), [saver]);
  const offline = network === "offline";

  const ready = useCallback(() => {
    if (!offline) return true;
    haptic.warning();
    showToast(NO_INTERNET, { description: saver.offlineHint });
    return false;
  }, [offline, saver]);

  const change = useCallback(
    (next: T | ((current: T) => T), feedback: () => void = haptic.select) => {
      if (!ready()) return;
      feedback();
      saver.change(next);
    },
    [ready, saver],
  );

  return { value: view.desired ?? saved, change, ready, status: view.status };
}
