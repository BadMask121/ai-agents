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
  themeColor: "#0A0A0A",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-background text-foreground">
        <InsecureCookieBanner />
        {children}
      </body>
    </html>
  );
}
