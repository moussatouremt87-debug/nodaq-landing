import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Shell } from "./shell";

export const metadata: Metadata = {
  title: "NODAQ — Cockpit",
  description: "Employés virtuels souverains pour PME — cockpit dirigeant.",
  // PWA (2.17) : le manifest + l'icône Apple permettent « Ajouter à l'écran
  // d'accueil » — prérequis iOS pour les notifications push.
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "NODAQ" },
  icons: { apple: "/apple-touch-icon.png" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
