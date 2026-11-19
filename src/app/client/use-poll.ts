"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Consulta periódica com intervalo crescente (02 §jobs): rápido enquanto há
 * trabalho ativo, mais lento quando ocioso e bem mais lento com a aba em
 * segundo plano. Ao voltar para a aba, consulta na hora.
 */
export function usePoll<T>(load: () => Promise<T>, opts: { active: (data: T) => boolean; fastMs?: number; slowMs?: number }) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  const optsRef = useRef(opts);
  const refreshRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    loadRef.current = load;
    optsRef.current = opts;
  });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delay = optsRef.current.fastMs ?? 1000;

    const tick = async () => {
      if (timer) clearTimeout(timer);
      const { fastMs = 1000, slowMs = 8000 } = optsRef.current;
      try {
        const next = await loadRef.current();
        if (cancelled) return;
        setData(next);
        setError(null);
        delay = optsRef.current.active(next) ? fastMs : Math.min(delay * 2, slowMs);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        delay = Math.min(delay * 2, slowMs);
      }
      timer = setTimeout(tick, document.hidden ? Math.max(delay * 4, 15_000) : delay);
    };

    refreshRef.current = () => {
      delay = optsRef.current.fastMs ?? 1000;
      void tick();
    };
    const onVisible = () => {
      if (!document.hidden) refreshRef.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const refresh = useCallback(() => refreshRef.current(), []);
  return { data, error, refresh };
}
