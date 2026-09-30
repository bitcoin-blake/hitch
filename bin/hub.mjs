#!/usr/bin/env node
// A Hitch hub in Node: accepts channels, routes HTLCs between them for a small fee, watches every funding output and every
// close through the local node's RPC, and answers closes and cheats the way a tab does. The protocol is lib/peer.mjs and
// lib/route.mjs, unchanged; this file is the host: the key, the relays, the chain, the store, a status page on localhost.
//   SCHEMA=… BLAKETESTNODE=… SIDESTR_LIB=… node bin/hub.mjs --key-file ~/.datstr/hitch-hub.key --data ~/.hitch/hub --relays wss://a,wss://b
//     [--poll 20] [--fee 10] [--status 3481] [--confs 2] [--max-per-peer 4] [--max-channels 64] [--max-unfunded 16] [--open-rate 4]
import { readFile, writeFile, mkdir, rename, chmod, stat, copyFile, open as openFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
const H = (p) => p.replace(/^~/, homedir());
const argv = process.argv.slice(2); const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const num = (n, d, lo, hi) => { const v = Number(opt(n, d)); if (!Number.isInteger(v) || v < lo || v > hi) { console.error(`${n} must be a whole number between ${lo} and ${hi}`); process.exit(2); } return v; };
const SCHEMA = H(process.env.SCHEMA ?? '~/bitcoin-desktop/schema'), BTN = H(process.env.BLAKETESTNODE ?? '~/remote/github.com/bitcoin-blake/blaketestnode'), LIB = H(process.env.SIDESTR_LIB ?? '~/remote/github.com/sidestr/spec/siding/lib');
const KEY_FILE = H(opt('--key-file', '')), DATA = H(opt('--data', '~/.hitch/hub')), RELAYS = String(opt('--relays', '')).split(',').map((s) => s.trim()).filter((s) => /^wss?:\/\//.test(s));
const POLL = num('--poll', 20, 5, 600), HUB_FEE = num('--fee', 10, 0, 100000), STATUS_PORT = num('--status', 0, 0, 65535), CONFS = num('--confs', 2, 1, 100);
const MAX_PER_PEER = num('--max-per-peer', 4, 1, 1000), MAX_CHANNELS = num('--max-channels', 64, 1, 100000), MAX_UNFUNDED = num('--max-unfunded', 16, 1, 10000), OPEN_RATE = num('--open-rate', 4, 1, 1000);
if (!KEY_FILE || !RELAYS.length) { console.error('--key-file and --relays (wss://…) are required'); process.exit(2); }
const STALE_AFTER = 600, ARCHIVE_AFTER = 7 * 24 * 3600; // seconds without a fresh height before HTLC decisions stop; age of a finished channel before it leaves the live file
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
process.on('unhandledRejection', (e) => log('ERR unhandled:', e?.stack ?? e));
process.on('uncaughtException', (e) => { log('ERR uncaught:', e?.stack ?? e); process.exit(1); });
const [{ loadEngine }, { makeRpc }, { CHAIN }, hash, secp, { makeSigner }, relay, { verifyNostrEvent }, { makeChannels }, { makePeer, KIND, LIVE, WATCHED, TERMINAL }, { makeRouter }] = await Promise.all([import(`${BTN}/lib/engine.mjs`), import(`${BTN}/lib/rpc.mjs`), import(`${BTN}/lib/params.mjs`), import(`${SCHEMA}/codec/hash.js`), import(`${SCHEMA}/codec/secp256k1.js`), import(`${LIB}/schnorr.mjs`), import(`${LIB}/relay.mjs`), import(`${SCHEMA}/codec/nostr.js`), import('../lib/channel.mjs'), import('../lib/peer.mjs'), import('../lib/route.mjs')]);
const k = await loadEngine(CHAIN.network); const signer = makeSigner({ hash, secp }); const C = makeChannels({ k, hash, secp, signer });
// the node may not be up when we are: wait for it rather than crash-loop under pm2
const rpc = await makeRpc(CHAIN.conf, CHAIN.network); let height = null, heightAt = 0;
for (let tries = 0; height == null; tries++) { try { height = await rpc('getblockcount'); heightAt = Date.now(); } catch (e) { if (tries === 0) log('waiting for the node:', e.message); await new Promise((r) => setTimeout(r, Math.min(60000, 2000 * (tries + 1)))); } }
await mkdir(DATA, { recursive: true, mode: 0o700 }); try { await chmod(DATA, 0o700); } catch {}
let key; if (existsSync(KEY_FILE)) { const st = await stat(KEY_FILE); if (st.mode & 0o077) { console.error(`${KEY_FILE} is readable by others; chmod 600 it`); process.exit(2); } key = (await readFile(KEY_FILE, 'utf8')).trim(); } else { key = signer.randomKey(); await writeFile(KEY_FILE, key + '\n', { mode: 0o600 }); log(`new key written to ${KEY_FILE}`); }
if (!/^[0-9a-f]{64}$/.test(key)) { console.error('the key file must hold 32 bytes as hex'); process.exit(2); }
const pub = signer.pubkeyOf(key), script = '5120' + pub; const events = relay.makeEvents({ signer, hash });
// the channel file: the previous copy is kept; a missing or unreadable file falls back to it, and says so on the status page
const CH_FILE = `${DATA}/channels.json`, BAK = `${CH_FILE}.bak`; let CH = []; let restoredFromBak = false;
const loadChannels = async () => { if (existsSync(CH_FILE)) { try { return JSON.parse(await readFile(CH_FILE, 'utf8')); } catch (e) { log('channels.json unreadable:', e.message); } } if (existsSync(BAK)) { restoredFromBak = true; log('WARNING: using the previous copy of the channel file; resync before closing anything'); return JSON.parse(await readFile(BAK, 'utf8')); } return []; };
CH = await loadChannels();
// saves are serialised, coalesced and atomic: the last good copy kept, the new file synced to disk, then renamed over
let saving = Promise.resolve(), saveWanted = false, saveOk = true;
const saveNow = async () => { const tmp = `${CH_FILE}.tmp`; if (existsSync(CH_FILE)) await copyFile(CH_FILE, BAK); const fh = await openFile(tmp, 'w', 0o600); try { await fh.writeFile(JSON.stringify(CH)); await fh.sync(); } finally { await fh.close(); } await rename(tmp, CH_FILE); };
const save = () => { if (saveWanted) return saving; saveWanted = true; saving = saving.then(async () => { saveWanted = false; try { await saveNow(); saveOk = true; return true; } catch (e) { saveOk = false; log('ERR save:', e.message); return false; } }); return saving; };
const invoices = new Map(); const opens = new Map(); // pubkey → open times in the last hour
const bg = (f) => (...a) => { f(...a).catch((e) => log('ERR router:', e.message)); };
const io = { myScript: script, height: () => height ?? 0, stale: () => Date.now() - heightAt > STALE_AFTER * 1000, save, log: (t, c) => log(c === 'e' ? 'ERR' : '·', t), notify: (t, b) => log(`${t}: ${b}`), invoiceFor: (h) => invoices.get(h) ?? null,
  send: async (ch, body) => { const ev = events.signEvent(key, { kind: KIND, tags: [['chain', CHAIN.network], ['p', ch.peer], ['ch', ch.id]], content: JSON.stringify(body) }); const r = await relay.publish({ relays: RELAYS, event: ev }); const ok = Object.values(r).filter((x) => x === 'ok').length; if (!ok) log(`ERR message ${body.t} reached no relay`, JSON.stringify(r)); return ok; },
  broadcast: async (hex, what) => { try { const txid = await rpc('sendrawtransaction', hex); log(`${what}: sent to the node, ${txid.slice(0, 16)}…`); return 1; } catch (e) { log(`ERR ${what}: the node refused: ${e.message}`); return 0; } },
  buildFunding: async () => { throw new Error('the hub does not fund channels; open one to it, with a push if you want it to pay you back'); },
  // admission: per key, in all, unfunded in all, and per key per hour; the hub funds nothing, so this guards its state and its node, not its coins
  acceptOpen: (from, m) => { const live = CH.filter((c) => LIVE.has(c.status)); const mine = live.filter((c) => c.peer === from).length; const unfunded = live.filter((c) => ['proposed', 'accepted', 'funding'].includes(c.status)).length;
    const recent = (opens.get(from) ?? []).filter((t) => Date.now() - t < 3600e3); opens.set(from, [...recent, Date.now()]);
    const why = mine >= MAX_PER_PEER ? `${mine} live channels already` : live.length >= MAX_CHANNELS ? `${live.length} live channels in all` : unfunded >= MAX_UNFUNDED ? `${unfunded} unfunded channels waiting` : recent.length >= OPEN_RATE ? `${recent.length} opens from that key this hour` : io.stale() ? 'my chain view is stale' : null;
    if (why) log(`open from ${from.slice(0, 12)}… declined: ${why}`); return !why; },
  // the transaction that spent an output, if any: unspent per the node's view, else found by walking the blocks since `from` (the walk remembered per output)
  findSpend: async (ch, { txid, vout, from }) => { const out = await rpc('gettxout', txid, vout, true); if (out) return null; ch.scanned ??= {}; const key2 = `${txid}:${vout}`; const s = ch.scanned[key2]; if (s?.found) return s.found;
    for (let h = Math.max(from, (s?.to ?? from) - 6); h <= height; h++) { const b = await rpc('getblock', await rpc('getblockhash', h), 2); const tx = b.tx.find((t) => t.vin.some((i) => i.txid === txid && i.vout === vout)); if (tx) { const found = { txid: tx.txid, height: h, hex: tx.hex }; ch.scanned[key2] = { to: h, found }; return found; } }
    ch.scanned[key2] = { to: height }; return null; } };
const peer = makePeer({ C, signer, hash, pub, key, channels: CH, io, opts: { delay: 6, fee: 300, hubFee: HUB_FEE, minDelay: 3, hub: true } }); const router = makeRouter({ peer, io, invoices, hub: true });
io.onUpdate = bg(router.onUpdate); io.onDropped = bg(router.onDropped); io.onPreimage = bg(router.onPreimage);
log(`hub ${pub} on ${CHAIN.network}; ${CH.length} channel(s) on file${restoredFromBak ? ' (FROM THE BACKUP COPY)' : ''}; fee ${HUB_FEE} sat per forward; ${CONFS} confirmation(s) to open; relays ${RELAYS.map((u) => u.replace('wss://', '')).join(', ')}`);
relay.subscribe({ relays: RELAYS, chainId: CHAIN.network, kind: KIND, verify: verifyNostrEvent, since: 3600, log: (s) => log('·', s), onEvent: (ev) => { let m = null; (async () => { if (!ev?.tags?.some?.((t) => t[0] === 'p' && t[1] === pub)) return; try { m = JSON.parse(ev.content); } catch { return; } await peer.onMessage(ev.pubkey, m); })().catch((e) => log(`ERR message ${m?.t ?? '?'} for ${m?.id ?? '?'}: ${e.stack ?? e.message}`)); } });
// the chain, through the local node: a funding output confirms (with the declared value) or is spent; a spend is found by walking the
// blocks since the last look; a spend that a reorganisation undid is noticed while it is young; closes are followed output by output
let watching = false;
async function watch() { if (watching) return; watching = true;
  try { height = await rpc('getblockcount'); heightAt = Date.now(); } catch (e) { watching = false; return log('ERR rpc:', e.message, io.stale() ? '(chain view stale: no HTLC decisions until it returns)' : ''); }
  try { for (const ch of CH) { if (!WATCHED.has(ch.status)) continue;
    try { const out = await rpc('gettxout', ch.funding.txid, ch.funding.vout, true);
      if (out && ch.spentBy) { peer.unSpend(ch); }
      if (out && out.confirmations < CONFS) { ch.conf = out.confirmations; continue; }
      if (out) { const value = Math.round(out.value * 1e8); if (value !== ch.funding.value || out.scriptPubKey?.hex !== ch.funding.spk) { if (ch.status !== 'bad-funding') { ch.status = 'bad-funding'; save(); log(`ERR channel ${ch.id}: the funding output is ${value} sat to ${out.scriptPubKey?.hex?.slice(0, 12)}…, not the ${ch.funding.value} declared; refused`); } continue; }
        if (['funding', 'unfunded'].includes(ch.status)) { ch.status = 'open'; ch.fundedHeight = height - out.confirmations + 1; save(); log(`channel ${ch.id} open: ${ch.funding.value} sat at block ${ch.fundedHeight}`); } else if (!ch.fundedHeight) { ch.fundedHeight = height - out.confirmations + 1; save(); } ch.conf = out.confirmations; continue; }
      if (!ch.fundedHeight) continue;
      if (ch.spentBy) { if (height - ch.spentBy.height < 6) { const t = await rpc('getrawtransaction', ch.spentBy.txid, true).catch(() => null); if (!t || !(t.confirmations > 0)) { peer.unSpend(ch); continue; } } await peer.afterClose(ch); continue; }
      const from = Math.max(ch.fundedHeight, (ch.scannedTo ?? ch.fundedHeight) - 6);
      for (let h = from; h <= height; h++) { const b = await rpc('getblock', await rpc('getblockhash', h), 2); const tx = b.tx.find((t) => t.vin.some((i) => i.txid === ch.funding.txid && i.vout === ch.funding.vout)); if (tx) { await peer.onSpend(ch, { txid: tx.txid, height: h, hex: tx.hex }); break; } ch.scannedTo = h; }
    } catch (e) { log(`ERR watch ${ch.id}:`, e.message); } }
    // finished channels leave the live file after a week, to the archive
    const old = CH.filter((c) => TERMINAL.has(c.status) && Date.now() / 1000 - (c.spentBy?.at ?? c.at ?? 0) > ARCHIVE_AFTER); if (old.length) { await appendFile(`${DATA}/archive.jsonl`, old.map((c) => JSON.stringify(c) + '\n').join(''), { mode: 0o600 }); for (const c of old) CH.splice(CH.indexOf(c), 1); save(); log(`${old.length} finished channel(s) moved to the archive`); }
  } finally { watching = false; } }
await watch(); setInterval(watch, POLL * 1000);
setTimeout(() => peer.resyncAll().catch((e) => log('ERR resync:', e.message)), 3000);
let ticking = false; setInterval(() => { if (ticking) return; ticking = true; peer.tick().then(() => router.tick()).catch((e) => log('ERR tick:', e.message)).finally(() => { ticking = false; }); }, 30000);
// a status page on localhost: channels, balances, every HTLC with its deadline, relays, the chain view; no secrets
if (STATUS_PORT) { const sockets = () => { try { return Object.fromEntries([...relay.sockets()].map(([u, open]) => [u, open ? 'open' : 'closed'])); } catch { return {}; } };
  const htlcRows = (c) => peer.htlcs(c).map((h) => ({ id: h.id, hash: h.hash.slice(0, 16), amount: h.amount, offered: h.from === c.role, expiry: h.expiry, blocksLeft: h.expiry - (height ?? 0), preimage: !!peer.knownPreimage(c, h.hash), upstream: Object.entries(c.forwards ?? {}).find(([hh]) => hh === h.hash)?.[1]?.up ?? null }));
  const server = createServer((req, res) => { const body = { node: pub, network: CHAIN.network, height, heightAgeSeconds: Math.round((Date.now() - heightAt) / 1000), stale: io.stale(), saveOk, restoredFromBak, fee: HUB_FEE, confs: CONFS, relays: sockets(),
      channels: CH.map((c) => ({ id: c.id, peer: c.peer.slice(0, 16), status: c.status, n: c.n, mine: peer.myBal(c), theirs: peer.theirBal(c), htlcs: htlcRows(c), pending: c.pending ? c.pending.m.kind : null, awaiting: !!c.awaiting, funding: `${c.funding.txid}:${c.funding.vout}`, value: c.funding.value, conf: c.conf ?? null, spentBy: c.spentBy?.txid ?? null, claims: c.claimed ?? null, outputs: c.outputs ?? null })),
      warnings: [...(io.stale() ? ['the chain view is stale'] : []), ...(saveOk ? [] : ['the last save failed']), ...(restoredFromBak ? ['running from the backup copy of the channel file'] : []), ...CH.flatMap((c) => htlcRows(c).filter((h) => h.blocksLeft <= 12).map((h) => `htlc ${h.id} on ${c.id} has ${h.blocksLeft} blocks left`))] };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body, null, 1)); });
  server.on('error', (e) => { log('ERR status server:', e.message); process.exit(1); });
  server.listen(STATUS_PORT, '127.0.0.1', () => log(`status on http://127.0.0.1:${STATUS_PORT}/`)); }
