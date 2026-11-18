// Meu cadastro: o técnico mantém a foto, o nome, o celular (WhatsApp), o e-mail de login, o endereço, a cidade/UF,
// a região que atende e a chave PIX em que recebe pelos chamados. E-mail e chave PIX pedem a senha atual (conta
// invadida não desvia o pagamento) e a central é avisada na hora. Tudo pede internet: nada entra na fila offline e o
// cadastro fica só na memória (lib/profile.ts). Grupo, cargo, acesso, serviços e jornada continuam com a central.

import NetInfo from "@react-native-community/netinfo";
import * as Clipboard from "expo-clipboard";
import { router, usePreventRemove } from "expo-router";
import { HeaderHeightContext } from "expo-router/react-navigation";
import { useContext, useEffect, useEffectEvent, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type TextInputInstance,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ActionSheet, type SheetAction } from "../components/ActionSheet";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { Text } from "../components/Text";
import { capturePhotos, recoverCapture } from "../components/ticket/photoCapture";
import { SheetScaffold } from "../components/ticket/SheetScaffold";
import { Button, Card, EmptyState, ErrorBox, Field, InfoBox, Input, SectionTitle } from "../components/ui";
import { ApiError, errorMessage } from "../lib/api";
import { PIX_KEY_TYPE, PIX_KEY_TYPES } from "../lib/constants";
import { confirmAction } from "../lib/dialogs";
import { formatTime } from "../lib/format";
import { haptic } from "../lib/haptics";
import { maskCep, maskPhone, onlyDigits, phoneDigits, UFS } from "../lib/masks";
import { maskPixInput, parsePixKey, pixInputValue, pixKeyInputProps } from "../lib/pix";
import { loadProfile, removeAvatar, saveProfile, uploadAvatar, useProfile, type AvatarPhoto } from "../lib/profile";
import { useSyncStatus } from "../lib/sync";
import { showToast } from "../lib/toast";
import type { MyProfile, MyProfileUpdate, PixKeyType } from "../lib/types";
import { RADIUS, useStyles, useTheme, type Palette } from "../theme/theme";

// As mesmas regras do servidor (schemas/my_profile.py e core/pix.py), que confere de novo.
const MSG = {
  name: "Informe seu nome completo.",
  phone: "Informe o celular com DDD.",
  email: "Informe um e-mail válido.",
  city: "Informe a cidade.",
  uf: "UF inválida.",
  zip: "CEP com 8 números.",
  pixKey: "Informe a chave PIX.",
  holder: "Informe o nome do titular da conta.",
} as const;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const NO_INTERNET = "Sem internet";
const OFFLINE_SAVE = "Conecte o aparelho para salvar seu cadastro.";
const OFFLINE_PHOTO = "Conecte o aparelho para trocar a foto.";

const fullDate = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });

interface Form {
  name: string;
  phone: string;
  email: string;
  zip: string;
  addressLine: string;
  district: string;
  city: string;
  uf: string;
  coverage: string;
  pixType: PixKeyType | null;
  /** Como está no campo (com a máscara do tipo). */
  pixKey: string;
  pixHolder: string;
  /** "Remover chave PIX" tocado: a chave sai quando salvar. */
  pixRemoved: boolean;
}

type FieldKey = Exclude<keyof Form, "pixType" | "pixRemoved">;
type Errors = Partial<Record<FieldKey, string>>;
/** Ordem da tela: o primeiro erro vai para o rodapé. */
const FIELD_ORDER: FieldKey[] = ["name", "phone", "email", "zip", "addressLine", "district", "city", "uf", "coverage", "pixKey", "pixHolder"];

interface Review {
  /** Só o que mudou (o corpo do PATCH, sem a senha). */
  body: MyProfileUpdate;
  errors: Errors;
  emailChanged: boolean;
  pixChange: "set" | "removed" | null;
}

type LoadState = { status: "loading" } | { status: "ok" } | { status: "error"; offline: boolean; message: string };

const collapse = (text: string) => text.trim().replace(/\s+/g, " ");

