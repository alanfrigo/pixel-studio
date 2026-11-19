import Link from "next/link";
import { commonMessages } from "@/i18n/messages/common";
import { workspaceMessages } from "@/i18n/messages/workspace";
import { serverMessages } from "@/i18n/server";
import { HealthBanner } from "@/app/client/health-banner";
import { ScenesStudio, type ScenesTab } from "./scenes-studio";

const TABS: ScenesTab[] = ["scene", "parallax", "rooms", "furniture", "kit", "iso", "objects"];

/** Cenas, salas e móveis (cartão T2): cena plana, paralaxe, salas, móveis, kit, isométrico e props. */
export default async function ScenesPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { projectId } = await params;
  const [c, w] = await Promise.all([serverMessages(commonMessages), serverMessages(workspaceMessages)]);
  const { tab } = await searchParams;
  return (
    <main>
      <p className="small">
        <Link href={`/projects/${projectId}`}>{c.backToProject}</Link> · <Link href={`/projects/${projectId}/world`}>{w.nav.worldShort}</Link>
      </p>
      <HealthBanner />
      <ScenesStudio projectId={projectId} initialTab={TABS.includes(tab as ScenesTab) ? (tab as ScenesTab) : "scene"} />
    </main>
  );
}
