import { useCallback, useEffect, useRef, useState } from "react";

export type Load<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; value: T; at: number };

/**
 * Loads from the agent and, when `refreshMs` is set, reloads quietly in the background:
 * the last good value stays on screen while a refresh runs or fails.
 */
export function useAgent<T>(
  load: () => Promise<T>,
  deps: unknown[] = [],
  refreshMs?: number
): Load<T> & { retry: () => void; stale: boolean } {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  const [stale, setStale] = useState(false);
  const [nonce, setNonce] = useState(0);
  const retry = useCallback(() => setNonce((n) => n + 1), []);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    const run = (quiet: boolean) =>
      loadRef
        .current()
        .then((value) => {
          if (!active) return;
          setState({ status: "ready", value, at: Date.now() });
          setStale(false);
        })
        .catch((error: unknown) => {
          if (!active) return;
          const message = error instanceof Error ? error.message : "The request failed.";
          if (quiet) setStale(true);
          else setState({ status: "error", message });
        });
    void run(false);
    const timer = refreshMs ? window.setInterval(() => void run(true), refreshMs) : null;
    return () => {
      active = false;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [...deps, nonce, refreshMs]);

  return { ...state, retry, stale };
}

/** The current time, updated every `everyMs`. */
export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** True when the reader asked the system for less motion. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return reduced;
}
