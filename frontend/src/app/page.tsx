import { redirect } from "next/navigation";

// A tela inicial é a lista de chamados.
export default function Home() {
  redirect("/chamados");
}
