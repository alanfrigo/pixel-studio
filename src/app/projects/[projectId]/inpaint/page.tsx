import Link from "next/link";
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
  return (
    <main>
      <p className="small">
        <Link href={`/projects/${projectId}`}>← Projeto</Link>
      </p>
      {asset && revision && file ? (
        <InpaintEditor projectId={projectId} assetId={asset} revisionId={revision} fileKey={file} />
      ) : (
        <p className="error">Abra o inpainting a partir de uma revisão aprovada na biblioteca.</p>
      )}
    </main>
  );
}
