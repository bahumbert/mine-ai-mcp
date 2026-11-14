#!/usr/bin/env bash
# Sourced by entrypoint.sh: the Minecraft server folder and process. Tested by docker/entrypoint-test.sh.
# Paths come from the environment so the test can point them at a temporary folder:
#   OPT_DIR (the image's server files, /opt), REPO (the checkout in the image), MINECRAFT_DIR (the bind-mounted server
#   folder), JAVA, JAVA_MEMORY, MINECRAFT_VERSION, MINECRAFT_LOG.

# The program of the image's server.jar: what docker/download-server.mjs wrote into server-source.json; an image built
# before Paper has no program in it and runs vanilla.
image_server_program() {
  if grep -q '"program": "paper"' "${OPT_DIR:-/opt}/server-source.json" 2>/dev/null; then echo paper; else echo vanilla; fi
}

# A vanilla image on a folder Paper has split into world_nether/ is refused (spec 2026-11-14 D7). The entrypoint runs
# this before docker/prepare.mjs, so a refused start leaves no run or attempt record.
refuse_vanilla_on_paper_world() {
  [[ "$(image_server_program)" == vanilla && -e "${MINECRAFT_DIR:-/data/minecraft}/world_nether" ]] || return 0
  echo 'This world has run on Paper, which keeps the Nether and the End in folders of their own (world_nether, world_the_end). Going back to vanilla is not offered yet: keep Paper, or move the world folders aside to start a new world on vanilla. In Docker: build the image without MINECRAFT_SERVER=vanilla to keep Paper, or move world_nether and world_the_end out of the data folder (minecraft/ in the run folder).' >&2
  return 1
}

# Makes /data/minecraft ready for a Paper image: the Mojang jar goes into the cache folder when absent (Paperclip then
# downloads nothing; copied under a temporary name so a killed copy never leaves half a jar there) and Paper's settings
# are applied (spec 2026-11-14 D2). A vanilla image needs nothing.
prepare_minecraft_folder() {
  local opt=${OPT_DIR:-/opt} repo=${REPO:-/opt/mine-ai-mcp} dir=${MINECRAFT_DIR:-/data/minecraft}
  mkdir -p "$dir"
  [[ "$(image_server_program)" == paper ]] || return 0
  local mojang="$dir/cache/mojang_${MINECRAFT_VERSION}.jar"
  mkdir -p "$dir/cache"
  if [[ ! -e "$mojang" ]]; then
    cp "$opt/mojang_${MINECRAFT_VERSION}.jar" "$mojang.part" && mv "$mojang.part" "$mojang" \
      || { rm -f "$mojang.part"; echo "The Mojang jar could not be copied to $mojang" >&2; return 1; }
  fi
  bun "$repo/launcher/src/install/paper-settings-cli.ts" "$dir" >&2 || { echo "Paper settings could not be applied to $dir (see above)" >&2; return 1; }
}

# Starts the server in the background with its console on fd 3 and its output in $MINECRAFT_LOG; sets java_pid.
launch_minecraft() {
  (
    cd "${MINECRAFT_DIR:-/data/minecraft}" || exit 1
    exec "${JAVA:-java}" "-Xmx${JAVA_MEMORY:-2G}" -jar "${OPT_DIR:-/opt}/server.jar" nogui <&3 >"$MINECRAFT_LOG" 2>"$MINECRAFT_LOG.stderr"
  ) &
  java_pid=$!
}
