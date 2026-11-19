import Link from "next/link";
import { ProjectList } from "./project-list";
import { HealthBanner } from "./client/health-banner";

export default function HomePage() {
  return (
    <main>
      <h1>Pixel Studio</h1>
      <p className="small">
        <Link href="/settings">Provedores de geração</Link>
      </p>
      <HealthBanner />
      <ProjectList />
    </main>
  );
}
