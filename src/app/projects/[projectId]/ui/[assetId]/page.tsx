import Link from "next/link";
import { commonMessages } from "@/i18n/messages/common";
import { serverMessages } from "@/i18n/server";
import { UiEditor } from "./ui-editor";

export default async function UiEditorPage({ params }: { params: Promise<{ projectId: string; assetId: string }> }) {
  const { projectId, assetId } = await params;
  const c = await serverMessages(commonMessages);
  return (
    <main>
      <p className="small">
        <Link href={`/projects/${projectId}`}>{c.backToProject}</Link>
      </p>
      <UiEditor projectId={projectId} assetId={assetId} />
    </main>
  );
}
