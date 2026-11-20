import { getJSON } from './api';
import type { Settings } from './settings';

export interface Photo {
  /** index into the library array, also the map feature's `i` property */
  i: number;
  id: string;
  lat: number;
  lon: number;
  /** capture time, ms since epoch */
  t: number;
  year: number;
  video: boolean;
  fav: boolean;
  w: number;
  h: number;
  /** video length in seconds */
  dur: number;
}

export interface Library {
  photos: Photo[];
  total: number;
  missing: number;
  minYear: number;
  maxYear: number;
}

type Row = [string, number, number, number, number, number, number, number, number];

export async function loadLibrary(): Promise<Library> {
  const d = await getJSON<{ total: number; missing: number; assets: Row[] }>('/locations');
  let minYear = Infinity;
  let maxYear = -Infinity;
  const photos = d.assets.map((r, i): Photo => {
    const year = new Date(r[3]).getFullYear();
    if (year < minYear) minYear = year;
    if (year > maxYear) maxYear = year;
    return { i, id: r[0], lat: r[1], lon: r[2], t: r[3], year, video: r[4] === 1, fav: r[5] === 1, w: r[6], h: r[7], dur: r[8] };
  });
  const now = new Date().getFullYear();
  return {
    photos,
    total: d.total,
    missing: d.missing,
    minYear: Number.isFinite(minYear) ? minYear : now,
    maxYear: Number.isFinite(maxYear) ? maxYear : now,
  };
}

/** The same filter the map layers apply, for code that walks the photo list itself. */
export function passes(p: Photo, s: Settings): boolean {
  if (p.video ? !s.videos : !s.photos) return false;
  if (s.favoritesOnly && !p.fav) return false;
  if (s.yearFrom != null && p.year < s.yearFrom) return false;
  if (s.yearTo != null && p.year > s.yearTo) return false;
  return true;
}
