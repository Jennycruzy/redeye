const NEW_YORK = "America/New_York";
const PREMARKET_MINUTE = 4 * 60;
const REGULAR_CLOSE_MINUTE = 16 * 60;
const POSTMARKET_END_MINUTE = 20 * 60;

export type TradingPeriod = "regular" | "premarket" | "postmarket" | "overnight" | "closed";

export interface TradingSession {
  period: TradingPeriod;
  isRegular: boolean;
  sessionDate: string;
  regularOpenMs: number;
  regularCloseMs: number;
  nextRegularOpenMs: number;
  nextRegularCloseMs: number;
  earlyClose: boolean;
  holiday: string | null;
}

export interface OffHoursWindow {
  kind: "overnight" | "weekend" | "holiday";
  closeTs: number;
  openTs: number;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: NEW_YORK,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

function partsAt(timestampMs: number): LocalParts {
  if (!Number.isFinite(timestampMs)) throw new Error("Timestamp must be finite.");
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(timestampMs)).map((part) => [part.type, part.value])
  );
  const required = ["year", "month", "day", "hour", "minute", "second"] as const;
  for (const name of required) {
    if (parts[name] === undefined) throw new Error(`New York time is missing ${name}.`);
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function localDateKey(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")}`;
}

function localWallClockToMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const displayed = partsAt(guess);
  const displayedAsUtc = Date.UTC(
    displayed.year,
    displayed.month - 1,
    displayed.day,
    displayed.hour,
    displayed.minute,
    displayed.second
  );
  const offsetMs = displayedAsUtc - guess;
  return guess - offsetMs;
}

