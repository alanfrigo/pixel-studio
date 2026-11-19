import Link from "next/link";
import { commonMessages } from "@/i18n/messages/common";
import { serverMessages } from "@/i18n/server";
import { HealthBanner } from "@/app/client/health-banner";
import { WorldStudio } from "./world-studio";

/** Mundo (cartão T1): texturas repetíveis, tilesets e mapas editáveis. */
export default async function WorldPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ tab?: string; map?: string }> }) {
  const { projectId } = await params;
  const c = await serverMessages(commonMessages);
  const { tab, map } = await searchParams;
  return (
    <main>
      <p className="small">
        <Link href={`/projects/${projectId}`}>{c.backToProject}</Link>
      </p>
      <HealthBanner />
      <WorldStudio projectId={projectId} initialTab={tab === "tilesets" || tab === "maps" ? tab : "textures"} initialMap={map ?? null} />
    </main>
  );
}
