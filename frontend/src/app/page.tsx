import { redirect } from "next/navigation";

// A tela inicial é a fila do analista (o solicitante é levado aos chamados dele).
export default function Home() {
  redirect("/minha-fila");
}
