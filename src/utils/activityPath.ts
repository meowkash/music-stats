/**
 * Geometry for the Dashboard's listening-activity path.
 *
 * The card is a single chart: a smoothed gradient curve of daily plays, an
 * average reference line, and a marked peak day. Everything else the eye
 * doesn't need (raw columns, typical-range band, stat readouts) is gone, so the
 * two annotations carry the story on their own.
 */
import type { YearlyTotals } from '../types/music';

export interface ActivityDay {
  date: string;
  plays: number;
}

export interface ActivitySeries {
  days: ActivityDay[];
  peak: { index: number; day: ActivityDay } | null;
  /** Longest run of consecutive listening days *within the selected range*. */
  longestStreak: number;
  activeDays: number;
  total: number;
  dailyAverage: number;
}

const DAY_MS = 86_400_000;

function toDateString(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * yearly-totals is keyed by year with day-of-year indexed arrays, so walking
 * back N days means stitching across the year boundary.
 */
export function lastNDays(totals: YearlyTotals, count: number, endTime = Date.now()): ActivityDay[] {
  const end = Date.UTC(
    new Date(endTime).getUTCFullYear(),
    new Date(endTime).getUTCMonth(),
    new Date(endTime).getUTCDate(),
  );

  const days: ActivityDay[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const time = end - i * DAY_MS;
    const date = new Date(time);
    const year = date.getUTCFullYear();
    const startOfYear = Date.UTC(year, 0, 1);
    const dayIndex = Math.round((time - startOfYear) / DAY_MS);
    const yearData = totals[String(year)];
    const plays = yearData?.[dayIndex] ?? 0;
    days.push({ date: toDateString(time), plays });
  }
  return days;
}

export function buildActivitySeries(totals: YearlyTotals, count: number, endTime = Date.now()): ActivitySeries {
  const days = lastNDays(totals, count, endTime);
  const values = days.map((d) => d.plays);

  let peakIndex = -1;
  for (let i = 0; i < values.length; i++) {
    if (peakIndex === -1 || values[i] > values[peakIndex]) peakIndex = i;
  }

  let longestStreak = 0;
  let run = 0;
  for (const value of values) {
    run = value > 0 ? run + 1 : 0;
    if (run > longestStreak) longestStreak = run;
  }

  const total = values.reduce((a, b) => a + b, 0);
  const activeDays = values.filter((v) => v > 0).length;

  return {
    days,
    peak: peakIndex >= 0 && values[peakIndex] > 0 ? { index: peakIndex, day: days[peakIndex] } : null,
    longestStreak,
    activeDays,
    total,
    dailyAverage: days.length ? Math.round((total / days.length) * 10) / 10 : 0,
  };
}

export interface PathGeometry {
  width: number;
  height: number;
  /** Smooth curve through the daily plays. */
  line: string;
  /** Same curve closed to the baseline, for the area fill. */
  area: string;
  /** Plot inset — room for Y-axis labels on the left. */
  plot: { left: number; top: number; right: number; bottom: number };
  /** Horizontal grid + Y-axis tick labels (matches Statistics chart styling). */
  yTicks: Array<{ y: number; label: string }>;
  /** Average reference line, plus where to hang its label. */
  averageLine: {
    y: number;
    x1: number;
    x2: number;
    value: number;
    labelX: number;
    labelY: number;
    anchor: 'start' | 'end' | 'middle';
  };
  peak: {
    x: number;
    y: number;
    plays: number;
    label: string;
    labelX: number;
    labelY: number;
    anchor: 'start' | 'end' | 'middle';
  } | null;
  ticks: Array<{ x: number; label: string }>;
}

const MONTH_INITIALS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Dates are UTC day keys; parsing them any other way shifts the labels a day. */
function parseDay(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

/**
 * Within a week the weekday is the useful handle ("Tuesday"); over longer
 * ranges the calendar date is.
 */
function describeDay(date: string, count: number): string {
  const d = parseDay(date);
  return count <= 7 ? WEEKDAYS[d.getUTCDay()] : `${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/**
 * Catmull-Rom through the points, converted to cubic béziers, with control
 * points clamped into the plot box. Without the clamp a spike sends the curve
 * overshooting past the baseline and the chart appears to dip below zero.
 */
function smoothPath(points: Array<{ x: number; y: number }>, top: number, bottom: number): string {
  if (points.length < 2) return points.length ? `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}` : '';

  const clamp = (y: number) => Math.min(bottom, Math.max(top, y));

  let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;

    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = clamp(p1.y + (p2.y - p0.y) / 6);
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = clamp(p2.y - (p3.y - p1.y) / 6);

    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

/** Bottom-axis labels, at a density that suits the span being shown. */
function buildTicks(days: ActivityDay[], xAt: (index: number) => number): Array<{ x: number; label: string }> {
  const ticks: Array<{ x: number; label: string }> = [];

  if (days.length <= 7) {
    days.forEach((day, i) => {
      ticks.push({ x: xAt(i), label: WEEKDAY_INITIALS[parseDay(day.date).getUTCDay()] });
    });
    return ticks;
  }

  if (days.length <= 31) {
    // Anchored to the end so "today" always gets a label.
    for (let i = days.length - 1; i >= 0; i -= 7) {
      const d = parseDay(days[i].date);
      ticks.unshift({ x: xAt(i), label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}` });
    }
    return ticks;
  }

  let lastMonth = -1;
  days.forEach((day, i) => {
    const month = parseDay(day.date).getUTCMonth();
    if (month !== lastMonth) {
      lastMonth = month;
      ticks.push({ x: xAt(i), label: MONTH_INITIALS[month] });
    }
  });
  return ticks;
}

