import Link from "next/link";
import { commonMessages } from "@/i18n/messages/common";
import { serverMessages } from "@/i18n/server";
import { HealthBanner } from "../client/health-banner";
import { ProviderSettings } from "./provider-settings";

export default async function SettingsPage() {
  const c = await serverMessages(commonMessages);
  return (
    <main>
      <p className="small">
        <Link href="/">{c.backToProjects}</Link>
      </p>
      <h1>{c.providers}</h1>
      <HealthBanner />
      <ProviderSettings />
    </main>
  );
}
