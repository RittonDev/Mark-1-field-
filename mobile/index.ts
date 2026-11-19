// Entrada do app. As rotas (inclusive o _layout) só carregam quando a tela monta; quando o Android
// acorda o app fechado com novas posições da jornada, ou para a sincronização periódica, ele roda sem
// tela e nada monta. Por isso as tarefas de segundo plano (rastreamento e sincronização) são definidas
// aqui, na carga do bundle, antes de qualquer evento chegar. Depois delas, o fim de sessão: sem tela, é
// ele que limpa as notificações, desliga a tarefa e apaga os dados do técnico desativado quando o
// servidor encerra a sessão.
import "expo-router/entry";
import "./src/lib/trackingTask";
import "./src/lib/backgroundSync";
import "./src/lib/sessionEnd";
