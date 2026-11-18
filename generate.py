#!/usr/bin/env python3

"""Render index.html from meta.yml and a Jinja template.

Open the generated ``index.html`` directly in a browser; no web server is
needed. The page loads ``static/styles.css`` and the consolidated
``static/main.js`` bundle from this repository, then fetches its own live data.

API keys from ``.env`` are embedded in ``index.html`` so the browser can call
Linode directly. That file is therefore git-ignored, and this script refuses
to embed keys while git tracks it.
"""

import os
import re
import subprocess
import sys
import urllib.parse
from datetime import date, datetime
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:
    yaml = None

try:
    from jinja2 import (
        Environment,
        FileSystemLoader,
        StrictUndefined,
        TemplateError,
        select_autoescape,
    )
except ImportError:
    Environment = None
    FileSystemLoader = None
    StrictUndefined = None
    TemplateError = None
    select_autoescape = None


BASE_DIR = Path(__file__).resolve().parent
META_FILE = BASE_DIR / "meta.yml"
ENV_FILE = BASE_DIR / ".env"
TEMPLATE_DIR = BASE_DIR / "templates"
OUTPUT_FILE = BASE_DIR / "index.html"
LOG_FILE = BASE_DIR / "latest.log"
LOG_TIMESTAMP_FORMAT = "%Y-%m-%d %H:%M:%S"
LOG_LEVELS = frozenset(("INFO", "WARNING", "ERROR"))

OPTIONAL_METADATA_TEXT_FIELDS = (
    "title",
    "favicon",
    "header_img",
    "background_img",
)
ASSET_PATH_PATTERN = re.compile(r"^/?[A-Za-z0-9._/-]+$")
SYMBOL_PATTERN = re.compile(r"^[A-Z0-9.^=-]{1,12}$")
ZIP_PATTERN = re.compile(r"^\d{5}$")
NUMERIC_ID_PATTERN = re.compile(r"^\d{1,20}$")
DEFAULT_TITLE = "Home"
# Minutes each data source stays cached in the browser before it is fetched
# again. Overridable per section under ``refresh_minutes`` in meta.yml.
DEFAULT_REFRESH_MINUTES: dict[str, int] = {
    "weather": 30,
    "stocks": 60,
    "rss": 30,
    "linode": 15,
}
MAX_REFRESH_MINUTES = 1440
DEFAULT_RSS_ITEMS = 8
MAX_RSS_ITEMS = 30
MAX_WEATHER_LOCATIONS = 6
MAX_STOCK_SYMBOLS = 12
MAX_RSS_FEEDS = 10
MAX_TASKS = 30
# MAX_SERVICES = 100  # Unused: the old "services" schema was replaced.


def _sanitize_log_text(message: str) -> str:
    """Return one-line log text without control characters."""
    return " ".join(message.replace("\r", " ").replace("\n", " ").split())


def write_log(message: str, level: str = "INFO") -> None:
    """Append a timestamped generator event to the log.

    Args:
        message: Human-readable event or error description.
        level: Structured log level: INFO, WARNING, or ERROR.

    Raises:
        ValueError: If the log level is unsupported.
        OSError: If the log file cannot be opened or written.
    """
    normalized_level = level.upper()
    if normalized_level not in LOG_LEVELS:
        raise ValueError(f"Unsupported log level: {level}")

    timestamp = datetime.now().strftime(LOG_TIMESTAMP_FORMAT)
    safe_message = _sanitize_log_text(message)
    with LOG_FILE.open("a", encoding="utf-8") as log_handle:
        log_handle.write(
            f"{timestamp} - GENERATE - level={normalized_level} "
            f"message={safe_message}\n"
        )

# The previous "services" schema is unused by the homepage; kept for reference.
# def _validate_services(metadata: dict[str, Any]) -> None:
#     """Validate optional service data in the metadata mapping."""
#     services = metadata.get("services")
#     if services is None:
#         return
#     if not isinstance(services, dict):
#         raise ValueError("meta.yml field 'services' must be a mapping")
#     if len(services) > MAX_SERVICES:
#         raise ValueError(f"meta.yml contains more than {MAX_SERVICES} services")
#     ... (per-service name/description/price checks)


