// Talks to the Photos helper through the dev server at /__photos (see vite-photos-bridge.ts).
const BASE = '/__photos';

export class BridgeError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(BASE + path);
  let body: unknown = null;
  try {
    body = await r.json();
  } catch {
    /* not JSON */
  }
  if (!r.ok) throw new BridgeError((body as { error?: string } | null)?.error ?? `HTTP ${r.status}`, r.status);
  return body as T;
}

const q = encodeURIComponent;
/** One thumbnail size everywhere so the browser cache serves markers, hover cards and grids alike. */
export const thumbURL = (id: string) => `${BASE}/thumb?id=${q(id)}&s=256`;
export const imageURL = (id: string, max: number) => `${BASE}/image?id=${q(id)}&max=${max}`;
export const videoURL = (id: string) => `${BASE}/video?id=${q(id)}`;

export interface Place {
  title?: string;
  subtitle?: string;
  error?: string;
}

const places = new Map<string, Promise<Place>>();

export function lookupPlace(lat: number, lon: number): Promise<Place> {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  let p = places.get(key);
  if (!p) {
    p = getJSON<Place>(`/place?lat=${lat}&lon=${lon}`).then(
      (r) => {
        if (r.error) places.delete(key); // rate-limited or skipped: try again next time
        return r;
      },
      (e: Error) => {
        places.delete(key);
        return { error: e.message };
      },
    );
    places.set(key, p);
  }
  return p;
}
