import { HealthBanner } from "@/app/client/health-banner";
import { DialogueStudio, type DialogueTab } from "./dialogue-studio";

const TABS: DialogueTab[] = ["portrait", "expressions", "speech", "font"];

/** Diálogo e tipografia (cartão D1): retrato, expressões/visemes, fala e fonte bitmap. */
export default async function DialoguePage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { projectId } = await params;
  const { tab } = await searchParams;
  return (
    <>
      <HealthBanner />
      <DialogueStudio projectId={projectId} initialTab={TABS.includes(tab as DialogueTab) ? (tab as DialogueTab) : "portrait"} />
    </>
  );
}
