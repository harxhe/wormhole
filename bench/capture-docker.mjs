import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const outDir = resolve("bench", "results");
const script = `
set -eu
apk add --no-cache tcpdump >/dev/null 2>&1
mkdir -p /out
rm -f /out/wormhole.pcap /out/wormhole-tls-keys.log
export WORMHOLE_TLS_KEYLOG=/out/wormhole-tls-keys.log
export WORMHOLE_LOG_LEVEL=error

npm run server >/tmp/server.log 2>&1 &
SERVER=$!
for i in $(seq 1 60); do
  if node -e "require('net').connect(4443,'127.0.0.1',function(){this.end();process.exit(0)}).on('error',()=>process.exit(1))" 2>/dev/null; then break; fi
  sleep 0.2
done

tcpdump -i lo -U -w /out/wormhole.pcap 'tcp port 4443 or tcp port 8080 or (tcp portrange 15000-15099)' 2>/dev/null &
CAP=$!

node -e "const http=require('http'),net=require('net');http.createServer((q,s)=>s.end('capture-ok')).listen(3000,'127.0.0.1');net.createServer(s=>s.pipe(s)).listen(3001,'127.0.0.1')" &
APP=$!

node client/bin/wormhole.js http 3000 --token dev-token-please-change --subdomain capture --no-inspect >/tmp/http.log 2>&1 &
HTTP=$!
node client/bin/wormhole.js tcp 3001 --token dev-token-please-change --subdomain capture-tcp >/tmp/tcp.log 2>&1 &
TCP=$!

for i in $(seq 1 60); do
  if grep -q Forwarding /tmp/http.log 2>/dev/null && grep -q Forwarding /tmp/tcp.log 2>/dev/null; then break; fi
  sleep 0.2
done

node -e "const http=require('http'),net=require('net');const one=()=>new Promise((res,rej)=>{const r=http.request({host:'127.0.0.1',port:8080,path:'/',headers:{Host:'capture.localhost'}},x=>{x.resume();x.on('end',res)});r.on('error',rej);r.end()});Promise.all(Array.from({length:10},one)).then(()=>new Promise((res,rej)=>{const s=net.connect(15000,'127.0.0.1',()=>s.write('capture-tcp'));s.on('data',d=>{if(d.toString()==='capture-tcp'){s.end();res()}else rej(new Error('bad echo'))});s.on('error',rej)})).catch(e=>{console.error(e);process.exit(1)})"
sleep 1

kill $HTTP $TCP $APP $SERVER 2>/dev/null || true
sleep 1
kill -INT $CAP 2>/dev/null || true
wait $CAP 2>/dev/null || true
ls -l /out/wormhole.pcap /out/wormhole-tls-keys.log
`;

const result = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "-v",
    `${outDir}:/out`,
    "--entrypoint",
    "sh",
    "wormhole-relay:test",
    "-c",
    script
  ],
  { stdio: "inherit" }
);
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
