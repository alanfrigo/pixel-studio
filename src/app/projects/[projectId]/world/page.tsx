import { HealthBanner } from "@/app/client/health-banner";
import { WorldStudio } from "./world-studio";

/** Mundo (cartão T1): texturas repetíveis, tilesets e mapas editáveis. */
export default async function WorldPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ tab?: string; map?: string }> }) {
  const { projectId } = await params;
  const { tab, map } = await searchParams;
  return (
    <>
      <HealthBanner />
      <WorldStudio projectId={projectId} initialTab={tab === "tilesets" || tab === "maps" ? tab : "textures"} initialMap={map ?? null} />
    </>
  );
}
