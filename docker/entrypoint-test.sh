#!/usr/bin/env bash
# Tests of docker/minecraft-folder.sh (the server-folder part of entrypoint.sh): run in the repository root,
# `bash docker/entrypoint-test.sh`. No Docker, no real server: JAVA= is a fake, REPO= a fake applier (one case runs the real one).
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(dirname "$here")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failures=0

pass() { echo "ok - $1"; }
fail() { echo "not ok - $1: $2"; failures=$((failures + 1)); }

# new_image <program|none> prints a fresh /opt stand-in: server.jar, the mojang jar and, unless "none", server-source.json.
new_image() {
  local dir; dir=$(mktemp -d -p "$work")
  printf 'server jar' >"$dir/server.jar"
  printf 'mojang jar' >"$dir/mojang_1.21.4.jar"
  [[ "$1" == none ]] || printf '{\n  "program": "%s",\n  "version": "1.21.4"\n}' "$1" >"$dir/server-source.json"
  echo "$dir"
}

# fake_repo prints a stand-in for /opt/mine-ai-mcp whose applier records its arguments in $repo/applied.
fake_repo() {
  local dir; dir=$(mktemp -d -p "$work")
  mkdir -p "$dir/launcher/src/install"
  printf 'import { appendFileSync } from "node:fs";\nappendFileSync(new URL("../../../applied", import.meta.url), process.argv.slice(2).join(" ") + "\\n");\n' \
    >"$dir/launcher/src/install/paper-settings-cli.ts"
  echo "$dir"
}

# run_prepare <opt dir> <repo> <minecraft dir>: prepare_minecraft_folder in a fresh shell; stdout+stderr in $work/out, its status returned.
run_prepare() {
  OPT_DIR="$1" REPO="$2" MINECRAFT_DIR="$3" MINECRAFT_VERSION=1.21.4 bash -c 'source "$1/minecraft-folder.sh" && prepare_minecraft_folder' _ "$here" >"$work/out" 2>&1
}

# --- copies the mojang jar into an empty cache, applies the settings (the applier gets the minecraft folder) and leaves
# --- a world vanilla made to Paper (it moves the dimensions itself)
opt=$(new_image paper); repo=$(fake_repo); data="$work/data1"
mkdir -p "$data/world/DIM-1"
if run_prepare "$opt" "$repo" "$data" && [[ "$(cat "$data/cache/mojang_1.21.4.jar" 2>/dev/null)" == 'mojang jar' \
  && "$(cat "$repo/applied" 2>/dev/null)" == "$data" && -d "$data/world/DIM-1" && ! -e "$data/cache/mojang_1.21.4.jar.part" ]]; then
  pass 'copies the mojang jar into an empty cache and applies the settings'
else fail 'copies the mojang jar into an empty cache and applies the settings' "applied=$(cat "$repo/applied" 2>/dev/null) out=$(cat "$work/out")"; fi

# --- a cache jar already there is kept
opt=$(new_image paper); repo=$(fake_repo); data="$work/data2"
mkdir -p "$data/cache"; printf 'patched earlier' >"$data/cache/mojang_1.21.4.jar"
if run_prepare "$opt" "$repo" "$data" && [[ "$(cat "$data/cache/mojang_1.21.4.jar")" == 'patched earlier' ]]; then
  pass 'keeps the mojang jar already in the cache'
else fail 'keeps the mojang jar already in the cache' "$(cat "$work/out")"; fi

# --- the real applier writes Paper's two config files from packaging/paper-settings.json
opt=$(new_image paper); data="$work/data4"
if run_prepare "$opt" "$repo_root" "$data" && [[ -f "$data/spigot.yml" && -f "$data/config/paper-world-defaults.yml" && -f "$data/.paper-settings-digest" ]]; then
  pass 'the real applier writes the Paper config files'
else fail 'the real applier writes the Paper config files' "$(cat "$work/out")"; fi

# --- a failing applier stops the start
opt=$(new_image paper); repo=$(fake_repo); data="$work/data5"
printf 'process.exit(3);\n' >"$repo/launcher/src/install/paper-settings-cli.ts"
if ! run_prepare "$opt" "$repo" "$data" && grep -q 'Paper settings' "$work/out"; then
  pass 'a failing applier stops the start'
else fail 'a failing applier stops the start' "$(cat "$work/out")"; fi

