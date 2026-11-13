import type { Metadata } from "next";
import { Manrope } from "next/font/google";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";
import "./globals.css";
import { Providers } from "./providers";

// Tipografia da marca: geométrica e legível em tabelas (números tabulares), servida pelo próprio app.
const brandFont = Manrope({ subsets: ["latin"], variable: "--font-brand", display: "swap" });

// A cor da barra (theme-color) não vem daqui: o script de tema a define pelo tema escolhido, que pode
// ser diferente do tema do sistema (a meta com "media" deixava a barra clara com o app escuro).
export const metadata: Metadata = {
  title: { default: "Maxx Field", template: "%s · Maxx Field" },
  description: "Gestão de chamados e ordens de serviço de T.I. em campo",
  // Ícone quadrado do app (o símbolo largo ficava achatado no quadradinho da aba).
  icons: { icon: "/brand/app-icon-192.png", apple: "/brand/app-icon-192.png" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // O script define data-theme antes da hidratação; o aviso de diferença no <html> é esperado.
    <html lang="pt-BR" className={brandFont.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
