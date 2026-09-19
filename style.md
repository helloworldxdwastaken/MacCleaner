# MacCleaner — Design Style Guide (v3, 2026-09-19)

The UI is a CleanMyMac-inspired light theme: every section page gets its own
full-app gradient wallpaper matching that section's 3D icon color, with white
text and frosted-glass cards. This document is the single source of truth for
the look — follow it when adding screens, icons, or assets.

---

## 1. Page anatomy (identical on every page)

Every tinted page uses the **same skeleton** — same hero position, same sizes,
same paddings, same content stretch:

```
┌────────────────────────────────────────────────────┐
│  [full-app wallpaper: bg-<page>.jpg]               │
│                                                    │
│              ┌──────────────┐                      │
│              │  3D page icon │   ← .page-hero .hi   │
│              └──────────────┘      170×170, centered │
│              Page Title            ← 30px/700      │
│              Tagline (optional)    ← 13.5px, .ph-sub│
│              meta line (optional)  ← 12px, .ph-meta │
│              [green CTA, optional]                 │
│                                                    │
│  ┌ cards below, inside .page-wrap (1180px) ──────┐  │
│  │  frosted glass · 10% white · blur 24px        │  │
│  └───────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────┘
```

### Rules
- **Hero (`.page-hero`)**: flex column, centered, `gap: 10px`,
  `margin: 14px 0 26px`. Icon is `.hi` = **170×170 px** with
  `drop-shadow(0 16px 34px rgba(8,12,30,0.35))`. Title `h1` = **30px / 700 /
  -0.5px letter-spacing**, white. Subtitle `.ph-sub` = 13.5px,
  `max-width: 560px`.
- **Content wrapper (`.page-wrap`)**: `max-width: 1180px; margin: 0 auto;`
  on **every** page — no page invents its own width.
- **Cards** sit directly on the wallpaper (no page-level padding/radius — the
  wallpaper is full-app, not an inset panel).
- **Icon↔page mapping is fixed**: each page shows the icon of its section
  (never the brand logo). Dashboard = teal monitor+check, Smart Scan = green
  broom, Disk Map = violet mosaic, Duplicates = amber twin-photos+ magnifier,
  Performance = magenta lightning, Fans = cyan fan, Uninstaller = red
  app-into-can, Updater = blue tile+down-arrow, Privacy = amber shield.
- Small toolbar icons (16–20px) stay **stroke SVG** (`data-icon` spans);
  3D raster icons are used at **≥20 px** only.

## 2. Wallpaper system (full-app background)

- Assets: `public/assets/bg-<page>.jpg` — AI-rendered soft abstract gradients,
  1600px wide JPEG (≤ ~80 KB each), one per tinted page, color-dominated by
  that page's section color.
- Wiring: `body[data-pagebg="<view>"]::before` paints the wallpaper edge-to-edge
  (fixed, z −1) under a dark readability overlay
  `linear-gradient(rgba(4,8,16,0.08), rgba(4,8,16,0.28))`.
- `switchView()` sets `document.body.dataset.pagebg` for the 9 views in
  `TINTED_VIEWS`; all other surfaces (modals, settings) keep the default
  mint-white blob backdrop (`--canvas-base: #f0f5f2`).
- **Sidebar over wallpaper**: dark frosted glass —
  `rgba(12,14,34,0.34)` + `backdrop-filter: blur(28px) saturate(140%)`,
  white text via scoped `--text-*` overrides and a root-level
  `color: var(--text-1)` re-resolve.

### Per-page color map
| Page | Wallpaper file | Dominant color | Section icon |
|---|---|---|---|
| Dashboard | bg-dashboard.jpg | deep teal-green | icon-dashboard |
| Smart Scan | bg-fastclean.jpg | deep green | icon-smartscan |
| Disk Map | bg-treemap.jpg | deep violet | icon-diskmap |
| Duplicates | bg-duplicates.jpg | deep amber | icon-duplicates |
| Performance | bg-maintenance.jpg | deep magenta-pink | icon-performance |
| Fan Control | bg-fans.jpg | deep cyan-blue | icon-fans |
| Uninstaller | bg-apps.jpg | deep orange-red | icon-uninstaller |
| Updater | bg-updater.jpg | deep blue | icon-updater |
| Privacy | bg-privacy.jpg | deep amber-orange | icon-privacy |

