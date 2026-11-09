#!/bin/sh
# Builds the signed release APK and writes latest.json for the in-app updater (ADR 0033 §14), into
# apps/android/release/downloads/ (git-ignored). Uploading is a separate, manual step with your own SSH key:
# this script only prints the command. Signing needs the key and password described in app/build.gradle.kts.
#
#   apps/android/scripts/publish-update.sh
set -eu
cd "$(dirname "$0")/.."

code=$(sed -n 's/^ *versionCode = \([0-9]*\)$/\1/p' app/build.gradle.kts)
name=$(sed -n 's/^ *versionName = "\([0-9.]*\)"$/\1/p' app/build.gradle.kts)
[ -n "$code" ] && [ -n "$name" ] || { echo "versionCode/versionName not found in app/build.gradle.kts" >&2; exit 1; }

./gradlew -q clean assembleRelease
out=release/downloads
mkdir -p "$out"
apk="durby-$name.apk"
cp app/build/outputs/apk/release/app-release.apk "$out/$apk"
sha=$(shasum -a 256 "$out/$apk" | cut -d' ' -f1)
printf '{\n  "versionCode": %s,\n  "versionName": "%s",\n  "apk": "%s",\n  "sha256": "%s"\n}\n' \
  "$code" "$name" "$apk" "$sha" > "$out/latest.json"

echo "Built $out/$apk (versionCode $code, sha256 $sha) and $out/latest.json."
echo "Upload the APK first, then latest.json (devices read latest.json and fetch the APK it names):"
echo "  scp $out/$apk <server>:/opt/durby/downloads/android/"
echo "  scp $out/latest.json <server>:/opt/durby/downloads/android/"
