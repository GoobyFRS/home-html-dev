#!/usr/bin/env bash
# deploy-homepage.sh
# Deploys the home-html-dev static site to /var/www/home-dev-goobyfrs-net/
# Follows NASA Power of 10 rules adapted for shell:
#   - Explicit error checking on every command (Rule 7)
#   - No unbounded loops; all loops have fixed, countable iterations (Rule 2)
#   - Minimal function complexity; each function does one thing (Rule 1)
#   - All variables initialized before use; strict mode enforced (Rule 6)
#   - Guard/assertion checks before destructive operations (Rule 7)
#   - No dynamic path construction from unvalidated input (Rule 5)

set -Eeuo pipefail
IFS=$'\n\t'

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
readonly REPO_DIR="/home/matt/GitHub/home-html-dev"
readonly INDEX_FILE="${REPO_DIR}/index.html"
readonly STATIC_DIR="${REPO_DIR}/static"
readonly WEB_ROOT="/var/www/home-dev-goobyfrs-net"
readonly CADDY_DIR="/etc/caddy"
readonly CADDY_CONFIG="${CADDY_DIR}/Caddyfile"
readonly WEB_OWNER="caddy:caddy"
readonly SCRIPT_NAME="$(basename -- "$0")"
readonly LOG_TIMESTAMP_FORMAT="+%Y-%m-%d %H:%M:%S"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
log_message() {
    local level="$1"
    local message="$2"
    local timestamp

    timestamp="$(date "${LOG_TIMESTAMP_FORMAT}")"
    message="${message//$'\r'/ }"
    message="${message//$'\n'/ }"
    printf '[%s] level=%s script=%s message=%s\n' \
        "$timestamp" "$level" "$SCRIPT_NAME" "$message"
}

log_info() {
    local message="$1"
    log_message "INFO" "$message"
}

log_error() {
    local message="$1"
    log_message "ERROR" "$message" >&2
}

on_error() {
    local exit_code="$1"
    local line_number="$2"
    log_error "event=deployment_failed exit_code=${exit_code} line=${line_number}"
}

# ---------------------------------------------------------------------------
# Assertions
# ---------------------------------------------------------------------------
assert_directory_exists() {
    local directory="$1"
    local label="$2"

    if [[ ! -d "$directory" ]]; then
        log_error "event=preflight_failed required_directory_missing label=${label} path=${directory}"
        return 1
    fi
}

assert_file_exists() {
    local file_path="$1"
    local label="$2"

    if [[ ! -f "$file_path" ]]; then
        log_error "event=validation_failed required_file_missing label=${label} path=${file_path}"
        return 1
    fi
}

assert_command_exists() {
    local command_name="$1"

    if ! command -v "$command_name" &>/dev/null; then
        log_error "event=preflight_failed required_command_missing command=${command_name}"
        return 1
    fi
}

# ---------------------------------------------------------------------------
# Deployment steps
# ---------------------------------------------------------------------------
preflight_checks() {
    log_info "event=preflight_started"

    assert_directory_exists "$REPO_DIR" "site repository"
    assert_directory_exists "$WEB_ROOT" "web root"
    assert_directory_exists "$CADDY_DIR" "Caddy configuration directory"
    assert_file_exists "$CADDY_CONFIG" "Caddy configuration"

    assert_command_exists git
    assert_command_exists sudo
    assert_command_exists caddy
    assert_command_exists python3

    log_info "event=preflight_passed"
}

sync_repository() {
    local repository_status

    log_info "event=repository_sync_started repository=${REPO_DIR}"
    repository_status="$(git -C "$REPO_DIR" status --porcelain --untracked-files=no)"

    if [[ -n "$repository_status" ]]; then
        log_error "event=repository_sync_failed reason=tracked_local_changes repository=${REPO_DIR}"
        return 1
    fi

    git -C "$REPO_DIR" pull --ff-only origin main
    log_info "event=repository_sync_passed repository=${REPO_DIR}"
}

generate_site() {
    log_info "event=site_generation_started repository=${REPO_DIR}"
    (
        cd "$REPO_DIR"
        python3 generate.py
    )
    log_info "event=site_generation_passed output_file=${INDEX_FILE}"
}

validate_site() {
    log_info "event=site_validation_started repository=${REPO_DIR}"
    assert_file_exists "$INDEX_FILE" "generated index"
    assert_directory_exists "$STATIC_DIR" "generated static assets"
    log_info "event=site_validation_passed"
}

deploy_site() {
    log_info "event=site_deployment_started web_root=${WEB_ROOT}"

    sudo install -d -m 0755 "$WEB_ROOT"
    sudo install -d -m 0755 "${WEB_ROOT}/static"
    sudo install -m 0644 "$INDEX_FILE" "${WEB_ROOT}/index.html"
    sudo cp -a "${STATIC_DIR}/." "${WEB_ROOT}/static/"

    log_info "event=site_deployment_passed web_root=${WEB_ROOT}"
}

fix_ownership() {
    log_info "event=ownership_update_started web_root=${WEB_ROOT} owner=${WEB_OWNER}"
    sudo chown -R "$WEB_OWNER" "$WEB_ROOT"
    log_info "event=ownership_update_passed owner=${WEB_OWNER}"
}

reload_caddy() {
    log_info "event=caddy_validation_started config=${CADDY_CONFIG}"
    sudo caddy validate --config "$CADDY_CONFIG"
    log_info "event=caddy_validation_passed"

    log_info "event=caddy_reload_started config=${CADDY_CONFIG}"
    sudo caddy reload --config "$CADDY_CONFIG"
    log_info "event=caddy_reload_passed"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
    if (( $# != 0 )); then
        log_error "event=usage_failed reason=script_accepts_no_arguments"
        return 64
    fi

    log_info "event=deployment_started"
    preflight_checks
    sync_repository
    generate_site
    validate_site
    deploy_site
    fix_ownership
    reload_caddy
    log_info "event=deployment_passed web_root=${WEB_ROOT}"
    return 0
}

trap 'on_error "$?" "$LINENO"' ERR
main "$@"
