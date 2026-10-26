import type { YearData } from '../types/music';
import { fetchAppJson, onPathsUpdated } from './dataStore';
export * from './musicQueries';
const yearCache: Record<string, YearData> = {};
export async function loadYearData(year: string): Promise<YearData> {
  return yearCache[year] ??= await fetchAppJson<YearData>(`/data/year-${year}.json`);
}
export async function loadYearsData(years: string[]): Promise<void> {
  await Promise.all(years.map(loadYearData));
}
onPathsUpdated([/^\/data\/year-\d+\.json$/], () => {
  for (const year of Object.keys(yearCache)) delete yearCache[year];
});
