#!/bin/sh
# Scheduled pg_dump for the `backup` Compose profile. A dump gets its final name only after
# pg_dump succeeds, so every homefit-*.dump in the directory is complete.
set -eu
interval=${BACKUP_INTERVAL_SECONDS:-86400}
keep=${BACKUP_KEEP:-14}
directory=${BACKUP_DIRECTORY:-/backups}
for number in "$interval" "$keep"; do
	case "$number" in
		'' | *[!0-9]* | 0*)
			echo 'backup: BACKUP_INTERVAL_SECONDS and BACKUP_KEEP must be positive integers' >&2
			exit 1
			;;
	esac
done
mkdir -p "$directory"
# Only left behind when an earlier run was killed in the middle of a dump.
rm -f "$directory"/.dump-*
temporary=
sleeper=
trap 'test -z "$temporary" || rm -f "$temporary"' EXIT
trap 'test -z "$sleeper" || kill "$sleeper" 2>/dev/null; exit 1' INT TERM
while :; do
	temporary=$(mktemp "$directory/.dump-XXXXXX")
	# pg_dump's custom format is compressed and directly restorable with pg_restore.
	if ! pg_dump --format=custom --compress=gzip:6 --file="$temporary"; then
		echo 'backup: pg_dump failed; no completed backup was published' >&2
		exit 1
	fi
	stamp=$(date -u +%Y%m%dT%H%M%S)
	destination="$directory/homefit-$stamp-${temporary##*-}.dump"
	mv "$temporary" "$destination"
	temporary=
	echo "backup: wrote $destination"
	# Our generated names contain no whitespace; don't prune unrelated files.
	ls -1t "$directory"/homefit-*.dump | tail -n +"$((keep + 1))" | while IFS= read -r old; do
		rm -- "$old"
	done
	if [ "${BACKUP_ONCE:-0}" = 1 ]; then break; fi
	# Waiting on a background sleep lets the shell handle a stop request immediately.
	sleep "$interval" &
	sleeper=$!
	wait "$sleeper"
	sleeper=
done
