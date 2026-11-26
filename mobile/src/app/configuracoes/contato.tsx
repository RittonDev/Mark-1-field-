// Configurações › Contato: o celular (WhatsApp, por onde a central fala com o técnico), o telefone secundário e o e-mail
// de login. Trocar o e-mail pede a senha atual e não troca o login na hora: o e-mail novo fica pendente até o técnico abrir
// o link que chega nele (aqui, "Reenviar link" e "Cancelar troca"). O login que ainda não foi validado tem "Enviar link".
// Com o envio de e-mail desligado no servidor, o e-mail fica só leitura (a troca é pela central). A central é avisada.
// Só online, como todo o cadastro; com a API de antes do cadastro V2, "Indisponível no momento".

import { useRef, useState } from "react";
import { StyleSheet, View, type TextInputInstance } from "react-native";
import { CadastroUnavailable } from "../../components/settings/CadastroUnavailable";
import { EmailPendingBox } from "../../components/settings/EmailPendingBox";
import { FormCard, ProfileFormScreen } from "../../components/settings/ProfileFormScreen";
import { Button, Field, Input } from "../../components/ui";
import { errorMessage } from "../../lib/api";
import { confirmAction } from "../../lib/dialogs";
import { haptic } from "../../lib/haptics";
import { maskPhone } from "../../lib/masks";
import { noNetwork, offlineFailure } from "../../lib/net";
import { cancelEmailChange, hasCadastroV2, sendEmailLink } from "../../lib/profile";
import { CONTACT_SECTION, emailHint, emailStatus } from "../../lib/profileForm";
import { showToast } from "../../lib/toast";
import { useProfileForm } from "../../lib/useProfileForm";
import { useStyles, type Palette } from "../../theme/theme";

const NO_INTERNET = "Sem internet";

export default function ContactScreen() {
  const styles = useStyles(makeStyles);
  const state = useProfileForm(CONTACT_SECTION);
  const { profile, review, errors, update, saving } = state;
  // "Enviar link" / "Reenviar link" ou "Cancelar troca" no ar.
  const [busy, setBusy] = useState<"resend" | "cancel" | null>(null);
  const phone2Ref = useRef<TextInputInstance>(null);
  const emailRef = useRef<TextInputInstance>(null);

  if (profile && !hasCadastroV2(profile)) return <CadastroUnavailable onRetry={state.retry} />;

  // O estado do e-mail vem do cadastro gravado (o link pedido e a troca cancelada chegam por ele).
  const status = profile ? emailStatus(profile) : null;
  // Digitando um e-mail novo: a dica diz o que acontece ao salvar, e o link do login de hoje sai de cena.
  const editing = review?.body.email !== undefined;

  async function sendLink() {
    if (!profile || busy || saving) return;
    const target = profile.email_pending ?? profile.email;
    if (await noNetwork()) {
      showToast(NO_INTERNET, { description: "Conecte o aparelho para enviar o link." });
      return;
    }
    setBusy("resend");
    try {
      await sendEmailLink();
      haptic.success();
      showToast("Link enviado", { tone: "success", description: `Abra o e-mail em ${target}.` });
    } catch (error) {
      if (await offlineFailure(error)) showToast(NO_INTERNET, { description: "Conecte o aparelho para enviar o link." });
      else showToast("Não foi possível enviar o link", { tone: "error", description: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function cancelChange() {
    if (!profile || busy || saving) return;
    const ok = await confirmAction("Cancelar a troca de e-mail?", `Você continua entrando com ${profile.email}.`, {
      confirmText: "Cancelar troca",
      cancelText: "Voltar",
    });
    if (!ok) return;
    if (await noNetwork()) {
      showToast(NO_INTERNET, { description: "Conecte o aparelho para cancelar a troca." });
      return;
    }
    setBusy("cancel");
    try {
      await cancelEmailChange();
      haptic.success();
      showToast("Troca de e-mail cancelada", { tone: "success" });
    } catch (error) {
      if (await offlineFailure(error)) showToast(NO_INTERNET, { description: "Conecte o aparelho para cancelar a troca." });
      else showToast("Não foi possível cancelar a troca", { tone: "error", description: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <ProfileFormScreen state={state}>
      {(form) => (
        <FormCard>
          <Field label="Celular (WhatsApp)" required error={errors.phone}>
            <Input
              value={form.phone}
              onChangeText={(text) => update({ phone: maskPhone(text) })}
              accessibilityLabel="Celular (WhatsApp)"
              keyboardType="phone-pad"
              autoComplete="tel"
              textContentType="telephoneNumber"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => phone2Ref.current?.focus()}
            />
          </Field>
          <Field label="Telefone secundário" error={errors.phone2}>
            <Input
              ref={phone2Ref}
              value={form.phone2}
              onChangeText={(text) => update({ phone2: maskPhone(text) })}
              accessibilityLabel="Telefone secundário"
              keyboardType="phone-pad"
              autoComplete="tel"
              textContentType="telephoneNumber"
              returnKeyType={form.mailEnabled ? "next" : "done"}
              submitBehavior={form.mailEnabled ? "submit" : undefined}
              onSubmitEditing={() => {
                if (form.mailEnabled) emailRef.current?.focus();
              }}
            />
          </Field>
          <View style={styles.email}>
            <Field label="E-mail" required hint={status ? emailHint(status, editing) : undefined} error={errors.email}>
              <Input
                ref={emailRef}
                value={form.email}
                onChangeText={(email) => update({ email: email.replace(/\s/g, "") })}
                editable={form.mailEnabled}
                accessibilityLabel="E-mail"
                accessibilityState={{ disabled: !form.mailEnabled }}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                textContentType="emailAddress"
                maxLength={255}
                style={form.mailEnabled ? undefined : styles.readOnly}
              />
            </Field>
            {status?.kind === "unverified" && !editing ? (
              <Button
                compact
                variant="ghost"
                title={status.sentAt ? "Reenviar link" : "Enviar link"}
                onPress={() => void sendLink()}
                loading={busy === "resend"}
                disabled={busy !== null || saving}
                style={styles.inline}
              />
            ) : null}
            {status?.kind === "pending" ? (
              <EmailPendingBox
                email={status.email}
                sentAt={status.sentAt}
                busy={busy}
                disabled={saving}
                onResend={status.resend ? () => void sendLink() : undefined}
                onCancel={() => void cancelChange()}
              />
            ) : null}
          </View>
        </FormCard>
      )}
    </ProfileFormScreen>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    email: { gap: 10 },
    readOnly: { color: c.inkMuted },
    inline: { alignSelf: "flex-start" },
  });