## 3. Frosted glass (cards on wallpaper)

On tinted pages, `.card.glass` becomes:
```css
background: rgba(255,255,255,0.10);          /* 10% white fill */
backdrop-filter: blur(24px) saturate(150%);  /* frosted blur */
border-color: rgba(255,255,255,0.16);        /* white hairline */
box-shadow: 0 10px 30px rgba(8,12,30,0.25), inset 0 1px 0 rgba(255,255,255,0.16);
```
Scoped var overrides do the rest (all values are the SAME on every page):
```css
--text-1: rgba(255,255,255,0.96);  --text-2: rgba(255,255,255,0.74);
--text-3: rgba(255,255,255,0.52);  --hairline: rgba(255,255,255,0.16);
--surface-1: rgba(255,255,255,0.10); --surface-2: rgba(255,255,255,0.14);
--surface-3: rgba(255,255,255,0.22);
```
Inputs/selects: `rgba(255,255,255,0.10)` bg + `rgba(255,255,255,0.24)` border,
white text. Danger buttons: `rgba(255,69,58,0.20)` bg, `#ff8d85` text.

## 4. 3D iconography — two sets

All icons are generated with the image model (`higgsfield` CLI → GPT Image 2),
transparent background, `--background transparent --aspect_ratio 1:1`,
master 2048², then `sips` downscales: `-256` (heroes/empty states) and `-64`
(nav, headers, chips). Masters live in `build/3d-icons/`, web variants in
`public/assets/`.

### 4a. Colored section icons (the set)
Style: **glossy clay/plastic 3D**, chunky rounded shapes, soft specular
highlights, studio key light top-left, ¾ top-down camera, single accent color
family per icon, soft drop shadow, transparent background, no text, no
container tile.

| Icon file | Subject | Color family |
|---|---|---|
| icon-logo | 3D computer + white paint brush | violet #6A5BFF → #3E7BFA → cyan #00C6FB (brand) |
| icon-app-icon | same in macOS squircle | brand gradient (dock icon → build/icon.png) |
| icon-dashboard | monitor, checkmark on screen | teal-green #26D085 → #0EAE8C |
| icon-smartscan | broom + sparkle dust | teal-green |
| icon-diskmap | mosaic treemap blocks | violet #A78BFA → #7C5CFF |
| icon-duplicates | twin photo cards + magnifier | amber #F5C542 → #E8A200 |
| icon-performance | lightning bolt | magenta-pink #F472B6 → #D946EF |
| icon-fans | front-facing fan (ring + 3 blades + hub) | cyan #2BC8F5 → #1E9BE0 |
| icon-uninstaller | app tile dropping into a tin can | orange-red #FF6B4A → #E8452C |
| icon-updater | app tile + bold down arrow | blue #3D9BFF → #2563EB |
| icon-trends | ascending bar chart | indigo #6A7BFF → #4C5BD4 |
| icon-privacy | plain shield, blank face | amber-orange #FFB020 → #F59E0B |
| icon-maintenance | toolbox, lid ajar | pink #EC6BB4 → #C13FD6 |
| icon-activity | wall clock | slate-blue #7C8FA6 → #4A5D75 |
| icon-settings | gear + two slider faders | slate #9BA5B0 → #6B7683 |

Used at: sidebar nav (22px), page heroes (170px), empty states (170px), fans
view header, duplicates gate, updater empty state, app detail empty state.

### 4b. White icons (the tinted-page set)
Same style rules, but **monochrome pure-white plastic** with soft gray shading
— no color accents ever. Used INSIDE tinted pages (card headers, stat-tile
chips) where colored icons would fight the wallpaper.

