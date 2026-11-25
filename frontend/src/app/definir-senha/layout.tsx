import type { Metadata } from "next";

// Página aberta pelo link do e-mail (o token vem no fragmento #token=): sem login e fora dos buscadores.
export const metadata: Metadata = {
  title: "Definir nova senha",
  robots: { index: false, follow: false },
};

export default function SetPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}
