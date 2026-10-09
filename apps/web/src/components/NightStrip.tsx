import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent
} from "react";
import type { NightTrace } from "../lib/api";
import { changePct, localStamp, nyClock, pct, usd } from "../lib/format";

export interface StripLine {
  value: number;
  label: string;
  tone: "close" | "trigger";
}

export interface StripMark {
  at: number;
  label: string;
  tone: "decision" | "lock" | "trade";
}

export interface StripCheck {
  at: number;
  price: number;
}

interface Props {
  trace: NightTrace;
  lines?: StripLine[];
  marks?: StripMark[];
  /** The agent's own logged checks, drawn as dots over the 24/7 trace. */
  checks?: StripCheck[];
  now: number;
  height?: number;
  /** Shown on every panel that is a replay of recorded data rather than a live run. */
  replay?: boolean;
  compact?: boolean;
  title: string;
}

const PAD = { top: 18, right: 14, bottom: 30, left: 14 };

function hourTicks(closeTs: number, openTs: number, innerW: number): number[] {
  const span = openTs - closeTs;
  const step = span > 30 * 3600e3 ? 12 * 3600e3 : 4 * 3600e3;
  const first = Math.ceil(closeTs / 3600e3) * 3600e3;
  const ticks: number[] = [];
  for (let t = first; t < openTs; t += 3600e3) {
    // Ticks fall on New York hours that divide the step evenly.
    const hour = Number(nyClock(t).slice(0, 2));
    // Leave room for the "Close" and "Open" labels at both ends.
    const edge = (48 / Math.max(innerW, 1)) * span;
    const nearEdge = t - closeTs < edge || openTs - t < edge;
    if ((hour * 3600e3) % step === 0 && !nearEdge) ticks.push(t);
  }
  return ticks;
}

function tickLabel(t: number, long: boolean): string {
  const clock = nyClock(t);
  if (!long) return clock === "00:00" ? "midnight" : clock;
  const day = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: "America/New_York"
  }).format(t);
  return `${day} ${clock}`;
}

