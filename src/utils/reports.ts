import type { YearlyTotals } from '../types/music';
import type { RecapIndexEntry } from './recapStories';

export type ReportRange = 'week' | 'month' | 'year';

export interface ReportBucket {
  label: string;
  current: number;
  previous: number;
}

export interface ReportView {
  range: ReportRange;
  offset: number;
  start: number;
  end: number;
  rangeLabel: string;
  compareLabel: string;
  thisLabel: string;
  lastLabel: string;
  currentTotal: number;
  previousTotal: number;
  deltaPct: number | null;
  previousPeak: number;
  buckets: ReportBucket[];
  avgDaily: number;
  prevAvgDaily: number;
  hours: number;
  prevHours: number;
  percentile: number;
  canPrev: boolean;
  canNext: boolean;
}

const DAY_MS = 86_400_000;
const WEEKDAY = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LABEL = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DEFAULT_MINUTES_PER_PLAY = 3.5;

function utcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function playsOn(totals: YearlyTotals, dayStart: number): number {
  const d = new Date(dayStart);
  const year = d.getUTCFullYear();
  const dayIndex = Math.round((dayStart - Date.UTC(year, 0, 1)) / DAY_MS);
  return totals[String(year)]?.[dayIndex] ?? 0;
}

function sumRange(totals: YearlyTotals, start: number, end: number): number {
  let total = 0;
  for (let t = start; t < end; t += DAY_MS) total += playsOn(totals, t);
  return total;
}

function minutesPerPlay(year: number, recaps: RecapIndexEntry[]): number {
  const entry = recaps.find((r) => r.year === year);
  if (!entry?.scrobbles) return DEFAULT_MINUTES_PER_PLAY;
  return entry.minutes / entry.scrobbles;
}

function hoursInRange(totals: YearlyTotals, recaps: RecapIndexEntry[], start: number, end: number): number {
  let minutes = 0;
  for (let t = start; t < end; t += DAY_MS) {
    const year = new Date(t).getUTCFullYear();
    minutes += playsOn(totals, t) * minutesPerPlay(year, recaps);
  }
  return minutes / 60;
}

function earliestDay(totals: YearlyTotals): number {
  const years = Object.keys(totals)
    .map(Number)
    .sort((a, b) => a - b);
  if (!years.length) return utcDay(Date.now());
  const year = years[0];
  const arr = totals[String(year)] ?? [];
  const idx = arr.findIndex((v) => v > 0);
  return Date.UTC(year, 0, 1) + Math.max(idx, 0) * DAY_MS;
}

export function periodBounds(range: ReportRange, offset: number, now = Date.now()): [number, number] {
  const today = utcDay(now);
  if (range === 'week') {
    const dow = new Date(today).getUTCDay();
    const mondayDelta = dow === 0 ? -6 : 1 - dow;
    const start = today + mondayDelta * DAY_MS - offset * 7 * DAY_MS;
    return [start, start + 7 * DAY_MS];
  }
  if (range === 'month') {
    const d = new Date(today);
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - offset, 1);
    const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - offset + 1, 1);
    return [start, end];
  }
  const year = new Date(today).getUTCFullYear() - offset;
  return [Date.UTC(year, 0, 1), Date.UTC(year + 1, 0, 1)];
}

function formatRange(range: ReportRange, start: number, end: number): string {
  const last = end - DAY_MS;
  const a = new Date(start);
  const b = new Date(last);
  if (range === 'year') return String(a.getUTCFullYear());
  if (range === 'month') return `${MONTH_SHORT[a.getUTCMonth()]} ${a.getUTCFullYear()}`;
  if (a.getUTCMonth() === b.getUTCMonth()) {
    return `${a.getUTCDate()} ${MONTH_SHORT[a.getUTCMonth()]} – ${b.getUTCDate()} ${MONTH_SHORT[b.getUTCMonth()]}`;
  }
  return `${a.getUTCDate()} ${MONTH_SHORT[a.getUTCMonth()]} – ${b.getUTCDate()} ${MONTH_SHORT[b.getUTCMonth()]}`;
}

