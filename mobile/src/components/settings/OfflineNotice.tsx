// Aviso de sem internet no topo das telas de Configurações (o cadastro é só online). Num componente próprio: só ele
// redesenha a cada mudança do sync, não o formulário.

import { useSyncStatus } from "../../lib/sync";
import { InfoBox } from "../ui";

export function OfflineNotice({ text = "Sem internet: conecte o aparelho para salvar." }: { text?: string }) {
  const { network } = useSyncStatus();
  return network === "offline" ? <InfoBox icon="wifiOff" message={text} /> : null;
}
