// Fullscreen viewer. Shows the photo at screen resolution (downloaded from iCloud if needed) or plays
// the video. Arrow keys move through the photos at the selected spot.
import { imageURL, lookupPlace, videoURL } from './api';
import { escapeHTML, fmtCount, fmtDate, fmtTime } from './format';
import { icons } from './icons';
import { sel } from './selection';

export class Lightbox {
  private root: HTMLElement;
  private q = <T extends HTMLElement>(s: string) => this.root.querySelector<T>(s)!;
  private token = 0;
  isOpen = false;

  constructor(root: HTMLElement) {
    this.root = root;
    root.innerHTML = `
      <div class="lb-stage">
        <img class="lb-low" alt="">
        <img class="lb-img" alt="">
        <video class="lb-video" controls playsinline></video>
        <div class="lb-loading"><span class="spinner"></span><span class="lb-loading-text"></span></div>
      </div>
      <button class="lb-btn lb-close" data-act="close" title="Close (Esc)">${icons.close}</button>
      <button class="lb-btn lb-nav prev" data-act="prev" title="Previous (←)">${icons.left}</button>
      <button class="lb-btn lb-nav next" data-act="next" title="Next (→)">${icons.right}</button>
      <div class="lb-info"><span class="lb-date"></span><span class="lb-place"></span><span class="lb-pos"></span></div>`;
    root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'close') return this.close();
      if (act === 'prev') return sel.step(-1);
      if (act === 'next') return sel.step(1);
      if (t.classList.contains('lb-stage')) this.close(); // click on the dark background
    });
    sel.on(() => this.isOpen && (sel.current ? this.render() : this.close()));
  }

  open() {
    if (!sel.current) return;
    this.isOpen = true;
    this.root.hidden = false;
    this.render();
  }

  close() {
    this.isOpen = false;
    this.root.hidden = true;
    const v = this.q<HTMLVideoElement>('.lb-video');
    v.pause();
    v.removeAttribute('src');
    v.load();
    this.q<HTMLImageElement>('.lb-img').removeAttribute('src');
  }

  private render() {
    const p = sel.current;
    if (!p) return;
    const token = ++this.token;
    const stage = this.q('.lb-stage');
    const low = this.q<HTMLImageElement>('.lb-low');
    const img = this.q<HTMLImageElement>('.lb-img');
    const video = this.q<HTMLVideoElement>('.lb-video');
    const loadingText = this.q('.lb-loading-text');
    stage.classList.remove('loaded', 'failed', 'slow');
    stage.classList.toggle('is-video', p.video);
    this.root.classList.toggle('multi', sel.group.length > 1);

    // the panel's 1280px copy is usually cached already and shows instantly while the big one loads
    low.src = imageURL(p.id, 1280);
    img.removeAttribute('src');
    video.pause();
    video.removeAttribute('src');
    const slow = window.setTimeout(() => token === this.token && stage.classList.add('slow'), 400);
    const done = (ok: boolean) => {
      if (token !== this.token) return;
      clearTimeout(slow);
      stage.classList.remove('slow');
      stage.classList.add(ok ? 'loaded' : 'failed');
    };

    if (p.video) {
      loadingText.textContent = 'Downloading video from iCloud…';
      video.poster = imageURL(p.id, 1280);
      video.oncanplay = () => done(true);
      video.onerror = () => done(false);
      video.src = videoURL(p.id);
      video.play().catch(() => {
        /* autoplay can be refused; the controls are there */
      });
    } else {
      loadingText.textContent = 'Loading full resolution from iCloud…';
      const max = Math.min(4096, Math.ceil(Math.max(window.innerWidth, window.innerHeight) * (window.devicePixelRatio || 1)));
      const pre = new Image();
      pre.onload = () => {
        if (token !== this.token) return;
        img.src = pre.src;
        done(true);
      };
      pre.onerror = () => done(false);
      pre.src = imageURL(p.id, max);
    }

    const n = sel.group.length;
    this.q('.lb-date').textContent = `${fmtDate(p.t)} · ${fmtTime(p.t)}`;
    this.q('.lb-pos').textContent = n > 1 ? `${fmtCount(sel.index + 1)} / ${fmtCount(n)}` : '';
    const place = this.q('.lb-place');
    place.textContent = '';
    lookupPlace(p.lat, p.lon).then((r) => {
      if (sel.current === p && r.title) place.innerHTML = escapeHTML([r.title, r.subtitle].filter(Boolean).join(', '));
    });
  }
}
