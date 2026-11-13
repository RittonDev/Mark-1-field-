import type { Metadata } from "next";

// Nome da aba do navegador no login e na volta do login Microsoft ("Entrar · Maxx Field").
export const metadata: Metadata = { title: "Entrar" };

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
