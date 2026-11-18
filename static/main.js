/**
 * Homepage browser bundle.
 *
 * Keep the modules in dependency order so this classic script works when the
 * generated homepage is opened directly from disk with file://.
 */
/**
 * Browser-side data collectors for the homepage.
 *
 * The page is opened straight from disk (file://), so every request is a
 * cross-origin browser request and only works if the remote service sends
 * CORS headers:
 *   - Weather (api.weather.gov, Zippopotam), stocks (CNBC) and Linode: work.
 *   - RSS is pending the local FreshRSS instance (see parse_feed below).
 *
 * Every section is a plain object with `ok`, `complete`, `error`, `stale` and
 * `updated`, cached in localStorage so each service is only contacted when
 * its refresh interval has elapsed.
 */
(function (namespace) {
"use strict";

const HTTP_TIMEOUT_MS = 10000;
const MAX_RESPONSE_CHARS = 2000000;
const RETRY_MS = 5 * 60 * 1000;
const CACHE_PREFIX = "home-dashboard:";
const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:"]);

const SPARKLINE_WIDTH = 120;
const SPARKLINE_HEIGHT = 32;
const SPARKLINE_PADDING = 2;

const ZIP_PATTERN = /^\d{5}$/;
const ZIP_LOOKUP_URL = "https://api.zippopotam.us/us/";
const NWS_POINTS_URL = "https://api.weather.gov/points/";
const NWS_STATIONS_URL = "https://api.weather.gov/stations/";
const NWS_URL_PREFIX = "https://api.weather.gov/";
const MAX_STATIONS = 3;
const KMH_TO_MPH = 0.621371;
const METERS_PER_SECOND_TO_MPH = 2.23694;

const STOCK_URL = "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol";
const LINODE_URL = "https://api.linode.com/v4/linode/instances/";

const LINODE_WINDOWS = [
    { label: "1 hour", window_ms: 60 * 60 * 1000 },
    { label: "12 hours", window_ms: 12 * 60 * 60 * 1000 },
];

// First matching rule wins: [forecast text pattern, day icon, night icon].
const WEATHER_ICON_RULES = [
    [/thunder/i, "⛈️", "⛈️"],
    [/snow|flurr|blizzard|sleet|ice|wintry/i, "🌨️", "🌨️"],
    [/rain|shower|drizzle/i, "🌧️", "🌧️"],
    [/fog|haze|smoke|mist/i, "🌫️", "🌫️"],
    [/partly/i, "⛅", "☁️"],
    [/mostly (clear|sunny)/i, "🌤️", "🌙"],
    [/cloudy|overcast/i, "☁️", "☁️"],
    [/sunny|clear/i, "☀️", "🌙"],
];
const UNKNOWN_WEATHER_ICON = "🌡️";

/** Raised when a data source cannot be reached or returns bad data. */
class CollectorError extends Error {}

// --------------------------------------------------------------------------
// Storage and HTTP helpers
// --------------------------------------------------------------------------

/**
 * Read a JSON value from localStorage.
 * @param {string} key Cache key without the shared prefix.
 * @returns {*} The stored value, or null if missing or unreadable.
 */
function read_storage(key) {
    try {
        return JSON.parse(window.localStorage.getItem(CACHE_PREFIX + key));
    } catch {
        return null;
    }
}

/**
 * Write a JSON value to localStorage, ignoring quota or privacy-mode errors.
 * @param {string} key Cache key without the shared prefix.
 * @param {*} value JSON-serializable value.
 */
function write_storage(key, value) {
    try {
        window.localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value));
    } catch {
        // The cache only saves requests; losing it is harmless.
    }
}

/**
 * Describe a URL for error messages without leaking paths or query strings.
 * @param {string} url Absolute URL.
 * @returns {string} The host.
 */
function describe_url(url) {
    return new URL(url).host;
}

/**
 * Fetch a URL as text with a timeout and a size limit.
 * @param {string} url Absolute URL.
 * @param {RequestInit} [options] Extra fetch options (method, headers, body).
 * @returns {Promise<string>} The response body.
 * @throws {CollectorError} On network failure, HTTP error or oversized body.
 */
