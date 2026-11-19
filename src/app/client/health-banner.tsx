"use client";

import { useLocale, useMessages, useText } from "@/i18n/client";
import { commonMessages } from "@/i18n/messages/common";
import { homeMessages } from "@/i18n/messages/home";
import { apiFetch, formatBytes, type Health } from "./api";
import { usePoll } from "./use-poll";

/** Avisa quando o worker ou o Python estão indisponíveis; revisar assets prontos continua possível. */
export function HealthBanner({ warningsOnly = true }: { warningsOnly?: boolean }) {
  const locale = useLocale();
  const m = useMessages(homeMessages).health;
  const c = useMessages(commonMessages);
  const text = useText();
  const { data, error } = usePoll(() => apiFetch<Health>("/health"), { active: () => false, fastMs: 5000, slowMs: 10_000 });
  if (error) return <div className="banner banner-error">{m.serverDown(error)}</div>;
  if (!data) return null;
  const problems: string[] = [];
  if (!data.worker.online) problems.push(m.workerDown);
  if (!data.python.ok) problems.push(m.pythonDown(text(data.python.error) || c.unknownError));
  if (warningsOnly && !problems.length) return null;
  return (
    <div className={problems.length ? "banner banner-warn" : "banner banner-ok"}>
      {problems.length ? (
        problems.map((p) => <div key={p}>{p}</div>)
      ) : (
        <span>{m.ok(data.python.python ?? "?", data.python.pillow ?? "?", data.sqlite.version, formatBytes(data.storage.freeBytes, locale))}</span>
      )}
    </div>
  );
}
