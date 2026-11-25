// Folha "Confirme com sua senha" das Configurações: mudar o e-mail (Contato), os dados da empresa ou as formas de
// recebimento pede a senha atual (conta invadida não desvia o pagamento). A senha não fica guardada. O erro do servidor
// aparece aqui dentro: a senha é limpa e o campo ganha o foco de novo. O estado (senha, erro, salvando) vem de quem
// abre (useProfileForm, Formas de recebimento); o título, o botão e o tom dele mudam por ação ("Tornar preferencial?",
// "Excluir").

import { useEffect, useRef, useState } from "react";
import { StyleSheet, type TextInputInstance } from "react-native";
import { SheetScaffold } from "../ticket/SheetScaffold";
import { Button, ErrorBox } from "../ui";
import { PasswordField } from "./PasswordField";

export interface PasswordSheetProps {
  visible: boolean;
  /** Padrão: "Confirme com sua senha". */
  title?: string;
  /** Por que pede a senha ("Mudar o e-mail pede a senha atual."). */
  description: string;
  password: string;
  onChangePassword: (text: string) => void;
  error: string | null;
  saving: boolean;
  /** O botão de confirmar; padrão: "Confirmar e salvar". */
  confirmLabel?: string;
  /** O botão de confirmar no tom de perigo (Excluir). */
  destructive?: boolean;
  onConfirm: () => void;
  /** Cancelar, voltar do Android e descer a folha no iPhone (não fecha salvando). */
  onClose: () => void;
  /** A folha terminou de sair (para sair da tela depois, no iPhone). */
  onClosed: () => void;
}

export function PasswordSheet({
  visible,
  title = "Confirme com sua senha",
  description,
  password,
  onChangePassword,
  error,
  saving,
  confirmLabel = "Confirmar e salvar",
  destructive = false,
  onConfirm,
  onClose,
  onClosed,
}: PasswordSheetProps) {
  const inputRef = useRef<TextInputInstance>(null);
  // Abriu de novo: o campo começa de novo, com a senha escondida.
  const [opened, setOpened] = useState(0);
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) setOpened((n) => n + 1);
  }

  // Recusada (senha errada, e-mail já cadastrado, sem internet): o campo, já limpo, ganha o foco para tentar de novo.
  useEffect(() => {
    if (error && visible) inputRef.current?.focus();
  }, [error, visible]);

  return (
    <SheetScaffold
      visible={visible}
      title={title}
      description={description}
      onRequestClose={onClose}
      onClosed={onClosed}
      footer={
        <>
          <Button title="Cancelar" onPress={onClose} disabled={saving} style={styles.button} />
          <Button
            title={confirmLabel}
            variant={destructive ? "danger" : "primary"}
            onPress={onConfirm}
            loading={saving}
            style={styles.button}
          />
        </>
      }
    >
      <PasswordField
        key={opened}
        value={password}
        onChangeText={onChangePassword}
        inputRef={inputRef}
        autoFocus
        onSubmitEditing={onConfirm}
      />
      {error ? <ErrorBox message={error} /> : null}
    </SheetScaffold>
  );
}

const styles = StyleSheet.create({
  button: { flex: 1 },
});
