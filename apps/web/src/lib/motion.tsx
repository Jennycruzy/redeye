import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Wraps a live number so it flashes up or down when the agent reports a new value.
 * The first value never flashes: only real changes are worth the eye.
 */
export function Tick({ value, children }: { value: number | null; children: ReactNode }) {
  const last = useRef<number | null>(value);
  const [flash, setFlash] = useState<{ n: number; dir: "up" | "down" } | null>(null);
  useEffect(() => {
    const previous = last.current;
    last.current = value;
    if (previous === null || value === null || previous === value) return;
    setFlash((f) => ({ n: (f?.n ?? 0) + 1, dir: value > previous ? "up" : "down" }));
  }, [value]);
  return (
    <span key={flash?.n ?? 0} className={flash ? `tick tick--${flash.dir}` : "tick"}>
      {children}
    </span>
  );
}

/** Fades its content up the first time it scrolls into view. */
export function Reveal({ children, className = "" }: { children: ReactNode; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const node = box.current;
    if (!node || typeof IntersectionObserver === "undefined") return setShown(true);
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -8% 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={box} className={`reveal${shown ? " reveal--in" : ""} ${className}`.trim()}>
      {children}
    </div>
  );
}
