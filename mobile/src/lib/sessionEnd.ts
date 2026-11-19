// Fim de sessão no aparelho, com ou sem tela. A entrada (index.ts) importa este módulo depois das tarefas de segundo
// plano: a rodada que o sistema roda com o app fechado (tarefa periódica ou jornada), em que as rotas e o auth.ts não
// carregam, também reage quando o servidor encerra a sessão (401 do /auth/refresh: sessão expirada, senha redefinida,
// técnico desativado ou sem acesso ao app).
//
// - Limpeza: sync parado, nenhuma notificação agendada nem na bandeja (loja e endereço aparecem na tela bloqueada),
//   jornada parada e tarefa periódica desligada. Com técnico desativado ou sem acesso ao app, apaga também as OS, os
//   dados de clientes, as fotos e a fila (LGPD); se apagar falhar, a tarefa fica ligada para tentar de novo.
// - O fim fica gravado (session.ts) antes de os tokens saírem: se o app morrer no meio, a próxima rodada sem tela ou a
//   abertura seguinte (restoreSession) conclui a limpeza, e o login mostra o motivo.
//
// Não importa auth.ts nem telas. backgroundSync.ts não importa este módulo (recebe a limpeza por setSessionEndCleanup):
// sem ciclo de imports.

import { ACCESS_DISABLED_MESSAGE } from "./access";
import { setAccessRevokedHandler } from "./api";
import { setSessionEndCleanup, unregisterBackgroundSync } from "./backgroundSync";
import { clearNotificationsOnSignOut } from "./notifications";
import { session, type SessionStatus } from "./session";
import { stopSync, wipeLocalData } from "./sync";
import { stopTracking } from "./tracking";

let cleaning: Promise<boolean> | null = null;
let cleanAgain = false;

/**
 * Limpeza do fim de sessão, uma por vez. `fresh`: o pedido traz algo novo (outra saída, a ordem de apagar os dados) e a
 * limpeza em andamento ganha outra volta logo depois; sem ele, quem chama espera a que está em andamento. Resolve true
 * quando não ficou nada a apagar. Não lança erro.
 */
function cleanUp(fresh = false): Promise<boolean> {
  if (cleaning) {
    if (fresh) cleanAgain = true;
    return cleaning;
  }
  cleaning = (async () => {
    try {
      let done: boolean;
      do {
        cleanAgain = false;
        done = await cleanOnce();
      } while (cleanAgain);
      return done;
    } finally {
      cleaning = null;
    }
  })();
  return cleaning;
}

async function cleanOnce(): Promise<boolean> {
  try {
    // Já entrou de novo: nada da sessão anterior a limpar.
    if (session.get().status === "signedIn") return true;
    const ending = await session.pendingEnd().catch(() => null);
    stopSync();
    await clearNotificationsOnSignOut();
    let done = true;
    if (ending?.wipe) {
      try {
        await wipeLocalData();
        // Apagados: o motivo continua gravado para o login da próxima abertura (se nesse meio-tempo não entrou outro
        // fim nem outra sessão).
        if ((await session.pendingEnd().catch(() => null)) === ending) await session.setPendingEnd({ ...ending, wipe: false });
      } catch (error) {
        done = false;
        console.warn("Falha ao apagar os dados do aparelho", error);
      }
    }
    // Por último: parar a jornada (fim do serviço de localização) e desligar a tarefa periódica podem encerrar o
    // processo que roda sem tela. Com os dados ainda por apagar, a tarefa fica ligada para a próxima rodada tentar de novo.
    await stopTracking({ endOnServer: false }).catch(() => undefined);
    if (done) await unregisterBackgroundSync();
    return done;
  } catch (error) {
    console.warn("Falha ao encerrar a sessão no aparelho", error);
    return false;
  }
}

/** Conclui o fim de sessão: espera a limpeza em andamento ou faz uma. Não lança erro. */
export async function finishSessionEnd(): Promise<void> {
  await cleanUp();
}

/** Espera a limpeza em andamento, se houver: o login não abre outra sessão no meio dela. */
export async function sessionEndSettled(): Promise<void> {
  if (cleaning) await cleaning;
}

/**
 * Sem acesso ao app (o papel mudou no servidor, ou a sessão salva é de quem não é técnico): sai com o motivo e grava a
 * ordem de apagar os dados locais. Não espera a limpeza: o 401 pode vir de dentro de uma operação da jornada (fila
 * única), e a limpeza para a jornada. Quem pode esperar chama finishSessionEnd ou applyPendingEnd.
 */
export async function revokeAccess(message: string): Promise<void> {
  await session.signOut(false, message, true);
  void cleanUp();
}

/**
 * Senha certa de conta desativada (login) de quem é dono dos dados do aparelho, que saiu antes de a central desativar:
 * apaga as OS e os dados de clientes guardados (LGPD). A ordem fica gravada antes, para valer se o app morrer no meio.
 */
export async function forgetDisabledAccess(): Promise<void> {
  await session.setPendingEnd({ wipe: true, notice: ACCESS_DISABLED_MESSAGE, expired: false });
  await cleanUp(true);
}

/**
 * Abertura do app: conclui o fim de sessão que ficou gravado (o servidor encerrou a sessão com o app sem tela, ou o app
 * morreu no meio da limpeza). O motivo já está no login (session.load); concluída a limpeza, o fim gravado sai e a
 * próxima abertura não repete o aviso. Não lança erro.
 */
export async function applyPendingEnd(): Promise<void> {
  if (!(await session.pendingEnd().catch(() => null))) return;
  if (await cleanUp()) await session.setPendingEnd(null);
}

// 401 do /auth/refresh com o motivo de canal (papel mudou no servidor): sai e apaga os dados locais.
setAccessRevokedHandler(revokeAccess);
// A rodada sem tela espera a limpeza quando a sessão termina.
setSessionEndCleanup(finishSessionEnd);

let previousStatus: SessionStatus = session.get().status;

// Qualquer saída da conta (Sair, sessão expirada, senha redefinida, acesso desativado ou retirado), com ou sem tela.
session.subscribe(() => {
  const { status } = session.get();
  const ended = previousStatus === "signedIn" && status === "signedOut";
  previousStatus = status;
  if (ended) void cleanUp(true);
});