async function fetch_text(url, options = {}) {
    const description = describe_url(url);
    let response;
    try {
        response = await fetch(url, {
            ...options,
            cache: "no-store",
            referrerPolicy: "no-referrer",
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
    } catch (error) {
        // A blocked CORS request and an offline network look identical here.
        throw new CollectorError(`Request to ${description} failed (offline, or blocked by CORS)`);
    }
    if (!response.ok) {
        throw new CollectorError(`HTTP ${response.status} from ${description}`);
    }
    const body = await response.text();
    if (body.length > MAX_RESPONSE_CHARS) {
        throw new CollectorError(`Response from ${description} is too large`);
    }
    return body;
}

/**
 * Fetch a URL and decode its JSON body.
 * @param {string} url Absolute URL.
 * @param {RequestInit} [options] Extra fetch options.
 * @returns {Promise<*>} The decoded JSON document.
 * @throws {CollectorError} If the request fails or the body is not JSON.
 */
async function fetch_json(url, options = {}) {
    const body = await fetch_text(url, options);
    try {
        return JSON.parse(body);
    } catch {
        throw new CollectorError(`Invalid JSON from ${describe_url(url)}`);
    }
}

/**
 * @param {*} value Any value.
 * @returns {number|null} The value if it is a finite number, else null.
 */
function as_number(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// --------------------------------------------------------------------------
// Formatting and chart helpers
// --------------------------------------------------------------------------

/**
 * Format a time as e.g. `7:35 PM` in the device's locale.
 * @param {number} timestamp_ms Milliseconds since the epoch.
 * @returns {string} Short clock text.
 */
function format_clock(timestamp_ms) {
    return new Date(timestamp_ms).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
    });
}

/**
 * Convert numbers into SVG polyline points for a sparkline.
 * @param {number[]} values Samples in time order.
 * @param {number} minimum Value drawn at the bottom of the chart.
 * @param {number} maximum Value drawn at the top of the chart.
 * @returns {string} `"x,y x,y"` points, or "" if there is nothing to draw.
 */
function build_chart_points(values, minimum, maximum) {
    if (values.length < 2 || maximum <= minimum) {
        return "";
    }
    const drawable_height = SPARKLINE_HEIGHT - 2 * SPARKLINE_PADDING;
    const step = SPARKLINE_WIDTH / (values.length - 1);
    return values
        .map((value, index) => {
            const clamped = Math.min(Math.max(value, minimum), maximum);
            const ratio = (clamped - minimum) / (maximum - minimum);
            const y_position = SPARKLINE_HEIGHT - SPARKLINE_PADDING - ratio * drawable_height;
            return `${(index * step).toFixed(1)},${y_position.toFixed(1)}`;
        })
        .join(" ");
}

/**
 * @param {number} bits_per_second A bit rate.
 * @returns {string} Text such as `1.2 Mb/s`.
 */
function format_rate(bits_per_second) {
    const units = [[1e9, "Gb/s"], [1e6, "Mb/s"], [1e3, "kb/s"]];
    for (const [threshold, unit] of units) {
        if (bits_per_second >= threshold) {
            return `${(bits_per_second / threshold).toFixed(1)} ${unit}`;
        }
    }
    return `${bits_per_second.toFixed(0)} b/s`;
}

/**
 * @param {number|null} published_ms Publication time, or null.
 * @param {number} now_ms Current time.
 * @returns {string} A short relative age such as `3h`, or "".
 */
function format_age(published_ms, now_ms) {
    if (published_ms === null) {
        return "";
    }
    const seconds = Math.max(0, Math.floor((now_ms - published_ms) / 1000));
    if (seconds < 3600) {
        return `${Math.max(1, Math.floor(seconds / 60))}m`;
    }
    if (seconds < 86400) {
        return `${Math.floor(seconds / 3600)}h`;
    }
    return `${Math.floor(seconds / 86400)}d`;
}

// --------------------------------------------------------------------------
// Weather (api.weather.gov)
// --------------------------------------------------------------------------

/**
 * Resolve a US ZIP code to a place name and coordinates (cached forever).
 * @param {string} zip_code Five-digit ZIP code.
 * @returns {Promise<{place: string, latitude: number, longitude: number}>}
 */
async function lookup_zip(zip_code) {
    if (!ZIP_PATTERN.test(zip_code)) {
        throw new CollectorError(`Invalid ZIP code: ${zip_code}`);
    }
    const cache_key = `zip:${zip_code}`;
    const cached = read_storage(cache_key);
    if (cached && as_number(cached.latitude) !== null) {
        return cached;
    }

    const payload = await fetch_json(ZIP_LOOKUP_URL + zip_code);
    const place = payload?.places?.[0];
    const latitude = Number.parseFloat(place?.latitude);
    const longitude = Number.parseFloat(place?.longitude);
    if (!place || Number.isNaN(latitude) || Number.isNaN(longitude)) {
        throw new CollectorError(`ZIP code ${zip_code} not found`);
    }
    const location = {
        place: `${place["place name"]}, ${place["state abbreviation"]}`,
        latitude,
        longitude,
    };
    write_storage(cache_key, location);
    return location;
}

/**
 * @param {*} url A URL taken from an API response.
 * @returns {string} The URL, if it points at api.weather.gov.
 * @throws {CollectorError} If it points anywhere else.
 */
function require_nws_url(url) {
    if (typeof url !== "string" || !url.startsWith(NWS_URL_PREFIX)) {
        throw new CollectorError("Unexpected URL in weather.gov response");
    }
    return url;
}

/**
 * Find the forecast URL and nearby observation stations for a ZIP code.
 * The grid and stations never change, so they are cached permanently.
 * @param {string} zip_code Five-digit ZIP code.
 * @returns {Promise<{place: string, forecast_url: string, station_ids: string[]}>}
 */
async function lookup_grid(zip_code) {
    const location = await lookup_zip(zip_code);
    const cache_key = `grid:${zip_code}`;
    const cached = read_storage(cache_key);
    if (cached?.forecast_url && Array.isArray(cached.station_ids)) {
        return cached;
    }

    const coordinates = `${location.latitude.toFixed(4)},${location.longitude.toFixed(4)}`;
    const point = await fetch_json(NWS_POINTS_URL + coordinates);
    const forecast_url = require_nws_url(point?.properties?.forecast);
    const stations_url = require_nws_url(point?.properties?.observationStations);

    const stations = await fetch_json(`${stations_url}?limit=${MAX_STATIONS}`);
    const station_ids = (stations?.features ?? [])
        .map((feature) => feature?.properties?.stationIdentifier)
        .filter((station_id) => typeof station_id === "string" && /^[A-Za-z0-9]+$/.test(station_id));
    if (station_ids.length === 0) {
        throw new CollectorError(`No weather stations near ${zip_code}`);
    }

    const grid = { place: location.place, forecast_url, station_ids };
    write_storage(cache_key, grid);
    return grid;
}

/**
 * Read the latest observation from the first station that is reporting.
 * Some (often personal) stations return only empty values.
 * @param {string[]} station_ids Station identifiers, nearest first.
 * @returns {Promise<object|null>} Observation properties, or null if no
 *     station reported a temperature.
 */
async function fetch_observation(station_ids) {
    for (const station_id of station_ids) {
        try {
            const payload = await fetch_json(`${NWS_STATIONS_URL}${station_id}/observations/latest`);
            if (as_number(payload?.properties?.temperature?.value) !== null) {
                return payload.properties;
            }
        } catch (error) {
            console.warn(`Station ${station_id}: ${error.message}`);
        }
    }
    return null;
}

/**
 * @param {object|null} wind_speed A weather.gov quantity `{value, unitCode}`.
 * @returns {number|null} Speed in mph, or null if not reported.
 */
function wind_in_mph(wind_speed) {
    const value = as_number(wind_speed?.value);
    if (value === null) {
        return null;
    }
    return String(wind_speed.unitCode).endsWith("m_s-1") ? value * METERS_PER_SECOND_TO_MPH : value * KMH_TO_MPH;
}

/**
 * @param {string} forecast_text A short forecast such as "Mostly Cloudy".
 * @param {boolean} is_daytime Whether the forecast period is in daytime.
 * @returns {string} An emoji matching the forecast.
 */
function pick_weather_icon(forecast_text, is_daytime) {
    const rule = WEATHER_ICON_RULES.find(([pattern]) => pattern.test(forecast_text));
    if (!rule) {
        return UNKNOWN_WEATHER_ICON;
    }
    return is_daytime ? rule[1] : rule[2];
}

/**
 * Fetch current conditions and the forecast for a ZIP code from the US
 * National Weather Service (api.weather.gov).
 *
 * Temperature, humidity and wind come from the nearest reporting station;
 * the condition text and high/low come from the forecast.
 *
 * @param {string} zip_code Five-digit ZIP code.
 * @returns {Promise<object>} Place, temperature, humidity, wind, condition,
 *     icon, high and low. Humidity and wind are null when not reported.
 */
async function fetch_weather(zip_code) {
    const grid = await lookup_grid(zip_code);
    const [observation, forecast] = await Promise.all([
        fetch_observation(grid.station_ids),
        fetch_json(grid.forecast_url),
    ]);

    const periods = (forecast?.properties?.periods ?? []).filter((period) => period?.temperatureUnit === "F");
    if (periods.length === 0) {
        throw new CollectorError(`No forecast for ${zip_code}`);
    }
    const [current_period] = periods;
    const celsius = as_number(observation?.temperature?.value);
    const temperature = celsius === null ? as_number(current_period.temperature) : (celsius * 9) / 5 + 32;
    if (temperature === null) {
        throw new CollectorError(`Incomplete weather data for ${zip_code}`);
    }

    const humidity = as_number(observation?.relativeHumidity?.value);
    const wind = wind_in_mph(observation?.windSpeed);
    const high_period = periods.find((period) => period.isDaytime);
    const low_period = periods.find((period) => !period.isDaytime);
    const condition = String(current_period.shortForecast || observation?.textDescription || "Unknown");
    return {
        place: grid.place,
        temperature: Math.round(temperature),
        humidity: humidity === null ? null : Math.round(humidity),
        wind: wind === null ? null : Math.round(wind),
        condition,
        icon: pick_weather_icon(condition, current_period.isDaytime),
        high: as_number(high_period?.temperature),
        low: as_number(low_period?.temperature),
    };
}

// --------------------------------------------------------------------------
// Stocks (CNBC quote service: unofficial, keyless, CORS-enabled)
// --------------------------------------------------------------------------

/**
 * @param {string} symbol Requested ticker.
 * @param {object|undefined} quote The matching CNBC quote, if any.
 * @returns {object} A stock entry; `ok` is false if the quote is unusable.
 */
function build_stock_entry(symbol, quote) {
    const price = Number.parseFloat(String(quote?.last).replace(/,/g, ""));
    if (!quote || quote.code !== 0 || Number.isNaN(price)) {
        return { ok: false, label: symbol, error: "Symbol not found" };
    }

    const change = Number.parseFloat(String(quote.change).replace(/,/g, "")) || 0;
    const percent = String(quote.change_pct ?? "").replace(/^(?=\d)/, "+");
    return {
        ok: true,
        error: "",
        label: symbol,
        name: String(quote.name ?? symbol),
        price: String(quote.last),
        change_percent: percent || "0.00%",
        direction: change > 0 ? "up" : change < 0 ? "down" : "flat",
        points: "",
    };
}

/**
 * Fetch quotes for all tickers in a single request.
 * @param {string[]} symbols Ticker symbols such as `AAPL`.
 * @returns {Promise<object>} A section with `entries`.
 */
async function collect_stocks(symbols) {
    if (symbols.length === 0) {
        return { ok: false, error: "No tickers configured", entries: [] };
    }
    const query = new URLSearchParams({
        symbols: symbols.join("|"),
        requestMethod: "itv",
        noform: "1",
        partnerId: "2",
        fund: "1",
        exthrs: "1",
        output: "json",
        events: "1",
    });
    const payload = await fetch_json(`${STOCK_URL}?${query}`);
    const quotes = payload?.FormattedQuoteResult?.FormattedQuote;
    if (!Array.isArray(quotes)) {
        throw new CollectorError("Unexpected response from CNBC");
    }

    const quotes_by_symbol = new Map(quotes.map((quote) => [String(quote?.symbol).toUpperCase(), quote]));
    const entries = symbols.map((symbol) => build_stock_entry(symbol, quotes_by_symbol.get(symbol)));
    const succeeded = entries.filter((entry) => entry.ok).length;
    return {
        ok: succeeded > 0,
        complete: succeeded === entries.length,
        error: succeeded > 0 ? "" : "No quotes available",
        entries,
    };
}

// --------------------------------------------------------------------------
// RSS / Atom (not wired up yet: pending the local FreshRSS instance)
// --------------------------------------------------------------------------

/**
 * @param {Element} parent XML element.
 * @param {string} local_name Child element name without namespace prefix.
 * @returns {Element|null} The first matching direct child.
 */
function find_child(parent, local_name) {
    return Array.from(parent.children).find((child) => child.localName === local_name) ?? null;
}

/**
 * @param {Element} parent XML element.
 * @param {string} local_name Child element name.
 * @returns {string} Trimmed child text, or "".
 */
function child_text(parent, local_name) {
    return find_child(parent, local_name)?.textContent.trim() ?? "";
}

/**
 * @param {string} link A URL from a feed.
 * @returns {string} The URL if it is http(s), otherwise "".
 */
function safe_link(link) {
    try {
        return ALLOWED_LINK_PROTOCOLS.has(new URL(link).protocol) ? link : "";
    } catch {
        return "";
    }
}

/**
 * @param {string} raw_date RFC 822 or ISO 8601 text.
 * @returns {number|null} Milliseconds since the epoch, or null.
 */
function parse_feed_date(raw_date) {
    const timestamp = Date.parse(raw_date);
    return Number.isNaN(timestamp) ? null : timestamp;
}

/**
 * Parse RSS 2.0 or Atom text into entries.
 * @param {string} xml_text Raw feed XML.
 * @returns {{title: string, link: string, source: string, published: (number|null)}[]}
 * @throws {CollectorError} If the XML is invalid.
 */
function parse_feed(xml_text) {
    const document_root = new DOMParser().parseFromString(xml_text, "application/xml");
    if (document_root.getElementsByTagName("parsererror").length > 0) {
        throw new CollectorError("Feed is not valid XML");
    }

    const root = document_root.documentElement;
    const channel = find_child(root, "channel");
    if (channel) {
        const source = child_text(channel, "title");
        return Array.from(channel.children)
            .filter((child) => child.localName === "item")
            .map((item) => ({
                title: child_text(item, "title"),
                link: safe_link(child_text(item, "link")),
                source,
                published: parse_feed_date(child_text(item, "pubDate")),
            }));
    }

    const source = child_text(root, "title");
    return Array.from(root.children)
        .filter((child) => child.localName === "entry")
        .map((entry) => ({
            title: child_text(entry, "title"),
            link: safe_link(find_child(entry, "link")?.getAttribute("href") ?? ""),
            source,
            published: parse_feed_date(child_text(entry, "updated") || child_text(entry, "published")),
        }));
}

/**
 * Merge several feeds into one newest-first list.
 * @param {string[]} feed_urls Feed URLs (the server must send CORS headers).
 * @param {number} max_items Maximum number of entries to return.
 * @param {number} now_ms Current time, used for relative ages.
 * @returns {Promise<object>} A section with `ok`, `error` and `entries`.
 */
async function collect_rss(feed_urls, max_items, now_ms) {
    const results = await Promise.allSettled(
        feed_urls.map(async (feed_url) => parse_feed(await fetch_text(feed_url))),
    );

    const entries = [];
    results.forEach((result, index) => {
        if (result.status === "fulfilled") {
            entries.push(...result.value);
        } else {
            console.warn(`RSS feed ${index + 1}: ${result.reason.message}`);
        }
    });

    const items = entries
        .filter((entry) => entry.title)
        .sort((first, second) => (second.published ?? 0) - (first.published ?? 0))
        .slice(0, max_items)
        .map((entry) => ({
            title: entry.title,
            link: entry.link,
            source: entry.source,
            age: format_age(entry.published, now_ms),
        }));
    if (items.length === 0) {
        return { ok: false, error: "No feed items available", entries: [] };
    }
    return { ok: true, complete: results.every((result) => result.status === "fulfilled"), error: "", entries: items };
}

// --------------------------------------------------------------------------
// Linode
// --------------------------------------------------------------------------

/**
 * @param {*} series Linode `[[timestamp_ms, value], ...]` list.
 * @param {number} since_ms Ignore samples older than this.
 * @returns {number[]} Sample values in time order.
 */
function series_values(series, since_ms) {
    if (!Array.isArray(series)) {
        return [];
    }
    return series
        .filter((sample) => Array.isArray(sample) && as_number(sample[0]) !== null && as_number(sample[1]) !== null)
        .filter((sample) => sample[0] >= since_ms)
        .map((sample) => sample[1]);
}

/**
 * @param {*} series Linode series.
 * @returns {number} The newest timestamp in the series, or 0.
 */
function latest_timestamp(series) {
    if (!Array.isArray(series)) {
        return 0;
    }
    const timestamps = series.map((sample) => as_number(sample?.[0])).filter((stamp) => stamp !== null);
    return timestamps.length > 0 ? Math.max(...timestamps) : 0;
}

/**
 * @param {number[]} values A non-empty list of numbers.
 * @returns {{latest: number, average: number, peak: number}} Summary.
 */
function summarize(values) {
    return {
        latest: values[values.length - 1],
        average: values.reduce((total, value) => total + value, 0) / values.length,
        peak: Math.max(...values),
    };
}

/**
 * @param {string} label Window label such as "1 hour".
 * @param {number} window_ms Window length in milliseconds.
 * @param {object} stats Linode `data` object.
 * @returns {object} One CPU and network view, `ok: false` without samples.
 */
function build_linode_view(label, window_ms, stats) {
    const since_ms = latest_timestamp(stats.cpu) - window_ms;
    const cpu_values = series_values(stats.cpu, since_ms);
    const in_values = series_values(stats.netv4?.in, since_ms);
    const out_values = series_values(stats.netv4?.out, since_ms);
    if (cpu_values.length === 0 || in_values.length === 0 || out_values.length === 0) {
        return { label, ok: false };
    }

    const cpu = summarize(cpu_values);
    const network_peak = Math.max(...in_values, ...out_values, 1);
    return {
        label,
        ok: true,
        cpu_points: build_chart_points(cpu_values, 0, Math.max(cpu.peak, 1)),
        cpu_latest: `${cpu.latest.toFixed(1)}%`,
        cpu_average: `${cpu.average.toFixed(1)}%`,
        cpu_peak: `${cpu.peak.toFixed(1)}%`,
        in_points: build_chart_points(in_values, 0, network_peak),
        out_points: build_chart_points(out_values, 0, network_peak),
        in_latest: format_rate(in_values[in_values.length - 1]),
        out_latest: format_rate(out_values[out_values.length - 1]),
        network_peak: format_rate(network_peak),
    };
}

/**
 * Fetch 1 hour and 12 hour CPU/network views for the Linode instance.
 * @param {{linode_token: string, linode_id: string}} credentials Read-only
 *     token and numeric instance ID embedded by generate.py.
 * @returns {Promise<object>} A section with `ok`, `error` and `views`.
 */
async function collect_linode(credentials) {
    const payload = await fetch_json(`${LINODE_URL}${credentials.linode_id}/stats`, {
        headers: { Authorization: `Bearer ${credentials.linode_token}` },
    });
    if (!payload?.data || typeof payload.data !== "object") {
        throw new CollectorError("Linode returned no statistics");
    }
    const views = LINODE_WINDOWS.map(({ label, window_ms }) => build_linode_view(label, window_ms, payload.data));
    return { ok: true, error: "", views };
}

// --------------------------------------------------------------------------
// Section definitions and caching
// --------------------------------------------------------------------------

/**
 * Collect one weather entry per ZIP code; a failing ZIP never fails the rest.
 * @param {string[]} zip_codes Five-digit ZIP codes.
 * @returns {Promise<object>} A section with `entries`.
 */
async function collect_weather(zip_codes) {
    const entries = await Promise.all(
        zip_codes.map(async (zip_code) => {
            try {
                const item = await fetch_weather(zip_code);
                return { ok: true, error: "", ...item, label: item.place };
            } catch (error) {
                console.warn(`ZIP ${zip_code}: ${error.message}`);
                return { ok: false, label: `ZIP ${zip_code}`, error: error.message };
            }
        }),
    );
    const succeeded = entries.filter((entry) => entry.ok).length;
    return {
        ok: succeeded > 0,
        complete: succeeded === entries.length,
        error: succeeded > 0 ? "" : "No data available",
        entries,
    };
}

/**
 * @param {string} message Explanation shown in the panel.
 * @param {string} empty_key Name of the list the renderer expects.
 * @returns {function(): Promise<object>} A collector that does no network
 *     work and reports the panel as not configured.
 */
function not_configured(message, empty_key) {
    return async () => ({ ok: false, complete: true, error: message, [empty_key]: [] });
}

/**
 * Build the list of dashboard sections from the embedded page config.
 * @param {object} config The `dashboard-config` JSON.
 * @returns {{name: string, signature: *, ttl_minutes: number,
 *     collect: function(): Promise<object>}[]} Section definitions.
 */
function build_section_definitions(config) {
    const refresh = config.refresh_minutes;
    const credentials = config.credentials;
    return [
        {
            name: "weather",
            signature: config.weather_zips,
            ttl_minutes: refresh.weather,
            collect: () => collect_weather(config.weather_zips),
        },
        {
            name: "stocks",
            signature: config.stock_symbols,
            ttl_minutes: refresh.stocks,
            collect: () => collect_stocks(config.stock_symbols),
        },
        {
            name: "linode",
            signature: credentials.linode_id,
            ttl_minutes: refresh.linode,
            collect: config.linode_enabled
                ? () => collect_linode(credentials)
                : not_configured("Not configured: set LINODE_RO_API and LINODE_COMPUTE_ID in .env", "views"),
        },
    ];
}

/**
 * @param {string} name Section name.
 * @param {*} signature Config fingerprint of the section.
 * @returns {object|null} The cached section (even if expired), or null if
 *     there is none or it was built for a different configuration.
 */
function load_cached_section(name, signature) {
    const cached = read_storage(name);
    const same_config = cached && JSON.stringify(cached.signature) === JSON.stringify(signature);
    return same_config && cached.data ? cached.data : null;
}

/**
 * @param {object|null} cached Cache record.
 * @param {*} signature Current config fingerprint.
 * @param {number} ttl_ms Freshness window of a fully successful fetch.
 * @param {number} now_ms Current time.
 * @returns {boolean} True if the cache is for this config and not expired.
 */
function is_fresh(cached, signature, ttl_ms, now_ms) {
    if (!cached?.data || JSON.stringify(cached.signature) !== JSON.stringify(signature)) {
        return false;
    }
    if (!Number.isFinite(cached.fetched_at)) {
        return false;
    }
    // An incomplete section is retried soon rather than after a full interval.
    const allowed_ms = cached.data.complete ? ttl_ms : Math.min(RETRY_MS, ttl_ms);
    const age_ms = now_ms - cached.fetched_at;
    return age_ms >= 0 && age_ms < allowed_ms;
}

/**
 * Return a section from cache, refetching it only when it is due.
 *
 * If a refetch fails and older good data exists, that data is kept and
 * marked `stale`, so a flaky or slow connection does not blank the page.
 *
 * @param {{name: string, signature: *, ttl_minutes: number,
 *     collect: function(): Promise<object>}} definition Section definition.
 * @param {number} [now_ms] Current time.
 * @returns {Promise<{section: object, fetched: boolean}>} The section and
 *     whether it was just refetched (so the caller should re-render).
 */
async function refresh_section(definition, now_ms = Date.now()) {
    const { name, signature, ttl_minutes, collect } = definition;
    const cached = read_storage(name);
    if (is_fresh(cached, signature, ttl_minutes * 60 * 1000, now_ms)) {
        return { section: cached.data, fetched: false };
    }

    let section;
    try {
        section = await collect();
    } catch (error) {
        console.warn(`${name}: ${error.message}`);
        section = { ok: false, error: error.message, entries: [], views: [], metrics: [] };
    }
    section.complete = section.complete ?? section.ok;
    section.stale = false;
    section.updated = format_clock(now_ms);

    const same_config = cached && JSON.stringify(cached.signature) === JSON.stringify(signature);
    if (!section.ok && same_config && cached.data?.ok) {
        console.warn(`${name}: showing stale data (${section.error})`);
        section = { ...cached.data, stale: true, complete: false };
    }

    write_storage(name, { fetched_at: now_ms, signature, data: section });
    return { section, fetched: true };
}

namespace.collectors = {
    build_section_definitions,
    load_cached_section,
    refresh_section,
    collect_rss,
};
})(window.HomeDashboard = window.HomeDashboard || {});


