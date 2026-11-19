import Link from "next/link";
import { commonMessages } from "@/i18n/messages/common";
import { inpaintMessages } from "@/i18n/messages/inpaint";
import { serverMessages } from "@/i18n/server";
import { InpaintEditor } from "./inpaint-editor";

export default async function InpaintPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ asset?: string; revision?: string; file?: string }>;
}) {
  const { projectId } = await params;
  const { asset, revision, file } = await searchParams;
  const [c, m] = await Promise.all([serverMessages(commonMessages), serverMessages(inpaintMessages)]);
  return (
    <main>
      <p className="small">
        <Link href={`/projects/${projectId}`}>{c.backToProject}</Link>
      </p>
      {asset && revision && file ? (
        <InpaintEditor projectId={projectId} assetId={asset} revisionId={revision} fileKey={file} />
      ) : (
        <p className="error">{m.openFromLibrary}</p>
      )}
    </main>
  );
}
