// Folha "Confirme com sua senha" das Configurações: mudar o e-mail (Contato) ou a chave PIX pede a senha atual (conta
// invadida não desvia o pagamento). A senha não fica guardada. O erro do servidor aparece aqui dentro: a senha é limpa
// e o campo ganha o foco de novo. O estado (senha, erro, salvando) vem de useProfileForm.

import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, type TextInputInstance } from "react-native";
import { useTheme } from "../../theme/theme";
import { Icon } from "../Icon";
import { SheetScaffold } from "../ticket/SheetScaffold";
import { Button, ErrorBox, Field, Input } from "../ui";

export interface PasswordSheetProps {
  visible: boolean;
  /** Por que pede a senha ("Mudar o e-mail pede a senha atual."). */
  description: string;
  password: string;
  onChangePassword: (text: string) => void;
  error: string | null;
  saving: boolean;
  onConfirm: () => void;
  /** Cancelar, voltar do Android e descer a folha no iPhone (não fecha salvando). */
  onClose: () => void;
  /** A folha terminou de sair (para sair da tela depois, no iPhone). */
  onClosed: () => void;
}

export function PasswordSheet({
  visible,
  description,
  password,
  onChangePassword,
  error,
  saving,
  onConfirm,
  onClose,
  onClosed,
}: PasswordSheetProps) {
  const c = useTheme();
  const inputRef = useRef<TextInputInstance>(null);
  const [showPassword, setShowPassword] = useState(false);
  // Abriu de novo: a senha volta escondida.
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) setShowPassword(false);
  }

  // Recusada (senha errada, e-mail já cadastrado, sem internet): o campo, já limpo, ganha o foco para tentar de novo.
  useEffect(() => {
    if (error && visible) inputRef.current?.focus();
  }, [error, visible]);

  const toggle = (
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
    <SheetScaffold
      visible={visible}
      title="Confirme com sua senha"
      description={description}
      onRequestClose={onClose}
      onClosed={onClosed}
      footer={
        <>
          <Button title="Cancelar" onPress={onClose} disabled={saving} style={styles.button} />
          <Button title="Confirmar e salvar" variant="primary" onPress={onConfirm} loading={saving} style={styles.button} />
        </>
      }
    >
      <Field label="Senha atual">
        <Input
          ref={inputRef}
          value={password}
          onChangeText={onChangePassword}
          secureTextEntry={!showPassword}
          autoComplete="current-password"
          textContentType="password"
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          maxLength={256}
          accessibilityLabel="Senha atual"
          returnKeyType="done"
          onSubmitEditing={onConfirm}
          right={toggle}
        />
      </Field>
      {error ? <ErrorBox message={error} /> : null}
    </SheetScaffold>
  );
}

const styles = StyleSheet.create({
  button: { flex: 1 },
});
