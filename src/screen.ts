import type { Map as MLMap } from 'maplibre-gl';
import { passes, type Photo } from './data';
import type { Settings } from './settings';

export interface OnScreen {
  p: Photo;
  x: number;
  y: number;
}

const RAD = Math.PI / 180;

/** Angle in degrees between two points on the sphere. */
function arc(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const a =
    Math.sin(((lat2 - lat1) * RAD) / 2) ** 2 +
    Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(((lon2 - lon1) * RAD) / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(a)))) / RAD;
}

/**
 * Every photo that passes the filters and sits on screen (plus `margin` px), with its pixel
 * position. On a zoomed-out globe, points on the far side are skipped.
 */
export function photosOnScreen(map: MLMap, photos: Photo[], s: Settings, margin = 0): OnScreen[] {
  const c = map.getCanvas();
  const W = c.clientWidth;
  const H = c.clientHeight;
  const zoom = map.getZoom();
  const globe = s.globe && zoom < 7;
  // visible cap shrinks as you zoom in; generous near the horizon so nothing pops at the edges
  const maxArc = globe ? Math.min(82, 25 + 60 / Math.max(0.5, zoom)) : 180;
  const center = map.getCenter();
  const out: OnScreen[] = [];
  for (const p of photos) {
    if (!passes(p, s)) continue;
    if (globe && arc(center.lat, center.lng, p.lat, p.lon) > maxArc) continue;
    const pt = map.project([p.lon, p.lat]);
    if (pt.x < -margin || pt.y < -margin || pt.x > W + margin || pt.y > H + margin) continue;
    out.push({ p, x: pt.x, y: pt.y });
  }
  return out;
}

/** Photos within `radius` px of a screen point, oldest first. */
export function photosNear(map: MLMap, photos: Photo[], s: Settings, x: number, y: number, radius: number): Photo[] {
  const r2 = radius * radius;
  return photosOnScreen(map, photos, s, radius)
    .filter((o) => (o.x - x) ** 2 + (o.y - y) ** 2 <= r2)
    .map((o) => o.p)
    .sort((a, b) => a.t - b.t);
}
