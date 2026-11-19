import Link from "next/link";
import { HealthBanner } from "@/app/client/health-banner";
import { commonMessages } from "@/i18n/messages/common";
import { serverMessages } from "@/i18n/server";
import { DialogueStudio, type DialogueTab } from "./dialogue-studio";

const TABS: DialogueTab[] = ["portrait", "expressions", "speech", "font"];

/** Diálogo e tipografia (cartão D1): retrato, expressões/visemes, fala e fonte bitmap. */
export default async function DialoguePage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { projectId } = await params;
  const { tab } = await searchParams;
  const c = await serverMessages(commonMessages);
  return (
    <main>
      <p className="small">
        <Link href={`/projects/${projectId}`}>{c.backToProject}</Link>
      </p>
      <HealthBanner />
      <DialogueStudio projectId={projectId} initialTab={TABS.includes(tab as DialogueTab) ? (tab as DialogueTab) : "portrait"} />
    </main>
  );
}
