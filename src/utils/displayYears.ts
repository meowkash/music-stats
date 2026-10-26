import type { YearlyTotals } from '../types/music';

/** Plays before 2023 came from a one-off bulk import and are inflated, so
 *  graphs and stories start here. The data files keep every year. */
export const FIRST_DISPLAY_YEAR = 2023;

export function isDisplayYear(year: string | number): boolean {
  return Number(year) >= FIRST_DISPLAY_YEAR;
}

export function displayYearlyTotals(totals: YearlyTotals): YearlyTotals {
  return Object.fromEntries(Object.entries(totals).filter(([year]) => isDisplayYear(year)));
}
