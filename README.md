# PhotoX

A satellite map of the world with every photo and video from your Apple Photos library pinned where you took it. Unlike the Places map in Photos, nothing gets merged into groups: every photo keeps its own dot at every zoom level. Zoom in and the dots become thumbnails. Photos taken at the same spot fan out in a spiral, each with a thin line back to where it was taken.

Everything runs on your Mac. Your photos are never uploaded. Only the satellite imagery comes from the internet (Esri World Imagery).

## Run it

```bash
cd ~/Projects/Personal/PhotoX
npm install        # first time only
npm run dev        # opens http://localhost:5179
```

The first time, click **Allow access to Photos** and choose **Allow Full Access** when macOS asks about “PhotoX Photos”. To change that later, go to System Settings → Privacy & Security → Photos.

## Using it

- **Click a dot or thumbnail** to open the photo panel on the right. It shows the photo, the date and time, the place name, and every other photo at that spot. Click the photo (or press **F**) for fullscreen. Videos play there.
- **Tuck the panels away** at any time with the arrow in their header, or press **P** (photo panel), **O** (options) or **H** (both). A small tab stays at the screen edge to bring each one back.
- **Hover** a dot for a quick preview.
- **← / →** step through the photos at the selected spot. **⌘-drag** rotates and tilts the map.

### Options (left panel)

| Option | What it does |
|---|---|
| Display: **Dots** (default) | Every photo is a dot. At the zoom you choose (default 14) they turn into thumbnails. |
| Display: **Thumbnails** | Thumbnails at every zoom. Up to 400 on screen at once, spread evenly across the view. The rest stay dots. |
| Display: **Heatmap** | A heatmap when zoomed out that fades into dots, then thumbnails, as you zoom in. Clicking the heatmap zooms in. |
| Thumbnail size, dot size, color | Make them as big or small as you like. **Color by year** shades dots from blue (oldest) to pink (newest). |
| Show | Photos, videos, favorites only, and a year range. |
| Map | 3D globe or flat map, place names and borders, roads. |
| Random photo / Show all photos | Fly somewhere random in your library, or zoom out to fit everything. |

Settings and the last map position are remembered between visits.

## How it works

Web pages can't read the Photos library, so `npm run dev` first builds a small helper app, `helper/build/PhotoX Photos.app`, from [helper/PhotosBridge.swift](helper/PhotosBridge.swift). It uses Apple's PhotoKit, so photos stored only in iCloud work too: Photos downloads them when you open one. Map thumbnails come from the small previews Photos already keeps on your Mac, so they load quickly even when the originals are in iCloud. The helper runs in the background with no Dock icon, listens only on 127.0.0.1, needs a secret token that only the dev server knows, and quits after 30 idle minutes. The Vite server ([vite-photos-bridge.ts](vite-photos-bridge.ts)) starts it when needed and forwards `/__photos/*` to it.

| Piece | File |
|---|---|
| Photos access, image and video serving, place names | [helper/PhotosBridge.swift](helper/PhotosBridge.swift) |
| Map, layers, hover, click | [src/photomap.ts](src/photomap.ts) |
| Thumbnails and the spiral fan-out | [src/thumbs.ts](src/thumbs.ts) |
| Photo panel / fullscreen viewer | [src/panel.ts](src/panel.ts), [src/lightbox.ts](src/lightbox.ts) |
| Options panel | [src/options.ts](src/options.ts) |

- Locations come from PhotoKit (`PHAsset.location`), which includes any locations you corrected in Photos. Items without a location are counted in the options panel but can't be placed on the map.
- Place names come from Apple's reverse geocoder, and only for the photo you're looking at.
- Videos are copied once to `~/Library/Caches/PhotoX/videos` so the browser can seek in them. Copies unused for two weeks are deleted automatically.
- Building the helper needs the Xcode command line tools (`xcode-select --install`).
