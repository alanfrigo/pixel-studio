import { HealthBanner } from "@/app/client/health-banner";
import { ScenesStudio, type ScenesTab } from "./scenes-studio";

const TABS: ScenesTab[] = ["scene", "parallax", "rooms", "furniture", "kit", "iso", "objects"];

/** Cenas, salas e móveis (cartão T2): cena plana, paralaxe, salas, móveis, kit, isométrico e props. */
export default async function ScenesPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { projectId } = await params;
  const { tab } = await searchParams;
  return (
    <>
      <HealthBanner />
      <ScenesStudio projectId={projectId} initialTab={TABS.includes(tab as ScenesTab) ? (tab as ScenesTab) : "scene"} />
    </>
  );
}
