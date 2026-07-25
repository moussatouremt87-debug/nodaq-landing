import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Shell } from "./shell";

export const metadata: Metadata = {
  title: "NODAQ — Cockpit",
  description: "Employés virtuels souverains pour PME — cockpit dirigeant.",
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
