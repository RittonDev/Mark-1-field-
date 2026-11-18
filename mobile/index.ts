// Entrada do app. As rotas (inclusive o _layout) só carregam quando a tela monta; quando o Android
// acorda o app fechado com novas posições da jornada, ele roda sem tela e nada monta. Por isso a
// tarefa do rastreamento é definida aqui, na carga do bundle, antes de qualquer evento chegar.
import "expo-router/entry";
import "./src/lib/trackingTask";