def _optional_mapping(metadata: dict[str, Any], field_name: str) -> dict[str, Any]:
    """Return an optional mapping field, or raise if it has another type."""
    value = metadata.get(field_name)
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError(f"meta.yml field '{field_name}' must be a mapping")
    return value


def _mapping_or_list_values(
    metadata: dict[str, Any],
    field_name: str,
    maximum: int,
) -> list[Any]:
    """Return values from a mapping (``key1: x``) or list field."""
    value = metadata.get(field_name)
    if value is None:
        return []
    if isinstance(value, dict):
        values = list(value.values())
    elif isinstance(value, list):
        values = value
    else:
        raise ValueError(f"meta.yml field '{field_name}' must be a mapping or list")
    if len(values) > maximum:
        raise ValueError(f"meta.yml field '{field_name}' allows at most {maximum} entries")
    return values


def _validate_http_url(value: Any, field_name: str) -> str:
    """Validate an absolute http(s) URL and return it stripped."""
    if not isinstance(value, str):
        raise ValueError(f"{field_name} must be a URL string")
    parsed_url = urllib.parse.urlparse(value.strip())
    if parsed_url.scheme not in ("http", "https") or not parsed_url.netloc:
        raise ValueError(f"{field_name} must be an absolute http(s) URL")
    return value.strip()


def _validate_zip_codes(metadata: dict[str, Any]) -> list[str]:
    """Return validated five-digit ZIP codes from the ``weather`` field."""
    zip_codes = []
    for raw_zip in _mapping_or_list_values(metadata, "weather", MAX_WEATHER_LOCATIONS):
        # YAML reads an unquoted 02134 as the octal integer 1116, so any
        # integer below 10000 is rejected rather than silently corrupted.
        if isinstance(raw_zip, int) and not isinstance(raw_zip, bool) and raw_zip < 10000:
            raise ValueError(
                f"ZIP code {raw_zip!r} is ambiguous; quote ZIPs with a leading zero"
            )
        zip_code = str(raw_zip).strip()
        if not ZIP_PATTERN.match(zip_code):
            raise ValueError(f"Invalid ZIP code {raw_zip!r}")
        zip_codes.append(zip_code)
    return zip_codes


def _validate_stock_symbols(metadata: dict[str, Any]) -> list[str]:
    """Return validated upper-case ticker symbols from ``fin_stock``."""
    symbols = []
    for raw_symbol in _mapping_or_list_values(metadata, "fin_stock", MAX_STOCK_SYMBOLS):
        symbol = str(raw_symbol).strip().upper()
        if not SYMBOL_PATTERN.match(symbol):
            raise ValueError(f"Invalid stock ticker {raw_symbol!r}")
        symbols.append(symbol)
    return symbols


def _validate_rss(metadata: dict[str, Any]) -> tuple[list[str], int]:
    """Return validated feed URLs and the maximum number of entries."""
    rss = _optional_mapping(metadata, "rss")
    raw_feeds = rss.get("feeds") or []
    if not isinstance(raw_feeds, list) or len(raw_feeds) > MAX_RSS_FEEDS:
        raise ValueError(f"rss.feeds must be a list of at most {MAX_RSS_FEEDS} URLs")
    feeds = [_validate_http_url(feed, "rss.feeds entry") for feed in raw_feeds]

    max_items = rss.get("max_items", DEFAULT_RSS_ITEMS)
    if isinstance(max_items, bool) or not isinstance(max_items, int):
        raise ValueError("rss.max_items must be an integer")
    if not 1 <= max_items <= MAX_RSS_ITEMS:
        raise ValueError(f"rss.max_items must be between 1 and {MAX_RSS_ITEMS}")
    return feeds, max_items


def _validate_refresh_minutes(metadata: dict[str, Any]) -> dict[str, int]:
    """Return per-section refresh intervals (minutes) with defaults applied."""
    configured = _optional_mapping(metadata, "refresh_minutes")
    unknown_sections = set(configured) - set(DEFAULT_REFRESH_MINUTES)
    if unknown_sections:
        raise ValueError(
            "Unknown refresh_minutes section(s): "
            + ", ".join(sorted(str(name) for name in unknown_sections))
        )

    refresh = dict(DEFAULT_REFRESH_MINUTES)
    for section_name, minutes in configured.items():
        if isinstance(minutes, bool) or not isinstance(minutes, int):
            raise ValueError(f"refresh_minutes.{section_name} must be an integer")
        if not 1 <= minutes <= MAX_REFRESH_MINUTES:
            raise ValueError(
                f"refresh_minutes.{section_name} must be between 1 and "
                f"{MAX_REFRESH_MINUTES}"
            )
        refresh[section_name] = minutes
    return refresh


