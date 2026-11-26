// Estado das telas do cadastro em Configurações. `useProfileLoad`: o cadastro da memória e a releitura do servidor ao
// abrir, ao puxar e quando o app volta para o primeiro plano (o menu, a Foto do perfil e os formulários).
// `useProfileForm`: um formulário que salva só a sua parte, com o comportamento que o Meu cadastro já tinha: abre com o
// cadastro da memória e relê sem apagar o que foi digitado; os erros aparecem depois do primeiro "Salvar" (o primeiro
// vai para o rodapé); sem rede, avisa antes de enviar; a tela pode perguntar antes de enviar ("Confira o CPF"); e-mail e
// dados da empresa pedem a senha numa folha; salvou, avisa e sai; sair com alteração pergunta. Tudo só online
// (lib/profile.ts).

import { router, usePreventRemove } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { PasswordSheetProps } from "../components/settings/PasswordSheet";
import type { ProfileLoad } from "../components/settings/ProfileGate";
import { errorMessage } from "./api";
import { confirmAction } from "./dialogs";
import { haptic } from "./haptics";
import { noNetwork, offlineFailure } from "./net";
import { loadProfile, saveProfile, useProfile } from "./profile";
import { firstError, hasChanges, rebase, type SectionReview, type SectionSpec } from "./profileForm";
import { showToast } from "./toast";
import type { MyProfile } from "./types";

const NO_INTERNET = "Sem internet";
const OFFLINE_SAVE = "Conecte o aparelho para salvar seu cadastro.";

/** A pergunta da tela antes de enviar ("Confira o CPF"); o outro botão é "Voltar", que não envia nada. */
export interface SaveConfirm {
  title: string;
  message: string;
  confirmText: string;
}

/**
 * A tela do cadastro: a SectionSpec de lib/profileForm.ts com o que o cadastro V2 acrescenta. `saved` recebe também o
 * formulário gravado (o aviso do e-mail novo cita o de hoje) e `confirm`, quando devolve uma pergunta, roda antes da
 * senha e do envio. Uma SectionSpec sem os dois também serve.
 */
export type ProfileFormSpec<F extends object, K extends string> = SectionSpec<F, K> & {
  saved: (review: SectionReview<K>, base: F) => { title: string; description?: string };
  confirm?: (review: SectionReview<K>, base: F) => SaveConfirm | null;
};

export interface ProfileLoadState {
  /** O cadastro na memória (null até a primeira leitura, sem internet ou depois de sair da conta). */
  profile: MyProfile | null;
  /** A última leitura do servidor feita por esta tela. */
  load: ProfileLoad;
  /** "Tentar de novo": volta a carregar. */
  retry: () => void;
  /** Puxar para atualizar: relê sem esconder o que está na tela. */
  refresh: () => void;
  refreshing: boolean;
}

/**
 * Relê o cadastro ao abrir a tela (a leitura em andamento é compartilhada), em "Tentar de novo", ao puxar e quando o app
 * volta para o primeiro plano. O link do e-mail abre no navegador, fora do app: na volta, o Contato (e a linha dele no
 * menu) já mostra o login validado, em vez de agir sobre o estado de antes.
 */
