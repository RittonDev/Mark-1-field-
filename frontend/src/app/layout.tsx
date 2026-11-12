import type { Metadata, Viewport } from "next";
import { Manrope } from "next/font/google";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";
import "./globals.css";
import { Providers } from "./providers";

// Tipografia da marca: geométrica e legível em tabelas (números tabulares), servida pelo próprio app.
const brandFont = Manrope({ subsets: ["latin"], variable: "--font-brand", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Maxx Field", template: "%s · Maxx Field" },
  description: "Gestão de chamados e ordens de serviço de T.I. em campo",
  icons: { icon: "/brand/maxxfield-mark.png" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7f9" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0d14" },
  ],
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