def _validate_tasks(metadata: dict[str, Any]) -> list[dict[str, Any]]:
    """Return normalized tasks with display values and completion state.

    Returns:
        A list of mappings with ``title``, ``due`` (ISO date or ``""``),
        ``due_label`` (a screen-reader-friendly date), and ``done``.
    """
    raw_tasks = metadata.get("tasks") or []
    if not isinstance(raw_tasks, list) or len(raw_tasks) > MAX_TASKS:
        raise ValueError(f"meta.yml field 'tasks' must be a list of at most {MAX_TASKS}")

    tasks = []
    for raw_task in raw_tasks:
        task_fields = raw_task if isinstance(raw_task, dict) else {"title": raw_task}
        title = task_fields.get("title")
        if not isinstance(title, str) or not title.strip():
            raise ValueError("Each task needs a non-empty title")

        raw_due = task_fields.get("due")
        due_date = None
        if isinstance(raw_due, date):
            due_date = raw_due
        elif raw_due is not None:
            try:
                due_date = date.fromisoformat(str(raw_due))
            except ValueError as error:
                raise ValueError(
                    f"Task due date must be YYYY-MM-DD: {raw_due!r}"
                ) from error
        tasks.append(
            {
                "title": title.strip(),
                "due": due_date.isoformat() if due_date else "",
                "due_label": (
                    f"{due_date.strftime('%B')} {due_date.day}, {due_date.year}"
                    if due_date
                    else ""
                ),
                "done": task_fields.get("done") is True,
            }
        )
    return tasks


def _validate_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    """Validate and normalize loaded website metadata."""
    template_name = metadata.get("template")
    if not isinstance(template_name, str) or not template_name.strip():
        raise ValueError("meta.yml must define a non-empty template name")

    normalized_metadata = dict(metadata)
    normalized_metadata["template"] = template_name.strip()

    for field_index in range(len(OPTIONAL_METADATA_TEXT_FIELDS)):
        field_name = OPTIONAL_METADATA_TEXT_FIELDS[field_index]
        field_value = normalized_metadata.get(field_name)
        if field_value is None:
            continue
        if not isinstance(field_value, str):
            raise ValueError(
                f"meta.yml field '{field_name}' must be a string"
            )
        if not field_value.strip():
            raise ValueError(
                f"meta.yml field '{field_name}' must not be empty"
            )
        if field_name != "title":
            asset_path = field_value.strip()
            if not ASSET_PATH_PATTERN.match(asset_path) or ".." in asset_path:
                raise ValueError(f"meta.yml field '{field_name}' is not a safe path")
            # Relative paths keep the site working from any URL prefix.
            normalized_metadata[field_name] = asset_path.lstrip("/")

    normalized_metadata["title"] = (
        str(normalized_metadata.get("title") or DEFAULT_TITLE).strip()
    )
    for asset_field in ("favicon", "header_img", "background_img"):
        normalized_metadata[asset_field] = normalized_metadata.get(asset_field) or ""
    normalized_metadata["weather_zips"] = _validate_zip_codes(metadata)
    normalized_metadata["stock_symbols"] = _validate_stock_symbols(metadata)
    feeds, max_items = _validate_rss(metadata)
    normalized_metadata["rss_feeds"] = feeds
    normalized_metadata["rss_max_items"] = max_items
    normalized_metadata["refresh_minutes"] = _validate_refresh_minutes(metadata)
    normalized_metadata["tasks"] = _validate_tasks(metadata)

    map_config = _optional_mapping(metadata, "map")
    map_url = map_config.get("url")
    normalized_metadata["map_url"] = (
        _validate_http_url(map_url, "map.url") if map_url else ""
    )
    normalized_metadata["map_title"] = str(map_config.get("title") or "Map")

    return normalized_metadata


