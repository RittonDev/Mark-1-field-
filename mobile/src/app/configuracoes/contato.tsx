// Configurações › Contato: o celular (WhatsApp, por onde a central fala com o técnico), o telefone secundário e o e-mail
// de login. Trocar o e-mail pede a senha atual e não troca o login na hora: o e-mail novo fica pendente até o técnico abrir
// o link que chega nele (aqui, "Reenviar link" e "Cancelar troca"). O login que ainda não foi validado tem "Enviar link".
// O link abre no navegador: na volta ao app, a tela relê o cadastro (useProfileLoad; e puxar para atualizar), e as duas
// ações conferem o que o servidor devolve (o link já aberto: "Seu e-mail já foi validado" / "já está validado").
// Com o envio de e-mail desligado no servidor, o e-mail fica só leitura (a troca é pela central). A central é avisada.
// Só online, como todo o cadastro; com a API de antes do cadastro V2, "Indisponível no momento".

import { useRef, useState } from "react";
import { StyleSheet, View, type TextInputInstance } from "react-native";
import { CadastroUnavailable } from "../../components/settings/CadastroUnavailable";
import { EmailPendingBox } from "../../components/settings/EmailPendingBox";
import { FormCard, ProfileFormScreen } from "../../components/settings/ProfileFormScreen";
import { Button, Field, Input } from "../../components/ui";
import { ApiError, errorMessage } from "../../lib/api";
import { confirmAction } from "../../lib/dialogs";
import { haptic } from "../../lib/haptics";
import { maskPhone } from "../../lib/masks";
import { noNetwork, offlineFailure } from "../../lib/net";
import { cancelEmailChange, hasCadastroV2, loadProfile, sendEmailLink } from "../../lib/profile";
import { cancelChangeNotice, CONTACT_SECTION, emailHint, emailStatus } from "../../lib/profileForm";
import { showToast } from "../../lib/toast";
import { useProfileForm } from "../../lib/useProfileForm";
import { useStyles, type Palette } from "../../theme/theme";

const NO_INTERNET = "Sem internet";

export default function ContactScreen() {
  const styles = useStyles(makeStyles);
  const state = useProfileForm(CONTACT_SECTION);
  const { profile, review, errors, update, saving } = state;
  // "Enviar link" / "Reenviar link" ou "Cancelar troca" no ar (o carregando no botão); `acting` trava o segundo toque.
  const [busy, setBusy] = useState<"resend" | "cancel" | null>(null);
  const acting = useRef(false);
  const phone2Ref = useRef<TextInputInstance>(null);
  const emailRef = useRef<TextInputInstance>(null);

  if (profile && !hasCadastroV2(profile)) return <CadastroUnavailable onRetry={state.retry} />;

  // O estado do e-mail vem do cadastro gravado (o link pedido e a troca cancelada chegam por ele).
  const status = profile ? emailStatus(profile) : null;
  // Digitando um e-mail novo: a dica diz o que acontece ao salvar, e o link do login de hoje sai de cena.
  const editing = review?.body.email !== undefined;

  async function sendLink() {
    if (!profile || acting.current || saving) return;
    // Dois toques seguidos não mandam dois links (a conferência da rede já é assíncrona).
    acting.current = true;
    const target = profile.email_pending ?? profile.email;
    try {
      if (await noNetwork()) {
        showToast(NO_INTERNET, { description: "Conecte o aparelho para enviar o link." });
        return;
      }
      setBusy("resend");
      await sendEmailLink();
      haptic.success();
      showToast("Link enviado", { tone: "success", description: `Abra o e-mail em ${target}.` });
    } catch (error) {
      if (error instanceof ApiError && error.code === "EMAIL_ALREADY_VERIFIED") {
        // Validou no navegador com a tela aberta: a releitura tira o "Pendente de validação" e o botão.
        void loadProfile().catch(() => undefined);
        showToast("Seu e-mail já está validado");
      } else if (await offlineFailure(error)) {
        showToast(NO_INTERNET, { description: "Conecte o aparelho para enviar o link." });
      } else {
        showToast("Não foi possível enviar o link", { tone: "error", description: errorMessage(error) });
      }
    } finally {
      acting.current = false;
      setBusy(null);
    }
  }

  async function cancelChange() {
    if (!profile || acting.current || saving) return;
    acting.current = true;
    // O cadastro da tela: o que o DELETE devolve diz se ainda havia troca a cancelar.
    const before = profile;
    try {
      const ok = await confirmAction("Cancelar a troca de e-mail?", `Você continua entrando com ${before.email}.`, {
        confirmText: "Cancelar troca",
        cancelText: "Voltar",
      });
      if (!ok) return;
      if (await noNetwork()) {
        showToast(NO_INTERNET, { description: "Conecte o aparelho para cancelar a troca." });
        return;
      }
      setBusy("cancel");
      const notice = cancelChangeNotice(before, await cancelEmailChange());
      haptic.success();
      showToast(notice.title, { tone: notice.tone, description: notice.description });
    } catch (error) {
      if (await offlineFailure(error)) showToast(NO_INTERNET, { description: "Conecte o aparelho para cancelar a troca." });
      else showToast("Não foi possível cancelar a troca", { tone: "error", description: errorMessage(error) });
    } finally {
      acting.current = false;
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