/** Round up to a human-friendly axis maximum (2000, 5000, 10000, …). */
function niceAxisMax(value: number): number {
  if (value <= 0) return 10;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const nice =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

function buildYTicks(scaleMax: number, toY: (value: number) => number): Array<{ y: number; label: string }> {
  const steps = scaleMax <= 20 ? 4 : 5;
  const ticks: Array<{ y: number; label: string }> = [];
  for (let i = 0; i <= steps; i++) {
    const value = (scaleMax * i) / steps;
    const label = Number.isInteger(value) ? String(value) : value.toLocaleString(undefined, { maximumFractionDigits: 1 });
    ticks.push({ y: toY(value), label });
  }
  return ticks;
}

export function buildPathGeometry(
  series: ActivitySeries,
  width = 720,
  height = 190,
): PathGeometry {
  const { days, dailyAverage } = series;
  // Headroom at the top for the peak callout, room at the bottom for the axis.
  const padTop = 30;
  const padBottom = 22;
  const padLeft = 42;
  const padRight = 10;
  const plotHeight = height - padTop - padBottom;
  const plotWidth = Math.max(1, width - padLeft - padRight);
  const baseline = height - padBottom;

  const maxPlays = Math.max(...days.map((d) => d.plays), 1);
  const scaleMax = niceAxisMax(Math.max(maxPlays * 1.15, 1));

  const toY = (value: number) => padTop + plotHeight * (1 - Math.min(value / scaleMax, 1));
  const step = days.length > 1 ? plotWidth / (days.length - 1) : 0;
  const xAt = (index: number) => padLeft + index * step;

  const points = days.map((day, i) => ({ x: xAt(i), y: toY(day.plays) }));
  const line = smoothPath(points, padTop, baseline);
  const area = points.length
    ? `${line} L ${(width - padRight).toFixed(2)} ${baseline.toFixed(2)} L ${padLeft.toFixed(2)} ${baseline.toFixed(2)} Z`
    : '';

  const averageY = toY(dailyAverage);

  let peak: PathGeometry['peak'] = null;
  if (series.peak) {
    const x = xAt(series.peak.index);
    const y = toY(series.peak.day.plays);
    // Anchor the callout away from whichever edge it is nearest, so a peak on
    // day one or today still renders its full text inside the box.
    const anchor: 'start' | 'end' | 'middle' =
      x < width * 0.3 ? 'start' : x > width * 0.7 ? 'end' : 'middle';
    peak = {
      x,
      y,
      plays: series.peak.day.plays,
      label: `Peak of ${series.peak.day.plays} plays on ${describeDay(series.peak.day.date, days.length)}`,
      labelX: anchor === 'start' ? Math.max(x - 6, 2) : anchor === 'end' ? Math.min(x + 6, width - 2) : x,
      labelY: y - 14,
      anchor,
    };
  }

  // Hunt for the stretch of the average line the curve stays farthest from,
  // so the label can sit right on the line without the curve cutting through
  // its text. `avgLabel` is an estimate of the rendered text's pixel width
  // (rough, but good enough to size the search window).
  const avgLabelText = `${dailyAverage} Daily Plays on Average`;
  const avgLabelWidth = avgLabelText.length * 6.3;
  const radiusIdx = step > 0 ? Math.max(1, Math.round(avgLabelWidth / 2 / step)) : 0;
  const peakMargin = peak ? avgLabelWidth : 0;

  let bestIndex = 0;
  let bestScore = -Infinity;
  let bestDiff = 0;
  for (let i = 0; i < points.length; i++) {
    let clearance = Infinity;
    let diffSum = 0;
    let diffCount = 0;
    for (let j = Math.max(0, i - radiusIdx); j <= Math.min(points.length - 1, i + radiusIdx); j++) {
      const diff = points[j].y - averageY;
      clearance = Math.min(clearance, Math.abs(diff));
      diffSum += diff;
      diffCount++;
    }
    const nearPeak = peak && Math.abs(points[i].x - peak.x) < peakMargin;
    const score = clearance - (nearPeak ? clearance * 0.6 : 0);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
      bestDiff = diffCount ? diffSum / diffCount : 0;
    }
  }

  const bestX = points[bestIndex]?.x ?? (padLeft + width - padRight) / 2;
  const avgAnchor: 'start' | 'end' | 'middle' =
    bestX < width * 0.3 ? 'start' : bestX > width * 0.7 ? 'end' : 'middle';
  // The curve mostly sits below the line here (fewer plays), so the label
  // tucks in above it; otherwise it drops underneath.
  const labelAbove = bestDiff >= 0;
  const avgLabelY = labelAbove
    ? Math.max(averageY - 7, padTop + 9)
    : Math.min(averageY + 15, baseline - 3);

  return {
    width,
    height,
    line,
    area,
    plot: { left: padLeft, top: padTop, right: width - padRight, bottom: baseline },
    yTicks: buildYTicks(scaleMax, toY),
    averageLine: {
      y: averageY,
      x1: padLeft,
      x2: width - padRight,
      value: dailyAverage,
      labelX: avgAnchor === 'start' ? Math.max(bestX, padLeft + 2) : avgAnchor === 'end' ? Math.min(bestX, width - padRight - 2) : bestX,
      labelY: avgLabelY,
      anchor: avgAnchor,
    },
    peak,
    ticks: buildTicks(days, xAt),
  };
}
