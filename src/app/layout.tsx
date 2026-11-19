import type { Metadata } from "next";
import type { ReactNode } from "react";
import { I18nProvider } from "@/i18n/client";
import { commonMessages } from "@/i18n/messages/common";
import { requestLocale } from "@/i18n/server";
import { StudioNavigation } from "./studio-navigation";
import "./globals.css";
import "./studio.css";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await requestLocale();
  const description = commonMessages[locale].appDescription;
  return {
    title: "Pixel Studio",
    description,
    icons: "/studio-icon.svg",
    openGraph: { title: "Pixel Studio", description, type: "website" },
    other: { "page-type": "software", "site-kind": "software" },
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await requestLocale();
  return (
    <html lang={locale} data-type="software" data-radius="sharp" data-buttons="tonal" data-motion="" data-ground="sage" suppressHydrationWarning>
      <head>
        {/* eslint-disable-next-line @next/next/no-css-tags -- Kit styles are kept as a separately loaded asset. */}
        <link rel="stylesheet" href="/assets/motion/motion.css" />
        <meta name="theme-color" content="#ffffff" />
        <script dangerouslySetInnerHTML={{ __html: "document.documentElement.classList.add('m-enter');setTimeout(()=>document.documentElement.classList.add('m-enter-done'),700)" }} />
      </head>
      <body>
        <I18nProvider locale={locale}>
          <StudioNavigation />
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
