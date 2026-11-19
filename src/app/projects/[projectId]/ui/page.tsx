import Link from "next/link";
import { commonMessages } from "@/i18n/messages/common";
import { uiKitMessages } from "@/i18n/messages/ui-kit";
import { serverMessages } from "@/i18n/server";
import { HealthBanner } from "@/app/client/health-banner";
import { type KitTab, UiKitStudio } from "./ui-kit-studio";

const TABS: KitTab[] = ["template", "states", "components", "screens"];

/** Kit e composição de UI (cartão U3): template → recorte → estados → itens de menu → telas. */
export default async function UiKitPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { projectId } = await params;
  const { tab } = await searchParams;
  const [c, m] = await Promise.all([serverMessages(commonMessages), serverMessages(uiKitMessages)]);
  return (
    <main style={{ maxWidth: 1280 }}>
      <p className="small">
        <Link href={`/projects/${projectId}`}>{c.backToProject}</Link> · <span className="muted">{m.studio.subtitle}</span>
      </p>
      <HealthBanner />
      <UiKitStudio projectId={projectId} initialTab={TABS.includes(tab as KitTab) ? (tab as KitTab) : "template"} />
    </main>
  );
}
