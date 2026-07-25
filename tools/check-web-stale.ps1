# Used by build_and_run.bat to skip `npm install` + `npm run build` when
# nothing under web/ (excluding node_modules/build-output dirs) has changed
# since the last successful build - avoids paying that full step on every
# run for a C++-only change.
#
# Exit 0: web/ is unchanged, safe to skip the npm steps.
# Exit 1: rebuild needed (or anything about this check couldn't be trusted -
# deliberately conservative, since a false "skip" would silently ship a
# stale public/ instead of merely costing a slower rebuild).
$ErrorActionPreference = "Stop"
try {
    # Written unconditionally by web/shell/scripts/sync-dist.mjs on every
    # successful build - not public/index.html itself, since that (or any
    # single output file) might not get touched on a given build if its
    # own content happened not to change.
    $stampPath = Join-Path $PSScriptRoot "..\.web-build-stamp"
    if (-not (Test-Path $stampPath)) { exit 1 }
    $ref = (Get-Item $stampPath).LastWriteTimeUtc

    $webDir = Join-Path $PSScriptRoot "..\web"
    $newest = Get-ChildItem -Recurse -File $webDir -ErrorAction SilentlyContinue |
        Where-Object {
            $_.FullName -notmatch '\\node_modules\\' -and
            $_.FullName -notmatch '\\dist\\' -and
            $_.FullName -notmatch '\\\.vite-staging\\'
        } |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1 -ExpandProperty LastWriteTimeUtc

    if ($newest -and $newest -le $ref) { exit 0 } else { exit 1 }
} catch {
    exit 1
}
