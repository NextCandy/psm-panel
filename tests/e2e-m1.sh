#!/usr/bin/env bash
# M1 end to end on a test VPS (needs Docker; expects proxy-stack and psm-panel
# side by side under $W, default /root/w).
#
# A PSM server with the three cores and test certificates, and the panel under
# `wrangler dev`, on one Docker network. The server is added in the panel, gets
# nodes of every kind, joins with the one-time token from the install command,
# and its psm-agent (which listens on no port) applies them. Then the page is
# driven in a real browser with Playwright.
set -uo pipefail
W=${W:-/root/w}; P=$W/proxy-stack; N=$W/psm-panel; T=$W/m1; mkdir -p "$T"
pass=0; fail=0
ok()  { echo "  ok   $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL $1"; fail=$((fail + 1)); }
chk() { local n="$1"; shift; if "$@" >"$T/chk.out" 2>&1; then ok "$n"; else bad "$n"; tail -8 "$T/chk.out" | sed 's/^/       /'; fi; }
sec() { echo; echo "=== $1"; }

NET=psm-m1; V=psm-m1-vps; K=psm-m1-panel; U=psm-m1-ui
cleanup() { docker rm -f "$V" "$K" "$U" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; true; }
trap cleanup EXIT
cleanup
docker network create "$NET" >/dev/null

sec "psm-agent: vet, unit tests, static build"
chk "go vet + go test + build" docker run --rm -v "$P/agent:/src" -w /src -e CGO_ENABLED=0 golang:1.27-alpine \
    sh -c 'go vet ./... && go test -count=1 ./... && go build -trimpath -ldflags "-s -w" -o /src/psm-agent .'

sec "panel (wrangler dev)"
rm -rf "$N/.wrangler"
docker run -d --name "$K" --network "$NET" --network-alias panel -v "$N:/app" -w /app node:22 sleep infinity >/dev/null
chk "npm install" docker exec "$K" npm install --no-audit --no-fund
chk "typecheck" docker exec "$K" npx tsc --noEmit
chk "build the pages" docker exec "$K" npm run build
# SYNC_INTERVAL=10 keeps the test short (the default is 30)
docker exec "$K" sh -c "printf 'TOKEN_KEY=%s\nPANEL_URL=http://panel:8787\nSYNC_INTERVAL=10\n' \$(head -c 32 /dev/urandom | base64) > .dev.vars"
chk "D1 migrations" docker exec "$K" npx wrangler d1 migrations apply psm-panel --local
docker exec -d "$K" sh -c 'npx wrangler dev --ip 0.0.0.0 --port 8787 > /tmp/wrangler.log 2>&1'

sec "a PSM server with three cores"
source "$P/tests/integration/container.sh"
it_start debian "$V" && it_copy_tree "$V"
docker network connect "$NET" "$V"
chk "install.sh"   docker exec "$V" bash -c 'cd /opt/psm && printf "1\n0\n0\n0\n0\n" | timeout 900 bash install.sh'
chk "xray_install" docker exec "$V" bash -c "cd /opt/psm && source lib/xray/core.sh && xray_install <<< \$'n\n0\n0\n0\n0\n'"
chk "sb_install"   docker exec "$V" bash -c "cd /opt/psm && source lib/singbox/core.sh && sb_install <<< \$'1\nn\n0\n0\n'"
chk "mh_install"   docker exec "$V" bash -c "cd /opt/psm && source lib/mihomo/core.sh && mh_install <<< \$'n\n0\n0\n0\n'"
docker exec "$V" bash -c '
  CA=/root/ca; mkdir -p $CA /etc/psm/certs /etc/nginx/ssl/x.example.com
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 7 -subj "/CN=M1 CA" -keyout $CA/ca.key -out $CA/ca.crt >/dev/null 2>&1
  issue() { openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj "/CN=$1" -keyout "$2" -out $CA/$1.csr >/dev/null 2>&1
            printf "subjectAltName=DNS:%s\n" "$1" > $CA/$1.ext
            openssl x509 -req -in $CA/$1.csr -CA $CA/ca.crt -CAkey $CA/ca.key -CAcreateserial -days 7 -extfile $CA/$1.ext -out "$3" >/dev/null 2>&1; }
  issue t.example.com /etc/psm/certs/t.key /etc/psm/certs/t.crt
  issue x.example.com /etc/nginx/ssl/x.example.com/privkey.pem /etc/nginx/ssl/x.example.com/fullchain.pem'
