import type { Metadata, Viewport } from "next";
import "./globals.css";
import { InsecureCookieBanner } from "@/components/InsecureCookieBanner";

export const metadata: Metadata = {
  title: "career-ops",
  description: "Personal job application agent",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#09090b",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-zinc-950 text-zinc-100">
        <InsecureCookieBanner />
        {children}
      </body>
    </html>
  );
}
