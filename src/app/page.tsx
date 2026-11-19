import Link from "next/link";
import { commonMessages } from "@/i18n/messages/common";
import { serverMessages } from "@/i18n/server";
import { ProjectList } from "./project-list";
import { HealthBanner } from "./client/health-banner";

export default async function HomePage() {
  const c = await serverMessages(commonMessages);
  return (
    <main>
      <h1>Pixel Studio</h1>
      <p className="small">
        <Link href="/settings">{c.providers}</Link>
      </p>
      <HealthBanner />
      <ProjectList />
    </main>
  );
}
