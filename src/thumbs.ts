// Thumbnail markers. When you are zoomed in (or in Thumbnails mode) every photo on screen becomes a
// small picture. Photos taken at (almost) the same spot are fanned out in a sunflower spiral around
// that spot, each with a thin line back to where it was taken, so nothing hides under anything else.
import maplibregl, { type Map as MLMap } from 'maplibre-gl';
import { thumbURL } from './api';
import type { Photo } from './data';
import { fmtDuration } from './format';
import { icons } from './icons';
import { photosOnScreen, type OnScreen } from './screen';
import { sel } from './selection';
import type { Settings } from './settings';

/** Most thumbnails on screen at once. Photos beyond this stay visible as dots. */
const CAP = 400;
/** Most photos fanned out around one spot; the rest are behind a "+N" badge. */
const SPIRAL_MAX = 60;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

interface Entry {
  marker: maplibregl.Marker;
  el: HTMLElement;
  line: HTMLElement;
  img: HTMLImageElement;
  p: Photo;
}

interface Placed {
  p: Photo;
  ox: number;
  oy: number;
}

interface Badge {
  at: Photo;
  ox: number;
  oy: number;
  count: number;
}

export class ThumbLayer {
  private entries = new Map<number, Entry>();
  private badges: maplibregl.Marker[] = [];
  private raf = 0;

  constructor(
    private map: MLMap,
    private photos: Photo[],
    private settings: () => Settings,
    private onPick: (p: Photo) => void,
  ) {
    map.on('load', () => this.schedule());
    map.on('moveend', () => this.schedule());
    map.on('resize', () => this.schedule());
    sel.on(() => this.markSelected());
  }

  active(): boolean {
    const s = this.settings();
    return s.mode === 'thumbs' || this.map.getZoom() >= s.thumbZoom;
  }

  schedule() {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.update());
  }

  private update() {
    if (!this.active()) return this.clear();
    const size = this.settings().thumbSize;
    const onScreen = photosOnScreen(this.map, this.photos, this.settings(), size / 2);
    const chosen = onScreen.length > CAP ? sample(onScreen, CAP, size) : onScreen;
    const { placed, badges } = layout(chosen, size);

    const next = new Map<number, Entry>();
    for (const pl of placed) {
      let e = this.entries.get(pl.p.i);
      if (e) this.entries.delete(pl.p.i);
      else e = this.create(pl.p);
      e.marker.setOffset([pl.ox, pl.oy]);
      setLeader(e.line, pl.ox, pl.oy);
      next.set(pl.p.i, e);
    }
    for (const e of this.entries.values()) this.destroy(e);
    this.entries = next;

    this.badges.forEach((b) => b.remove());
    this.badges = badges.map((b) => {
      const el = document.createElement('button');
      el.className = 'more-badge';
      el.textContent = `+${b.count}`;
      el.title = `${b.count} more photos here. Click to see them all.`;
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.onPick(b.at);
      });
      return new maplibregl.Marker({ element: el, anchor: 'center', offset: [b.ox, b.oy] }).setLngLat([b.at.lon, b.at.lat]).addTo(this.map);
    });
    this.markSelected();
  }

  private create(p: Photo): Entry {
    const el = document.createElement('div');
    el.className = 'thumb';
    el.innerHTML =
      `<div class="leader"></div><div class="tile"><img alt="" decoding="async" draggable="false">` +
      (p.video ? `<span class="vid">${icons.play}${fmtDuration(p.dur)}</span>` : '') +
      (p.fav ? `<span class="fav">${icons.heart}</span>` : '') +
      `</div>`;
    const img = el.querySelector('img')!;
    img.src = thumbURL(p.id);
    img.addEventListener('error', () => el.classList.add('broken'), { once: true });
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.onPick(p);
    });
    const marker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([p.lon, p.lat]).addTo(this.map);
    return { marker, el, line: el.querySelector('.leader')!, img, p };
  }

  private destroy(e: Entry) {
    e.img.removeAttribute('src'); // cancels the download if it is still running
    e.marker.remove();
  }

  clear() {
    for (const e of this.entries.values()) this.destroy(e);
    this.entries.clear();
    this.badges.forEach((b) => b.remove());
    this.badges = [];
  }

  private markSelected() {
    const cur = sel.current?.i;
    const inGroup = new Set(sel.group.map((p) => p.i));
    for (const e of this.entries.values()) {
      e.el.classList.toggle('sel', e.p.i === cur);
      e.el.classList.toggle('in-group', e.p.i !== cur && inGroup.has(e.p.i));
    }
  }
}