function compareLabel(range: ReportRange): string {
  return range === 'week' ? 'last week' : range === 'month' ? 'last month' : 'last year';
}

function thisLabel(range: ReportRange): string {
  return range === 'week' ? 'This week' : range === 'month' ? 'This month' : 'This year';
}

function lastLabel(range: ReportRange): string {
  return range === 'week' ? 'Last week' : range === 'month' ? 'Last month' : 'Last year';
}

function dayCount(start: number, end: number): number {
  return Math.max(1, Math.round((end - start) / DAY_MS));
}

function bucketsFor(
  range: ReportRange,
  totals: YearlyTotals,
  current: [number, number],
  previous: [number, number],
): ReportBucket[] {
  const [c0, c1] = current;
  const [p0, p1] = previous;

  if (range === 'year') {
    const year = new Date(c0).getUTCFullYear();
    const prevYear = new Date(p0).getUTCFullYear();
    return MONTH_LABEL.map((label, month) => ({
      label,
      current: sumRange(totals, Date.UTC(year, month, 1), Date.UTC(year, month + 1, 1)),
      previous: sumRange(totals, Date.UTC(prevYear, month, 1), Date.UTC(prevYear, month + 1, 1)),
    }));
  }

  const currentDays: number[] = [];
  for (let t = c0; t < c1; t += DAY_MS) currentDays.push(t);

  return currentDays.map((t, i) => {
    const d = new Date(t);
    const prevT = p0 + i * DAY_MS;
    const label =
      range === 'week' ? WEEKDAY[d.getUTCDay()] : String(d.getUTCDate());
    return {
      label,
      current: playsOn(totals, t),
      previous: prevT < p1 ? playsOn(totals, prevT) : 0,
    };
  });
}

function allPeriodTotals(totals: YearlyTotals, range: ReportRange, now: number): number[] {
  const first = earliestDay(totals);
  const values: number[] = [];
  for (let offset = 0; ; offset++) {
    const [start, end] = periodBounds(range, offset, now);
    if (end <= first) break;
    values.push(sumRange(totals, start, end));
    if (offset > 800) break;
  }
  return values;
}

export function buildReport(
  totals: YearlyTotals,
  recaps: RecapIndexEntry[],
  range: ReportRange,
  offset: number,
  now = Date.now(),
): ReportView {
  const first = earliestDay(totals);
  const current = periodBounds(range, offset, now);
  const previous = periodBounds(range, offset + 1, now);
  const currentTotal = sumRange(totals, current[0], current[1]);
  const previousTotal = sumRange(totals, previous[0], previous[1]);
  const days = dayCount(current[0], current[1]);
  const prevDays = dayCount(previous[0], previous[1]);
  const history = allPeriodTotals(totals, range, now);
  const previousPeak = history.length ? Math.max(...history) : currentTotal;
  const below = history.filter((v) => v < currentTotal).length;
  const percentile = history.length > 1 ? Math.round((below / (history.length - 1)) * 100) : 50;
  const deltaPct =
    previousTotal > 0 ? Math.round(((currentTotal - previousTotal) / previousTotal) * 100) : null;

  const canNext = offset > 0;
  const canPrev = previous[1] > first;

  return {
    range,
    offset,
    start: current[0],
    end: current[1],
    rangeLabel: formatRange(range, current[0], current[1]),
    compareLabel: compareLabel(range),
    thisLabel: thisLabel(range),
    lastLabel: lastLabel(range),
    currentTotal,
    previousTotal,
    deltaPct,
    previousPeak,
    buckets: bucketsFor(range, totals, current, previous),
    avgDaily: Math.round((currentTotal / days) * 10) / 10,
    prevAvgDaily: Math.round((previousTotal / prevDays) * 10) / 10,
    hours: Math.round(hoursInRange(totals, recaps, current[0], current[1]) * 10) / 10,
    prevHours: Math.round(hoursInRange(totals, recaps, previous[0], previous[1]) * 10) / 10,
    percentile,
    canPrev,
    canNext,
  };
}

export function rangeNoun(range: ReportRange): string {
  return range === 'week' ? 'weeks' : range === 'month' ? 'months' : 'years';
}
