// The satellite map: Esri World Imagery on a MapLibre globe, every photo drawn as its own dot by
// WebGL (no clustering), an optional heatmap, hover previews, and click-to-pick.
import maplibregl, {
  type ExpressionSpecification,
  type FilterSpecification,
  type GeoJSONSourceSpecification,
  type Map as MLMap,
  type StyleSpecification,
} from 'maplibre-gl';
import { thumbURL } from './api';
import type { Library, Photo } from './data';
import { fmtShortDate } from './format';
import { photosNear } from './screen';
import { sel } from './selection';
import { loadView, saveView, type Settings } from './settings';
import { ThumbLayer } from './thumbs';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const tiles = (service: string) => [`${ESRI}/${service}/MapServer/tile/{z}/{y}/{x}`];

/** Cool to warm, picked to stay readable on both dark ocean and bright desert imagery. */
export const YEAR_PALETTE = ['#4d8bff', '#2fd0c8', '#9be15d', '#ffd23f', '#ff8a3d', '#ff4f8b'];

/** Pixels around the click point that count as "this spot". */
const PICK_RADIUS = 28;

export class PhotoMap {
  readonly map: MLMap;
  readonly thumbs: ThumbLayer;
  private hover: HTMLElement;
  private hoverId = -1;
  private ready: Promise<void>;