/**
 * DOM rendering for the dashboard sections.
 *
 * Content from APIs and feeds is only ever inserted with `textContent` and
 * element attributes, never as HTML, so it cannot inject markup.
 */
(function (namespace) {
"use strict";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const LINK_REL = "noopener noreferrer";

/**
 * Create an HTML element.
 * @param {string} tag_name Element name.
 * @param {string} [class_name] CSS classes.
 * @param {string} [text] Text content.
 * @returns {HTMLElement} The new element.
 */
function create_element(tag_name, class_name = "", text = "") {
    const element = document.createElement(tag_name);
    if (class_name) {
        element.className = class_name;
    }
    if (text) {
        element.textContent = text;
    }
    return element;
}

/**
 * Create an element and append children to it.
 * @param {string} tag_name Element name.
 * @param {string} class_name CSS classes.
 * @param {(Node|null)[]} children Child nodes; nulls are skipped.
 * @returns {HTMLElement} The new element.
 */
function create_parent(tag_name, class_name, children) {
    const element = create_element(tag_name, class_name);
    element.append(...children.filter(Boolean));
    return element;
}

/**
 * Create an SVG element.
 * @param {string} tag_name SVG element name.
 * @param {Object<string, string>} attributes Attributes to set.
 * @returns {SVGElement} The new element.
 */
function create_svg(tag_name, attributes) {
    const element = document.createElementNS(SVG_NAMESPACE, tag_name);
    Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
    return element;
}

/**
 * @param {string} points SVG polyline points.
 * @param {string} [tone] One of accent, up, down, flat, warn.
 * @returns {SVGElement|null} A filled sparkline, or null without points.
 */
function create_sparkline(points, tone = "accent") {
    if (!points) {
        return null;
    }
    const svg = create_svg("svg", {
        class: `sparkline tone-${tone}`,
        viewBox: "0 0 120 32",
        preserveAspectRatio: "none",
        "aria-hidden": "true",
        focusable: "false",
    });
    svg.append(
        create_svg("polygon", { class: "sparkline-area", points: `${points} 120,32 0,32` }),
        create_svg("polyline", { class: "sparkline-line", points }),
    );
    return svg;
}

/**
 * @param {string} first_points Points for the first line.
 * @param {string} second_points Points for the second line.
 * @returns {SVGElement|null} A two-line chart, or null without points.
 */
function create_dual_sparkline(first_points, second_points) {
    if (!first_points || !second_points) {
        return null;
    }
    const svg = create_svg("svg", {
        class: "sparkline",
        viewBox: "0 0 120 32",
        preserveAspectRatio: "none",
        "aria-hidden": "true",
        focusable: "false",
    });
    svg.append(
        create_svg("polyline", { class: "sparkline-line tone-accent", points: first_points }),
        create_svg("polyline", { class: "sparkline-line tone-warn", points: second_points }),
    );
    return svg;
}

/**
 * @param {object} section A section with `stale` and `updated`.
 * @returns {HTMLElement|null} A "stale since" badge, or null.
 */
function create_stale_badge(section) {
    if (!section.stale) {
        return null;
    }
    const badge = create_element("span", "badge", `stale since ${section.updated}`);
    badge.title = "Showing the last good data";
    return badge;
}

/**
 * @param {string} title Card title.
 * @param {object|null} [section] Section used for the stale badge.
 * @returns {HTMLElement} A card header.
 */
function create_card_header(title, section = null, title_id = "") {
    const heading = create_element("h2", "card-title", title);
    if (title_id) {
        heading.id = title_id;
    }
    return create_parent("header", "card-header", [
        heading,
        section ? create_stale_badge(section) : null,
    ]);
}

/**
 * @param {string} text Message text.
 * @returns {HTMLElement} A muted paragraph.
 */
function create_message(text) {
    return create_element("p", "muted", text);
}

// --------------------------------------------------------------------------
// Sections
// --------------------------------------------------------------------------

/**
 * @param {object} place A weather entry.
 * @param {object} section The weather section.
 * @returns {HTMLElement} A weather card.
 */
function create_weather_card(place, section) {
    if (!place.ok) {
        return create_parent("article", "card weather-card", [
            create_card_header(place.label),
            create_message("Weather unavailable."),
        ]);
    }

    const stat_items = [
        ["Humidity", place.humidity === null ? "—" : `${place.humidity}%`],
        ["Wind", place.wind === null ? "—" : `${place.wind} mph`],
    ];
    if (place.high !== null && place.low !== null) {
        stat_items.push(["H / L", `${place.high}° / ${place.low}°`]);
    }
    const stats = create_parent(
        "ul",
        "weather-stats",
        stat_items.map(([label, value]) => {
            const item = create_element("li");
            item.append(create_element("span", "", label), ` ${value}`);
            return item;
        }),
    );
    const icon = create_element("span", "weather-icon", place.icon);
    icon.setAttribute("aria-hidden", "true");

    return create_parent("article", "card weather-card", [
        create_card_header(place.label, section),
        create_parent("div", "weather-main", [
            icon,
            create_parent("div", "", [
                create_element("p", "weather-temp", `${place.temperature}°F`),
                create_element("p", "weather-condition", place.condition),
            ]),
        ]),
        stats,
    ]);
}

/**
 * @param {HTMLElement} container The weather container.
 * @param {object} section The weather section.
 */
function render_weather(container, section) {
    if (section.entries.length === 0) {
        container.replaceChildren(
            create_parent("article", "card weather-card", [
                create_card_header("Weather"),
                create_message(section.error || "Add ZIP codes under weather in meta.yml."),
            ]),
        );
        return;
    }
    container.replaceChildren(...section.entries.map((place) => create_weather_card(place, section)));
}

/**
 * @param {HTMLElement} container The stocks container.
 * @param {object} section The stocks section.
 */
function render_stocks(container, section) {
    const card = create_parent("section", "card stocks-card", [
        create_card_header("Markets", section, "markets-title"),
    ]);
    card.setAttribute("aria-labelledby", "markets-title");
    if (section.entries.length === 0) {
        card.append(create_message("Add tickers under fin_stock in meta.yml."));
        container.replaceChildren(card);
        container.setAttribute("aria-busy", "false");
        return;
    }

    const rows = section.entries.map((quote) => {
        const symbol = create_element("span", "stock-symbol", quote.label);
        if (!quote.ok) {
            return create_parent("li", "stock", [
                create_parent("div", "stock-name", [symbol]),
                create_message("unavailable"),
            ]);
        }
        return create_parent("li", "stock", [
            create_parent("div", "stock-name", [symbol, create_element("span", "stock-company", quote.name)]),
            create_sparkline(quote.points, quote.direction),
            create_parent("div", "stock-price", [
                create_element("span", "stock-last", quote.price),
                create_element("span", `stock-change tone-${quote.direction}`, quote.change_percent),
            ]),
        ]);
    });
    card.append(create_parent("ul", "stock-list", rows));
    container.replaceChildren(card);
    container.setAttribute("aria-busy", "false");
}

/**
 * @param {HTMLElement} container The RSS container.
 * @param {object} section The RSS section.
 */
function render_rss(container, section) {
    const card = create_parent("section", "card rss-card", [
        create_card_header("News", section, "news-title"),
    ]);
    card.setAttribute("aria-labelledby", "news-title");
    if (!section.ok) {
        card.append(create_message(section.error));
        container.replaceChildren(card);
        container.setAttribute("aria-busy", "false");
        return;
    }

    const items = section.entries.map((entry) => {
        let title;
        if (entry.link) {
            title = create_element("a", "rss-title", entry.title);
            title.href = entry.link;
            title.target = "_blank";
            title.rel = LINK_REL;
            title.append(create_element("span", "visually-hidden", " (opens in a new tab)"));
        } else {
            title = create_element("span", "rss-title", entry.title);
        }
        const meta_text = entry.age ? `${entry.source} · ${entry.age}` : entry.source;
        return create_parent("li", "rss-item", [title, create_element("p", "rss-meta", meta_text)]);
    });
    card.append(create_parent("ul", "rss-list", items));
    container.replaceChildren(card);
    container.setAttribute("aria-busy", "false");
}

/**
 * @param {object} view One Linode time-window view.
 * @param {object} section The Linode section.
 * @returns {HTMLElement} A card for the view.
 */
function create_linode_card(view, section) {
    const card = create_parent("article", "card stats-card", [
        create_card_header(`Nextcloud · Linode · ${view.label}`, section),
    ]);
    if (!view.ok) {
        card.append(create_message("No data for this period."));
        return card;
    }

    const network_value = create_parent("span", "metric-value", [
        create_element("span", "legend tone-accent", `↓ ${view.in_latest}`),
        create_element("span", "legend tone-warn", `↑ ${view.out_latest}`),
    ]);
    card.append(
        create_parent("ul", "metric-list", [
            create_parent("li", "metric", [
                create_element("span", "metric-label", "CPU"),
                create_element("span", "metric-value", view.cpu_latest),
                create_sparkline(view.cpu_points),
                create_element("span", "metric-detail", `avg ${view.cpu_average} · peak ${view.cpu_peak}`),
            ]),
            create_parent("li", "metric", [
                create_element("span", "metric-label", "Network"),
                network_value,
                create_dual_sparkline(view.in_points, view.out_points),
                create_element("span", "metric-detail", `peak ${view.network_peak}`),
            ]),
        ]),
    );
    return card;
}

/**
 * @param {HTMLElement} container The Linode container.
 * @param {object} section The Linode section.
 */
function render_linode(container, section) {
    if (!section.ok) {
        const card = create_parent("article", "card stats-card stats-card-wide", [
            create_card_header("Nextcloud · Linode"),
            create_message(section.error),
        ]);
        container.replaceChildren(card);
        container.setAttribute("aria-busy", "false");
        return;
    }
    container.replaceChildren(...section.views.map((view) => create_linode_card(view, section)));
    container.setAttribute("aria-busy", "false");
}

namespace.render = {
    RENDERERS: {
        weather: render_weather,
        stocks: render_stocks,
        rss: render_rss,
        linode: render_linode,
    },
};
})(window.HomeDashboard = window.HomeDashboard || {});


