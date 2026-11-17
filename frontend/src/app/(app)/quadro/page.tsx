import { redirect } from "next/navigation";

/** O Quadro (kanban) saiu do menu: links e favoritos antigos levam para a lista de Chamados. */
export default function QuadroPage() {
  redirect("/chamados");
}