  constructor(
    container: HTMLElement,
    private lib: Library,
    private s: Settings,
    private onPick: (group: Photo[], index: number) => void,
  ) {
    const view = loadView();
    this.map = new maplibregl.Map({
      container,
      style: this.style(),
      center: view?.center ?? [0, 20],
      zoom: view?.zoom ?? 1.6,
      bearing: view?.bearing ?? 0,
      pitch: view?.pitch ?? 0,
      maxZoom: 21,
      maxPitch: 75,
      attributionControl: { compact: true },
      // cmd/ctrl-drag rotates and tilts, like Apple Maps
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

    this.ready = new Promise((res) =>
      this.map.once('style.load', () => {
        this.map.setProjection({ type: this.s.globe ? 'globe' : 'mercator' });
        if (!view) this.fitAll(false);
        res();
      }),
    );

    this.thumbs = new ThumbLayer(this.map, lib.photos, () => this.s, (p) => this.pickPhoto(p));
    this.hover = document.getElementById('hover')!;
    this.bindEvents();
    sel.on(() => this.highlight());
  }

  // ---------- style ----------

  private style(): StyleSpecification {
    const s = this.s;
    const data: GeoJSONSourceSpecification['data'] = {
      type: 'FeatureCollection',
      features: this.lib.photos.map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { i: p.i, y: p.year, v: p.video ? 1 : 0, f: p.fav ? 1 : 0 },
      })),
    };
    const none: FilterSpecification = ['==', ['get', 'i'], -1];
    return {
      version: 8,
      sources: {
        sat: {
          type: 'raster',
          tiles: tiles('World_Imagery'),
          tileSize: 256,
          maxzoom: 19,
          attribution: 'Imagery © <a href="https://www.esri.com" target="_blank" rel="noreferrer">Esri</a>, Maxar, Earthstar Geographics, GIS User Community',
        },
        roads: { type: 'raster', tiles: tiles('Reference/World_Transportation'), tileSize: 256, maxzoom: 19 },
        labels: { type: 'raster', tiles: tiles('Reference/World_Boundaries_and_Places'), tileSize: 256, maxzoom: 19 },
        photos: { type: 'geojson', data, buffer: 64 },
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#02040a' } },
        { id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-fade-duration': 150 } },
        { id: 'roads', type: 'raster', source: 'roads', layout: { visibility: s.roads ? 'visible' : 'none' }, paint: { 'raster-opacity': 0.85 } },
        { id: 'labels', type: 'raster', source: 'labels', layout: { visibility: s.labels ? 'visible' : 'none' } },
        {
          id: 'heat',
          type: 'heatmap',
          source: 'photos',
          layout: { visibility: s.mode === 'heat' ? 'visible' : 'none' },
          filter: this.filter(),
          paint: {
            'heatmap-weight': 1,
            'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 0.6, 10, 2.5],
            'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 6, 6, 16, 11, 28],
            'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0.9, 11, 0],
            'heatmap-color': [
              'interpolate', ['linear'], ['heatmap-density'],
              0, 'rgba(0,0,0,0)', 0.12, '#3b2aa8', 0.32, '#a62fbf', 0.52, '#f0506e', 0.75, '#ff9a3c', 1, '#fff2a8',
            ],
          },
        },
        {
          id: 'group',
          type: 'circle',
          source: 'photos',
          filter: none,
          paint: { 'circle-radius': this.radius(4), 'circle-color': 'rgba(255,255,255,0.12)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.75 },
        },
        {
          id: 'dots',
          type: 'circle',
          source: 'photos',
          filter: this.filter(),
          paint: {
            'circle-radius': this.radius(0),
            'circle-color': this.color(),
            'circle-stroke-color': 'rgba(0,0,0,0.6)',
            'circle-stroke-width': 1,
            'circle-opacity': this.dotOpacity(),
            'circle-stroke-opacity': this.dotOpacity(),
          },
        },
        {
          id: 'selected',
          type: 'circle',
          source: 'photos',
          filter: none,
          paint: { 'circle-radius': this.radius(7), 'circle-color': 'rgba(255,255,255,0.18)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 },
        },
      ],
      sky: { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0] },
    };
  }

  private filter(): FilterSpecification {
    const s = this.s;
    const f: unknown[] = ['all'];
    if (!s.videos) f.push(['==', ['get', 'v'], 0]);
    if (!s.photos) f.push(['==', ['get', 'v'], 1]);
    if (s.favoritesOnly) f.push(['==', ['get', 'f'], 1]);
    if (s.yearFrom != null) f.push(['>=', ['get', 'y'], s.yearFrom]);
    if (s.yearTo != null) f.push(['<=', ['get', 'y'], s.yearTo]);
    return f as FilterSpecification;
  }

  private radius(extra: number): ExpressionSpecification {
    const r = this.s.dotSize;
    return ['interpolate', ['linear'], ['zoom'], 0, r * 0.55 + extra, 6, r * 0.8 + extra, 12, r + extra, 18, r * 1.5 + extra];
  }

  private color(): string | ExpressionSpecification {
    const { minYear, maxYear } = this.lib;
    if (!this.s.colorByYear || maxYear <= minYear) return this.s.color;
    const stops: (number | string)[] = [];
    YEAR_PALETTE.forEach((c, k) => stops.push(minYear + ((maxYear - minYear) * k) / (YEAR_PALETTE.length - 1), c));
    return ['interpolate', ['linear'], ['get', 'y'], ...stops] as ExpressionSpecification;
  }

  private dotOpacity(): number | ExpressionSpecification {
    return this.s.mode === 'heat' ? ['interpolate', ['linear'], ['zoom'], 7.5, 0, 10, 1] : 1;
  }

  /** Re-applies every setting to the live map. Cheap enough to call on any change. */
  async apply(s: Settings) {
    this.s = s;
    await this.ready;
    const m = this.map;
    m.setLayoutProperty('labels', 'visibility', s.labels ? 'visible' : 'none');
    m.setLayoutProperty('roads', 'visibility', s.roads ? 'visible' : 'none');
    m.setLayoutProperty('heat', 'visibility', s.mode === 'heat' ? 'visible' : 'none');
    m.setFilter('heat', this.filter());
    m.setFilter('dots', this.filter());
    m.setPaintProperty('dots', 'circle-radius', this.radius(0));
    m.setPaintProperty('group', 'circle-radius', this.radius(4));
    m.setPaintProperty('selected', 'circle-radius', this.radius(7));
    m.setPaintProperty('dots', 'circle-color', this.color());
    m.setPaintProperty('dots', 'circle-opacity', this.dotOpacity());
    m.setPaintProperty('dots', 'circle-stroke-opacity', this.dotOpacity());
    const proj = s.globe ? 'globe' : 'mercator';
    if (m.getProjection()?.type !== proj) m.setProjection({ type: proj });
    m.getContainer().style.setProperty('--thumb', `${s.thumbSize}px`);
    this.thumbs.schedule();
  }

  // ---------- picking ----------

  private bindEvents() {
    const m = this.map;
    m.getContainer().style.setProperty('--thumb', `${this.s.thumbSize}px`);

    m.on('click', (e) => {
      if ((e.originalEvent.target as HTMLElement | null)?.closest('.thumb, .more-badge')) return;
      if (this.s.mode === 'heat' && m.getZoom() < 8) {
        m.easeTo({ center: e.lngLat, zoom: Math.min(m.getZoom() + 3, 10) });
        return;
      }
      const hit = this.hitTest(e.point.x, e.point.y, 10);
      if (hit) this.pickAt(hit.x, hit.y, hit.p);
    });

    m.on('mousemove', (e) => {
      const target = e.originalEvent.target as HTMLElement | null;
      const overMarker = !!target?.closest('.thumb, .more-badge');
      const hidden = this.s.mode === 'heat' && m.getZoom() < 8.5;
      const hit = overMarker || hidden ? null : this.hitTest(e.point.x, e.point.y, 8);
      m.getCanvas().style.cursor = hit ? 'pointer' : '';
      if (hit) this.showHover(hit.p, e.point.x, e.point.y, hit.count);
      else this.hideHover();
    });
    m.on('mouseout', () => this.hideHover());
    m.on('movestart', () => this.hideHover());

    m.on('moveend', () => {
      const c = m.getCenter();
      saveView({ center: [c.lng, c.lat], zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch() });
    });
  }

  /** The dot closest to a screen point, and how many dots are under it. */
  private hitTest(x: number, y: number, r: number): { p: Photo; x: number; y: number; count: number } | null {
    if (!this.map.getLayer('dots')) return null;
    const feats = this.map.queryRenderedFeatures([[x - r, y - r], [x + r, y + r]], { layers: ['dots'] });
    if (!feats.length) return null;
    let best: { p: Photo; x: number; y: number } | null = null;
    let bestD = Infinity;
    const seen = new Set<number>();
    for (const f of feats) {
      const i = f.properties?.i as number;
      if (seen.has(i)) continue;
      seen.add(i);
      const p = this.lib.photos[i];
      const pt = this.map.project([p.lon, p.lat]);
      const d = (pt.x - x) ** 2 + (pt.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { p, x: pt.x, y: pt.y };
      }
    }
    return best && { ...best, count: seen.size };
  }

  private pickAt(x: number, y: number, clicked: Photo) {
    const group = photosNear(this.map, this.lib.photos, this.s, x, y, PICK_RADIUS);
    if (!group.includes(clicked)) group.unshift(clicked);
    this.hideHover();
    this.onPick(group, group.indexOf(clicked));
  }

  /** Pick a photo by itself (thumbnail click, random photo): gathers whatever else is at that spot. */
  pickPhoto(p: Photo) {
    const pt = this.map.project([p.lon, p.lat]);
    this.pickAt(pt.x, pt.y, p);
  }

  private showHover(p: Photo, x: number, y: number, count: number) {
    const h = this.hover;
    if (this.hoverId !== p.i) {
      this.hoverId = p.i;
      h.innerHTML = `<img src="${thumbURL(p.id)}" alt=""><div class="hv-meta"><span>${fmtShortDate(p.t)}</span>${
        count > 1 ? `<span class="hv-more">+${count - 1} more here</span>` : ''
      }</div>`;
    }
    h.hidden = false;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const w = 168;
    const hh = 150;
    const left = x + 18 + w > W ? x - 18 - w : x + 18;
    const top = Math.min(Math.max(8, y - hh / 2), H - hh - 8);
    h.style.transform = `translate(${left}px, ${top}px)`;
  }

  private hideHover() {
    this.hover.hidden = true;
    this.hoverId = -1;
  }

  // ---------- selection & camera ----------

  private highlight() {
    if (!this.map.getLayer('selected')) return;
    const cur = sel.current;
    this.map.setFilter('selected', ['==', ['get', 'i'], cur ? cur.i : -1]);
    this.map.setFilter('group', ['in', ['get', 'i'], ['literal', sel.group.length > 1 ? sel.group.map((p) => p.i) : []]]);
  }

  /** Pans just enough to keep a photo on screen (and clear of the side panels). */
  reveal(p: Photo, padRight: number, padLeft: number) {
    const pt = this.map.project([p.lon, p.lat]);
    const c = this.map.getCanvas();
    const m = 60;
    if (pt.x < padLeft + m || pt.x > c.clientWidth - padRight - m || pt.y < m || pt.y > c.clientHeight - m) {
      this.map.easeTo({ center: [p.lon, p.lat], offset: [(padLeft - padRight) / 2, 0], duration: 600 });
    }
  }

  flyTo(p: Photo, padRight: number, padLeft: number) {
    this.map.flyTo({
      center: [p.lon, p.lat],
      zoom: Math.max(this.map.getZoom(), 16),
      offset: [(padLeft - padRight) / 2, 0],
      speed: 1.6,
    });
  }

  fitAll(animate = true) {
    const ps = this.lib.photos;
    if (!ps.length) return;
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    for (const p of ps) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
    }
    if (maxLon - minLon > 200) {
      // photos all over the world: show the whole globe, turned toward where most of them are
      const lon = ps.reduce((s, p) => s + p.lon, 0) / ps.length;
      const lat = ps.reduce((s, p) => s + p.lat, 0) / ps.length;
      this.map.jumpTo({ center: [lon, lat], zoom: 1.6 });
      return;
    }
    this.map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 80, maxZoom: 12, animate });
  }

  /** Flies to a random photo (respecting the filters) and opens it. */
  random(passes: (p: Photo) => boolean, padRight: number, padLeft: number) {
    const pool = this.lib.photos.filter(passes);
    if (!pool.length) return;
    const p = pool[Math.floor(Math.random() * pool.length)];
    this.map.flyTo({ center: [p.lon, p.lat], zoom: 16, offset: [(padLeft - padRight) / 2, 0], speed: 1.8 });
    this.map.once('moveend', () => this.pickPhoto(p));
  }
}