function setLeader(line: HTMLElement, ox: number, oy: number) {
  const len = Math.hypot(ox, oy);
  if (len < 2) {
    line.style.display = 'none';
    return;
  }
  line.style.display = '';
  line.style.width = `${len}px`;
  line.style.transform = `rotate(${Math.atan2(-oy, -ox)}rad)`;
}

/**
 * Too many photos for thumbnails: pick an even spread across the screen. Each screen cell
 * contributes its favourites and newest photos first, round-robin, so every area gets pictures.
 */
function sample(all: OnScreen[], cap: number, size: number): OnScreen[] {
  const cell = size * 0.9;
  const buckets = new Map<string, OnScreen[]>();
  for (const o of all) {
    const k = `${Math.floor(o.x / cell)},${Math.floor(o.y / cell)}`;
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = []));
    b.push(o);
  }
  const lists = [...buckets.values()];
  for (const l of lists) l.sort((a, b) => Number(b.p.fav) - Number(a.p.fav) || b.p.t - a.p.t);
  // a stable but scattered order, so the picks don't all come from one corner and don't reshuffle on every pan
  const key = (l: OnScreen[]) => (Math.imul(l[0].p.i + 1, 2654435761) >>> 0);
  lists.sort((a, b) => key(a) - key(b));
  const out: OnScreen[] = [];
  for (let round = 0; out.length < cap; round++) {
    let any = false;
    for (const l of lists) {
      if (round >= l.length) continue;
      any = true;
      out.push(l[round]);
      if (out.length >= cap) break;
    }
    if (!any) break;
  }
  return out;
}

/** Groups photos that land on (nearly) the same pixel and fans each group out in a spiral. */
function layout(items: OnScreen[], size: number): { placed: Placed[]; badges: Badge[] } {
  const d = size * 0.35;
  const d2 = d * d;
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const grid = new Map<string, number[]>();
  items.forEach((o, i) => {
    const cx = Math.floor(o.x / d);
    const cy = Math.floor(o.y / d);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          const q = items[j];
          if ((q.x - o.x) ** 2 + (q.y - o.y) ** 2 <= d2) parent[find(i)] = find(j);
        }
      }
    }
    const k = `${cx},${cy}`;
    const cell = grid.get(k);
    if (cell) cell.push(i);
    else grid.set(k, [i]);
  });

  const groups = new Map<number, OnScreen[]>();
  items.forEach((o, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(o);
    else groups.set(r, [o]);
  });

  const placed: Placed[] = [];
  const badges: Badge[] = [];
  const spacing = size * 0.75;
  for (const g of groups.values()) {
    if (g.length === 1) {
      placed.push({ p: g[0].p, ox: 0, oy: 0 });
      continue;
    }
    g.sort((a, b) => a.p.t - b.p.t);
    const cx = g.reduce((s, o) => s + o.x, 0) / g.length;
    const cy = g.reduce((s, o) => s + o.y, 0) / g.length;
    const shown = g.slice(0, SPIRAL_MAX);
    shown.forEach((o, k) => {
      const r = spacing * Math.sqrt(k + 0.5);
      const a = k * GOLDEN - Math.PI / 2;
      placed.push({ p: o.p, ox: cx + r * Math.cos(a) - o.x, oy: cy + r * Math.sin(a) - o.y });
    });
    if (g.length > shown.length) badges.push({ at: g[0].p, ox: cx - g[0].x, oy: cy - g[0].y, count: g.length - shown.length });
  }
  return { placed, badges };
}