function weekday(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function nthWeekday(
  year: number,
  month: number,
  targetWeekday: number,
  occurrence: number
): number {
  const first = weekday(year, month, 1);
  return 1 + ((targetWeekday - first + 7) % 7) + (occurrence - 1) * 7;
}

function lastWeekday(year: number, month: number, targetWeekday: number): number {
  const lastDay = daysInMonth(year, month);
  return lastDay - ((weekday(year, month, lastDay) - targetWeekday + 7) % 7);
}

function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

function observedDate(year: number, month: number, day: number): string {
  const dayOfWeek = weekday(year, month, day);
  if (dayOfWeek === 6) return localDateKey(year, month, day - 1);
  if (dayOfWeek === 0) return localDateKey(year, month, day + 1);
  return localDateKey(year, month, day);
}

function holidayName(year: number, month: number, day: number): string | null {
  const key = localDateKey(year, month, day);
  const easter = easterSunday(year);
  const goodFriday = new Date(Date.UTC(year, easter.month - 1, easter.day - 2));
  const holidays = new Map<string, string>([
    [observedDate(year, 1, 1), "New Year's Day"],
    [localDateKey(year, 1, nthWeekday(year, 1, 1, 3)), "Martin Luther King Jr. Day"],
    [localDateKey(year, 2, nthWeekday(year, 2, 1, 3)), "Washington's Birthday"],
    [localDateKey(year, goodFriday.getUTCMonth() + 1, goodFriday.getUTCDate()), "Good Friday"],
    [localDateKey(year, 5, lastWeekday(year, 5, 1)), "Memorial Day"],
    [observedDate(year, 6, 19), "Juneteenth National Independence Day"],
    [observedDate(year, 7, 4), "Independence Day"],
    [localDateKey(year, 9, nthWeekday(year, 9, 1, 1)), "Labor Day"],
    [localDateKey(year, 11, nthWeekday(year, 11, 4, 4)), "Thanksgiving Day"],
    [observedDate(year, 12, 25), "Christmas Day"]
  ]);
  return holidays.get(key) ?? null;
}

function earlyCloseMinute(year: number, month: number, day: number): number | null {
  const key = localDateKey(year, month, day);
  const thanksgiving = localDateKey(year, 11, nthWeekday(year, 11, 4, 4));
  const dayAfterThanksgiving = new Date(Date.UTC(year, 10, nthWeekday(year, 11, 4, 4) + 1));
  const christmasEve = localDateKey(year, 12, 24);
  if (
    key ===
    localDateKey(
      dayAfterThanksgiving.getUTCFullYear(),
      dayAfterThanksgiving.getUTCMonth() + 1,
      dayAfterThanksgiving.getUTCDate()
    )
  ) {
    return 13 * 60;
  }
  if (key === christmasEve && weekday(year, 12, 24) !== 0 && weekday(year, 12, 24) !== 6)
    return 13 * 60;
  if (weekday(year, 7, 3) !== 0 && weekday(year, 7, 3) !== 6 && observedDate(year, 7, 4) === key)
    return 13 * 60;
  if (thanksgiving === key) return REGULAR_CLOSE_MINUTE;
  return null;
}

function isWeekend(year: number, month: number, day: number): boolean {
  const dayOfWeek = weekday(year, month, day);
  return dayOfWeek === 0 || dayOfWeek === 6;
}

function nextTradingDate(year: number, month: number, day: number): LocalParts {
  let date = new Date(Date.UTC(year, month - 1, day));
  for (let i = 0; i < 370; i += 1) {
    date = new Date(date.getTime() + 86_400_000);
    const nextYear = date.getUTCFullYear();
    const nextMonth = date.getUTCMonth() + 1;
    const nextDay = date.getUTCDate();
    if (
      !isWeekend(nextYear, nextMonth, nextDay) &&
      holidayName(nextYear, nextMonth, nextDay) === null
    ) {
      return { year: nextYear, month: nextMonth, day: nextDay, hour: 0, minute: 0, second: 0 };
    }
  }
  throw new Error("Could not find the next NYSE trading date.");
}

function previousTradingDate(year: number, month: number, day: number): LocalParts {
  let date = new Date(Date.UTC(year, month - 1, day));
  for (let i = 0; i < 370; i += 1) {
    date = new Date(date.getTime() - 86_400_000);
    const previousYear = date.getUTCFullYear();
    const previousMonth = date.getUTCMonth() + 1;
    const previousDay = date.getUTCDate();
    if (
      !isWeekend(previousYear, previousMonth, previousDay) &&
      holidayName(previousYear, previousMonth, previousDay) === null
    ) {
      return {
        year: previousYear,
        month: previousMonth,
        day: previousDay,
        hour: 0,
        minute: 0,
        second: 0
      };
    }
  }
  throw new Error("Could not find the previous NYSE trading date.");
}

function containsHoliday(start: LocalParts, end: LocalParts): boolean {
  let date = new Date(Date.UTC(start.year, start.month - 1, start.day));
  const endMs = Date.UTC(end.year, end.month - 1, end.day);
  while (date.getTime() < endMs) {
    date = new Date(date.getTime() + 86_400_000);
    if (holidayName(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()) !== null) {
      return true;
    }
  }
  return false;
}

function regularBounds(
  year: number,
  month: number,
  day: number
): {
  openMs: number;
  closeMs: number;
  earlyClose: boolean;
} {
  const earlyCloseAt = earlyCloseMinute(year, month, day);
  const closeMinute = earlyCloseAt ?? REGULAR_CLOSE_MINUTE;
  return {
    openMs: localWallClockToMs(year, month, day, 9, 30),
    closeMs: localWallClockToMs(year, month, day, Math.floor(closeMinute / 60), closeMinute % 60),
    earlyClose: earlyCloseAt !== null && earlyCloseAt < REGULAR_CLOSE_MINUTE
  };
}

export function nyseSessionAt(timestampMs: number): TradingSession {
  const local = partsAt(timestampMs);
  const dateKey = localDateKey(local.year, local.month, local.day);
  const holiday = holidayName(local.year, local.month, local.day);
  const weekend = isWeekend(local.year, local.month, local.day);
  const bounds = regularBounds(local.year, local.month, local.day);
  const next = nextTradingDate(local.year, local.month, local.day);
  const nextBounds = regularBounds(next.year, next.month, next.day);
  const minute = local.hour * 60 + local.minute + local.second / 60;

  if (weekend || holiday !== null) {
    return {
      period: "closed",
      isRegular: false,
      sessionDate: dateKey,
      regularOpenMs: bounds.openMs,
      regularCloseMs: bounds.closeMs,
      nextRegularOpenMs: nextBounds.openMs,
      nextRegularCloseMs: nextBounds.closeMs,
      earlyClose: false,
      holiday
    };
  }

  let period: TradingPeriod;
  if (minute >= PREMARKET_MINUTE && timestampMs < bounds.openMs) period = "premarket";
  else if (timestampMs >= bounds.openMs && timestampMs < bounds.closeMs) period = "regular";
  else if (timestampMs >= bounds.closeMs && minute < POSTMARKET_END_MINUTE) period = "postmarket";
  else period = "overnight";

  return {
    period,
    isRegular: period === "regular",
    sessionDate: dateKey,
    regularOpenMs: bounds.openMs,
    regularCloseMs: bounds.closeMs,
    nextRegularOpenMs:
      period === "regular" || period === "postmarket" || period === "overnight"
        ? nextBounds.openMs
        : bounds.openMs,
    nextRegularCloseMs:
      period === "regular" || period === "postmarket" || period === "overnight"
        ? nextBounds.closeMs
        : bounds.closeMs,
    earlyClose: bounds.earlyClose,
    holiday: null
  };
}

export function nextWindow(timestampMs: number): OffHoursWindow {
  const local = partsAt(timestampMs);
  const todayIsTradingDay =
    !isWeekend(local.year, local.month, local.day) &&
    holidayName(local.year, local.month, local.day) === null;
  const todayBounds = regularBounds(local.year, local.month, local.day);
  const start =
    todayIsTradingDay && timestampMs >= todayBounds.openMs
      ? local
      : todayIsTradingDay && timestampMs < todayBounds.openMs
        ? previousTradingDate(local.year, local.month, local.day)
        : previousTradingDate(local.year, local.month, local.day);
  const startBounds = regularBounds(start.year, start.month, start.day);
  const openDate = nextTradingDate(start.year, start.month, start.day);
  const openBounds = regularBounds(openDate.year, openDate.month, openDate.day);
  const daySpan = Math.round(
    (Date.UTC(openDate.year, openDate.month - 1, openDate.day) -
      Date.UTC(start.year, start.month - 1, start.day)) /
      86_400_000
  );
  const kind = containsHoliday(start, openDate) ? "holiday" : daySpan > 1 ? "weekend" : "overnight";
  return { kind, closeTs: startBounds.closeMs, openTs: openBounds.openMs };
}
