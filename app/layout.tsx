import type { Metadata } from "next";
import localFont from "next/font/local";

import { PrivyAppProvider } from "@/components/privy-app-provider";
import { getEnv } from "@/lib/server/env";

import "./globals.css";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});

const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "MyMake",
  description: "A personal AI-powered UI editor for uploaded React frontend designs.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const privyAppId = getEnv().publicPrivyAppId || "";

  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        <PrivyAppProvider appId={privyAppId}>{children}</PrivyAppProvider>
      </body>
    </html>
  );
}
