import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { BridgeError, getJSON } from './api';
import { loadLibrary, passes, type Library } from './data';
import { fmtCount } from './format';
import { Lightbox } from './lightbox';
import { Options } from './options';
import { Panel } from './panel';
import { PhotoMap } from './photomap';
import { sel } from './selection';
import { loadSettings, saveSettings, type Settings } from './settings';

const boot = document.getElementById('boot')!;
const bootMsg = boot.querySelector<HTMLElement>('.boot-msg')!;
const bootExtra = boot.querySelector<HTMLElement>('.boot-extra')!;

function say(msg: string, extra = '') {
  bootMsg.textContent = msg;
  bootExtra.innerHTML = extra;
}

type Status = { auth: string; version: number };

async function connect(): Promise<Library | null> {
  let st: Status;
  try {
    st = await getJSON<Status>('/status');
  } catch (e) {
    const msg = e instanceof BridgeError && e.status === 501 ? e.message : 'Could not reach the Photos helper.';
    say(msg, `<p class="boot-hint">Stop the server and run <code>npm run dev</code> again. It builds the helper with the Xcode command line tools.</p>`);
    return null;
  }

  if (st.auth === 'notDetermined') {
    say('PhotoX needs to read your Photos library.', `<button class="btn primary" id="allow">Allow access to Photos</button>
      <p class="boot-hint">macOS will ask whether “PhotoX Photos” may access your photos. Choose <b>Allow Full Access</b>. Nothing leaves your Mac.</p>`);
    await new Promise<void>((res) => document.getElementById('allow')!.addEventListener('click', () => res(), { once: true }));
    say('Waiting for you to answer the macOS prompt…');
    st = await getJSON<Status>('/authorize');
  }

  if (st.auth !== 'authorized' && st.auth !== 'limited') {
    say('PhotoX doesn’t have access to your photos.', `<p class="boot-hint">Open <b>System Settings → Privacy &amp; Security → Photos</b>, turn on <b>PhotoX Photos</b> (Full Access), then reload this page.</p>
      <button class="btn" onclick="location.reload()">Reload</button>`);
    return null;
  }

  const started = performance.now();
  const tick = window.setInterval(() => say(`Reading photo locations… ${Math.round((performance.now() - started) / 1000)}s`), 1000);
  say('Reading photo locations…');
  try {
    return await loadLibrary();
  } catch (e) {
    say('Could not read your library.', `<p class="boot-hint">${(e as Error).message}</p><button class="btn" onclick="location.reload()">Try again</button>`);
    return null;
  } finally {
    clearInterval(tick);
  }
}

function start(lib: Library) {
  let settings: Settings = loadSettings();
  const filtered = () => lib.photos.filter((p) => passes(p, settings)).length;

  const pmap = new PhotoMap(document.getElementById('map')!, lib, settings, (group, index) => {
    sel.set(group, index);
    if (settings.autoOpen && !panel.open) panel.setOpen(true);
  });

  const panel = new Panel(document.getElementById('panel')!, settings.panelOpen, {
    onOpenChange: (open) => persist({ panelOpen: open }),
    onClose: () => sel.clear(),
    onFullscreen: () => lightbox.open(),
    onZoom: (p) => pmap.flyTo(p, panel.coverage, options.coverage),
  });

  const lightbox = new Lightbox(document.getElementById('lightbox')!);

  const options = new Options(document.getElementById('options')!, settings, lib, {
    onChange: (s) => {
      // the panel open states are owned here, not by the options panel
      persist({ ...s, panelOpen: settings.panelOpen, optionsOpen: settings.optionsOpen });
      pmap.apply(settings);
      options.setVisibleCount(filtered());
      // drop photos from the selection that the new filters hide
      if (sel.group.length) {
        const keep = sel.group.filter((p) => passes(p, settings));
        if (keep.length !== sel.group.length) {
          const cur = sel.current;
          keep.length ? sel.set(keep, Math.max(0, cur ? keep.indexOf(cur) : 0)) : sel.clear();
        }
      }
    },
    onOpenChange: (open) => persist({ optionsOpen: open }),
    onRandom: () => pmap.random((p) => passes(p, settings), panelWidthIfOpen(), options.coverage),
    onFitAll: () => pmap.fitAll(),
  });
  options.setVisibleCount(filtered());

  function persist(patch: Partial<Settings>) {
    settings = { ...settings, ...patch };
    saveSettings(settings);
  }

  /** The panel's width as it will be once a photo is open (for flying to a random photo). */
  function panelWidthIfOpen() {
    return settings.autoOpen || panel.open ? Math.min(400, window.innerWidth * 0.4) : 0;
  }

  sel.on(() => {
    panel.render();
    const p = sel.current;
    if (p && !lightbox.isOpen) pmap.reveal(p, panel.coverage, options.coverage);
  });

  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, select') && !(t as HTMLInputElement).type?.match(/checkbox|color/)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case 'Escape':
        if (lightbox.isOpen) lightbox.close();
        break;
      case 'ArrowLeft':
        if (sel.group.length > 1) { sel.step(-1); e.preventDefault(); }
        break;
      case 'ArrowRight':
        if (sel.group.length > 1) { sel.step(1); e.preventDefault(); }
        break;
      case 'f':
      case 'Enter':
        if (sel.current) lightbox.isOpen ? lightbox.close() : lightbox.open();
        break;
      case 'o':
        options.setOpen(!options.open);
        break;
      case 'p':
        if (sel.current) panel.setOpen(!panel.open);
        break;
      case 'h': {
        const hide = options.open || (panel.open && !!sel.current);
        options.setOpen(!hide);
        if (sel.current) panel.setOpen(!hide);
        break;
      }
    }
  });

  boot.classList.add('done');
  setTimeout(() => boot.remove(), 600);
}

connect().then((lib) => {
  if (!lib) return;
  if (!lib.photos.length) {
    say(`None of your ${fmtCount(lib.total)} photos and videos have a location.`, `<p class="boot-hint">Location is saved when Location Services is on for the Camera app.</p>`);
    return;
  }
  start(lib);
});
