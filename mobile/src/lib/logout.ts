// Sair da conta (Perfil › Sair; antes ficava na tela Conta): a confirmação, com a oferta de enviar os itens antes de
// sair quando há o que enviar e internet, e o texto que a tela mostra enquanto sai. Com a sessão encerrada, o
// Stack.Protected do layout leva para o login (a jornada aberta é encerrada no logout).

import { useState } from "react";
import { Alert, Platform } from "react-native";
import { errorMessage } from "./api";
import { logout } from "./auth";
import { countPending } from "./db";
import { confirmAction } from "./dialogs";
import { requestSync, useSyncStatus } from "./sync";
import { showToast } from "./toast";
import { useTracking } from "./tracking";

const itemsLabel = (n: number) => (n === 1 ? "1 item não enviado" : `${n} itens não enviados`);

type LogoutChoice = "send" | "leave" | "cancel";

/**
 * Confirmação do Sair. Com itens para enviar e internet, oferece mandar antes de sair. No navegador
 * (pré-visualização) o Alert de três botões não existe: fica só sair ou cancelar.
 */
function askLogout(pending: number, canSend: boolean): Promise<LogoutChoice> {
  const message = pending
    ? `Há ${itemsLabel(pending)}. Eles ficam guardados neste aparelho e vão quando você entrar de novo. Se outro técnico entrar aqui, serão apagados.`
    : "Você vai precisar da senha para entrar de novo. Se a jornada estiver aberta, ela é encerrada.";
  if (!pending || !canSend || Platform.OS === "web") {
    return confirmAction("Sair da conta?", message, { confirmText: "Sair", destructive: true }).then((ok) => (ok ? "leave" : "cancel"));
  }
  return new Promise((resolve) => {
    Alert.alert(
      "Sair da conta?",
      message,
      [
        { text: "Cancelar", style: "cancel", onPress: () => resolve("cancel") },
        { text: "Sair mesmo assim", style: "destructive", onPress: () => resolve("leave") },
        { text: "Enviar e sair", onPress: () => resolve("send") },
      ],
      { cancelable: true, onDismiss: () => resolve("cancel") },
    );
  });
}

export interface Logout {
  /** Saindo: a linha Sair mostra o indicador e não aceita outro toque. */
  leaving: boolean;
  /** O que a tela diz durante o Sair: enviando os itens primeiro ("Enviar e sair") ou saindo. */
  leavingText: string;
  confirmLogout: () => Promise<void>;
}

/** O Sair da conta: pergunta, envia os itens se o técnico pediu e encerra a sessão. */
export function useLogout(): Logout {
  const sync = useSyncStatus();
  const tracking = useTracking();
  const [leaving, setLeaving] = useState(false);
  const [leavingText, setLeavingText] = useState("");

  async function confirmLogout() {
    if (leaving) return;
    const count = sync.pendingOps + sync.pendingPhotos;
    const choice = await askLogout(count, sync.network !== "offline");
    if (choice === "cancel") return;
    setLeaving(true);
    if (choice === "send") {
      setLeavingText("Enviando os itens antes de sair…");
      await requestSync({ manual: true });
      // Sem conseguir conferir, vale o que havia antes: pergunta de novo em vez de sair calado.
      const { ops, photos } = await countPending().catch(() => ({ ops: count, photos: 0 }));
      const left = ops + photos;
      if (left > 0) {
        setLeaving(false);
        const again = await confirmAction(
          "Ainda há itens para enviar",
          `${itemsLabel(left)} não ${left === 1 ? "foi enviado" : "foram enviados"} agora. Eles ficam guardados neste aparelho e vão quando você entrar de novo.`,
          { confirmText: "Sair mesmo assim", destructive: true },
        );
        if (!again) return;
        setLeaving(true);
      }
    }
    // Com a sessão encerrada, o Stack.Protected do layout leva para o login.
    setLeavingText(tracking.shift ? "Encerrando a jornada e saindo…" : "Saindo…");
    try {
      await logout();
    } catch (e) {
      setLeaving(false);
      showToast("Não foi possível sair agora", { tone: "error", description: errorMessage(e) });
    }
  }

  return { leaving, leavingText, confirmLogout };
}
