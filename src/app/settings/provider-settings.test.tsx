// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProviderSettings } from "./provider-settings";

const endpoint = "/api/v1/settings/providers";
const codex = {
  id: "codex-local", name: "Local workstation", transport: "codex_cli", config: {}, simulated: false,
  capabilities: { generate_asset: ["text_to_image"] }, matrix: [], unavailable: null,
};
const openRouter = {
  id: "router-mini", name: "Remote model", transport: "openrouter_images", model: "openai/gpt-image-1-mini",
  config: {}, simulated: false, secretRef: "STUDIO_ROUTER_KEY", secretConfigured: true,
  capabilities: { generate_asset: ["text_to_image", "image_reference"] },
  matrix: [{ contractSnapshot: { en: "One reference per call", "pt-BR": "Uma referência por chamada" } }], unavailable: null,
};
const fetchProviders = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchProviders.mockReset();
  vi.stubGlobal("fetch", fetchProviders);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows how to recover a signed-out Codex, then updates readiness without submitting a job", async () => {
  let signedIn = false;
  fetchProviders.mockImplementation(async (url, init) => {
    if (url === endpoint && !init?.method) return Response.json({ profiles: [codex] });
    if (url === `${endpoint}/codex-local/check` && init?.method === "POST") {
      return Response.json({ ok: signedIn, message: signedIn ? "Image tool is available" : "Sign-in required" });
    }
    throw new Error(`Unexpected request: ${init?.method} ${url}`);
  });
  render(<ProviderSettings />);
  const connection = screen.getByRole("region", { name: "Codex connection" });
  expect(await within(connection).findByText("Sign-in required")).toBeTruthy();
  expect(within(connection).getByText("Needs attention")).toBeTruthy();
  expect(within(connection).getByText("codex login")).toBeTruthy();

  signedIn = true;
  fireEvent.click(within(connection).getByRole("button", { name: "Refresh status" }));
  expect(await within(connection).findByText("Image tool is available")).toBeTruthy();
  expect(within(connection).getByText("Ready")).toBeTruthy();
  expect(within(connection).queryByText("codex login")).toBeNull();
  expect(fetchProviders.mock.calls.map(([url]) => url)).toEqual([endpoint, `${endpoint}/codex-local/check`, endpoint, `${endpoint}/codex-local/check`]);
});

it("edits and checks a remote profile using only the credential reference, invalidating an older test", async () => {
  const checked = Promise.withResolvers<Response>();
  fetchProviders.mockImplementation(async (url, init) => {
    if (url === endpoint && !init?.method) return Response.json({ profiles: [openRouter] });
    if (url === `${endpoint}/router-mini/check` && init?.method === "POST") return checked.promise;
    if (url === endpoint && init?.method === "POST") return Response.json({ profile: openRouter }, { status: 201 });
    throw new Error(`Unexpected request: ${init?.method} ${url}`);
  });
  render(<ProviderSettings />);
  const remote = await screen.findByRole("region", { name: "Profiles" });
  expect(within(remote).getByText(/STUDIO_ROUTER_KEY \(set\)/)).toBeTruthy();
  expect(within(remote).getByText("One reference per call")).toBeTruthy();
  const probe = within(remote).getByRole<HTMLButtonElement>("button", { name: "Test at no cost" });
  fireEvent.click(probe);
  expect(probe.disabled).toBe(true);
  checked.resolve(Response.json({ ok: false, message: "Model unavailable on this plan" }));
  expect(await within(remote).findByText("Model unavailable on this plan")).toBeTruthy();
  expect(probe.disabled).toBe(false);

  fireEvent.click(within(remote).getByRole("link", { name: "Edit profile" }));
  const editor = screen.getByRole("region", { name: "Add or update a profile" });
  const id = within(editor).getByRole<HTMLInputElement>("textbox", { name: "ID" });
  expect({ value: id.value, locked: id.readOnly }).toEqual({ value: "router-mini", locked: true });
  fireEvent.change(within(editor).getByRole("textbox", { name: "Secret variable" }), { target: { value: "studio_trial_key" } });
  fireEvent.click(within(editor).getByRole("button", { name: "Save profile" }));
  expect(await within(editor).findByText(/Profile saved/)).toBeTruthy();
  expect(within(remote).queryByText("Model unavailable on this plan")).toBeNull();
  const body = fetchProviders.mock.calls.find(([url, init]) => url === endpoint && init?.method === "POST")?.[1]?.body;
  expect(typeof body).toBe("string");
  expect(JSON.parse(body as string)).toEqual({
    id: "router-mini", name: "Remote model", transport: "openrouter_images", config: {}, model: "openai/gpt-image-1-mini", secretRef: "STUDIO_TRIAL_KEY",
  });
});

it("does not save invalid JSON and shows field-level validation returned by the API", async () => {
  fetchProviders.mockImplementation(async (_url, init) => init?.method === "POST"
    ? Response.json({ code: "validation_failed", details: { issues: [{ path: ["baseUrl"], message: "Use HTTPS or a loopback address" }] } }, { status: 422 })
    : Response.json({ profiles: [] }));
  render(<ProviderSettings />);
  await screen.findByText("Codex not configured");
  const editor = screen.getByRole("region", { name: "Add or update a profile" });
  const profile = within(editor);
  fireEvent.change(profile.getByRole("combobox", { name: "Transport" }), { target: { value: "openai_images" } });
  for (const [name, value] of Object.entries({ ID: "local-vision", Name: "Local vision", Model: "model", "Secret variable": "key", "Base URL": "http://example.test" })) {
    fireEvent.change(profile.getByRole("textbox", { name }), { target: { value } });
  }
  fireEvent.click(profile.getByText("Advanced configuration"));
  const config = profile.getByRole("textbox", { name: "Configuration (JSON)" });
  const save = profile.getByRole("button", { name: "Save profile" });
  fireEvent.change(config, { target: { value: "{" } });
  await act(async () => fireEvent.click(save));
  expect(profile.getByRole("status").textContent).toMatch(/JSON|property name/i);
  expect(fetchProviders.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  fireEvent.change(config, { target: { value: "{}" } });
  fireEvent.click(save);
  expect(await profile.findByText("baseUrl: Use HTTPS or a loopback address")).toBeTruthy();
});