for _ in $(seq 1 60); do [[ "$(docker exec "$V" curl -s -o /dev/null -w '%{http_code}' http://panel:8787/api/servers)" == 200 ]] && break; sleep 2; done
chk "the server reaches the panel" test "$(docker exec "$V" curl -s -o /dev/null -w '%{http_code}' http://panel:8787/api/servers)" = 200

api()  { docker exec "$V" curl -s -H 'Content-Type: application/json' "$@"; }
code() { docker exec "$V" curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' "$@"; }
B=http://panel:8787

sec "add the server, and nodes before it joins"
api -X POST -d '{"name":"vps1"}' $B/api/servers > "$T/server.json"
chk "server added, with an install command" jq -e '.install_command | test("--panel http://panel:8787 --join [A-Za-z0-9_-]{40,}$")' "$T/server.json"
JT=$(jq -r '.install_command' "$T/server.json" | sed 's/.*--join //')
CERT='"sni":"t.example.com","cert_path":"/etc/psm/certs/t.crt","key_path":"/etc/psm/certs/t.key"'
node() { api -X POST -d "{\"server_id\":1,\"address\":\"203.0.113.10\",$1}" $B/api/nodes; }
declare -A WANT   # name → core/protocol
add_ok() {   # <name> <core/protocol> <json fields>
    local out; out=$(node "\"name\":\"$1\",$3")
    if jq -e '.status == "waiting" and .joined == false' <<<"$out" >/dev/null; then ok "node $1 saved, waiting for the server"; WANT[$1]=$2
    else bad "node $1"; echo "       $out"; fi
}
add_ok m1-xr   xray/reality      '"protocol":"vless","variant":"vless-reality","engine":"xray","port":31001,"params":{"server_name":"learn.microsoft.com","dest":"learn.microsoft.com:443"}'
add_ok m1-shy  sing-box/hysteria2 "\"protocol\":\"hysteria2\",\"variant\":\"hysteria2\",\"engine\":\"sing-box\",\"port\":31002,\"params\":{$CERT,\"obfs_pass\":\"m1-obfs\"}"
add_ok m1-mat  mihomo/anytls     "\"protocol\":\"anytls\",\"variant\":\"anytls\",\"engine\":\"mihomo\",\"port\":31003,\"params\":{$CERT}"
add_ok m1-stu  sing-box/tuic     "\"protocol\":\"tuic\",\"variant\":\"tuic\",\"engine\":\"sing-box\",\"port\":31004,\"params\":{$CERT}"
add_ok m1-xss  xray/ss2022       '"protocol":"ss2022","variant":"ss2022","engine":"xray","port":31005,"params":{}'
add_ok m1-svw  sing-box/vless    "\"protocol\":\"vless\",\"variant\":\"vless-tls\",\"engine\":\"sing-box\",\"port\":31006,\"params\":{$CERT,\"transport\":\"ws\"}"
add_ok m1-xt   xray/trojan       '"protocol":"trojan","variant":"trojan","engine":"xray","port":31007,"params":{"domain":"x.example.com"}'
add_ok m1-ms5  mihomo/socks      '"protocol":"socks","variant":"socks","engine":"mihomo","port":31008,"params":{"listen_addr":"0.0.0.0","username":"m1","password":"m1-pass-secret"}'
out=$(node '"name":"m1-snell","protocol":"snell","variant":"snell","engine":"standalone","port":31009,"params":{"version":"5"}')
chk "standalone Snell saved, waiting" jq -e '.status == "waiting"' <<<"$out"

sec "the panel refuses what PSM cannot do"
chk "TUIC on Xray → 400"            test "$(code -X POST -d '{"server_id":1,"address":"203.0.113.10","name":"x1","protocol":"tuic","variant":"tuic","engine":"xray","port":1,"params":{}}' $B/api/nodes)" = 400
chk "a name starting with - → 400"  test "$(code -X POST -d '{"server_id":1,"address":"203.0.113.10","name":"--show-secrets","protocol":"ss2022","variant":"ss2022","engine":"xray","port":1}' $B/api/nodes)" = 400
chk "Snell v6 on mihomo → 400"      test "$(code -X POST -d '{"server_id":1,"address":"203.0.113.10","name":"x2","protocol":"snell","variant":"snell","engine":"mihomo","port":1,"params":{"version":"6"}}' $B/api/nodes)" = 400
chk "REALITY without a target → 400" test "$(code -X POST -d '{"server_id":1,"address":"203.0.113.10","name":"x3","protocol":"vless","variant":"vless-reality","engine":"xray","port":1,"params":{}}' $B/api/nodes)" = 400
chk "same name twice → 409"         test "$(code -X POST -d '{"server_id":1,"address":"203.0.113.10","name":"m1-xss","protocol":"ss2022","variant":"ss2022","engine":"xray","port":31099}' $B/api/nodes)" = 409
chk "the node list shows no password" bash -c "! docker exec $V curl -s $B/api/nodes | grep -q m1-pass-secret"

sec "join with the one-time token"
docker cp "$P/agent/psm-agent" "$V":/usr/local/bin/psm-agent
chk "psm-agent join" docker exec "$V" psm-agent join -panel $B -token "$JT" -allow-http
chk "agent config is root-only (600)" docker exec "$V" bash -c "[[ \$(stat -c %a /etc/psm/agent.json) == 600 ]]"
chk "the join token works only once" bash -c "docker exec $V psm-agent join -panel $B -token $JT -allow-http -config /tmp/again.json 2>&1 | grep -q 403"
docker exec -d "$V" bash -c 'psm-agent run > /var/log/psm-agent.log 2>&1'

sec "the agent applies the nodes"
for _ in $(seq 1 60); do
    api $B/api/nodes > "$T/nodes.json"
    [[ $(jq '[.[] | select(.engine != "standalone" and .status != "applied")] | length' "$T/nodes.json") == 0 ]] && break
    sleep 3
done
for name in "${!WANT[@]}"; do
    st=$(jq -r --arg n "$name" '.[] | select(.name == $n) | .status + " " + (.last_error // "")' "$T/nodes.json")
    [[ "$st" == applied* ]] && ok "$name applied" || bad "$name: $st"
done
chk "the server is online, with its hostname" bash -c "docker exec $V curl -s $B/api/servers | jq -e '.[0].status == \"online\" and (.[0].hostname | length) > 0'"
chk "standalone Snell still waits" jq -e '.[] | select(.name == "m1-snell") | .status == "waiting"' "$T/nodes.json"

sec "what PSM has matches the panel"
for name in "${!WANT[@]}"; do
    cp=${WANT[$name]}
    chk "psm node show ${cp}/${name}: port matches" bash -c "docker exec $V psm node show ${cp%%/*} ${cp#*/} $name --json | jq -e --argjson p \$(jq --arg n $name '.[] | select(.name == \$n) | .port' $T/nodes.json) '[.. | objects | select(has(\"port\")) | .port] | index(\$p) != null'"
done
chk "the REALITY node has the target entered in the panel" bash -c "docker exec $V psm node show xray reality m1-xr --json | grep -q learn.microsoft.com"
chk "the Hysteria2 node has the SNI entered in the panel"   bash -c "docker exec $V psm node show sing-box hysteria2 m1-shy --json | grep -q t.example.com"
for pair in "m1-xr vless://" "m1-shy hysteria2://" "m1-stu tuic://" "m1-mat anytls://" "m1-xss ss://" "m1-xt trojan://"; do
    set -- $pair
    id=$(jq --arg n "$1" '.[] | select(.name == $n) | .id' "$T/nodes.json")
    chk "link of $1 starts with $2 and carries the node address" bash -c "docker exec $V curl -s $B/api/nodes/$id/link | jq -e --arg s '$2' '.content | startswith(\$s) and contains(\"203.0.113.10\")'"
done

sec "changes after joining go through the agent"
out=$(node '"name":"m1-late","protocol":"ss2022","variant":"ss2022","engine":"sing-box","port":31010,"params":{}')
chk "a new node on a joined server is queued" jq -e '.status == "queued" and .joined == true' <<<"$out"
for _ in $(seq 1 20); do [[ $(api $B/api/nodes | jq -r '.[] | select(.name == "m1-late") | .status') == applied ]] && break; sleep 2; done
chk "… and applied by the agent" bash -c "docker exec $V psm node show sing-box ss2022 m1-late --json >/dev/null"
id=$(jq '.[] | select(.name == "m1-mat") | .id' "$T/nodes.json")
chk "deleting an applied node → 202" test "$(code -X DELETE $B/api/nodes/$id)" = 202
for _ in $(seq 1 20); do api $B/api/nodes | jq -e '[.[] | select(.name == "m1-mat")] | length == 0' >/dev/null && break; sleep 2; done
chk "… it leaves the panel" bash -c "docker exec $V curl -s $B/api/nodes | jq -e '[.[] | select(.name == \"m1-mat\")] | length == 0'"
chk "… and PSM" bash -c "! docker exec $V psm node show mihomo anytls m1-mat --json >/dev/null 2>&1"

sec "psm-agent opens no port; secrets stay out of D1 and the log"
chk "psm-agent has no listening socket" bash -c "! docker exec $V ss -ltnup | grep -q psm-agent"
chk "psm-agent is running" docker exec "$V" pgrep -f 'psm-agent run'
AT=$(docker exec "$V" jq -r .token /etc/psm/agent.json)
chk "D1 holds no agent token, join token or node password in clear" bash -c "! docker exec $K grep -rqE '$AT|$JT|m1-pass-secret' /app/.wrangler/state"
chk "the agent log carries no token" bash -c "! docker exec $V grep -q '$AT' /var/log/psm-agent.log"

sec "sync interval: 3 s while there is work, SYNC_INTERVAL (10 here) when idle"
# the agent is stopped so these syncs, made with its token, are the only ones
agent_sync() { local b=${1-}; [[ -n $b ]] || b='{}'
               docker exec "$V" curl -s -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' -d "$b" $B/api/agent/sync; }
docker exec "$V" pkill -f 'psm-agent run'
for _ in 1 2 3 4 5; do docker exec "$V" pgrep -f 'psm-agent run' >/dev/null || break; sleep 1; done
chk "idle → 10" jq -e '.interval == 10 and (.tasks | length) == 0' <<<"$(agent_sync)"
node '"name":"m1-busy","protocol":"ss2022","variant":"ss2022","engine":"sing-box","port":31011,"params":{}' >/dev/null
s=$(agent_sync)
chk "a task handed out → 3" jq -e '.interval == 3 and (.tasks | length) == 1' <<<"$s"
tid=$(jq '.tasks[0].id' <<<"$s")
chk "its result reported → 3" jq -e '.interval == 3' <<<"$(agent_sync "{\"results\":[{\"task_id\":$tid,\"ok\":false,\"error\":\"m1 test\"}]}")"
chk "nothing left → 10" jq -e '.interval == 10 and (.tasks | length) == 0' <<<"$(agent_sync)"
id=$(api $B/api/nodes | jq '.[] | select(.name == "m1-busy") | .id')
chk "the failed node deletes at once → 204" test "$(code -X DELETE $B/api/nodes/$id)" = 204
docker exec -d "$V" bash -c 'psm-agent run >> /var/log/psm-agent.log 2>&1'

sec "the page, driven in a browser (Playwright)"
docker run -d --name "$U" --network "$NET" -v "$N/tests:/tests:ro" -v "$T:/out" -w /ui node:22 sleep infinity >/dev/null
chk "Playwright + Chromium" docker exec "$U" sh -c 'npm init -y >/dev/null && npm install --no-audit --no-fund playwright >/dev/null 2>&1 && npx playwright install --with-deps chromium >/dev/null 2>&1'
# run it from /ui, where playwright is installed (modules resolve from the script's directory)
docker exec "$U" sh -c 'cp /tests/ui-m1.mjs /ui/ && node /ui/ui-m1.mjs http://panel:8787 /out' > "$T/ui.out" 2>&1; ui=$?
sed 's/^/  /' "$T/ui.out"
(( ui == 0 )) && ok "UI flow" || bad "UI flow"
pass=$((pass + $(grep -c '^ok ' "$T/ui.out"))); fail=$((fail + $(grep -c '^FAIL ' "$T/ui.out")))

echo
echo "=== RESULT: $pass ok, $fail failed"
(( fail == 0 ))