function formFrom(p: MyProfile): Form {
  return {
    name: p.name,
    phone: maskPhone(p.phone ?? ""),
    email: p.email,
    zip: maskCep(p.address_zip ?? ""),
    addressLine: p.address_line ?? "",
    district: p.address_district ?? "",
    city: p.home_city ?? "",
    uf: p.home_state ?? "",
    coverage: p.coverage_area ?? "",
    pixType: p.pix?.key_type ?? null,
    pixKey: p.pix ? pixInputValue(p.pix.key_type, p.pix.key) : "",
    pixHolder: p.pix?.holder_name ?? "",
    pixRemoved: false,
  };
}

/** A chave como o servidor grava; digitada pela metade, o próprio texto (para comparar com a gravada). */
function keyOf(type: PixKeyType, text: string): string {
  const parsed = parsePixKey(type, text);
  return "key" in parsed ? parsed.key : text.trim();
}

/**
 * O que mudou em relação ao cadastro (`base`, os mesmos campos montados do servidor) e o que está errado. Nome,
 * celular, cidade e UF são obrigatórios sempre; e-mail, CEP e PIX só são conferidos quando mudam (há logins de teste
 * sem "@"). Escolher o tipo da chave sem digitar a chave não é mudança.
 */
function review(form: Form, base: Form): Review {
  const body: MyProfileUpdate = {};
  const errors: Errors = {};

  const name = collapse(form.name);
  if (name.length < 3) errors.name = MSG.name;
  if (name !== collapse(base.name)) body.name = name;

  const phone = phoneDigits(form.phone);
  if (phone.length < 10) errors.phone = MSG.phone;
  if (phone !== phoneDigits(base.phone)) body.phone = maskPhone(phone);

  const email = form.email.trim().toLowerCase();
  const emailChanged = email !== base.email.trim().toLowerCase();
  if (emailChanged) {
    body.email = email;
    if (!EMAIL.test(email)) errors.email = MSG.email;
  }

  const zip = onlyDigits(form.zip);
  if (zip !== onlyDigits(base.zip)) {
    body.address_zip = zip ? maskCep(zip) : null;
    if (zip && zip.length !== 8) errors.zip = MSG.zip;
  }

  const line = form.addressLine.trim();
  if (line !== base.addressLine.trim()) body.address_line = line || null;
  const district = form.district.trim();
  if (district !== base.district.trim()) body.address_district = district || null;

  const city = collapse(form.city);
  if (city.length < 2) errors.city = MSG.city;
  if (city !== collapse(base.city)) body.home_city = city;

  const uf = form.uf.trim().toUpperCase();
  if (!UFS.includes(uf)) errors.uf = MSG.uf;
  if (uf !== base.uf.trim().toUpperCase()) body.home_state = uf;

  const coverage = form.coverage.trim();
  if (coverage !== base.coverage.trim()) body.coverage_area = coverage || null;

  let pixChange: Review["pixChange"] = null;
  if (form.pixRemoved) {
    if (base.pixType) {
      body.pix = null;
      pixChange = "removed";
    }
  } else if (form.pixType) {
    const keyText = form.pixKey.trim();
    const parsed = keyText ? parsePixKey(form.pixType, keyText) : null;
    const key = parsed && "key" in parsed ? parsed.key : keyText;
    const holder = collapse(form.pixHolder);
    const changed = base.pixType
      ? form.pixType !== base.pixType || key !== keyOf(base.pixType, base.pixKey) || holder !== collapse(base.pixHolder)
      : keyText !== "";
    if (changed) {
      pixChange = "set";
      body.pix = { key_type: form.pixType, key, holder_name: holder };
      if (!keyText) errors.pixKey = MSG.pixKey;
      else if (parsed && "error" in parsed) errors.pixKey = parsed.error;
      if (holder.length < 3) errors.pixHolder = MSG.holder;
    }
  }
  return { body, errors, emailChanged, pixChange };
}

const hasChanges = (r: Review) => Object.keys(r.body).length > 0;
const firstError = (errors: Errors) => FIELD_ORDER.map((key) => errors[key]).find(Boolean) ?? null;

/**
 * O cadastro mudou no servidor com a tela aberta (foto enviada, releitura): o campo que a pessoa não mexeu acompanha
 * o servidor; o que ela mexeu fica como está.
 */
