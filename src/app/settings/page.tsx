import { requestLocale } from "@/i18n/server";
import { pick } from "@/i18n/locales";
import { HealthBanner } from "../client/health-banner";
import { modelGuidance } from "../client/model-guidance";
import { settingsMessages } from "./messages";
import { ProviderSettings } from "./provider-settings";
import styles from "./settings.module.css";

export default async function SettingsPage() {
  const locale = await requestLocale();
  const m = settingsMessages[locale];
  return (
    <main id="studio-content" tabIndex={-1} className={`studio-main ${styles.page}`}>
      <header className="studio-page-head">
        <h1>{m.title}</h1>
        <p className="muted">{m.intro}</p>
      </header>
      <ProviderSettings />
      <section className={styles.guide} aria-labelledby="model-guide">
        <h2 id="model-guide">{m.guide}</h2>
        <p className="muted">{m.benchmarkNote}</p>
        <dl>
          {modelGuidance.map((row) => (
            <div key={row.id}>
              <dt>{pick(row.task, locale)}</dt>
              <dd><code>{row.model}</code><p>{pick(row.evidence, locale)}</p></dd>
            </div>
          ))}
        </dl>
      </section>
      <details className={styles.diagnostics}>
        <summary>{m.system}</summary>
        <HealthBanner warningsOnly={false} />
      </details>
    </main>
  );
}