export function useProfileLoad(): ProfileLoadState {
  const profile = useProfile();
  const [load, setLoad] = useState<ProfileLoad>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let alive = true;
    loadProfile()
      .then(() => {
        if (!alive) return;
        setLoad({ status: "ok" });
        setRefreshing(false);
      })
      .catch(async (error: unknown) => {
        const offline = await offlineFailure(error);
        if (!alive) return;
        setLoad({ status: "error", offline, message: errorMessage(error) });
        setRefreshing(false);
      });
    return () => {
      alive = false;
    };
  }, [attempt]);

  // De volta ao app (do navegador, do e-mail, do WhatsApp): relê sem esconder o que está na tela; o formulário guarda o
  // que foi digitado (rebase).
  useEffect(() => {
    let alive = true;
    let current: string = AppState.currentState ?? "active";
    const sub = AppState.addEventListener("change", (next) => {
      const back = next === "active" && current !== "active";
      current = next;
      if (!back) return;
      loadProfile().then(
        () => {
          if (alive) setLoad({ status: "ok" });
        },
        async (error: unknown) => {
          const offline = await offlineFailure(error);
          if (alive) setLoad({ status: "error", offline, message: errorMessage(error) });
        },
      );
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  const retry = useCallback(() => {
    setLoad({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setLoad({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  return { profile, load, retry, refresh, refreshing };
}

export interface ProfileFormState<F extends object, K extends string> {
  profile: MyProfile | null;
  load: ProfileLoad;
  retry: () => void;
  /** Puxar para atualizar (ProfileFormScreen): relê sem apagar o que foi digitado. */
  refresh: () => void;
  refreshing: boolean;
  /** O formulário (null sem o cadastro na memória). */
  form: F | null;
  /** O mesmo formulário montado do cadastro gravado (para comparar e voltar ao gravado). */
  base: F | null;
  review: SectionReview<K> | null;
  update: (patch: Partial<F>) => void;
  /** Só depois do primeiro "Salvar". */
  errors: Partial<Record<K, string>>;
  footerError: string | null;
  dirty: boolean;
  saving: boolean;
  save: () => Promise<void>;
  /** Pronto para `<PasswordSheet {...sheet} />`; null na tela que não pede a senha. */
  sheet: PasswordSheetProps | null;
}

/** Salvou: volta para Configurações (sem histórico, abre Configurações). */
function leaveScreen() {
  if (router.canGoBack()) router.back();
  else router.replace("/configuracoes");
}

/** Um formulário do cadastro. `spec` é uma constante do módulo (lib/profileForm.ts). */
export function useProfileForm<F extends object, K extends string>(spec: ProfileFormSpec<F, K>): ProfileFormState<F, K> {
  const { profile, load, retry, refresh, refreshing } = useProfileLoad();
  // O cadastro de que o formulário partiu (para acompanhar uma releitura sem perder o que foi digitado).
  const [shown, setShown] = useState<MyProfile | null>(profile);
  const [form, setForm] = useState<F | null>(() => (profile ? spec.fromProfile(profile) : null));
  // Depois do primeiro "Salvar", os erros aparecem e acompanham a digitação.
  const [attempted, setAttempted] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Salvou ou descartou: sai sem perguntar.
  const [done, setDone] = useState(false);
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const mounted = useRef(true);
  const busy = useRef(false);
  const leaveAfterSheet = useRef(false);

  if (profile !== shown) {
    setShown(profile);
    if (profile) {
      setForm((current) => (current && shown ? rebase(current, spec.fromProfile(shown), spec.fromProfile(profile)) : spec.fromProfile(profile)));
    }
  }

  const base = profile ? spec.fromProfile(profile) : null;
  const review = form && base ? spec.review(form, base) : null;
  const dirty = Boolean(review && hasChanges(review));

  const allowLeave = usePreventRemove(dirty && !done, ({ repeat }) => {
    void confirmAction("Descartar as alterações?", "O que você mudou não foi salvo.", {
      confirmText: "Descartar",
      destructive: true,
    }).then((ok) => {
      if (!ok) return;
      setDone(true);
      repeat();
    });
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function update(patch: Partial<F>) {
    setForm((current) => (current ? { ...current, ...patch } : current));
    setSaveError(null);
  }

  /** Envia o que mudou; `from` é o formulário gravado de quando tocou em "Salvar" (para o aviso de salvo). */
  async function submit(changes: SectionReview<K>, from: F, currentPassword?: string) {
    const inSheet = currentPassword !== undefined;
    setSaving(true);
    try {
      await saveProfile(inSheet ? { ...changes.body, current_password: currentPassword } : changes.body);
      haptic.success();
      const { title, description } = spec.saved(changes, from);
      showToast(title, { tone: "success", description });
      // Saiu da tela enquanto salvava (descartou): o aviso basta, sem voltar mais uma tela.
      if (!mounted.current) return;
      setDone(true);
      allowLeave();
      // Com a folha da senha aberta, volta depois que ela sair (no iPhone, a tela não sai com um Modal saindo).
      if (inSheet) {
        leaveAfterSheet.current = true;
        setAsking(false);
      } else {
        leaveScreen();
      }
    } catch (error) {
      const offline = await offlineFailure(error);
      if (inSheet) {
        // A folha mostra o erro, limpa a senha e devolve o foco ao campo (PasswordSheet).
        setPasswordError(offline ? `${NO_INTERNET}. ${OFFLINE_SAVE}` : errorMessage(error));
        // Fechando a folha para corrigir o formulário (e-mail já cadastrado), o motivo continua no rodapé.
        if (!offline) setSaveError(errorMessage(error));
        setPassword("");
      } else if (offline) {
        showToast(NO_INTERNET, { description: OFFLINE_SAVE });
      } else {
        setSaveError(errorMessage(error));
      }
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    // Dois toques seguidos não mandam dois pedidos (a conferência da rede já é assíncrona).
    if (!review || !base || busy.current) return;
    setAttempted(true);
    setSaveError(null);
    if (firstError(review.errors, spec.order)) {
      haptic.warning();
      return;
    }
    if (!hasChanges(review)) return;
    busy.current = true;
    try {
      if (await noNetwork()) {
        showToast(NO_INTERNET, { description: OFFLINE_SAVE });
        return;
      }
      // A pergunta da tela (CPF, que depois só a central muda): "Voltar" não envia nem pede a senha.
      const ask = spec.confirm?.(review, base) ?? null;
      if (ask) {
        const ok = await confirmAction(ask.title, ask.message, { confirmText: ask.confirmText, cancelText: "Voltar" });
        if (!ok || !mounted.current) return;
      }
      if (review.needsPassword) {
        setPassword("");
        setPasswordError(null);
        setAsking(true);
        return;
      }
      await submit(review, base);
    } finally {
      busy.current = false;
    }
  }

  async function confirmWithPassword() {
    if (!review || !base || busy.current) return;
    if (!password) {
      setPasswordError("Informe a senha atual.");
      return;
    }
    setPasswordError(null);
    busy.current = true;
    try {
      await submit(review, base, password);
    } finally {
      busy.current = false;
    }
  }

  function closeSheet() {
    if (saving) return;
    setAsking(false);
    setPassword("");
    setPasswordError(null);
  }

  function sheetClosed() {
    if (!leaveAfterSheet.current) return;
    leaveAfterSheet.current = false;
    leaveScreen();
  }

  const sheet: PasswordSheetProps | null = spec.passwordReason
    ? {
        visible: asking,
        description: spec.passwordReason,
        password,
        onChangePassword: (text) => {
          setPassword(text);
          if (passwordError) setPasswordError(null);
        },
        error: passwordError,
        saving,
        onConfirm: () => void confirmWithPassword(),
        onClose: closeSheet,
        onClosed: sheetClosed,
      }
    : null;

  return {
    profile,
    load,
    retry,
    refresh,
    refreshing,
    form,
    base,
    review,
    update,
    errors: attempted && review ? review.errors : {},
    footerError: saveError ?? (attempted && review ? firstError(review.errors, spec.order) : null),
    dirty,
    saving,
    save,
    sheet,
  };
}
