import { HealthBanner } from "@/app/client/health-banner";
import { type KitTab, UiKitStudio } from "./ui-kit-studio";

const TABS: KitTab[] = ["template", "states", "components", "screens"];

/** Kit e composição de UI (cartão U3): template → recorte → estados → itens de menu → telas. */
export default async function UiKitPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { projectId } = await params;
  const { tab } = await searchParams;
  return (
    <>
      <HealthBanner />
      <UiKitStudio projectId={projectId} initialTab={TABS.includes(tab as KitTab) ? (tab as KitTab) : "template"} />
    </>
  );
}
