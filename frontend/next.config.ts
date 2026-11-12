import type { NextConfig } from "next";

// Cabeçalhos de segurança em todas as páginas: não abre dentro de outro site (clickjacking),
// não adivinha tipo de arquivo, não manda a URL completa para outros sites e só libera a
// localização (check-in pela web), nunca câmera ou microfone.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self)" },
];

const nextConfig: NextConfig = {
  // Imagem Docker enxuta: o build gera um servidor autocontido.
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