export function NightStrip({
  trace,
  lines = [],
  marks = [],
  checks = [],
  now,
  height = 260,
  replay = false,
  compact = false,
  title
}: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const titleId = useId();

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(280, Math.round(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { closeTs, openTs } = trace.window;
  const points = useMemo(
    () =>
      trace.points.map(([t, p]) => [t, Number(p)] as const).filter(([, p]) => Number.isFinite(p)),
    [trace.points]
  );
  const close = trace.close ? Number(trace.close.value) : null;
  const live = trace.phase === "live";
  const cursor = live ? Math.min(Math.max(now, closeTs), openTs) : openTs;

  const values = [
    ...points.map(([, p]) => p),
    ...checks.map((c) => c.price),
    ...lines.map((l) => l.value),
    ...(close === null ? [] : [close])
  ];
  const lo = values.length ? Math.min(...values) : 0;
  const hi = values.length ? Math.max(...values) : 1;
  const padY = Math.max((hi - lo) * 0.18, (hi || 1) * 0.0015);
  const yMin = lo - padY;
  const yMax = hi + padY;

  const innerW = width - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const x = (t: number) => PAD.left + ((t - closeTs) / (openTs - closeTs)) * innerW;
  const y = (p: number) => PAD.top + (1 - (p - yMin) / (yMax - yMin || 1)) * innerH;

  const path = points
    .map(([t, p], i) => `${i === 0 ? "M" : "L"}${x(t).toFixed(1)},${y(p).toFixed(1)}`)
    .join("");
  const area =
    points.length > 1
      ? `${path}L${x(points[points.length - 1]![0]).toFixed(1)},${PAD.top + innerH}L${x(points[0]![0]).toFixed(1)},${PAD.top + innerH}Z`
      : "";
  const last = points[points.length - 1];
  const ticks = hourTicks(closeTs, openTs, innerW);
  const longWindow = openTs - closeTs > 30 * 3600e3;
  const dawnStart = x(openTs - Math.min(2.5 * 3600e3, (openTs - closeTs) * 0.15));
  const gradientId = `${titleId}-dawn`;

  const nearest = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || points.length === 0) return null;
    const t = closeTs + ((clientX - rect.left - PAD.left) / innerW) * (openTs - closeTs);
    let best = 0;
    for (let i = 1; i < points.length; i += 1) {
      if (Math.abs(points[i]![0] - t) < Math.abs(points[best]![0] - t)) best = i;
    }
    return best;
  };

  const onPointer = (event: PointerEvent<SVGSVGElement>) => setHover(nearest(event.clientX));
  const onKey = (event: KeyboardEvent<SVGSVGElement>) => {
    if (points.length === 0) return;
    const step = event.shiftKey ? 12 : 1;
    if (event.key === "ArrowRight")
      setHover((h) => Math.min(points.length - 1, (h ?? points.length - 1) + step));
    else if (event.key === "ArrowLeft")
      setHover((h) => Math.max(0, (h ?? points.length - 1) - step));
    else if (event.key === "Home") setHover(0);
    else if (event.key === "End") setHover(points.length - 1);
    else if (event.key === "Escape") setHover(null);
    else return;
    event.preventDefault();
  };

  const active = hover === null ? null : points[hover];
  const activeChange = active && close !== null ? changePct(active[1], close) : null;
  const tipLeft = active ? Math.min(Math.max(x(active[0]), 90), width - 90) : 0;

  return (
    <figure className={`strip${compact ? " strip--compact" : ""}`}>
      <figcaption className="sr-only" id={titleId}>
        {title}. 24/7 price from {trace.source}, from the close at {nyClock(closeTs)} New York to
        the open.
      </figcaption>
      {replay && <span className="stamp stamp--replay">Replay · recorded data</span>}
      <div className="strip__plot" ref={box} style={{ height }}>
        <svg
          width={width}
          height={height}
          role="img"
          aria-labelledby={titleId}
          tabIndex={0}
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
        >
          <defs>
            <linearGradient id={`${gradientId}-wash`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--ember)" stopOpacity="0.16" />
              <stop offset="0.55" stopColor="var(--ember)" stopOpacity="0.04" />
              <stop offset="1" stopColor="var(--ember)" stopOpacity="0" />
            </linearGradient>
            <linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" stopColor="var(--dawn)" stopOpacity="0" />
              <stop offset="1" stopColor="var(--dawn)" stopOpacity="0.16" />
            </linearGradient>
          </defs>
          <rect
            x={dawnStart}
            y={PAD.top}
            width={x(openTs) - dawnStart}
            height={innerH}
            fill={`url(#${gradientId})`}
          />
          {live && cursor < openTs && (
            <rect
              className="strip__future"
              x={x(cursor)}
              y={PAD.top}
              width={Math.max(0, x(openTs) - x(cursor))}
              height={innerH}
            />
          )}
          {ticks.map((t) => (
            <g key={t}>
              <line
                className="strip__grid"
                x1={x(t)}
                x2={x(t)}
                y1={PAD.top}
                y2={PAD.top + innerH}
              />
              <text className="strip__tick" x={x(t)} y={height - 10} textAnchor="middle">
                {tickLabel(t, longWindow)}
              </text>
            </g>
          ))}
          <text
            className="strip__tick strip__tick--edge"
            x={PAD.left}
            y={height - 10}
            textAnchor="start"
          >
            Close
          </text>
          <text
            className="strip__tick strip__tick--edge"
            x={width - PAD.right}
            y={height - 10}
            textAnchor="end"
          >
            Open
          </text>
          {close !== null && (
            <g>
              <line
                className="strip__close"
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(close)}
                y2={y(close)}
              />
              {!compact && (
                <text className="strip__label" x={PAD.left + 4} y={y(close) - 6}>
                  Close {usd(close)}
                </text>
              )}
            </g>
          )}
          {lines
            .filter((l) => l.tone === "trigger")
            .map((l) => (
              <g key={`${l.label}-${l.value}`}>
                <line
                  className="strip__trigger"
                  x1={PAD.left}
                  x2={width - PAD.right}
                  y1={y(l.value)}
                  y2={y(l.value)}
                />
                <text
                  className="strip__label strip__label--trigger"
                  x={width - PAD.right - 4}
                  y={y(l.value) - 6}
                  textAnchor="end"
                >
                  {l.label}
                </text>
              </g>
            ))}
          {area && <path className="strip__area" d={area} fill={`url(#${gradientId}-wash)`} />}
          {path && <path className="strip__line" d={path} />}
          {checks.map((c) => (
            <circle key={c.at} className="strip__check" cx={x(c.at)} cy={y(c.price)} r={3.5} />
          ))}
          {marks.map((m) => (
            <g key={`${m.tone}-${m.at}`}>
              <line
                className={`strip__mark strip__mark--${m.tone}`}
                x1={x(m.at)}
                x2={x(m.at)}
                y1={PAD.top}
                y2={PAD.top + innerH}
              />
              <text
                className="strip__label strip__label--mark"
                x={Math.min(x(m.at) + 5, width - 120)}
                y={PAD.top + 12}
              >
                {m.label}
              </text>
            </g>
          ))}
          {last && (
            <g>
              {live && <circle className="strip__pulse" cx={x(last[0])} cy={y(last[1])} r={4} />}
              <circle className="strip__dot" cx={x(last[0])} cy={y(last[1])} r={4.5} />
            </g>
          )}
          {live && cursor < openTs && (
            <line
              className="strip__now"
              x1={x(cursor)}
              x2={x(cursor)}
              y1={PAD.top}
              y2={PAD.top + innerH}
            />
          )}
          {active && (
            <g>
              <line
                className="strip__crosshair"
                x1={x(active[0])}
                x2={x(active[0])}
                y1={PAD.top}
                y2={PAD.top + innerH}
              />
              <circle
                className="strip__dot strip__dot--hover"
                cx={x(active[0])}
                cy={y(active[1])}
                r={4.5}
              />
            </g>
          )}
        </svg>
        {active && (
          <div className="strip__tip" style={{ left: tipLeft }} role="status">
            <strong>{usd(active[1])}</strong>
            <span>{activeChange === null ? "" : `${pct(activeChange)} vs close`}</span>
            <span className="strip__tip-time">
              {nyClock(active[0])} New York · {localStamp(active[0]).split(", ")[1]} yours
            </span>
          </div>
        )}
        {points.length === 0 && (
          <p className="strip__empty">The 24/7 market has not printed in this window yet.</p>
        )}
      </div>
      {!compact && (
        <div className="strip__foot">
          <span className="strip__legend">
            <i className="key key--line" /> 24/7 price
            {close !== null && (
              <>
                <i className="key key--close" /> close
              </>
            )}
            {lines.some((l) => l.tone === "trigger") && (
              <>
                <i className="key key--trigger" /> trigger
              </>
            )}
            {checks.length > 0 && (
              <>
                <i className="key key--check" /> agent check
              </>
            )}
          </span>
          <button
            className="textbutton"
            type="button"
            onClick={() => setShowTable((s) => !s)}
            aria-expanded={showTable}
          >
            {showTable ? "Hide the numbers" : "Show the numbers"}
          </button>
        </div>
      )}
      {showTable && (
        <div className="strip__table">
          <table>
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                <th scope="col">New York</th>
                <th scope="col">24/7 price</th>
                <th scope="col">vs close</th>
              </tr>
            </thead>
            <tbody>
              {points
                .filter((_, i) => i % 3 === 0 || i === points.length - 1)
                .map(([t, p]) => (
                  <tr key={t}>
                    <td>{nyClock(t)}</td>
                    <td>{usd(p)}</td>
                    <td>{close === null ? "—" : pct(changePct(p, close))}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          <p className="fine">
            Source: {trace.source}. Close: {trace.close?.source ?? "not posted yet"}. Fetched{" "}
            {localStamp(Date.parse(trace.fetchedAt))}.
          </p>
        </div>
      )}
    </figure>
  );
}
