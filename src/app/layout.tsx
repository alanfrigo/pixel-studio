import type { Metadata } from "next";
import type { ReactNode } from "react";
import { I18nProvider, LocaleSwitch } from "@/i18n/client";
import { commonMessages } from "@/i18n/messages/common";
import { requestLocale } from "@/i18n/server";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await requestLocale();
  return { title: "Pixel Studio", description: commonMessages[locale].appDescription };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await requestLocale();
  return (
    <html lang={locale}>
      <body>
        <I18nProvider locale={locale}>
          <div className="locale-switch">
            <LocaleSwitch />
          </div>
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
