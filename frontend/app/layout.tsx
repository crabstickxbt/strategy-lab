import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Strategy Lab - SP500 vs SNP1",
  description: "Static pre-rendered SP500 vs SNP1 scenarios (optimistic and pessimistic) for GitHub Pages.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
