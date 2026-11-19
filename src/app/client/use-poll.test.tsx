// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePoll } from "./use-poll";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const flush = () => advance(0);

it("slows down while idle and returns to the fast interval when a job starts", async () => {
  const queued = { job: "tilemap", active: false };
  const running = { ...queued, active: true };
  const load = vi.fn<() => Promise<typeof queued>>()
    .mockResolvedValueOnce(queued)
    .mockResolvedValueOnce(queued)
    .mockResolvedValue(running);
  const { result, unmount } = renderHook(() => usePoll(load, { active: (data) => data.active, fastMs: 100, slowMs: 300 }));

  await flush();
  expect(result.current.data).toEqual(queued);
  await advance(199);
  expect(load).toHaveBeenCalledTimes(1);
  await advance(1);
  await advance(299);
  expect(load).toHaveBeenCalledTimes(2);
  await advance(1);
  expect(result.current.data).toEqual(running);
  await advance(99);
  expect(load).toHaveBeenCalledTimes(3);
  await advance(1);
  expect(load).toHaveBeenCalledTimes(4);

  unmount();
  await advance(1000);
  expect(load).toHaveBeenCalledTimes(4);
});

it("keeps the last results during failures and recovers immediately when the user refreshes", async () => {
  const oldLoad = vi.fn<() => Promise<string>>()
    .mockResolvedValueOnce("approved")
    .mockRejectedValue(new Error("worker disconnected"));
  const newLoad = vi.fn<() => Promise<string>>()
    .mockRejectedValueOnce("HTTP offline")
    .mockResolvedValue("updated");
  const { result, rerender } = renderHook(({ load }) => usePoll(load, { active: () => true }), { initialProps: { load: oldLoad } });
  await flush();
  await advance(1000);
  expect(result.current).toMatchObject({ data: "approved", error: "worker disconnected" });
  rerender({ load: newLoad });
  await advance(1999);
  expect(newLoad).not.toHaveBeenCalled();
  await advance(1);
  expect(result.current).toMatchObject({ data: "approved", error: "HTTP offline" });
  await act(async () => result.current.refresh());
  expect(result.current).toMatchObject({ data: "updated", error: null });
  await advance(1000);
  expect(newLoad).toHaveBeenCalledTimes(3);
  expect(oldLoad).toHaveBeenCalledTimes(2);
});

it("does not poll aggressively in hidden tabs and refreshes on return", async () => {
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  const load = vi.fn<() => Promise<string>>().mockResolvedValueOnce("queued").mockResolvedValue("succeeded");
  const { result } = renderHook(() => usePoll(load, { active: () => false, fastMs: 1000 }));
  await flush();
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  await advance(14_999);
  expect(load).toHaveBeenCalledTimes(1);
  expect(result.current.data).toBe("queued");
  hidden.mockReturnValue(false);
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(result.current.data).toBe("succeeded");
  await advance(1);
  expect(load).toHaveBeenCalledTimes(2);
});

it.each(["resolve", "reject"] as const)("ignores an in-flight poll that settles after the page unmounts (%s)", async (end) => {
  const deferred = Promise.withResolvers<string>();
  const load = vi.fn(() => deferred.promise);
  const { unmount } = renderHook(() => usePoll(load, { active: () => true }));
  unmount();
  await act(async () => {
    if (end === "resolve") deferred.resolve("done");
    else deferred.reject(new Error("disconnected"));
  });
  await advance(30_000);
  expect(load).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
