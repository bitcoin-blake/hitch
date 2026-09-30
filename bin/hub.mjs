#!/usr/bin/env node
// A Hitch hub in Node: accepts channels, routes HTLCs between them for a small fee, watches every funding output through
// the local node's RPC, and answers closes and cheats the way a tab does. The protocol is lib/peer.mjs and lib/route.mjs,
// unchanged; this file is the host: the key, the relays, the chain, the store, a status page on localhost.
//   SCHEMA=… BLAKETESTNODE=… SIDESTR_LIB=… node bin/hub.mjs --key-file ~/.datstr/hitch-hub.key --data ~/.hitch/hub --relays wss://a,wss://b [--poll 20] [--fee 10] [--status 3460] [--max-per-peer 4]
import { readFile, writeFile, mkdir, rename, chmod, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
const H = (p) => p.replace(/^~/, homedir());
const argv = process.argv.slice(2); const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const SCHEMA = H(process.env.SCHEMA ?? '~/bitcoin-desktop/schema'), BTN = H(process.env.BLAKETESTNODE ?? '~/remote/github.com/bitcoin-blake/blaketestnode'), LIB = H(process.env.SIDESTR_LIB ?? '~/remote/github.com/sidestr/spec/siding/lib');
const KEY_FILE = H(opt('--key-file', '')), DATA = H(opt('--data', '~/.hitch/hub')), RELAYS = String(opt('--relays', '')).split(',').map((s) => s.trim()).filter(Boolean);
const POLL = Number(opt('--poll', 20)), HUB_FEE = Number(opt('--fee', 10)), STATUS_PORT = Number(opt('--status', 0)), MAX_PER_PEER = Number(opt('--max-per-peer', 4));
if (!KEY_FILE || !RELAYS.length) { console.error('--key-file and --relays are required'); process.exit(2); }
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
process.on('unhandledRejection', (e) => log('ERR unhandled:', e?.message ?? e));
process.on('uncaughtException', (e) => log('ERR uncaught:', e?.message ?? e));
const [{ loadEngine }, { makeRpc }, { CHAIN }, hash, secp, { makeSigner }, relay, { verifyNostrEvent }, { makeChannels }, { makePeer, KIND, LIVE, WATCHED }, { makeRouter }] = await Promise.all([import(`${BTN}/lib/engine.mjs`), import(`${BTN}/lib/rpc.mjs`), import(`${BTN}/lib/params.mjs`), import(`${SCHEMA}/codec/hash.js`), import(`${SCHEMA}/codec/secp256k1.js`), import(`${LIB}/schnorr.mjs`), import(`${LIB}/relay.mjs`), import(`${SCHEMA}/codec/nostr.js`), import('../lib/channel.mjs'), import('../lib/peer.mjs'), import('../lib/route.mjs')]);
const k = await loadEngine(CHAIN.network); const signer = makeSigner({ hash, secp }); const C = makeChannels({ k, hash, secp, signer });
// the node may not be up when we are: wait for it rather than crash-loop under pm2
const rpc = await makeRpc(CHAIN.conf, CHAIN.network); let height = null;
for (let tries = 0; height == null; tries++) { try { height = await rpc('getblockcount'); } catch (e) { if (tries === 0) log('waiting for the node:', e.message); await new Promise((r) => setTimeout(r, Math.min(60000, 2000 * (tries + 1)))); } }
await mkdir(DATA, { recursive: true, mode: 0o700 }); try { await chmod(DATA, 0o700); } catch {}
let key; if (existsSync(KEY_FILE)) { const st = await stat(KEY_FILE); if (st.mode & 0o077) { console.error(`${KEY_FILE} is readable by others; chmod 600 it`); process.exit(2); } key = (await readFile(KEY_FILE, 'utf8')).trim(); } else { key = signer.randomKey(); await writeFile(KEY_FILE, key + '\n', { mode: 0o600 }); log(`new key written to ${KEY_FILE}`); }
if (!/^[0-9a-f]{64}$/.test(key)) { console.error('the key file must hold 32 bytes as hex'); process.exit(2); }
const pub = signer.pubkeyOf(key), script = '5120' + pub; const events = relay.makeEvents({ signer, hash });
const CH_FILE = `${DATA}/channels.json`; let CH = [];
if (existsSync(CH_FILE)) { try { CH = JSON.parse(await readFile(CH_FILE, 'utf8')); } catch (e) { const bak = `${CH_FILE}.bak`; if (existsSync(bak)) { log('channels.json unreadable, using the previous copy:', e.message); CH = JSON.parse(await readFile(bak, 'utf8')); } else { console.error('channels.json unreadable and no backup:', e.message); process.exit(2); } } }
// saves are serialised and atomic: write a temp file, keep the last good copy, rename over
let saving = Promise.resolve(); const saveNow = async () => { const tmp = `${CH_FILE}.tmp`; await writeFile(tmp, JSON.stringify(CH), { mode: 0o600 }); if (existsSync(CH_FILE)) await rename(CH_FILE, `${CH_FILE}.bak`); await rename(tmp, CH_FILE); };
const invoices = new Map();
const io = { myScript: script, height: () => height ?? 0, save: () => { saving = saving.then(saveNow).catch((e) => log('ERR save:', e.message)); return saving; }, log: (t, c) => log(c === 'e' ? 'ERR' : '·', t), notify: (t, b) => log(`${t}: ${b}`), invoiceFor: (h) => invoices.get(h) ?? null,
  send: async (ch, body) => { const ev = events.signEvent(key, { kind: KIND, tags: [['chain', CHAIN.network], ['p', ch.peer], ['ch', ch.id]], content: JSON.stringify(body) }); const r = await relay.publish({ relays: RELAYS, event: ev }); const ok = Object.values(r).filter((x) => x === 'ok').length; if (!ok) log(`ERR message ${body.t} reached no relay`, JSON.stringify(r)); return ok; },
  broadcast: async (hex, what) => { try { const txid = await rpc('sendrawtransaction', hex); log(`${what}: sent to the node, ${txid.slice(0, 16)}…`); return 1; } catch (e) { log(`ERR ${what}: the node refused: ${e.message}`); return 0; } },
  buildFunding: async () => { throw new Error('the hub does not fund channels; open one to it, with a push if you want it to pay you back'); },
  acceptOpen: (from, m) => { const mine = CH.filter((c) => c.peer === from && LIVE.has(c.status)).length; if (mine >= MAX_PER_PEER) { log(`open from ${from.slice(0, 12)}… declined: ${mine} live channels already`); return false; } return true; } };
const peer = makePeer({ C, signer, hash, pub, key, channels: CH, io, opts: { delay: 6, fee: 300, hubFee: HUB_FEE, minDelay: 3, hub: true } }); const router = makeRouter({ peer, io, invoices, hub: true }); io.onUpdate = router.onUpdate;
log(`hub ${pub} on ${CHAIN.network}; ${CH.length} channel(s) on file; fee ${HUB_FEE} sat per forward; relays ${RELAYS.map((u) => u.replace('wss://', '')).join(', ')}`);
relay.subscribe({ relays: RELAYS, chainId: CHAIN.network, kind: KIND, verify: verifyNostrEvent, since: 3600, log: (s) => log('·', s), onEvent: (ev) => { (async () => { if (!ev?.tags?.some?.((t) => t[0] === 'p' && t[1] === pub)) return; let m; try { m = JSON.parse(ev.content); } catch { return; } await peer.onMessage(ev.pubkey, m); })().catch((e) => log(`ERR message ${m?.t ?? '?'} for ${m?.id ?? '?'}: ${e.message}`)); } });
// the chain, through the local node: a funding output confirms (with the declared value) or is spent; a spend is found by walking the blocks since the funding
let watching = false;
async function watch() { if (watching) return; watching = true;
  try { height = await rpc('getblockcount'); } catch (e) { watching = false; return log('ERR rpc:', e.message); }
  try { for (const ch of CH) { if (!WATCHED.has(ch.status)) continue;
    try { const out = await rpc('gettxout', ch.funding.txid, ch.funding.vout, true);
      if (out && out.confirmations === 0) continue;
      if (out) { const value = Math.round(out.value * 1e8); if (value !== ch.funding.value || out.scriptPubKey?.hex !== ch.funding.spk) { if (ch.status !== 'bad-funding') { ch.status = 'bad-funding'; io.save(); log(`ERR channel ${ch.id}: the funding output is ${value} sat to ${out.scriptPubKey?.hex?.slice(0, 12)}…, not the ${ch.funding.value} declared; refused`); } continue; }
        if (ch.status === 'funding') { ch.status = 'open'; ch.fundedHeight = height - out.confirmations + 1; io.save(); log(`channel ${ch.id} open: ${ch.funding.value} sat at block ${ch.fundedHeight}`); } else if (!ch.fundedHeight) { ch.fundedHeight = height - out.confirmations + 1; io.save(); } ch.conf = out.confirmations; continue; }
      if (!ch.fundedHeight) continue; if (ch.spentBy) { await peer.afterClose(ch); continue; }
      for (let h = ch.fundedHeight; h <= height; h++) { const b = await rpc('getblock', await rpc('getblockhash', h), 2); const tx = b.tx.find((t) => t.vin.some((i) => i.txid === ch.funding.txid && i.vout === ch.funding.vout)); if (tx) { await peer.onSpend(ch, { txid: tx.txid, height: h, hex: tx.hex }); break; } }
    } catch (e) { log(`ERR watch ${ch.id}:`, e.message); } } } finally { watching = false; } }
await watch(); setInterval(watch, POLL * 1000);
setTimeout(() => peer.resyncAll().catch((e) => log('ERR resync:', e.message)), 3000);
setInterval(() => peer.tick().then(() => router.tick()).catch((e) => log('ERR tick:', e.message)), 30000);
// a status page on localhost: channels, balances, relays; no secrets
if (STATUS_PORT) { const sockets = () => { try { return Object.fromEntries([...relay.sockets()].map(([u, open]) => [u, open ? 'open' : 'closed'])); } catch { return {}; } };
  createServer((req, res) => { const body = { node: pub, network: CHAIN.network, height, fee: HUB_FEE, relays: sockets(), channels: CH.map((c) => ({ id: c.id, peer: c.peer.slice(0, 16), status: c.status, n: c.n, mine: peer.myBal(c), theirs: peer.theirBal(c), htlcs: peer.htlcs(c).length, pending: !!c.pending, awaiting: !!c.awaiting, funding: `${c.funding.txid}:${c.funding.vout}`, value: c.funding.value })) };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body, null, 1)); }).listen(STATUS_PORT, '127.0.0.1', () => log(`status on http://127.0.0.1:${STATUS_PORT}/`)); }
