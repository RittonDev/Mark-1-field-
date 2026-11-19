// Estado das telas do cadastro em Configurações. `useProfileLoad`: o cadastro da memória e a releitura do servidor ao
// abrir (o menu, a Foto do perfil e os formulários). `useProfileForm`: um formulário que salva só a sua parte, com o
// comportamento que o Meu cadastro já tinha: abre com o cadastro da memória e relê sem apagar o que foi digitado; os
// erros aparecem depois do primeiro "Salvar" (o primeiro vai para o rodapé); sem rede, avisa antes de enviar; e-mail e
// PIX pedem a senha numa folha; salvou, avisa e sai; sair com alteração pergunta. Tudo só online (lib/profile.ts).

import { router, usePreventRemove } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
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

/** Relê o cadastro ao abrir a tela (a leitura em andamento é compartilhada) e em "Tentar de novo" e puxar. */
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
export function useProfileForm<F extends object, K extends string>(spec: SectionSpec<F, K>): ProfileFormState<F, K> {
  const { profile, load, retry } = useProfileLoad();
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

  async function submit(changes: SectionReview<K>, currentPassword?: string) {
    const inSheet = currentPassword !== undefined;
    setSaving(true);
    try {
      await saveProfile(inSheet ? { ...changes.body, current_password: currentPassword } : changes.body);
      haptic.success();
      const { title, description } = spec.saved(changes);
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
    if (!review || busy.current) return;
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
      if (review.needsPassword) {
        setPassword("");
        setPasswordError(null);
        setAsking(true);
        return;
      }
      await submit(review);
    } finally {
      busy.current = false;
    }
  }

  async function confirmWithPassword() {
    if (!review || busy.current) return;
    if (!password) {
      setPasswordError("Informe a senha atual.");
      return;
    }
    setPasswordError(null);
    busy.current = true;
    try {
      await submit(review, password);
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