function rebase(form: Form, before: Form, after: Form): Form {
  const next: Record<string, unknown> = { ...form };
  for (const key of Object.keys(form) as (keyof Form)[]) {
    if (form[key] === before[key]) next[key] = after[key];
  }
  return next as unknown as Form;
}

/** Descrição do aviso de salvo, conforme o que mudou. */
function savedText(r: Review): string | undefined {
  const pix = r.pixChange === "set" ? "A central foi avisada da nova chave PIX." : r.pixChange === "removed" ? "Chave PIX removida." : null;
  if (r.emailChanged) {
    if (r.pixChange === "set") return "A central foi avisada. Use o novo e-mail para entrar no app.";
    return pix ? `${pix} Use o novo e-mail para entrar no app.` : "Use o novo e-mail para entrar no app.";
  }
  return pix ?? undefined;
}

/** "Chave alterada em 18/11/2026 às 14:30." */
function changedAtText(iso: string): string {
  return `Chave alterada em ${fullDate.format(new Date(iso))} às ${formatTime(iso)}.`;
}

/** Sem Wi-Fi e sem dados. Alcance incerto (teste de internet do sistema falhando) ainda vale tentar. */
async function noNetwork(): Promise<boolean> {
  const net = await NetInfo.fetch().catch(() => null);
  return net?.isConnected === false;
}

/** O pedido não saiu porque o aparelho está sem rede (e não por erro do servidor). */
async function offlineFailure(error: unknown): Promise<boolean> {
  return error instanceof ApiError && error.status === 0 && (await noNetwork());
}

function leaveScreen() {
  if (router.canGoBack()) router.back();
  else router.replace("/conta");
}

/** Aviso de sem internet. Num componente próprio: só ele redesenha a cada mudança do sync, não o formulário. */
function OfflineNotice() {
  const { network } = useSyncStatus();
  return network === "offline" ? <InfoBox icon="wifiOff" message="Sem internet: conecte o aparelho para salvar." /> : null;
}