# run_refuse <opt dir> <minecraft dir>: refuse_vanilla_on_paper_world in a fresh shell (the entrypoint runs it before docker/prepare.mjs writes anything).
run_refuse() {
  OPT_DIR="$1" MINECRAFT_DIR="$2" bash -c 'source "$1/minecraft-folder.sh" && refuse_vanilla_on_paper_world' _ "$here" >"$work/out" 2>&1
}

# --- refuses vanilla on a data folder with world_nether, naming the way back in Docker
opt=$(new_image vanilla); data="$work/data6"
mkdir -p "$data/world_nether/DIM-1"
refusal='This world has run on Paper, which keeps the Nether and the End in folders of their own (world_nether, world_the_end). Going back to vanilla is not offered yet: keep Paper, or move the world folders aside to start a new world on vanilla.'
if ! run_refuse "$opt" "$data" && grep -qF "$refusal" "$work/out" && grep -qF 'build the image without MINECRAFT_SERVER=vanilla' "$work/out" && [[ "$(ls "$data")" == world_nether ]]; then
  pass 'refuses vanilla on a data folder with world_nether'
else fail 'refuses vanilla on a data folder with world_nether' "$(cat "$work/out")"; fi

# --- a failed copy of the mojang jar leaves no jar in the cache and stops the start
opt=$(new_image paper); repo=$(fake_repo); data="$work/data6b"
fake_bin="$work/fake-bin"; mkdir -p "$fake_bin"
printf '#!/usr/bin/env bash\nprintf half >"${@: -1}"\nexit 1\n' >"$fake_bin/cp"; chmod +x "$fake_bin/cp"
if ! PATH="$fake_bin:$PATH" run_prepare "$opt" "$repo" "$data" && [[ ! -e "$data/cache/mojang_1.21.4.jar" && ! -e "$repo/applied" ]]; then
  pass 'a failed copy of the mojang jar leaves no jar in the cache'
else fail 'a failed copy of the mojang jar leaves no jar in the cache' "$(ls "$data/cache" 2>&1) $(cat "$work/out")"; fi

# --- vanilla on a vanilla world touches nothing of Paper's
opt=$(new_image vanilla); repo=$(fake_repo); data="$work/data7"
mkdir -p "$data/world"
if run_prepare "$opt" "$repo" "$data" && [[ ! -e "$repo/applied" && ! -e "$data/cache" ]]; then
  pass 'vanilla on a vanilla world adds no cache and no settings'
else fail 'vanilla on a vanilla world adds no cache and no settings' "$(cat "$work/out")"; fi

# --- an image without server-source.json (built before Paper) reads as vanilla
opt=$(new_image none); data="$work/data8"
mkdir -p "$data/world_nether"
if ! run_refuse "$opt" "$data" && grep -qF 'This world has run on Paper' "$work/out"; then
  pass 'an image without server-source.json reads as vanilla'
else fail 'an image without server-source.json reads as vanilla' "$(cat "$work/out")"; fi

# --- a Paper image is not refused on a world Paper has run
opt=$(new_image paper); data="$work/data8b"
mkdir -p "$data/world_nether"
if run_refuse "$opt" "$data"; then pass 'a Paper image is not refused on a world with world_nether'
else fail 'a Paper image is not refused on a world with world_nether' "$(cat "$work/out")"; fi

# --- the java line: JAVA= replaced by a fake, still -jar <image>/server.jar nogui in the minecraft folder
opt=$(new_image paper); data="$work/data10"; mkdir -p "$data"
fake_java="$work/fake-java"
printf '#!/usr/bin/env bash\necho "cwd=$PWD args=$*" >"%s/java-call"\n' "$work" >"$fake_java"; chmod +x "$fake_java"
log="$work/console.log"
if OPT_DIR="$opt" MINECRAFT_DIR="$data" MINECRAFT_LOG="$log" JAVA="$fake_java" JAVA_MEMORY=3G bash -c \
  'source "$1/minecraft-folder.sh"; exec 3</dev/null; launch_minecraft; wait "$java_pid"' _ "$here" \
  && [[ "$(cat "$work/java-call")" == "cwd=$data args=-Xmx3G -jar $opt/server.jar nogui" ]]; then
  pass 'launches java -jar server.jar nogui in the minecraft folder'
else fail 'launches java -jar server.jar nogui in the minecraft folder' "$(cat "$work/java-call" 2>&1)"; fi

echo "$failures failure(s)"
[[ "$failures" -eq 0 ]]
