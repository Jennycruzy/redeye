import type { RecordItem } from "./api";
import { pct, usd } from "./format";

/** The price at which a plan acts, from the close and its own trigger. */
export function triggerPrice(
  item: Pick<RecordItem, "kind" | "params">,
  close: number
): number | null {
  const params = item.params ?? {};
  if (item.kind === "sell_rise" && params.triggerRisePct)
    return close * (1 + Number(params.triggerRisePct) / 100);
  if ((item.kind === "guard" || item.kind === "buy_dip") && params.triggerDropPct)
    return close * (1 - Number(params.triggerDropPct) / 100);
  return null;
}

/** "Sell half at $232.78 or higher (+1%)" for the chart's trigger line. */
export function triggerLabel(item: Pick<RecordItem, "kind" | "params">, price: number): string {
  const params = item.params ?? {};
  if (item.kind === "sell_rise") {
    const share = params.sellPct ? `${params.sellPct}%` : "";
    return `Sell ${share} at ${usd(price)}+ (${pct(Number(params.triggerRisePct))})`;
  }
  if (item.kind === "buy_dip")
    return `Buy ${usd(params.maxUsd, 0)} at ${usd(price)} or less (${pct(-Number(params.triggerDropPct))})`;
  if (item.kind === "guard") {
    const share = params.sellPct ? `${params.sellPct}%` : "";
    return `Sell ${share} at ${usd(price)} or less (${pct(-Number(params.triggerDropPct))})`;
  }
  return "";
}