/**
 * Clock in the page header. Updates once a minute, aligned to the minute
 * boundary, so an idle display does almost no work.
 */
(function (namespace) {
"use strict";

const MINUTE_MS = 60 * 1000;

/**
 * Show the weekday, time and date in the hero section.
 * @param {Date} moment The time to display.
 */
function render_clock(moment) {
    const time_element = document.getElementById("clock-time");
    const weekday_element = document.getElementById("clock-weekday");
    const date_element = document.getElementById("clock-date");
    if (!time_element || !weekday_element || !date_element) {
        return;
    }

    time_element.textContent = moment.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    time_element.dateTime = moment.toISOString();
    weekday_element.textContent = moment.toLocaleDateString([], { weekday: "long" });
    date_element.textContent = moment.toLocaleDateString([], {
        month: "long",
        day: "numeric",
        year: "numeric",
    });
}

/**
 * Call a function now and then at the start of every minute.
 * @param {function(Date): void} on_tick Called with the current time.
 */
function start_minute_ticker(on_tick) {
    const tick = () => {
        on_tick(new Date());
        window.setTimeout(tick, MINUTE_MS - (Date.now() % MINUTE_MS));
    };
    tick();
}

namespace.clock = { render_clock, start_minute_ticker };
})(window.HomeDashboard = window.HomeDashboard || {});


