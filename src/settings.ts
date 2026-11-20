export type Mode = 'dots' | 'thumbs' | 'heat';

export interface Settings {
  mode: Mode;
  color: string;
  colorByYear: boolean;
  /** dot radius in px at mid zoom */
  dotSize: number;
  /** zoom level where dots turn into thumbnails (Dots and Heatmap modes) */
  thumbZoom: number;
  /** thumbnail edge in px */
  thumbSize: number;
  labels: boolean;
  roads: boolean;
  globe: boolean;
  photos: boolean;
  videos: boolean;
  favoritesOnly: boolean;
  /** null = no lower / upper bound */
  yearFrom: number | null;
  yearTo: number | null;
  autoOpen: boolean;
  optionsOpen: boolean;
  panelOpen: boolean;
}

export const defaults: Settings = {
  mode: 'dots',
  color: '#ffcc33',
  colorByYear: false,
  dotSize: 5,
  thumbZoom: 14,
  thumbSize: 56,
  labels: true,
  roads: false,
  globe: true,
  photos: true,
  videos: true,
  favoritesOnly: false,
  yearFrom: null,
  yearTo: null,
  autoOpen: true,
  optionsOpen: true,
  panelOpen: true,
};

const KEY = 'photox.settings.v1';
const VIEW_KEY = 'photox.view.v1';

export function loadSettings(): Settings {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...defaults };
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private window or storage blocked: settings just won't stick */
  }
}

export interface View {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
}

export function loadView(): View | null {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null');
    return v && Array.isArray(v.center) && typeof v.zoom === 'number' ? v : null;
  } catch {
    return null;
  }
}

export function saveView(v: View) {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}
