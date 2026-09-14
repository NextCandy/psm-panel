#!/usr/bin/env bash
# M0 end to end, on a test VPS (needs Docker; expects proxy-stack and psm-panel
# checked out side by side under $W, default /root/w): PSM with a few nodes, psm-api on loopback,
# and the panel Worker under `wrangler dev` in the same network namespace (as
# cloudflared would be in production), so psm-api is reached only on 127.0.0.1.
set -uo pipefail
W=${W:-/root/w}; P=$W/proxy-stack; N=$W/psm-panel
pass=0; fail=0
ok()  { echo "  ok   $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL $1"; fail=$((fail + 1)); }
chk() { local n="$1"; shift; if "$@" >/tmp/m0.out 2>&1; then ok "$n"; else bad "$n"; tail -8 /tmp/m0.out | sed 's/^/       /'; fi; }
sec() { echo; echo "=== $1"; }

C=psm-m0; K=psm-m0-worker
cleanup() { docker rm -f "$C" "$K" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

sec "psm-api: vet, unit tests, static build"
rm -f $P/api/psm-api
chk "go vet + go test + static build" docker run --rm -v $P/api:/src -w /src -e CGO_ENABLED=0 golang:alpine \
    sh -c 'go vet ./... && go test -count=1 ./... && go build -trimpath -ldflags "-s -w" -o psm-api .'
chk "the binary is static" bash -c "file $P/api/psm-api | grep -q 'statically linked'"

sec "PSM with three nodes"
source $P/tests/integration/container.sh
it_start debian "$C" && it_copy_tree "$C"
chk "install.sh" docker exec "$C" bash -c 'cd /opt/psm && printf "1\n0\n0\n0\n0\n" | timeout 900 bash install.sh'
# no core is installed here, so protocols that need a core to generate keys
# (REALITY) are left out: M0 is about the path, not the protocols
for spec in "xray ss2022 --tag m0-xr-ss --port 31001" "sing-box ss2022 --tag m0-sb-ss --port 31002" "mihomo ss2022 --tag m0-mh-ss --port 31003"; do
    chk "store-only node: $spec" docker exec "$C" bash -c "psm node add $spec --store-only --skip-dest-probe --json | grep -qE '\"status\": ?\"created\"'"
done
docker exec "$C" psm node list --json > $W/nodes.cli.json

sec "psm-api on loopback"
docker cp $P/api/psm-api "$C":/usr/local/bin/psm-api
TOKEN=$(head -c 48 /dev/urandom | base64 | tr -d '/+=\n' | head -c 48)
HASH=$(printf '%s' "$TOKEN" | $P/api/psm-api -hash-token)
docker exec "$C" bash -c "mkdir -p /etc/psm && printf '{\"listen\":\"127.0.0.1:9870\",\"token_sha256\":\"%s\",\"psm\":\"/usr/local/bin/psm\"}\n' $HASH > /etc/psm/api.json && chmod 600 /etc/psm/api.json"
docker exec -d "$C" bash -c 'psm-api -config /etc/psm/api.json > /var/log/psm-api.log 2>&1'
sleep 1
chk "listens on 127.0.0.1:9870 only" docker exec "$C" bash -c "ss -ltn | grep -q '127.0.0.1:9870' && ! ss -ltn | grep -qE '(0\.0\.0\.0|\*|\[::\]):9870'"
chk "refuses a non-loopback listen address" docker exec "$C" bash -c "printf '{\"listen\":\"0.0.0.0:9871\",\"token_sha256\":\"%s\"}' $HASH > /tmp/bad.json; ! psm-api -config /tmp/bad.json 2>&1 | grep -q listening"
api() { docker exec "$C" curl -s -o /dev/null -w '%{http_code}' "$@"; }
chk "no token → 401"    test "$(api http://127.0.0.1:9870/v1/health)" = 401
chk "wrong token → 401" test "$(api -H 'Authorization: Bearer wrong' http://127.0.0.1:9870/v1/nodes)" = 401
chk "right token → 200" test "$(api -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9870/v1/health)" = 200
chk "unknown core → 400" test "$(api -H "Authorization: Bearer $TOKEN" 'http://127.0.0.1:9870/v1/nodes?core=v2ray')" = 400
docker exec "$C" curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9870/v1/nodes > $W/nodes.api.json
chk "psm-api /v1/nodes = psm node list --json" bash -c "diff <(jq -S . $W/nodes.cli.json) <(jq -S . $W/nodes.api.json)"
chk "the request log has no token" docker exec "$C" bash -c "grep -q 'GET /v1/nodes' /var/log/psm-api.log && ! grep -q '$TOKEN' /var/log/psm-api.log"

sec "panel Worker (wrangler dev, same network namespace)"
rm -rf $N/.wrangler   # local D1 from an earlier run holds rows encrypted with an old TOKEN_KEY
docker run -d --name "$K" --network container:"$C" -v $N:/app -w /app node:22 sleep infinity >/dev/null
chk "npm install" docker exec "$K" npm install --no-audit --no-fund
chk "typecheck (tsc --noEmit)" docker exec "$K" npx tsc --noEmit
docker exec "$K" sh -c "printf 'TOKEN_KEY=%s\nALLOW_HTTP_API=1\n' \$(head -c 32 /dev/urandom | base64) > .dev.vars"
chk "D1 migrations (local)" docker exec "$K" npx wrangler d1 migrations apply psm-panel --local
docker exec -d "$K" sh -c 'npx wrangler dev --ip 127.0.0.1 --port 8787 > /tmp/wrangler-dev.log 2>&1'
for _ in $(seq 1 60); do [[ "$(docker exec "$C" curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/api/servers)" == 200 ]] && break; sleep 2; done
p() { docker exec "$C" curl -s "$@"; }
pc() { docker exec "$C" curl -s -o /dev/null -w '%{http_code}' "$@"; }
chk "panel is up" test "$(pc http://127.0.0.1:8787/api/servers)" = 200
chk "panel page served" bash -c "docker exec $C curl -s http://127.0.0.1:8787/ | grep -q 'PSM Panel'"
J='Content-Type: application/json'
chk "add server → 201" test "$(pc -X POST -H "$J" -d "{\"name\":\"m0\",\"api_url\":\"http://127.0.0.1:9870\",\"api_token\":\"$TOKEN\"}" http://127.0.0.1:8787/api/servers)" = 201
chk "same name again → 409" test "$(pc -X POST -H "$J" -d "{\"name\":\"m0\",\"api_url\":\"http://127.0.0.1:9870\",\"api_token\":\"$TOKEN\"}" http://127.0.0.1:8787/api/servers)" = 409
chk "ftp:// url → 400" test "$(pc -X POST -H "$J" -d "{\"name\":\"x\",\"api_url\":\"ftp://127.0.0.1\",\"api_token\":\"$TOKEN\"}" http://127.0.0.1:8787/api/servers)" = 400
chk "short token → 400" test "$(pc -X POST -H "$J" -d '{"name":"y","api_url":"http://127.0.0.1:9870","api_token":"short"}' http://127.0.0.1:8787/api/servers)" = 400
chk "server list does not return the token" bash -c "out=\$(docker exec $C curl -s http://127.0.0.1:8787/api/servers); grep -q '\"name\":\"m0\"' <<<\"\$out\" && ! grep -qi 'token' <<<\"\$out\""
chk "panel health → psm-api" bash -c "docker exec $C curl -s http://127.0.0.1:8787/api/servers/1/health | grep -q api_version"
p http://127.0.0.1:8787/api/servers/1/nodes > $W/nodes.panel.json
chk "panel nodes = psm node list --json" bash -c "diff <(jq -S . $W/nodes.cli.json) <(jq -S . $W/nodes.panel.json)"
docker exec "$C" psm node list --json --core mihomo > $W/nodes.cli.mihomo.json
p 'http://127.0.0.1:8787/api/servers/1/nodes?core=mihomo' > $W/nodes.panel.mihomo.json
chk "panel core filter = psm node list --json --core mihomo" bash -c "diff <(jq -S . $W/nodes.cli.mihomo.json) <(jq -S . $W/nodes.panel.mihomo.json) && jq -e '.count == 1 and (.items | length) == 1 and .items[0].core == \"mihomo\"' $W/nodes.panel.mihomo.json"
WRONG=$(head -c 48 /dev/urandom | base64 | tr -d '/+=\n' | head -c 48)
p -X POST -H "$J" -d "{\"name\":\"m0-wrong\",\"api_url\":\"http://127.0.0.1:9870\",\"api_token\":\"$WRONG\"}" http://127.0.0.1:8787/api/servers >/dev/null
chk "a server with a wrong token → 401 from psm-api" test "$(pc http://127.0.0.1:8787/api/servers/2/nodes)" = 401
chk "unknown server → 404" test "$(pc http://127.0.0.1:8787/api/servers/99/nodes)" = 404
chk "D1 holds no plaintext token" bash -c "! docker exec $K grep -rq '$TOKEN' /app/.wrangler/state"
# The page itself, as a browser runs it: the API checks above would not notice
# the page reading the wrong field and showing empty tables.
docker run --rm --network container:"$C" debian:13 sh -c 'apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq chromium >/dev/null 2>&1 && chromium --headless=new --no-sandbox --disable-gpu --virtual-time-budget=10000 --dump-dom http://127.0.0.1:8787/ 2>/dev/null' > $W/page.dom.html
chk "the page shows all three nodes" bash -c "grep -q m0-xr-ss $W/page.dom.html && grep -q m0-sb-ss $W/page.dom.html && grep -q m0-mh-ss $W/page.dom.html"
chk "the page shows the wrong-token server's error" grep -q unauthorized $W/page.dom.html
docker cp "$K":/app/package-lock.json $W/package-lock.json 2>/dev/null

echo
echo "=== RESULT: $pass ok, $fail failed"
(( fail == 0 ))
