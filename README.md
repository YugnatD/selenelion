# Selenelion

Plan **where to stand** for a solar or lunar eclipse.

A *selenelion* is the rare sight of an eclipsed Moon and the Sun at once, each just above an
opposite horizon — possible only because refraction lifts both bodies slightly above where the
geometry says they should be. Horizons, where you happen to be standing on Earth, and both bodies
at once: that is what this tool is about.

Most eclipse tools answer *when*. This one answers *where*, by crossing the astronomy with the
real world you would be standing in:

- **Terrain obstruction** — a horizon profile ray-cast from elevation tiles, per point and across
  the whole viewport, so you can see whether a ridge hides the eclipse from a given spot. A clear
  sky is worth nothing behind a mountain.
- **Solar and lunar** — solar eclipses from Besselian elements; lunar eclipses computed from Sun
  and Moon ephemerides, with a per-point answer to "is the Moon even up here?".
- **Cloud climatology** — 23 years of ERA5 (2001–2023) as static tiles: *the odds* of clear sky at
  this place at this time of year. Deliberately not a forecast — for a date months or years out,
  the statistics are the only honest answer, and anyone travelling next week will check a real
  forecast anyway.
- **Quality score** — terrain × weather × duration-at-totality combined into one map, to answer
  "of the places I could reach, which is actually best?".
- **3D view** — the terrain and the eclipsed body from the observer's eye, in Three.js.
- **PDF export** — every map view at a much finer grid resolution than the interactive one, as
  vector contours.

Fully static: no backend, no accounts, no API keys. English by default, French available.

## Getting started

```bash
npm install
npm run dev
```

Vite serves the app locally — see the terminal output for the URL.

### Climatology data

The weather views need roughly 800 MB of climatology tiles under `public/climatology` and
`public/climatology-hourly`. These are **not** tracked in git — generate them with:

```bash
npm run build:climatology
```

Everything else (eclipse computation, maps, terrain obstruction, 3D, PDF export) works without
them; only the weather views stay empty.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Type-check (`tsc -b`) then production build |
| `npm run preview` | Preview the production build locally |
| `npm run test` | Test suite (Vitest) |
| `npm run typecheck` | Type-check only, no build |
| `npm run lint` | Lint (Oxlint) |
| `npm run build:climatology` | Generate the climatology tiles under `public/climatology*` |

## Data sources

- Solar eclipse circumstances — [`@astronomy-bundle`](https://github.com/nerdyharry/astronomy-bundle),
  from Besselian elements (Espenak/NASA GSFC conventions)
- Elevation — AWS Terrain Tiles (Terrarium, SRTM/GMTED derived)
- Base map — [OpenFreeMap](https://openfreemap.org/) vector tiles (OpenStreetMap data)
- Cloud cover — ERA5 reanalysis via [Open-Meteo](https://open-meteo.com/)'s public archive
