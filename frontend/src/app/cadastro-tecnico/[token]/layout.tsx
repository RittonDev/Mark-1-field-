import type { Metadata } from "next";

// Ficha aberta pelo link de cadastro: fora dos buscadores (o link com o token é o acesso, e um link
// reutilizável pode circular em grupos abertos).
export const metadata: Metadata = {
  title: "Cadastro de técnico parceiro",
  robots: { index: false, follow: false },
};

export default function SignupLayout({ children }: { children: React.ReactNode }) {
  return children;
}
