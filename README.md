# Home HTML Dev

A dependency-light static homepage generator for a local home dashboard.
The site uses vanilla HTML, CSS, JavaScript, and a small Python 3 generator.

## Current features

- Localized clock, weekday, and date.
- Weather for configured US ZIP codes:
  - Current temperature, humidity, and wind.
  - Forecast condition, daily high, and daily low.
- Monthly calendar with previous, next, and today controls.
- Task list with optional ISO due dates, persisted checkbox state, and overdue
  indicators.
- Market quotes and percentage changes for configured ticker symbols.
- Nextcloud/Linode CPU and network charts for 1-hour and 12-hour windows.
- Embedded map iframe.
- Pending News card ready for a future FreshRSS connection.
- Responsive dark dashboard with frosted-glass cards and themed background images.

### Layout

- Left sidebar: weather, calendar, then Markets.
- Center column: Linode statistics, then the map.
- Right sidebar: Tasks, then News.

## How it works

[`generate.py`](generate.py) validates [`meta.yml`](meta.yml), reads optional
credentials from `.env`, renders the selected Jinja template, and writes
`index.html`. The generated file can be opened directly in a browser; no local
web server is required.

The page loads:

- [`static/styles.css`](static/styles.css)
- The consolidated [`static/main.js`](static/main.js) browser bundle
- Images from `static/`

All live data is fetched in the browser so the generated page remains a static
artifact. The single classic JavaScript bundle is intentionally compatible with
opening the page through `file://`.

## Data sources

| Widget | Source | Credentials |
| --- | --- | --- |
| Weather | National Weather Service and Zippopotam | None |
| Markets | Unofficial CNBC quote endpoint | None |
| Server statistics | Linode instance stats API | Read-only token and instance ID |
| News | FreshRSS-compatible RSS/Atom feed | Pending; feed URL planned |
| Map | URL configured in `meta.yml` | Depends on embedded service |

The page checks due sources once per minute. Each section has an independent
`refresh_minutes` interval and is cached in browser `localStorage`. Successful
cached values remain visible with a stale badge if a later refresh fails.
Task completion state is also stored in `localStorage` on the current device.

Weather, market, feed, and Linode browser requests require suitable CORS
headers. The unofficial CNBC endpoint may change without notice.

## Requirements

- Python 3
- Packages pinned in [`requirements.txt`](requirements.txt)
- A browser with current `localStorage`, `fetch`, and DOM APIs

## Setup

Create or activate a Python virtual environment, install the pinned packages,
and create the local environment file:

```sh
python -m venv venv
# Windows PowerShell:
venv\Scripts\Activate.ps1
# Linux/macOS:
source venv/bin/activate

python -m pip install -r requirements.txt
cp example_env .env
```

Fill in only the settings you use:

```dotenv
LINODE_RO_API=read_only_token
LINODE_COMPUTE_ID=numeric_instance_id
```

## Configuration

Edit [`meta.yml`](meta.yml) to control:

- `template`: currently `standard.html`
- `title`, `favicon`, `header_img`, and `background_img`
- `refresh_minutes` for weather, markets, RSS, and Linode
- `weather` ZIP codes as a list or mapping
- `fin_stock` ticker symbols as a list or mapping
- `map.title` and `map.url`
- `tasks` as strings or mappings with `title`, `due`, and `done`
- Reserved RSS settings under `rss.feeds` and `rss.max_items`

Quote ZIP codes that begin with `0`. YAML can otherwise interpret them as
integers. Market symbols and the Linode instance ID are validated during
generation. Template names and local asset paths are restricted to expected
locations.

## Generate

```sh
python generate.py
```

This validates configuration and creates `index.html`, overwriting it only
when generated content changes. Regenerate after changing `meta.yml`, `.env`,
a template, or generator code. Open the generated file directly in a browser.

Generation events and validation errors are written to `latest.log`.

## Security notes

- `index.html` is git-ignored because it may contain the Linode read-only API
  token in its embedded JSON configuration.
- `generate.py` refuses to embed credentials if `index.html` is tracked by Git.
- Keep `.env` local, never share the generated page publicly, and use a
  least-privilege read-only Linode token.
- Rendered API content uses `textContent` and controlled DOM attributes rather
  than injected HTML.
- Feed and map URLs are validated as absolute HTTP(S) URLs; iframe content uses
  a sandbox policy.
- The embedded map provider must allow framing and is responsible for the
  accessibility and security of its own iframe content.

## Accessibility

The generated HTML includes:

- A keyboard-visible skip link and logical landmark regions.
- One page heading and named widget headings.
- Visible focus indicators and at least 44px calendar controls.
- Semantic calendar rows, column headers, cells, dates, and current-day state.
- Labeled tasks, readable due dates, and text for overdue status.
- Polite live regions for data widgets and explicit busy states.
- New-tab announcements for external news links.
- WCAG AA text colors and forced-colors support.

The calendar and dashboard behavior was checked in the rendered accessibility
tree. Third-party iframe content is outside direct control of this project.

## Project layout

```text
generate.py                 Static site entry point and validation
meta.yml                    Site content and source configuration
example_env                 Supported environment-variable template
requirements.txt            Pinned Python dependencies
templates/
  base.html                 Shared accessible page shell
  standard.html             Current complete theme
  partials/                 Widget markup
static/
  main.js                   All browser collectors, rendering, and UI behavior
  styles.css                Responsive layout and theme
  *.webp                    Background and header images
deploy-homepage.sh           Environment-specific Linux/Caddy deployment helper
```

## Notes

- New Relic is no longer part of the page, collector code, configuration, or
  environment setup.
- RSS parsing and rendering hooks remain in `main.js`, but News is intentionally
  pending until `rss` data is wired into the dashboard section definitions.
- `collectors.py` is retained as inactive reference code under the project
  convention for superseded implementations; `generate.py` does not import it.
- `deploy-homepage.sh` is specific to the author's Linux paths and Caddy
  environment. It regenerates the root `index.html`, copies it with `static/`
  to the configured web root, fixes ownership, and reloads Caddy. Review and
  adapt it before using it elsewhere.
