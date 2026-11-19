import Link from "next/link";
import { HealthBanner } from "../client/health-banner";
import { ProviderSettings } from "./provider-settings";

export default function SettingsPage() {
  return (
    <main>
      <p className="small">
        <Link href="/">← Projetos</Link>
      </p>
      <h1>Provedores de geração</h1>
      <HealthBanner />
      <ProviderSettings />
    </main>
  );
}
