// Folha de formulário das Configurações (incluir e editar aptidão e formação): a folha de página inteira da OS com o
// rodapé [Cancelar] [ação] e o erro do servidor no fim do conteúdo. Fechar pelo "Cancelar", pelo voltar do Android ou
// descendo a folha no iPhone: salvando, não fecha; com algo preenchido, pergunta antes de descartar.

import type { ReactNode } from "react";
import { StyleSheet } from "react-native";
import { confirmAction } from "../../lib/dialogs";
import { SheetScaffold } from "../ticket/SheetScaffold";
import { Button, ErrorBox } from "../ui";

export function FormSheet({
  visible,
  title,
  description,
  submitLabel,
  onSubmit,
  onClose,
  onClosed,
  busy,
  error,
  dirty,
  submitDisabled = false,
  children,
}: {
  visible: boolean;
  title: string;
  description?: string;
  submitLabel: string;
  onSubmit: () => void;
  /** Fecha a folha (o pai põe `visible` em false). Só é chamado depois das perguntas acima. */
  onClose: () => void;
  /** A folha terminou de sair. */
  onClosed?: () => void;
  busy: boolean;
  /** Erro do servidor ou da rede, no fim do conteúdo. */
  error: string | null;
  /** Há algo preenchido ou mudado: fechar pergunta antes. */
  dirty: boolean;
  /** A ação fica desligada (a edição sem mudança). */
  submitDisabled?: boolean;
  children: ReactNode;
}) {
  async function requestClose() {
    if (busy) return;
    if (dirty) {
      const ok = await confirmAction("Descartar as alterações?", "O que você preencheu não foi salvo.", {
        confirmText: "Descartar",
        destructive: true,
      });
      if (!ok) return;
    }
    onClose();
  }

  return (
    <SheetScaffold
      visible={visible}
      title={title}
      description={description}
      onRequestClose={() => void requestClose()}
      onClosed={onClosed}
      footer={
        <>
          <Button title="Cancelar" onPress={() => void requestClose()} disabled={busy} style={styles.button} />
          <Button
            title={submitLabel}
            variant="primary"
            onPress={onSubmit}
            loading={busy}
            disabled={submitDisabled}
            style={styles.button}
          />
        </>
      }
    >
      {children}
      {error ? <ErrorBox message={error} /> : null}
    </SheetScaffold>
  );
}

const styles = StyleSheet.create({
  button: { flex: 1 },
});
