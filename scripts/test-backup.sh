#!/bin/sh
# Run with the disposable stack already up; never connects to the main database.
set -eu
cd "$(dirname "$0")/.."
root=$(pwd)
dumps=$(mktemp -d)
psql_test() { docker compose -f compose.test.yaml exec -T db psql -U homefit -v ON_ERROR_STOP=1 "$@"; }
cleanup() {
	psql_test -d homefit_test \
		-c 'DROP DATABASE IF EXISTS homefit_backup_fixture' \
		-c 'DROP DATABASE IF EXISTS homefit_backup_restore' >/dev/null
	rm -rf "$dumps"
}
trap cleanup EXIT
trap 'exit 1' INT TERM
[ "$(psql_test -At -d homefit_test -c 'SELECT current_database()')" = homefit_test ]
psql_test -d homefit_test \
	-c 'CREATE DATABASE homefit_backup_fixture' \
	-c 'CREATE DATABASE homefit_backup_restore' >/dev/null
psql_test -d homefit_backup_fixture -c "CREATE TABLE synthetic(id integer PRIMARY KEY, label text); INSERT INTO synthetic VALUES (1, 'synthetic fixture');" >/dev/null
run_backup() {
	docker run --rm --network homefit-test_default \
		-e PGHOST=db -e PGUSER=homefit -e PGPASSWORD=homefittest -e PGDATABASE="$1" \
		-e BACKUP_ONCE=1 -e BACKUP_KEEP=2 \
		-v "$root/scripts/backup.sh:/backup.sh:ro" -v "$dumps:/backups" \
		postgres:18-alpine sh /backup.sh
}
for iteration in 1 2 3; do run_backup homefit_backup_fixture; done
[ "$(find "$dumps" -name '*.dump' | wc -l)" -eq 2 ]
latest=$(ls -t "$dumps"/*.dump | head -n 1)
docker run --rm --network homefit-test_default \
	-e PGHOST=db -e PGUSER=homefit -e PGPASSWORD=homefittest \
	-v "$dumps:/backups:ro" postgres:18-alpine \
	pg_restore -d homefit_backup_restore --exit-on-error --no-owner "/backups/${latest##*/}"
[ "$(psql_test -At -d homefit_backup_restore -c 'SELECT label FROM synthetic WHERE id=1')" = 'synthetic fixture' ]
if run_backup does_not_exist; then
	echo 'Expected failed pg_dump' >&2
	exit 1
fi
[ "$(find "$dumps" -name '*.dump' | wc -l)" -eq 2 ]
[ "$(find "$dumps" -name '.dump-*' | wc -l)" -eq 0 ]
echo 'PASS: compressed dump, retention (2/3), scratch restore, failed dump cleanup'
