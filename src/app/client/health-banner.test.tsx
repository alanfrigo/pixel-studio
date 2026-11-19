// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n/client";
import type { Health } from "./api";
import { HealthBanner } from "./health-banner";

const healthy: Health = {
  ok: true,
  sqlite: { version: "3.53.2", schemaVersion: 15, latest: 15 },
  storage: { dataDir: "/studio", freeBytes: 2560 },
  python: { ok: true, python: "3.14.10", pillow: "13.0.0" },
  worker: { online: true, workers: [] },
};
const fetchHealth = vi.fn<typeof fetch>();
const flush = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));
const readyDiagnostic = "Worker ativo · Python 3.14.10 / Pillow 13.0.0 · SQLite 3.53.2 · 2,5 KB livres";
const workerWarning = /Worker indisponível: gerações e importações ficam na fila/;

beforeEach(() => {
  vi.useFakeTimers();
  fetchHealth.mockReset();
  vi.stubGlobal("fetch", fetchHealth);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("warns only while a dependency is broken, preserving the localized cause", async () => {
  const waiting = Promise.withResolvers<Response>();
  fetchHealth.mockReturnValueOnce(waiting.promise).mockImplementation(async () => Response.json(healthy));
  const view = render(<I18nProvider locale="pt-BR"><HealthBanner /></I18nProvider>);
  expect(view.container.textContent).toBe("");
  const unavailable: Health = {
    ...healthy,
    ok: false,
    worker: { online: false, workers: [] },
    python: { ok: false, error: { "pt-BR": "Pillow não instalado", en: "Pillow not installed" } },
  };
  waiting.resolve(Response.json(unavailable));
  await flush();
  expect(screen.getByText(workerWarning)).toBeTruthy();
  expect(screen.getByText("Processador Python indisponível: Pillow não instalado")).toBeTruthy();
  await flush(10_000);
  expect(screen.queryByText(workerWarning)).toBeNull();
  expect(screen.queryByText(readyDiagnostic)).toBeNull();
});

it("shows a server error for a failed check and then restores the detailed diagnostic", async () => {
  fetchHealth.mockImplementationOnce(async () => Response.json({ code: "offline", message: "em manutenção" }, { status: 503 }))
    .mockImplementation(async () => Response.json(healthy));
  render(<I18nProvider locale="pt-BR"><HealthBanner warningsOnly={false} /></I18nProvider>);
  await flush();
  expect(screen.getByText("Servidor indisponível: em manutenção")).toBeTruthy();
  await flush(10_000);
  expect(screen.queryByText(/Servidor indisponível/)).toBeNull();
  expect(screen.getByText(readyDiagnostic)).toBeTruthy();
});

it("does not report an unknown Python version as a real number and gives missing errors a useful label", async () => {
  fetchHealth.mockImplementationOnce(async () => Response.json({ ...healthy, python: { ok: true } } satisfies Health))
    .mockImplementation(async () => Response.json({ ...healthy, ok: false, python: { ok: false } } satisfies Health));
  render(<HealthBanner warningsOnly={false} />);
  await flush();
  expect(screen.getByText("Worker running · Python ? / Pillow ? · SQLite 3.53.2 · 2.5 KB free")).toBeTruthy();
  await flush(10_000);
  expect(screen.getByText("Python processor unavailable: unknown error")).toBeTruthy();
});
