// The options panel on the left: display mode, dot and thumbnail look, filters, map layers. Every
// change applies immediately and is remembered. It tucks away like the photo panel (O).
import type { Library } from './data';
import { fmtCount } from './format';
import { icons } from './icons';
import { YEAR_PALETTE } from './photomap';
import type { Mode, Settings } from './settings';

export interface OptionsActions {
  onChange: (s: Settings) => void;
  onOpenChange: (open: boolean) => void;
  onRandom: () => void;
  onFitAll: () => void;
}

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'dots', label: 'Dots', hint: 'Every photo is its own dot. Zoom in and they turn into thumbnails.' },
  { id: 'thumbs', label: 'Thumbnails', hint: 'Photos show as thumbnails at every zoom (up to 400 on screen, the rest stay dots).' },
  { id: 'heat', label: 'Heatmap', hint: 'A heatmap when zoomed out, dots and thumbnails as you zoom in.' },
];

const SIZES = [
  { v: 40, label: 'S' },
  { v: 56, label: 'M' },
  { v: 80, label: 'L' },
];

export class Options {
  private root: HTMLElement;
  private q = <T extends HTMLElement>(s: string) => this.root.querySelector<T>(s)!;
  open: boolean;

  constructor(root: HTMLElement, private s: Settings, private lib: Library, private actions: OptionsActions) {
    this.root = root;
    this.open = s.optionsOpen;
    const shown = lib.photos.length;
    const { minYear, maxYear } = lib;
    const oneYear = minYear === maxYear;
    root.innerHTML = `
      <button class="tab" data-act="toggle" title="Show options (O)">${icons.sliders}</button>
      <div class="card">
        <header class="card-head">
          <div class="head-title brand"><span class="logo">${icons.globe}</span><strong>PhotoX</strong></div>
          <button class="icon-btn" data-act="toggle" title="Tuck panel away (O)">${icons.left}</button>
        </header>
        <div class="scroll">
          <p class="stats"><strong>${fmtCount(shown)}</strong> on the map${
            lib.missing ? ` · <span title="These photos and videos have no location, so they can't be placed.">${fmtCount(lib.missing)} without location</span>` : ''
          }<br><span class="stats-visible"></span></p>

          <section>
            <h3>Display</h3>
            <div class="seg" data-k="mode">${MODES.map((m) => `<button data-v="${m.id}">${m.label}</button>`).join('')}</div>
            <p class="hint mode-hint"></p>
          </section>

          <section>
            <h3>Thumbnails</h3>
            <label class="row slider thumbzoom">
              <span>Appear at zoom</span>
              <input type="range" min="6" max="19" step="1" data-k="thumbZoom">
              <output></output>
            </label>
            <div class="row">
              <span>Size</span>
              <div class="seg small" data-k="thumbSize">${SIZES.map((z) => `<button data-v="${z.v}">${z.label}</button>`).join('')}</div>
            </div>
          </section>

          <section>
            <h3>Dots</h3>
            <label class="row slider">
              <span>Size</span>
              <input type="range" min="2" max="12" step="0.5" data-k="dotSize">
              <output></output>
            </label>
            <label class="row">
              <span>Color</span>
              <input type="color" data-k="color">
            </label>
            <label class="row check ${oneYear ? 'disabled' : ''}">
              <input type="checkbox" data-k="colorByYear" ${oneYear ? 'disabled' : ''}>
              <span>Color by year</span>
            </label>
            <div class="legend" ${oneYear ? 'hidden' : ''}>
              <div class="legend-bar" style="background:linear-gradient(90deg,${YEAR_PALETTE.join(',')})"></div>
              <div class="legend-ends"><span>${minYear}</span><span>${maxYear}</span></div>
            </div>
          </section>

          <section>
            <h3>Show</h3>
            <label class="row check"><input type="checkbox" data-k="photos"><span>Photos</span></label>
            <label class="row check"><input type="checkbox" data-k="videos"><span>Videos</span></label>
            <label class="row check"><input type="checkbox" data-k="favoritesOnly"><span>Favorites only</span></label>
            <label class="row slider ${oneYear ? 'disabled' : ''}">
              <span>From</span>
              <input type="range" min="${minYear}" max="${maxYear}" step="1" data-k="yearFrom" ${oneYear ? 'disabled' : ''}>
              <output></output>
            </label>
            <label class="row slider ${oneYear ? 'disabled' : ''}">
              <span>To</span>
              <input type="range" min="${minYear}" max="${maxYear}" step="1" data-k="yearTo" ${oneYear ? 'disabled' : ''}>
              <output></output>
            </label>
          </section>

          <section>
            <h3>Map</h3>
            <label class="row check"><input type="checkbox" data-k="globe"><span>3D globe</span></label>
            <label class="row check"><input type="checkbox" data-k="labels"><span>Place names and borders</span></label>
            <label class="row check"><input type="checkbox" data-k="roads"><span>Roads</span></label>
            <label class="row check"><input type="checkbox" data-k="autoOpen"><span>Open the photo panel when I click a photo</span></label>
          </section>

          <section class="buttons">
            <button class="btn" data-act="random">${icons.shuffle}<span>Random photo</span></button>
            <button class="btn" data-act="fit">${icons.globe}<span>Show all photos</span></button>
          </section>

          <section class="keys">
            <h3>Keys</h3>
            <dl>
              <dt>O</dt><dd>options panel</dd>
              <dt>P</dt><dd>photo panel</dd>
              <dt>H</dt><dd>hide all panels</dd>
              <dt>← →</dt><dd>previous / next photo here</dd>
              <dt>F / Enter</dt><dd>fullscreen</dd>
              <dt>Esc</dt><dd>close fullscreen</dd>
              <dt>⌘ drag</dt><dd>rotate and tilt the map</dd>
            </dl>
          </section>
        </div>
      </div>`;

    root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const seg = t.closest<HTMLElement>('.seg button');
      if (seg) {
        const k = seg.parentElement!.dataset.k as 'mode' | 'thumbSize';
        const v = seg.dataset.v!;
        this.set(k === 'mode' ? { mode: v as Mode } : { thumbSize: Number(v) });
        return;
      }
      switch (t.closest<HTMLElement>('[data-act]')?.dataset.act) {
        case 'toggle': return this.setOpen(!this.open);
        case 'random': return this.actions.onRandom();
        case 'fit': return this.actions.onFitAll();
      }
    });

    root.addEventListener('input', (e) => {
      const el = e.target as HTMLInputElement;
      const k = el.dataset.k as keyof Settings | undefined;
      if (!k) return;
      if (el.type === 'checkbox') return this.set({ [k]: el.checked } as Partial<Settings>);
      if (el.type === 'color') return this.set({ color: el.value });
      const v = Number(el.value);
      if (k === 'yearFrom') {
        // the ends of the slider mean "no limit", so new photos from future years still show up
        const to = this.s.yearTo ?? maxYear;
        const from = Math.min(v, to);
        return this.set({ yearFrom: from <= minYear ? null : from });
      }
      if (k === 'yearTo') {
        const from = this.s.yearFrom ?? minYear;
        const to = Math.max(v, from);
        return this.set({ yearTo: to >= maxYear ? null : to });
      }
      this.set({ [k]: v } as Partial<Settings>);
    });

    this.sync();
  }

  private set(patch: Partial<Settings>) {
    this.s = { ...this.s, ...patch };
    this.sync();
    this.actions.onChange(this.s);
  }

  setOpen(open: boolean) {
    this.open = open;
    this.s = { ...this.s, optionsOpen: open };
    this.sync();
    this.actions.onOpenChange(open);
  }

  get coverage(): number {
    return this.open ? this.root.getBoundingClientRect().width + 12 : 0;
  }

  /** Shows how many photos the current filters leave on the map. */
  setVisibleCount(n: number) {
    const total = this.lib.photos.length;
    this.q('.stats-visible').textContent = n === total ? '' : `${fmtCount(n)} match your filters`;
  }

  private sync() {
    const s = this.s;
    const { minYear, maxYear } = this.lib;
    this.root.classList.toggle('collapsed', !this.open);
    document.body.classList.toggle('options-open', this.open);
    this.root.querySelectorAll<HTMLElement>('.seg').forEach((seg) => {
      const cur = String(s[seg.dataset.k as 'mode' | 'thumbSize']);
      seg.querySelectorAll<HTMLElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.v === cur));
    });
    this.q('.mode-hint').textContent = MODES.find((m) => m.id === s.mode)!.hint;
    this.q('.thumbzoom').classList.toggle('disabled', s.mode === 'thumbs');
    this.q<HTMLInputElement>('[data-k="thumbZoom"]').disabled = s.mode === 'thumbs';
    this.root.querySelectorAll<HTMLInputElement>('input[data-k]').forEach((el) => {
      const k = el.dataset.k as keyof Settings;
      if (el.type === 'checkbox') el.checked = Boolean(s[k]);
      else if (k === 'yearFrom') el.value = String(s.yearFrom ?? minYear);
      else if (k === 'yearTo') el.value = String(s.yearTo ?? maxYear);
      else el.value = String(s[k]);
      const out = el.parentElement?.querySelector('output');
      if (out) out.textContent = el.value;
    });
    this.q('.legend').classList.toggle('dim', !s.colorByYear);
  }
}
