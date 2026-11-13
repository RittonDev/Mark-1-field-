import type { Metadata } from "next";

// Página do cliente aberta por link: fora dos buscadores (o link é o acesso).
export const metadata: Metadata = {
  title: "Relatório de atendimento",
  robots: { index: false, follow: false },
};

export default function ReportLayout({ children }: { children: React.ReactNode }) {
  return children;
}
