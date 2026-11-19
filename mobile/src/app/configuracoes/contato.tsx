// Configurações › Contato: o celular (WhatsApp, por onde a central fala com o técnico) e o e-mail de login. Mudar o
// e-mail pede a senha atual; a central é avisada. Só online, como todo o cadastro.

import { useRef } from "react";
import type { TextInputInstance } from "react-native";
import { FormCard, ProfileFormScreen } from "../../components/settings/ProfileFormScreen";
import { Field, Input } from "../../components/ui";
import { maskPhone } from "../../lib/masks";
import { CONTACT_SECTION } from "../../lib/profileForm";
import { useProfileForm } from "../../lib/useProfileForm";

export default function ContactScreen() {
  const state = useProfileForm(CONTACT_SECTION);
  const emailRef = useRef<TextInputInstance>(null);
  const emailChanged = Boolean(state.review?.needsPassword);
  return (
    <ProfileFormScreen state={state}>
      {(form) => (
        <FormCard>
          <Field label="Celular (WhatsApp)" required error={state.errors.phone}>
            <Input
              value={form.phone}
              onChangeText={(text) => state.update({ phone: maskPhone(text) })}
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
            hint={emailChanged ? "Você vai entrar no app com este e-mail." : "É o seu login no app."}
            error={state.errors.email}
          >
            <Input
              ref={emailRef}
              value={form.email}
              onChangeText={(email) => state.update({ email: email.replace(/\s/g, "") })}
              accessibilityLabel="E-mail"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              textContentType="emailAddress"
              maxLength={255}
            />
          </Field>
        </FormCard>
      )}
    </ProfileFormScreen>
  );
}
