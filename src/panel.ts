// The photo panel on the right: the selected photo, where and when it was taken, arrows through
// everything at that spot, and a grid of them. It can be tucked off to the side at any moment and
// pulled back with its tab (or P).
import { imageURL, lookupPlace, thumbURL } from './api';
import type { Photo } from './data';
import { escapeHTML, fmtCoord, fmtCount, fmtDate, fmtDuration, fmtTime } from './format';
import { icons } from './icons';
import { sel } from './selection';

const PANEL_IMAGE = 1280;
const GRID_MAX = 3000;

export interface PanelActions {
  onOpenChange: (open: boolean) => void;
  onClose: () => void;
  onFullscreen: () => void;
  onZoom: (p: Photo) => void;
}

export class Panel {
  private root: HTMLElement;
  private q = <T extends HTMLElement>(s: string) => this.root.querySelector<T>(s)!;
  private renderedGroup: Photo[] | null = null;
  private loadToken = 0;
  private placeTimer = 0;
  open: boolean;

  constructor(root: HTMLElement, open: boolean, private actions: PanelActions) {
    this.root = root;
    this.open = open;
    root.innerHTML = `
      <button class="tab" data-act="toggle" title="Show photo (P)">${icons.image}<span class="tab-count"></span></button>
      <div class="card">
        <header class="card-head">
          <div class="head-title"><strong class="pos"></strong><span class="pos-sub"></span></div>
          <button class="icon-btn" data-act="toggle" title="Tuck panel away (P)">${icons.right}</button>
          <button class="icon-btn" data-act="close" title="Close">${icons.close}</button>
        </header>
        <div class="viewer">
          <img class="v-low" alt="">
          <img class="v-full" alt="">
          <div class="v-play">${icons.play}<span class="v-dur"></span></div>
          <div class="v-loading"><span class="spinner"></span><span class="v-loading-text">Loading from iCloud…</span></div>
          <button class="v-nav prev" data-act="prev" title="Previous (←)">${icons.left}</button>
          <button class="v-nav next" data-act="next" title="Next (→)">${icons.right}</button>
        </div>
        <div class="meta">
          <div class="m-date"></div>
          <div class="m-place"><div class="m-place-title"></div><div class="m-place-sub"></div></div>
          <div class="m-coords"></div>
        </div>
        <div class="actions">
          <button class="btn" data-act="fullscreen">${icons.expand}<span>Fullscreen</span></button>
          <button class="btn" data-act="zoom">${icons.target}<span>Zoom to photo</span></button>
        </div>
        <div class="grid-wrap">
          <div class="grid-title"></div>
          <div class="grid"></div>
        </div>
      </div>`;

    root.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-k]');
      if (cell) return sel.go(Number(cell.dataset.k));
      switch (btn?.dataset.act) {
        case 'toggle': return this.setOpen(!this.open);
        case 'close': return this.actions.onClose();
        case 'prev': return sel.step(-1);
        case 'next': return sel.step(1);
        case 'fullscreen': return this.actions.onFullscreen();
        case 'zoom': return sel.current && this.actions.onZoom(sel.current);
      }
    });
    this.q('.viewer').addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('[data-act]')) this.actions.onFullscreen();
    });
    this.sync();
  }

  setOpen(open: boolean) {
    this.open = open;
    this.sync();
    this.actions.onOpenChange(open);
  }

  /** Width the panel covers on screen right now (for keeping photos clear of it). */
  get coverage(): number {
    return sel.current && this.open ? this.root.getBoundingClientRect().width + 12 : 0;
  }

  private sync() {
    const has = !!sel.current;
    this.root.classList.toggle('empty', !has);
    this.root.classList.toggle('collapsed', !this.open);
    document.body.classList.toggle('panel-open', has && this.open);
  }

  render() {
    this.sync();
    const p = sel.current;
    if (!p) {
      this.renderedGroup = null;
      return;
    }
    const n = sel.group.length;
    this.q('.pos').textContent = n > 1 ? `${fmtCount(sel.index + 1)} of ${fmtCount(n)}` : p.video ? 'Video' : 'Photo';
    this.q('.pos-sub').textContent = n > 1 ? 'at this spot' : '';
    this.q('.tab-count').textContent = n > 1 ? fmtCount(n) : '';
    this.root.classList.toggle('multi', n > 1);

    this.showImage(p);

    const d = this.q('.m-date');
    d.innerHTML = `<strong>${escapeHTML(fmtDate(p.t))}</strong><span>${escapeHTML(fmtTime(p.t))}${p.fav ? ` · <span class="fav-label">${icons.heart} Favorite</span>` : ''}</span>`;
    this.q('.m-coords').textContent = fmtCoord(p.lat, p.lon);
    this.loadPlace(p);
    this.renderGrid();
  }

  private showImage(p: Photo) {
    const token = ++this.loadToken;
    const viewer = this.q('.viewer');
    const low = this.q<HTMLImageElement>('.v-low');
    const full = this.q<HTMLImageElement>('.v-full');
    const ratio = p.w && p.h ? Math.min(1.9, Math.max(0.62, p.w / p.h)) : 1.333;
    viewer.style.aspectRatio = String(ratio);
    viewer.classList.toggle('is-video', p.video);
    this.q('.v-dur').textContent = p.video ? fmtDuration(p.dur) : '';
    viewer.classList.remove('loaded', 'slow', 'failed');
    low.src = thumbURL(p.id);
    full.removeAttribute('src');
    const slow = window.setTimeout(() => token === this.loadToken && viewer.classList.add('slow'), 450);
    const img = new Image();
    img.onload = () => {
      if (token !== this.loadToken) return;
      clearTimeout(slow);
      full.src = img.src;
      viewer.classList.add('loaded');
      viewer.classList.remove('slow');
      this.prefetchNeighbours();
    };
    img.onerror = () => {
      if (token !== this.loadToken) return;
      clearTimeout(slow);
      viewer.classList.remove('slow');
      viewer.classList.add('failed');
    };
    img.src = imageURL(p.id, PANEL_IMAGE);
  }

  private prefetchNeighbours() {
    const n = sel.group.length;
    if (n < 2) return;
    for (const d of [1, -1]) {
      const q = sel.group[(sel.index + d + n) % n];
      new Image().src = imageURL(q.id, PANEL_IMAGE);
    }
  }

  private loadPlace(p: Photo) {
    const title = this.q('.m-place-title');
    const sub = this.q('.m-place-sub');
    title.textContent = '';
    sub.textContent = '';
    this.q('.m-place').classList.add('pending');
    clearTimeout(this.placeTimer);
    // wait a moment so arrowing quickly through photos doesn't flood Apple's geocoder
    this.placeTimer = window.setTimeout(async () => {
      const r = await lookupPlace(p.lat, p.lon);
      if (sel.current !== p) return;
      this.q('.m-place').classList.remove('pending');
      title.textContent = r.title ?? '';
      sub.textContent = r.subtitle ?? '';
    }, 300);
  }

  private renderGrid() {
    const grid = this.q('.grid');
    const n = sel.group.length;
    if (this.renderedGroup !== sel.group) {
      this.renderedGroup = sel.group;
      if (n > 1) {
        const shown = sel.group.slice(0, GRID_MAX);
        this.q('.grid-title').textContent = `${fmtCount(n)} ${sel.group.every((q) => q.video) ? 'videos' : 'photos'} here, oldest first${n > GRID_MAX ? ` (first ${fmtCount(GRID_MAX)} shown)` : ''}`;
        grid.innerHTML = shown
          .map(
            (q, k) =>
              `<button class="cell" data-k="${k}" title="${escapeHTML(fmtDate(q.t))}"><img loading="lazy" decoding="async" alt="" src="${thumbURL(q.id)}">${
                q.video ? `<span class="cell-vid">${icons.play}</span>` : ''
              }</button>`,
          )
          .join('');
      } else {
        grid.innerHTML = '';
      }
    }
    grid.querySelector('.cell.current')?.classList.remove('current');
    const cur = grid.querySelector<HTMLElement>(`.cell[data-k="${sel.index}"]`);
    if (cur) {
      cur.classList.add('current');
      cur.scrollIntoView({ block: 'nearest' });
    }
  }
}
