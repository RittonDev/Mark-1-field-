// Campo "Senha atual" com o olho (mostrar e ocultar) das Configurações: a folha da senha (PasswordSheet) e as folhas
// que pedem a senha junto com o formulário (Formas de recebimento). A senha não fica guardada: quem usa o campo guarda
// o valor só enquanto a folha está aberta e limpa ao fechar ou quando o servidor recusa.

import { useState, type Ref } from "react";
import { Pressable, type TextInputInstance } from "react-native";
import { useTheme } from "../../theme/theme";
import { Icon } from "../Icon";
import { Field, Input } from "../ui";

export function PasswordField({
  value,
  onChangeText,
  error,
  inputRef,
  autoFocus = false,
  onSubmitEditing,
  required = false,
}: {
  value: string;
  onChangeText: (text: string) => void;
  /** Erro do campo, abaixo dele ("Informe a senha atual."). */
  error?: string | null;
  /** Para quem abre focar o campo (a senha recusada volta limpa e com o foco). */
  inputRef?: Ref<TextInputInstance>;
  autoFocus?: boolean;
  /** "Concluído" do teclado. */
  onSubmitEditing?: () => void;
  /** O asterisco no rótulo, quando o campo está entre outros obrigatórios. */
  required?: boolean;
}) {
  const c = useTheme();
  const [shown, setShown] = useState(false);

  return (
    <Field label="Senha atual" required={required} error={error}>
      <Input
        ref={inputRef}
        value={value}
        onChangeText={onChangeText}
        secureTextEntry={!shown}
        autoComplete="current-password"
        textContentType="password"
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={autoFocus}
        maxLength={256}
        accessibilityLabel="Senha atual"
        returnKeyType="done"
        onSubmitEditing={onSubmitEditing}
        right={
          <Pressable
            onPress={() => setShown((v) => !v)}
            hitSlop={14}
            accessibilityRole="button"
            accessibilityLabel={shown ? "Ocultar senha" : "Mostrar senha"}
          >
            <Icon name={shown ? "eyeOff" : "eye"} size={18} color={c.inkMuted} />
          </Pressable>
        }
      />
    </Field>
  );
}