export default function MyProfileScreen() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  // O teclado sobe a partir do cabeçalho.
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const profile = useProfile();
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // O cadastro de que o formulário partiu (para acompanhar uma releitura sem perder o que foi digitado).
  const [shown, setShown] = useState<MyProfile | null>(profile);
  const [form, setForm] = useState<Form | null>(() => (profile ? formFrom(profile) : null));
  // Depois do primeiro "Salvar", os erros aparecem e acompanham a digitação.
  const [attempted, setAttempted] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Salvou ou descartou: sai sem perguntar.
  const [done, setDone] = useState(false);
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [photoMenu, setPhotoMenu] = useState(false);
  const [photoBusy, setPhotoBusy] = useState<"upload" | "remove" | null>(null);
  const mounted = useRef(true);
  const leaveAfterSheet = useRef(false);
  const phoneRef = useRef<TextInputInstance>(null);
  const emailRef = useRef<TextInputInstance>(null);
  const addressRef = useRef<TextInputInstance>(null);
  const districtRef = useRef<TextInputInstance>(null);
  const cityRef = useRef<TextInputInstance>(null);
  const ufRef = useRef<TextInputInstance>(null);
  const coverageRef = useRef<TextInputInstance>(null);
  const holderRef = useRef<TextInputInstance>(null);
  const passwordRef = useRef<TextInputInstance>(null);

  if (profile !== shown) {
    setShown(profile);
    if (profile) setForm((current) => (current && shown ? rebase(current, formFrom(shown), formFrom(profile)) : formFrom(profile)));
  }

  const base = profile ? formFrom(profile) : null;
  const check = form && base ? review(form, base) : null;
  const dirty = Boolean(check && hasChanges(check));

  const allowLeave = usePreventRemove(dirty && !done, ({ repeat }) => {
    void confirmAction("Descartar as alterações?", "O que você mudou no cadastro não foi salvo.", {
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

  // Abre sempre com o cadastro do servidor; o que já está na memória aparece enquanto isso.
  useEffect(() => {
    let alive = true;
    loadProfile()
      .then(() => {
        if (alive) setLoad({ status: "ok" });
      })
      .catch(async (error: unknown) => {
        const offline = await offlineFailure(error);
        if (alive) setLoad({ status: "error", offline, message: errorMessage(error) });
      });
    return () => {
      alive = false;
    };
  }, [attempt]);

  async function sendPhoto(photo: AvatarPhoto) {
    setPhotoBusy("upload");
    try {
      await uploadAvatar(photo);
      haptic.success();
      showToast("Foto atualizada", { tone: "success" });
    } catch (error) {
      if (await offlineFailure(error)) showToast(NO_INTERNET, { description: OFFLINE_PHOTO });
      else showToast("Não foi possível enviar a foto", { tone: "error", description: errorMessage(error) });
    } finally {
      setPhotoBusy(null);
    }
  }

  // Android: foto tirada antes de o sistema fechar o app com a câmera aberta (aparelho com pouca memória).
  const onRecovered = useEffectEvent((photo: AvatarPhoto) => {
    void sendPhoto(photo);
  });
  useEffect(() => {
    let alive = true;
    recoverCapture((target) => target.kind === "avatar")
      .then((found) => {
        const photo = found?.assets[0];
        if (alive && photo) onRecovered(photo);
      })
      .catch((error: unknown) => console.warn("Não foi possível recuperar a foto do cadastro", error));
    return () => {
      alive = false;
    };
  }, []);

  function retry() {
    setLoad({ status: "loading" });
    setAttempt((n) => n + 1);
  }

  function update(patch: Partial<Form>) {
    setForm((current) => (current ? { ...current, ...patch } : current));
    setSaveError(null);
  }

  async function pickPhoto(source: "camera" | "library") {
    if (await noNetwork()) {
      showToast(NO_INTERNET, { description: OFFLINE_PHOTO });
      return;
    }
    const [photo] = await capturePhotos(source, { kind: "avatar" });
    if (photo) await sendPhoto(photo);
  }

  async function removePhoto() {
    const ok = await confirmAction("Remover a foto?", "No lugar dela ficam as suas iniciais.", { confirmText: "Remover", destructive: true });
    if (!ok) return;
    if (await noNetwork()) {
      showToast(NO_INTERNET, { description: OFFLINE_PHOTO });
      return;
    }
    setPhotoBusy("remove");
    try {
      await removeAvatar();
      showToast("Foto removida", { tone: "success" });
    } catch (error) {
      if (await offlineFailure(error)) showToast(NO_INTERNET, { description: OFFLINE_PHOTO });
      else showToast("Não foi possível remover a foto", { tone: "error", description: errorMessage(error) });
    } finally {
      setPhotoBusy(null);
    }
  }

  /** Trocar o tipo limpa a chave (voltar ao tipo gravado traz a chave gravada); o titular começa com o nome. */
  function chooseType(type: PixKeyType) {
    if (!form || !base || form.pixType === type) return;
    haptic.select();
    update({
      pixType: type,
      pixKey: type === base.pixType ? base.pixKey : "",
      pixHolder: form.pixHolder.trim() ? form.pixHolder : collapse(form.name),
    });
  }

  async function pasteKey() {
    const text = (await Clipboard.getStringAsync().catch(() => "")).trim();
    if (!text) {
      showToast("Nada para colar", { description: "Copie a chave aleatória no app do seu banco." });
      return;
    }
    update({ pixKey: maskPixInput("random", text) });
  }

  async function submit(changes: Review, currentPassword?: string) {
    const inSheet = currentPassword !== undefined;
    setSaving(true);
    try {
      await saveProfile(inSheet ? { ...changes.body, current_password: currentPassword } : changes.body);
      haptic.success();
      showToast("Cadastro atualizado", { tone: "success", description: savedText(changes) });
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
        setPasswordError(offline ? `${NO_INTERNET}. ${OFFLINE_SAVE}` : errorMessage(error));
        // Fechando a folha para corrigir o formulário (ex.: e-mail já cadastrado), o motivo continua no rodapé.
        if (!offline) setSaveError(errorMessage(error));
        setPassword("");
        passwordRef.current?.focus();
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
    if (!check || saving) return;
    setAttempted(true);
    setSaveError(null);
    if (firstError(check.errors)) {
      haptic.warning();
      return;
    }
    if (!hasChanges(check)) return;
    if (await noNetwork()) {
      showToast(NO_INTERNET, { description: OFFLINE_SAVE });
      return;
    }
    if (check.emailChanged || check.pixChange) {
      setPassword("");
      setPasswordError(null);
      setShowPassword(false);
      setAsking(true);
      return;
    }
    await submit(check);
  }

  async function confirmWithPassword() {
    if (!check || saving) return;
    if (!password) {
      setPasswordError("Informe a senha atual.");
      return;
    }
    setPasswordError(null);
    await submit(check, password);
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

  if (!profile || !form || !check) {
    if (load.status === "error") {
      return (
        <View style={styles.center}>
          {load.offline ? (
            <EmptyState
              icon="wifiOff"
              title={NO_INTERNET}
              description="Conecte o aparelho para abrir e salvar seu cadastro."
              action={{ label: "Tentar de novo", onPress: retry }}
            />
          ) : (
            <EmptyState
              icon="alert"
              title="Não foi possível abrir seu cadastro"
              description={load.message}
              action={{ label: "Tentar de novo", onPress: retry }}
            />
          )}
        </View>
      );
    }
    return (
      <View style={styles.center} accessibilityLiveRegion="polite">
        <ActivityIndicator color={c.primary} />
        <Text style={styles.loading}>Carregando seu cadastro…</Text>
      </View>
    );
  }

  const errors: Errors = attempted ? check.errors : {};
  const footerError = saveError ?? (attempted ? firstError(check.errors) : null);
  const roleLine = [profile.job_title, profile.team?.name].filter(Boolean).join(" · ");
  const pixType = form.pixType;
  const pixChangedAt = profile.pix?.updated_at ? changedAtText(profile.pix.updated_at) : undefined;
  const photoTitle =
    photoBusy === "upload" ? "Enviando foto…" : photoBusy === "remove" ? "Removendo foto…" : profile.avatar_url ? "Trocar foto" : "Adicionar foto";
  const removeAction: SheetAction = { key: "remove", label: "Remover foto", icon: "close", tone: "danger", onPress: () => void removePhoto() };
  const photoActions: SheetAction[] = [
    { key: "camera", label: "Tirar foto", icon: "camera", onPress: () => void pickPhoto("camera") },
    { key: "library", label: "Escolher da galeria", icon: "plus", onPress: () => void pickPhoto("library") },
    ...(profile.avatar_url ? [removeAction] : []),
  ];

  const passwordToggle = (
    <Pressable
      onPress={() => setShowPassword((v) => !v)}
      hitSlop={14}
      accessibilityRole="button"
      accessibilityLabel={showPassword ? "Ocultar senha" : "Mostrar senha"}
    >
      <Icon name={showPassword ? "eyeOff" : "eye"} size={18} color={c.inkMuted} />
    </Pressable>
  );

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="padding" keyboardVerticalOffset={headerHeight}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
      >
        <OfflineNotice />

        <Card style={styles.card}>
          <SectionTitle accent>Foto</SectionTitle>
          <View style={styles.photoRow}>
            <Avatar name={profile.name} uri={profile.avatar_url} size={88} />
            <View style={styles.photoText}>
              <Text style={styles.name}>{profile.name}</Text>
              {roleLine ? <Text style={styles.muted}>{roleLine}</Text> : null}
            </View>
          </View>
          <Button title={photoTitle} icon="camera" loading={photoBusy !== null} onPress={() => setPhotoMenu(true)} />
        </Card>

        <Card style={styles.card}>
          <SectionTitle accent>Dados pessoais</SectionTitle>
          <Field label="Nome completo" required error={errors.name}>
            <Input
              value={form.name}
              onChangeText={(name) => update({ name })}
              accessibilityLabel="Nome completo"
              autoCapitalize="words"
              autoComplete="name"
              textContentType="name"
              maxLength={160}
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => phoneRef.current?.focus()}
            />
          </Field>
          <Field label="Celular (WhatsApp)" required error={errors.phone}>
            <Input
              ref={phoneRef}
              value={form.phone}
              onChangeText={(text) => update({ phone: maskPhone(text) })}
              accessibilityLabel="Celular (WhatsApp)"
              keyboardType="phone-pad"
              autoComplete="tel"
              textContentType="telephoneNumber"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => emailRef.current?.focus()}
            />
          </Field>
          <Field
            label="E-mail"
            required
            hint={check.emailChanged ? "Você vai entrar no app com este e-mail." : "É o seu login no app."}
            error={errors.email}
          >
            <Input
              ref={emailRef}
              value={form.email}
              onChangeText={(email) => update({ email: email.replace(/\s/g, "") })}
              accessibilityLabel="E-mail"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              textContentType="emailAddress"
              maxLength={255}
            />
          </Field>
        </Card>

        <Card style={styles.card}>
          <SectionTitle accent>Endereço</SectionTitle>
          <Field label="CEP" error={errors.zip}>
            <Input
              value={form.zip}
              onChangeText={(text) => update({ zip: maskCep(text) })}
              accessibilityLabel="CEP"
              keyboardType="number-pad"
              autoComplete="postal-code"
              textContentType="postalCode"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => addressRef.current?.focus()}
            />
          </Field>
          <Field label="Endereço (rua, número e complemento)">
            <Input
              ref={addressRef}
              value={form.addressLine}
              onChangeText={(addressLine) => update({ addressLine })}
              accessibilityLabel="Endereço: rua, número e complemento"
              autoComplete="street-address"
              textContentType="fullStreetAddress"
              maxLength={255}
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => districtRef.current?.focus()}
            />
          </Field>
          <Field label="Bairro">
            <Input
              ref={districtRef}
              value={form.district}
              onChangeText={(district) => update({ district })}
              accessibilityLabel="Bairro"
              autoCapitalize="words"
              maxLength={120}
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => cityRef.current?.focus()}
            />
          </Field>
          <View style={styles.cityRow}>
            <View style={styles.cityField}>
              <Field label="Cidade" required error={errors.city}>
                <Input
                  ref={cityRef}
                  value={form.city}
                  onChangeText={(city) => update({ city })}
                  accessibilityLabel="Cidade"
                  autoCapitalize="words"
                  textContentType="addressCity"
                  maxLength={120}
                  returnKeyType="next"
                  submitBehavior="submit"
                  onSubmitEditing={() => ufRef.current?.focus()}
                />
              </Field>
            </View>
            <View style={styles.ufField}>
              <Field label="UF" required error={errors.uf}>
                <Input
                  ref={ufRef}
                  value={form.uf}
                  onChangeText={(text) => update({ uf: text.replace(/[^A-Za-z]/g, "").toUpperCase() })}
                  accessibilityLabel="UF"
                  autoCapitalize="characters"
                  autoCorrect={false}
                  textContentType="addressState"
                  maxLength={2}
                  returnKeyType="next"
                  submitBehavior="submit"
                  onSubmitEditing={() => coverageRef.current?.focus()}
                />
              </Field>
            </View>
          </View>
          <Field label="Região que atende">
            <Input
              ref={coverageRef}
              value={form.coverage}
              onChangeText={(coverage) => update({ coverage })}
              accessibilityLabel="Região que atende"
              multiline
              maxLength={1000}
            />
          </Field>
        </Card>

        <Card style={styles.card}>
          <SectionTitle accent>Pagamento</SectionTitle>
          {form.pixRemoved ? (
            <View style={styles.removed}>
              <InfoBox message="A chave PIX sai do cadastro quando você salvar." />
              <Button compact variant="ghost" title="Desfazer" onPress={() => update({ pixRemoved: false })} style={styles.inlineButton} />
            </View>
          ) : (
            <>
              <Field label="Tipo da chave PIX">
                <View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel="Tipo da chave PIX">
                  {PIX_KEY_TYPES.map((type) => {
                    const selected = pixType === type;
                    return (
                      <Pressable
                        key={type}
                        onPress={() => chooseType(type)}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: selected }}
                        style={[styles.chip, selected && styles.chipSelected]}
                      >
                        <Text style={[styles.chipText, selected && { color: c.brandInk }]}>{PIX_KEY_TYPE[type]}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </Field>
              {pixType ? (
                <>
                  <Field label="Chave PIX" required hint={pixChangedAt} error={errors.pixKey}>
                    <Input
                      // Teclado do tipo: o campo é refeito quando o tipo muda e, num tipo novo, já abre para digitar.
                      key={pixType}
                      autoFocus={pixType !== (profile.pix?.key_type ?? null)}
                      value={form.pixKey}
                      onChangeText={(text) => update({ pixKey: maskPixInput(pixType, text) })}
                      accessibilityLabel={`Chave PIX: ${PIX_KEY_TYPE[pixType]}`}
                      {...pixKeyInputProps(pixType)}
                      returnKeyType="next"
                      submitBehavior="submit"
                      onSubmitEditing={() => holderRef.current?.focus()}
                      right={
                        pixType === "random" ? (
                          <Pressable onPress={() => void pasteKey()} hitSlop={10} accessibilityRole="button" accessibilityLabel="Colar a chave">
                            <Text style={styles.paste}>Colar</Text>
                          </Pressable>
                        ) : undefined
                      }
                    />
                  </Field>
                  <Field label="Nome do titular da conta" required error={errors.pixHolder}>
                    <Input
                      ref={holderRef}
                      value={form.pixHolder}
                      onChangeText={(pixHolder) => update({ pixHolder })}
                      accessibilityLabel="Nome do titular da conta"
                      autoCapitalize="words"
                      maxLength={160}
                    />
                  </Field>
                </>
              ) : null}
              {profile.pix ? (
                <Button
                  compact
                  variant="danger"
                  title="Remover chave PIX"
                  onPress={() => update({ pixRemoved: true })}
                  style={styles.inlineButton}
                />
              ) : null}
            </>
          )}
        </Card>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
        {footerError ? <ErrorBox message={footerError} /> : null}
        <Button
          title="Salvar alterações"
          variant="primary"
          onPress={() => void save()}
          loading={saving && !asking}
          disabled={!dirty || saving}
        />
      </View>

      <ActionSheet visible={photoMenu} title="Foto do cadastro" actions={photoActions} onClose={() => setPhotoMenu(false)} />

      <SheetScaffold
        visible={asking}
        title="Confirme com sua senha"
        description="Mudanças no e-mail e na chave PIX pedem a senha atual."
        onRequestClose={closeSheet}
        onClosed={sheetClosed}
        footer={
          <>
            <Button title="Cancelar" onPress={closeSheet} disabled={saving} style={styles.sheetButton} />
            <Button
              title="Confirmar e salvar"
              variant="primary"
              onPress={() => void confirmWithPassword()}
              loading={saving}
              style={styles.sheetButton}
            />
          </>
        }
      >
        <Field label="Senha atual">
          <Input
            ref={passwordRef}
            value={password}
            onChangeText={(text) => {
              setPassword(text);
              if (passwordError) setPasswordError(null);
            }}
            secureTextEntry={!showPassword}
            autoComplete="current-password"
            textContentType="password"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            maxLength={256}
            accessibilityLabel="Senha atual"
            returnKeyType="done"
            onSubmitEditing={() => void confirmWithPassword()}
            right={passwordToggle}
          />
        </Field>
        {passwordError ? <ErrorBox message={passwordError} /> : null}
      </SheetScaffold>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    content: { padding: 16, gap: 14 },
    center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24, backgroundColor: c.canvas },
    loading: { fontSize: 14, color: c.inkMuted },
    card: { gap: 12 },
    photoRow: { flexDirection: "row", alignItems: "center", gap: 16 },
    photoText: { flex: 1, gap: 4 },
    name: { fontSize: 18, fontWeight: "700", color: c.ink },
    muted: { fontSize: 13, color: c.inkMuted },
    cityRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
    cityField: { flex: 1 },
    ufField: { width: 84 },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    chip: {
      paddingHorizontal: 16,
      minWidth: 48,
      height: 44,
      borderRadius: RADIUS.chip,
      borderWidth: 1,
      borderColor: c.lineStrong,
      backgroundColor: c.surface,
      alignItems: "center",
      justifyContent: "center",
    },
    chipSelected: { borderColor: c.primary, backgroundColor: c.primarySoft },
    chipText: { fontSize: 15, fontWeight: "600", color: c.ink },
    paste: { fontSize: 14, fontWeight: "700", color: c.brandInk },
    removed: { gap: 6 },
    inlineButton: { alignSelf: "flex-start" },
    footer: {
      gap: 10,
      paddingHorizontal: 16,
      paddingTop: 12,
      backgroundColor: c.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.line,
    },
    sheetButton: { flex: 1 },
  });