def load_metadata() -> dict[str, Any]:
    """Load and validate metadata for the static site.

    Returns:
        A normalized metadata mapping.

    Raises:
        RuntimeError: If PyYAML is missing or metadata parsing fails.
        ValueError: If metadata is not a valid mapping or has invalid fields.
    """
    if yaml is None:
        raise RuntimeError("Missing required dependency: PyYAML")

    try:
        with META_FILE.open("r", encoding="utf-8") as metadata_handle:
            loaded_metadata = yaml.safe_load(metadata_handle)
    except yaml.YAMLError as error:
        raise RuntimeError(f"Invalid meta.yml: {error}") from error
    except UnicodeDecodeError as error:
        raise RuntimeError("meta.yml must be UTF-8 encoded") from error

    if not isinstance(loaded_metadata, dict):
        raise ValueError("meta.yml must contain a YAML mapping")

    return _validate_metadata(loaded_metadata)


def resolve_template(template_name: str) -> str:
    """Resolve a template name within the templates directory.

    Args:
        template_name: Relative template filename or subdirectory path.

    Returns:
        A POSIX-relative template path.

    Raises:
        ValueError: If the name is empty, unsafe, or not an HTML template.
        FileNotFoundError: If the resolved template file does not exist.
    """
    if not isinstance(template_name, str) or not template_name.strip():
        raise ValueError("Template name must be a non-empty string")

    template_path = (TEMPLATE_DIR / template_name.strip()).resolve()
    templates_root = TEMPLATE_DIR.resolve()

    try:
        relative_template_path = template_path.relative_to(templates_root)
    except ValueError as error:
        raise ValueError(
            "Template path must stay inside the templates directory"
        ) from error

    if template_path.suffix.lower() != ".html":
        raise ValueError("Template must be an HTML file")
    if not template_path.is_file():
        raise FileNotFoundError(f"Template not found: {template_path}")

    return relative_template_path.as_posix()


def _create_template_environment() -> Any:
    """Create the Jinja environment after verifying dependencies."""
    if (
        Environment is None
        or FileSystemLoader is None
        or StrictUndefined is None
        or TemplateError is None
        or select_autoescape is None
    ):
        raise RuntimeError("Missing required dependency: Jinja2")

    return Environment(
        loader=FileSystemLoader(str(TEMPLATE_DIR)),
        autoescape=select_autoescape(enabled_extensions=("html", "xml")),
        undefined=StrictUndefined,
        trim_blocks=True,
        lstrip_blocks=True,
    )


def load_environment(env_file: Path = ENV_FILE) -> dict[str, str]:
    """Return process environment variables merged with an optional ``.env``.

    Real environment variables take precedence over the file. Lines are
    ``KEY=value``; blank lines and ``#`` comments are ignored.

    Args:
        env_file: Path of the dotenv-style file.

    Returns:
        A new mapping of environment variables.
    """
    environment: dict[str, str] = {}
    try:
        lines = env_file.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        lines = []
    except OSError as error:
        raise OSError(f"Unable to read {env_file.name}: {error}") from error

    for line in lines:
        stripped_line = line.strip()
        if not stripped_line or stripped_line.startswith("#"):
            continue
        key, separator, value = stripped_line.partition("=")
        if separator and key.strip():
            environment[key.strip()] = value.strip().strip("'\"")

    environment.update(os.environ)
    return environment