/**
 * Calendar and task list. Both run entirely in the browser; task check
 * state is kept in localStorage on each device.
 */
(function (namespace) {
"use strict";

const TASK_STORAGE_PREFIX = "home-dashboard:task:";
const WEEKDAYS_IN_WEEK = 7;
const MAX_CALENDAR_CELLS = 42;

/**
 * @param {Date} moment Any date.
 * @returns {string} The local date as `YYYY-MM-DD`.
 */
function to_iso_date(moment) {
    const month = String(moment.getMonth() + 1).padStart(2, "0");
    const day = String(moment.getDate()).padStart(2, "0");
    return `${moment.getFullYear()}-${month}-${day}`;
}

/** @returns {Set<string>} ISO due dates of tasks that are not checked. */
function read_open_due_dates() {
    const due_dates = new Set();
    document.querySelectorAll(".task").forEach((task) => {
        const checkbox = task.querySelector(".task-checkbox");
        const due = task.querySelector("[data-due]");
        if (due && checkbox && !checkbox.checked) {
            due_dates.add(due.dataset.due);
        }
    });
    return due_dates;
}

/**
 * Build one calendar cell.
 * @param {Date} day The day shown.
 * @param {number} visible_month Month (0-11) being displayed.
 * @param {string} today_iso Today as `YYYY-MM-DD`.
 * @param {Set<string>} due_dates Dates with open tasks.
 * @returns {HTMLElement} The cell.
 */
function create_day_cell(day, visible_month, today_iso, due_dates) {
    const cell = document.createElement("div");
    const day_iso = to_iso_date(day);
    const day_label = day.toLocaleDateString([], {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
    });
    cell.className = "calendar-day";
    cell.textContent = String(day.getDate());
    cell.setAttribute("role", "cell");
    cell.setAttribute("aria-label", day_label);
    if (day.getMonth() !== visible_month) {
        cell.classList.add("is-outside");
    }
    if (day_iso === today_iso) {
        cell.classList.add("is-today");
        cell.setAttribute("aria-current", "date");
    }
    if (due_dates.has(day_iso)) {
        cell.classList.add("has-task");
        cell.setAttribute("aria-label", `${day_label}, task due`);
    }
    return cell;
}

/**
 * Draw a month into the calendar card.
 * @param {number} year Full year.
 * @param {number} month Month index (0-11).
 */
function render_calendar(year, month) {
    const grid = document.getElementById("calendar-grid");
    const title = document.getElementById("calendar-title");
    if (!grid || !title) {
        return;
    }

    const first_of_month = new Date(year, month, 1);
    title.textContent = first_of_month.toLocaleDateString([], { month: "long", year: "numeric" });

    const first_cell = new Date(year, month, 1 - first_of_month.getDay());
    const today_iso = to_iso_date(new Date());
    const due_dates = read_open_due_dates();

    const header_cells = [];
    for (let weekday = 0; weekday < WEEKDAYS_IN_WEEK; weekday += 1) {
        const weekday_date = new Date(2023, 0, 1 + weekday);
        const header = document.createElement("div");
        header.className = "calendar-weekday";
        header.textContent = weekday_date.toLocaleDateString([], { weekday: "narrow" });
        header.setAttribute("role", "columnheader");
        header.setAttribute("aria-label", weekday_date.toLocaleDateString([], { weekday: "long" }));
        header_cells.push(header);
    }
    const header_row = document.createElement("div");
    header_row.className = "calendar-row";
    header_row.append(...header_cells);
    header_row.setAttribute("role", "row");
    const rows = [header_row];
    for (let offset = 0; offset < MAX_CALENDAR_CELLS; offset += 1) {
        if (offset % WEEKDAYS_IN_WEEK !== 0) {
            continue;
        }
        const row = document.createElement("div");
        row.className = "calendar-row";
        row.setAttribute("role", "row");
        for (let column = 0; column < WEEKDAYS_IN_WEEK; column += 1) {
            const day_offset = offset + column;
            const day = new Date(
                first_cell.getFullYear(),
                first_cell.getMonth(),
                first_cell.getDate() + day_offset,
            );
            row.append(create_day_cell(day, month, today_iso, due_dates));
        }
        rows.push(row);
    }
    grid.replaceChildren(...rows);
}

/** Restore saved check states and flag overdue tasks. */
function apply_task_state() {
    const today_iso = to_iso_date(new Date());
    document.querySelectorAll(".task").forEach((task) => {
        const checkbox = task.querySelector(".task-checkbox");
        if (!checkbox) {
            return;
        }
        const saved = window.localStorage.getItem(TASK_STORAGE_PREFIX + checkbox.dataset.taskKey);
        if (saved !== null) {
            checkbox.checked = saved === "done";
        }
        const due = task.querySelector("[data-due]");
        if (due) {
            const is_overdue = !checkbox.checked && due.dataset.due < today_iso;
            due.classList.toggle("is-overdue", is_overdue);
            due.setAttribute(
                "aria-label",
                `Due ${due.dataset.dueLabel || due.dataset.due}${is_overdue ? ", overdue" : ""}`,
            );
        }
    });
}

/**
 * Wire up the calendar, month navigation and task checkboxes.
 * @returns {function(): void} A function that redraws everything for the
 *     current date; call it when the day changes.
 */
function start_schedule() {
    const visible = { year: 0, month: 0 };

    const show_current_month = () => {
        const now = new Date();
        visible.year = now.getFullYear();
        visible.month = now.getMonth();
    };
    const redraw = () => {
        apply_task_state();
        render_calendar(visible.year, visible.month);
    };
    const shift_month = (delta) => {
        const shifted = new Date(visible.year, visible.month + delta, 1);
        visible.year = shifted.getFullYear();
        visible.month = shifted.getMonth();
        redraw();
    };

    document.getElementById("calendar-previous")?.addEventListener("click", () => shift_month(-1));
    document.getElementById("calendar-next")?.addEventListener("click", () => shift_month(1));
    document.getElementById("calendar-today")?.addEventListener("click", () => {
        show_current_month();
        redraw();
    });
    document.querySelectorAll(".task-checkbox").forEach((checkbox) => {
        checkbox.addEventListener("change", () => {
            try {
                window.localStorage.setItem(
                    TASK_STORAGE_PREFIX + checkbox.dataset.taskKey,
                    checkbox.checked ? "done" : "open",
                );
            } catch {
                // Check state simply will not persist without storage.
            }
            redraw();
        });
    });

    show_current_month();
    redraw();
    return () => {
        show_current_month();
        redraw();
    };
}

namespace.schedule = { start_schedule };
})(window.HomeDashboard = window.HomeDashboard || {});