| Icon file | Subject | Used on |
|---|---|---|
| icon-white-disk | hard drive | Disk usage card header |
| icon-white-thermo | thermometer | Temperature & fans · Fans "Sensors" header |
| icon-white-spark | four-point sparkle | Lifetime impact header |
| icon-white-fan | front-facing fan | Fans "Fans" header |
| icon-trash | trash bin, lid ajar | "Moved to Trash" stat tile |
| icon-junk | sparkle burst (star + two tiny stars) | "Junk items cleaned" stat tile |
| icon-box | app tile lifting out of a box | "Apps uninstalled" stat tile |
| icon-refresh | two circular refresh arrows | "Updates applied" stat tile |

Stat-tile chips use `--tint:#FFFFFF` (subtle white chip behind the white icon).

## 5. Color tokens (non-icon)

- Brand gradient (logo, favicon-era accents): `#6A5BFF → #3E7BFA → #00C6FB`
- Primary CTA green (CleanMyMac-style): `linear-gradient(180deg,#26D085,#0EAE8C)`,
  hover `#2BDA8E→#10BD97`, glow `rgba(14,174,140,0.35)`. The Smart Scan ring
  CTA uses `--fc-green: #0EAE8C`.
- Base chrome (non-tinted pages): canvas `#f0f5f2`, cards white 80% glass,
  hairlines `rgba(10,15,30,0.10)`, text `rgba(10,12,20,.92/.60/.42)`.
- Radii: `--r-lg 22px`, `--r-md 14px`, `--r-sm 10px`. Dashboard ring gradient
  is white (95%→55% alpha) on tinted pages.
- Sidebar (light mode, non-wallpaper): `--surface-1` fill, 16px radius,
  items 13.5px/500.

## 6. Generation recipe (how to make a new icon or wallpaper)

Icon:
```bash
higgsfield generate create gpt_image_2 \
  --prompt "<subject>, 3D glossy clay-style icon, macOS app icon style, chunky rounded shapes, glossy plastic material with soft specular highlights, soft studio key light from top-left, three-quarter top-down camera, single accent color family, saturated clean colors, soft drop shadow beneath, isolated on a fully transparent background, centered composition, no text, no container, no rounded-square tile" \
  --background transparent --aspect_ratio 1:1 --wait --json > /tmp/<name>.json
url=$(python3 -c "import json;print(json.load(open('/tmp/<name>.json'))[0]['result_url'])")
curl -sL "$url" -o build/3d-icons/icon-<name>.png
sips -Z 256 build/3d-icons/icon-<name>.png --out public/assets/icon-<name>-256.png
sips -Z 64  build/3d-icons/icon-<name>.png --out public/assets/icon-<name>-64.png
```
White variant: replace the style tail with "pure white glossy material with
soft gray shading … monochrome white color family only (no color accents)".
Wallpaper: same CLI, `--aspect_ratio 16:9` (opaque), then
`sips -Z 1600 -s format jpeg -s formatOptions 62 → public/assets/bg-<page>.jpg`.

Verify every generated file: `sips -g hasAlpha -g pixelWidth` → `yes`, 2048.

## 7. Do / Don't

- DO keep one accent color family per colored icon; DON'T mix two hues.
- DON'T put colored 3D icons on tinted pages — use the white set.
- DON'T resize the hero icon or change `.page-wrap` per page; they are global.
- DON'T add text to icons; DON'T use containers/tiles except the dock app icon.
- DON'T hardcode white/dark text colors inside tinted pages — use the scoped
  `--text-*` vars so both tinted and plain pages stay correct.
- DON'T forget: any new `/assets/*` URL in `img` tags is token-free
  (express.static); only `fetch` via `api()` needs nothing, raw EventSource/img
  `/api` URLs need `?token=`.
- Tray icon stays a monochrome template image (macOS requirement) — no 3D.