def _is_tracked_by_git(file_path: Path) -> bool:
    """Return True if git tracks ``file_path``; False if not or git is absent."""
    try:
        result = subprocess.run(
            ["git", "ls-files", "--error-unmatch", file_path.name],
            cwd=file_path.parent,
            capture_output=True,
            check=False,
            timeout=10,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def _numeric_or_empty(value: str, name: str) -> str:
    """Return ``value`` if it is a numeric ID, or "" (with a warning) if not."""
    if not value:
        return ""
    if NUMERIC_ID_PATTERN.match(value):
        return value
    write_log(f"{name} must be numeric; ignoring it.", level="WARNING")
    return ""


def build_client_config(
    metadata: dict[str, Any],
    environment: dict[str, str],
) -> dict[str, Any]:
    """Build the settings the browser needs, embedded in the page as JSON.

    This includes API keys read from the environment, so the result must
    only ever be written to a git-ignored file.

    Args:
        metadata: Validated metadata from ``load_metadata``.
        environment: Environment variables (see ``load_environment``).

    Returns:
        A JSON-serializable mapping read by ``static/main.js``.
    """
    credentials = {
        "linode_token": environment.get("LINODE_RO_API", ""),
        "linode_id": _numeric_or_empty(
            environment.get("LINODE_COMPUTE_ID", ""), "LINODE_COMPUTE_ID"
        ),
    }
    return {
        "weather_zips": metadata["weather_zips"],
        "stock_symbols": metadata["stock_symbols"],
        "refresh_minutes": metadata["refresh_minutes"],
        "linode_enabled": bool(credentials["linode_token"] and credentials["linode_id"]),
        "credentials": credentials,
    }


def _render_template(
    environment: Any,
    safe_template_name: str,
    metadata: dict[str, Any],
    client_config: dict[str, Any],
) -> str:
    """Render one template and convert template errors to runtime errors."""
    if TemplateError is None:
        raise RuntimeError("Missing required dependency: Jinja2")

    try:
        template = environment.get_template(safe_template_name)
        return template.render(meta=metadata, client_config=client_config)
    except TemplateError as error:
        raise RuntimeError(f"Template rendering failed: {error}") from error


def _write_if_changed(output_path: Path, content: str) -> bool:
    """Atomically write a text file unless it already has this content.

    Leaving an unchanged file alone keeps its modification time, so Caddy
    keeps answering browser revalidation requests with a tiny 304 response.

    Args:
        output_path: Destination file.
        content: Text to write (UTF-8).

    Returns:
        True if the file was written, False if it was already up to date.

    Raises:
        OSError: If the file cannot be read or written.
    """
    if output_path.is_file() and output_path.read_text(encoding="utf-8") == content:
        return False

    temporary_path = output_path.with_name(f".{output_path.name}.tmp")
    try:
        temporary_path.write_text(content, encoding="utf-8")
        temporary_path.replace(output_path)
    except OSError:
        temporary_path.unlink(missing_ok=True)
        raise
    return True


def generate_site() -> None:
    """Render ``index.html`` and the Caddy snippet from ``meta.yml``.

    Raises:
        RuntimeError: If dependencies or template rendering fail.
        ValueError: If metadata or template configuration is invalid.
        OSError: If files cannot be written.
    """
    template_environment = _create_template_environment()
    metadata = load_metadata()
    safe_template_name = resolve_template(metadata["template"])
    client_config = build_client_config(metadata, load_environment())

    has_credentials = any(client_config["credentials"].values())
    if has_credentials and _is_tracked_by_git(OUTPUT_FILE):
        raise ValueError(
            f"{OUTPUT_FILE.name} is tracked by git but would contain API keys; "
            f"run 'git rm --cached {OUTPUT_FILE.name}' first"
        )

    output = _render_template(
        template_environment,
        safe_template_name,
        metadata,
        client_config,
    )
    _write_if_changed(OUTPUT_FILE, output)
    if has_credentials:
        write_log(
            f"{OUTPUT_FILE.name} contains API keys; keep it out of version control.",
            level="WARNING",
        )


def _format_error(error: BaseException) -> str:
    """Return a concise, one-line error message."""
    message = str(error).strip()
    return message or error.__class__.__name__


def main() -> int:
    """Reset the build log, generate the site, and report the result.

    Returns:
        Zero for success, or one for a generation failure.
    """
    try:
        LOG_FILE.write_text("", encoding="utf-8")
    except OSError as error:
        print(
            f"Unable to reset {LOG_FILE}: {_format_error(error)}",
            file=sys.stderr,
        )
        return 1

    try:
        generate_site()
    except (OSError, RuntimeError, ValueError) as error:
        message = _format_error(error)
        try:
            write_log(message, level="ERROR")
        except OSError as log_error:
            print(
                f"Unable to write {LOG_FILE}: {_format_error(log_error)}",
                file=sys.stderr,
            )
        print(f"Generation failed: {message}", file=sys.stderr)
        return 1

    try:
        write_log("Site generated successfully.", level="INFO")
    except (OSError, ValueError) as error:
        print(
            f"Unable to write {LOG_FILE}: {_format_error(error)}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