/**
 * Homepage entry point (loaded as an ES module).
 *
 * Paints cached data immediately, then once a minute checks which sections
 * are due for a refresh. Each section has its own interval (see
 * `refresh_minutes` in meta.yml), so on a slow connection the browser only
 * downloads what is actually stale.
 *
 * Loaded as part of the single bundled classic script so the page
 * works when opened straight from disk, where browsers block ES modules.
 */
(function (namespace) {
"use strict";

const { start_minute_ticker, render_clock } = namespace.clock;
const { start_schedule } = namespace.schedule;
const { build_section_definitions, load_cached_section, refresh_section } = namespace.collectors;
const { RENDERERS } = namespace.render;

const CONTAINER_IDS = {
    weather: "weather",
    stocks: "stocks",
    linode: "linode",
};

/**
 * @returns {object|null} The config embedded by generate.py, or null.
 */
function read_config() {
    const config_element = document.getElementById("dashboard-config");
    try {
        return JSON.parse(config_element.textContent);
    } catch {
        return null;
    }
}

/**
 * Draw a section into its container.
 * @param {string} name Section name.
 * @param {object} section Section data.
 */
function show_section(name, section) {
    const container = document.getElementById(CONTAINER_IDS[name]);
    if (container) {
        RENDERERS[name](container, section);
        container.setAttribute("aria-busy", "false");
    }
}

/**
 * Refresh every due section, skipping any whose request is still running.
 * @param {object[]} definitions Section definitions.
 * @param {Set<string>} in_flight Names of sections currently refreshing.
 * @returns {Promise<void>}
 */
async function refresh_due_sections(definitions, in_flight) {
    await Promise.all(
        definitions.map(async (definition) => {
            if (in_flight.has(definition.name)) {
                return;
            }
            in_flight.add(definition.name);
            try {
                const { section, fetched } = await refresh_section(definition);
                if (fetched) {
                    show_section(definition.name, section);
                }
            } finally {
                in_flight.delete(definition.name);
            }
        }),
    );
}

/** Start the dashboard. */
function start_dashboard() {
    const redraw_schedule = start_schedule();
    const config = read_config();
    const definitions = config ? build_section_definitions(config) : [];

    definitions.forEach((definition) => {
        const cached = load_cached_section(definition.name, definition.signature);
        if (cached) {
            show_section(definition.name, cached);
        }
    });

    const in_flight = new Set();
    let displayed_day = new Date().toDateString();
    start_minute_ticker((moment) => {
        render_clock(moment);
        if (moment.toDateString() !== displayed_day) {
            displayed_day = moment.toDateString();
            redraw_schedule();
        }
        refresh_due_sections(definitions, in_flight);
    });
}

start_dashboard();
})(window.HomeDashboard = window.HomeDashboard || {});