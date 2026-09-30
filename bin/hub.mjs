#!/usr/bin/env node
// A Hitch hub in Node: accepts channels, routes HTLCs between them for a small fee, watches every funding output and every
// close through the local node's RPC, and answers closes and cheats the way a tab does. The protocol is lib/peer.mjs and
// lib/route.mjs, unchanged; this file is the host: the key, the relays, the chain, the store, a status page on localhost.
//   SCHEMA=… BLAKETESTNODE=… SIDESTR_LIB=… node bin/hub.mjs --key-file ~/.datstr/hitch-hub.key --data ~/.hitch/hub --relays wss://a,wss://b
//     [--poll 20] [--fee 10] [--status 3481] [--confs 2] [--max-per-peer 4] [--max-channels 64] [--max-unfunded 16] [--open-rate 4] [--max-delay 24]
import { readFile, writeFile, mkdir, rename, chmod, stat, copyFile, open as openFile, appendFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
const H = (p) => p.replace(/^~/, homedir());
const argv = process.argv.slice(2); const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const num = (n, d, lo, hi) => { const v = Number(opt(n, d)); if (!Number.isInteger(v) || v < lo || v > hi) { console.error(`${n} must be a whole number between ${lo} and ${hi}`); process.exit(2); } return v; };
const SCHEMA = H(process.env.SCHEMA ?? '~/bitcoin-desktop/schema'), BTN = H(process.env.BLAKETESTNODE ?? '~/remote/github.com/bitcoin-blake/blaketestnode'), LIB = H(process.env.SIDESTR_LIB ?? '~/remote/github.com/sidestr/spec/siding/lib');
const KEY_FILE = H(opt('--key-file', '')), DATA = H(opt('--data', '~/.hitch/hub')), RELAYS = String(opt('--relays', '')).split(',').map((s) => s.trim()).filter((s) => /^wss?:\/\//.test(s));
const POLL = num('--poll', 20, 5, 600), HUB_FEE = num('--fee', 10, 0, 100000), STATUS_PORT = num('--status', 0, 0, 65535), CONFS = num('--confs', 2, 1, 100);
const MAX_PER_PEER = num('--max-per-peer', 4, 1, 1000), MAX_CHANNELS = num('--max-channels', 64, 1, 100000), MAX_UNFUNDED = num('--max-unfunded', 16, 1, 10000), OPEN_RATE = num('--open-rate', 4, 1, 1000), MAX_DELAY = num('--max-delay', 24, 3, 144);
const STARTED = Date.now();
if (!KEY_FILE || !RELAYS.length) { console.error('--key-file and --relays (wss://…) are required'); process.exit(2); }
const STALE_AFTER = 600, ARCHIVE_AFTER = 7 * 24 * 3600, NEVER_SEEN_AFTER = 2 * 3600, WALK_MAX = 200, CLOSE_DEPTH = 6; // seconds without a fresh height before HTLC decisions stop; age of a finished channel before it leaves the live file
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
process.on('unhandledRejection', (e) => log('ERR unhandled:', e?.stack ?? e));
process.on('uncaughtException', (e) => { log('ERR uncaught:', e?.stack ?? e); process.exit(1); });
const [{ loadEngine }, { makeRpc }, { CHAIN }, hash, secp, { makeSigner }, relay, { verifyNostrEvent }, { makeChannels }, { makePeer, KIND, LIVE, WATCHED, TERMINAL, FOLLOWING }, { makeRouter }] = await Promise.all([import(`${BTN}/lib/engine.mjs`), import(`${BTN}/lib/rpc.mjs`), import(`${BTN}/lib/params.mjs`), import(`${SCHEMA}/codec/hash.js`), import(`${SCHEMA}/codec/secp256k1.js`), import(`${LIB}/schnorr.mjs`), import(`${LIB}/relay.mjs`), import(`${SCHEMA}/codec/nostr.js`), import('../lib/channel.mjs'), import('../lib/peer.mjs'), import('../lib/route.mjs')]);
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
{ const foreign = CH.filter((c) => (LIVE.has(c.status) || WATCHED.has(c.status)) && c.keys?.[c.role] !== pub); if (foreign.length) { console.error(`${foreign.length} channel(s) on file belong to another key (${foreign[0].keys[foreign[0].role].slice(0, 16)}…), not ${pub.slice(0, 16)}…: the key file is not the one these channels were made with; refusing to start`); process.exit(2); } }
const COMMIT = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } })();
// saves are serialised, coalesced and atomic: the last good copy kept, the new file synced to disk, then renamed over
let saving = Promise.resolve(), saveWanted = false, saveOk = true;
const saveNow = async () => { const tmp = `${CH_FILE}.tmp`; if (existsSync(CH_FILE)) await copyFile(CH_FILE, BAK); const fh = await openFile(tmp, 'w', 0o600); try { await fh.writeFile(JSON.stringify(CH)); await fh.sync(); } finally { await fh.close(); } await rename(tmp, CH_FILE); };
const save = () => { if (saveWanted) return saving; saveWanted = true; saving = saving.then(async () => { saveWanted = false; try { await saveNow(); saveOk = true; return true; } catch (e) { saveOk = false; log('ERR save:', e.message); return false; } }); return saving; };
const invoices = new Map(); const opens = new Map(); let declined = 0; // pubkey → accepted open times in the last hour; opens declined since start
const bg = (f) => (...a) => { f(...a).catch((e) => log('ERR router:', e.message)); };
const io = { myScript: script, height: () => height ?? 0, stale: () => Date.now() - heightAt > STALE_AFTER * 1000, save, log: (t, c) => log(c === 'e' ? 'ERR' : '·', t), notify: (t, b) => log(`${t}: ${b}`), invoiceFor: (h) => invoices.get(h) ?? null,
  send: async (ch, body) => { const ev = events.signEvent(key, { kind: KIND, tags: [['chain', CHAIN.network], ['p', ch.peer], ['ch', ch.id]], content: JSON.stringify(body) }); const r = await relay.publish({ relays: RELAYS, event: ev }); const ok = Object.values(r).filter((x) => x === 'ok').length; if (!ok) log(`ERR message ${body.t} reached no relay`, JSON.stringify(r)); return ok; },
  broadcast: async (hex, what) => { try { const txid = await rpc('sendrawtransaction', hex); log(`${what}: sent to the node, ${txid.slice(0, 16)}…`); return 1; } catch (e) { log(`ERR ${what}: the node refused: ${e.message}`); return 0; } },
  buildFunding: async () => { throw new Error('the hub does not fund channels; open one to it, with a push if you want it to pay you back'); },
  // admission: per key, in all, unfunded in all, and per key per hour; the hub funds nothing, so this guards its state and its node, not its coins
  acceptOpen: (from, m) => { const live = CH.filter((c) => LIVE.has(c.status) || c.status === 'unfunded'); const mine = live.filter((c) => c.peer === from).length; const unfunded = live.filter((c) => ['proposed', 'accepted', 'funding', 'unfunded'].includes(c.status)).length;
    for (const [k2, ts] of opens) { const keep = ts.filter((t) => Date.now() - t < 3600e3); if (keep.length) opens.set(k2, keep); else opens.delete(k2); } const recent = opens.get(from) ?? [];
    const why = m.delay > MAX_DELAY ? `delay ${m.delay} is above my ceiling of ${MAX_DELAY}` : mine >= MAX_PER_PEER ? `${mine} live channels already` : live.length >= MAX_CHANNELS ? `${live.length} live channels in all` : unfunded >= MAX_UNFUNDED ? `${unfunded} unfunded channels waiting` : recent.length >= OPEN_RATE ? `${recent.length} opens from that key this hour` : io.stale() ? 'my chain view is stale' : null;
    if (why) { declined++; log(`open from ${from.slice(0, 12)}… declined: ${why}`); } else opens.set(from, [...recent, Date.now()]); return !why; },
  // the transaction that spent an output, if any: unspent per the node's view, else found by walking the blocks since `from` (the walk remembered per output)
  findSpend: async (ch, { txid, vout }) => { const key2 = `${txid}:${vout}`; const s = ch.scanned?.[key2]; if (s?.found) return s.found; const out = await rpc('gettxout', txid, vout, true); if (out) return null; return spends.get(key2) ?? null; } };
const peer = makePeer({ C, signer, hash, pub, key, channels: CH, io, opts: { delay: 6, fee: 300, hubFee: HUB_FEE, minDelay: 3, hub: true, proposalTimeout: 1200 } }); const router = makeRouter({ peer, io, invoices, hub: true });
io.onUpdate = bg(router.onUpdate); io.onDropped = bg(router.onDropped); io.onPreimage = bg(router.onPreimage);
log(`hub ${pub} on ${CHAIN.network}; ${CH.length} channel(s) on file${restoredFromBak ? ' (FROM THE BACKUP COPY)' : ''}; fee ${HUB_FEE} sat per forward; ${CONFS} confirmation(s) to open; relays ${RELAYS.map((u) => u.replace('wss://', '')).join(', ')}`);
relay.subscribe({ relays: RELAYS, chainId: CHAIN.network, kind: KIND, verify: verifyNostrEvent, since: 3600, log: (s) => log('·', s), onEvent: (ev) => { let m = null; (async () => { if (!ev?.tags?.some?.((t) => t[0] === 'p' && t[1] === pub)) return; try { m = JSON.parse(ev.content); } catch { return; } await peer.onMessage(ev.pubkey, m); })().catch((e) => log(`ERR message ${m?.t ?? '?'} for ${m?.id ?? '?'}: ${e.stack ?? e.message}`)); } });
// the chain, through the local node. One walk over every new block serves every watched outpoint: the funding outputs of
// live channels and the outputs of every close being followed. The cursor (height and block hash) is kept on disk, so a
// restart continues where it left off, and a block hash that no longer matches means a reorganisation: back up and walk again.
const CURSOR_FILE = `${DATA}/cursor.json`; let cursor = null; try { if (existsSync(CURSOR_FILE) && !restoredFromBak) cursor = JSON.parse(await readFile(CURSOR_FILE, 'utf8')); } catch (e) { log('cursor.json unreadable, walking from the watched set:', e.message); }
const saveCursor = () => writeFile(CURSOR_FILE, JSON.stringify(cursor), { mode: 0o600 }).catch((e) => log('ERR cursor:', e.message));
const spends = new Map(); // outpoint → { txid, height, hex } found by the walk for outputs of closes
const watchedOutpoints = () => { const fund = new Map(), outs = new Map(); for (const ch of CH) { if (!WATCHED.has(ch.status)) continue; if (ch.fundedHeight && !ch.spentBy) fund.set(`${ch.funding.txid}:${ch.funding.vout}`, ch); if (ch.spentBy && ch.outputs) for (const v of Object.keys(ch.outputs)) outs.set(`${ch.spentBy.txid}:${v}`, ch); } return { fund, outs }; };
async function walkBlock(h) { const hashAt = await rpc('getblockhash', h); const b = await rpc('getblock', hashAt, 2); let closes = 0;
  for (let pass = 0; pass < 2; pass++) { const { fund, outs } = watchedOutpoints(); if (pass && !closes) break; closes = 0;
    for (const tx of b.tx) for (const i of tx.vin) { if (!i.txid) continue; const key2 = `${i.txid}:${i.vout}`; const ch = fund.get(key2); if (ch && !ch.spentBy) { closes++; try { await peer.onSpend(ch, { txid: tx.txid, height: h, blockHash: hashAt, hex: tx.hex }); } catch (e) { log(`ERR spend of ${ch.id}:`, e.message); } }
      const co = outs.get(key2); if (co) { const found = { txid: tx.txid, height: h, hex: tx.hex }; spends.set(key2, found); co.scanned ??= {}; co.scanned[key2] = { to: h, found }; } } }
  return hashAt; }
let watching = false;
async function watch() { if (watching) return; watching = true;
  try { const was = io.stale(); height = await rpc('getblockcount'); heightAt = Date.now(); if (was && heightAt) log('the chain view is fresh again'); } catch (e) { watching = false; if (!io.stale() || Date.now() - heightAt < STALE_AFTER * 1000 + POLL * 1000) log('ERR rpc:', e.message, io.stale() ? '(chain view stale: no HTLC decisions until it returns)' : ''); return; }
  try {
    // funding outputs: confirmed with the declared value (open), or gone (the walk finds the spend)
    for (const ch of CH) { if (!WATCHED.has(ch.status)) continue;
      try { const out = await rpc('gettxout', ch.funding.txid, ch.funding.vout, true);
        if (out && ch.spentBy) { for (const k2 of spends.keys()) if (k2.startsWith(ch.spentBy.txid)) spends.delete(k2); peer.unSpend(ch); }
        if (out) ch.lastUnspent = height;
        if (out && out.confirmations < CONFS) { ch.conf = out.confirmations; ch.seen = true; continue; }
        if (!out && !ch.fundedHeight && !ch.spentBy) { // never seen unspent: confirmed and spent while the hub was away, or never existed
          const t = await rpc('getrawtransaction', ch.funding.txid, true).catch(() => null); if (t?.blockhash) { const bh = await rpc('getblockheader', t.blockhash); ch.fundedHeight = bh.height; ch.seen = true; save(); log(`channel ${ch.id}: the funding is in block ${bh.height} and already spent; walking from there`); }
          else if (t) ch.seen = true; else if (ch.role === 'b' && ['funding', 'unfunded'].includes(ch.status) && !ch.seen && Date.now() / 1000 - ch.at > NEVER_SEEN_AFTER) { ch.status = 'abandoned'; save(); log(`channel ${ch.id}: the funding was never seen by the node in two hours; abandoned`); }
          continue; }
        if (out) { const value = Math.round(out.value * 1e8); if (value !== ch.funding.value || out.scriptPubKey?.hex !== ch.funding.spk) { if (ch.status !== 'bad-funding') { ch.status = 'bad-funding'; save(); log(`ERR channel ${ch.id}: the funding output is ${value} sat to ${out.scriptPubKey?.hex?.slice(0, 12)}…, not the ${ch.funding.value} declared; refused`); } continue; }
          if (['funding', 'unfunded'].includes(ch.status)) { ch.status = 'open'; ch.fundedHeight = height - out.confirmations + 1; save(); log(`channel ${ch.id} open: ${ch.funding.value} sat at block ${ch.fundedHeight}`); } else if (!ch.fundedHeight) { ch.fundedHeight = height - out.confirmations + 1; save(); } ch.conf = out.confirmations; continue; }
        if (ch.spentBy && ch.spentBy.blockHash && height - ch.spentBy.height < CLOSE_DEPTH) { const now2 = await rpc('getblockhash', ch.spentBy.height).catch(() => null); if (now2 && now2 !== ch.spentBy.blockHash) { for (const k2 of spends.keys()) if (k2.startsWith(ch.spentBy.txid)) spends.delete(k2); peer.unSpend(ch); continue; } }
        if (ch.status === 'closed-coop' && ch.spentBy && height - ch.spentBy.height + 1 >= CLOSE_DEPTH) { ch.status = 'closed'; save(); log(`channel ${ch.id}: the cooperative close is ${CLOSE_DEPTH} deep; closed`); }
      } catch (e) { log(`ERR watch ${ch.id}:`, e.message); } }
    // the walk: from the cursor (checked against the chain), or from the oldest thing watched
    const { fund, outs } = watchedOutpoints();
    if (fund.size || outs.size) { let from; if (cursor && (await rpc('getblockhash', cursor.height).catch(() => null)) === cursor.hash) from = cursor.height + 1; else if (cursor) { from = Math.max(1, cursor.height - 6); log(`block ${cursor.height} is no longer ${cursor.hash.slice(0, 12)}…: walking again from ${from}`); } else from = height - 6;
      // anything watched that the node no longer shows unspent, and that the walk has not covered, pulls the start back to where it was last seen
      const needs = [...[...fund.values()].filter((c) => (c.lastUnspent ?? 0) < height).map((c) => c.lastUnspent ?? c.fundedHeight), ...[...outs.entries()].filter(([k2, c]) => !c.scanned?.[k2]?.found).map(([, c]) => c.spentBy.height)]; if (needs.length) from = Math.min(from, ...needs);
      const to = Math.min(height, from + WALK_MAX - 1); if (to < height) log(`walking blocks ${from}–${to} of ${height}`);
      for (let h = Math.max(1, from); h <= to; h++) { const hashAt = await walkBlock(h); cursor = { height: h, hash: hashAt }; if (h % 50 === 0) await saveCursor(); } await saveCursor(); }
    for (const ch of CH) if (FOLLOWING.has(ch.status) && ch.spentBy) { try { await peer.afterClose(ch); } catch (e) { log(`ERR follow ${ch.id}:`, e.message); } }
    // finished channels leave the live file after a week, to the archive
    const old = CH.filter((c) => TERMINAL.has(c.status) && Date.now() / 1000 - (c.spentBy?.at ?? c.at ?? 0) > ARCHIVE_AFTER); if (old.length) { await appendFile(`${DATA}/archive.jsonl`, old.map((c) => JSON.stringify(c) + '\n').join(''), { mode: 0o600 }); for (const c of old) CH.splice(CH.indexOf(c), 1); save(); log(`${old.length} finished channel(s) moved to the archive`); }
  } finally { watching = false; } }
await watch(); setInterval(watch, POLL * 1000);
setTimeout(() => peer.resyncAll().catch((e) => log('ERR resync:', e.message)), 3000);
let ticking = false; setInterval(() => { if (ticking) return; ticking = true; peer.tick().then(() => router.tick()).catch((e) => log('ERR tick:', e.message)).finally(() => { ticking = false; }); }, 30000);
// a status page on localhost: the chain view, the store, every channel with its HTLCs and deadlines, forwards, a reconciliation of
// what is open against the node's view; 503 when the hub should not be trusted (stale view, failed save, running from the backup)
let statusError = null;
if (STATUS_PORT) { const sockets = () => { try { return Object.fromEntries([...relay.sockets()].map(([u, open]) => [u, open ? 'open' : 'closed'])); } catch { return {}; } };
  const htlcRows = (c) => peer.htlcs(c).map((h) => ({ id: h.id, hash: h.hash.slice(0, 16), amount: h.amount, offered: h.from === c.role, expiry: h.expiry, blocksLeft: h.expiry - (height ?? 0), preimage: !!peer.knownPreimage(c, h.hash), upstream: c.forwards?.[h.hash]?.up ?? null }));
  const server = createServer(async (req, res) => { try {
    let unspent = 0, openValue = 0; for (const c of CH) if (c.status === 'open') { openValue += c.funding.value; try { if (await rpc('gettxout', c.funding.txid, c.funding.vout, true)) unspent += c.funding.value; } catch {} }
    const warnings = [...(io.stale() ? ['the chain view is stale'] : []), ...(saveOk ? [] : ['the last save failed']), ...(restoredFromBak ? ['running from the backup copy of the channel file: resync before closing anything'] : []), ...(statusError ? [statusError] : []), ...(unspent !== openValue ? [`open channels hold ${openValue} sat but the node sees ${unspent} sat unspent`] : []),
      ...CH.flatMap((c) => htlcRows(c).filter((h) => h.blocksLeft <= 12).map((h) => `htlc ${h.id} on ${c.id} has ${h.blocksLeft} blocks left`)), ...CH.filter((c) => c.unsent?.length).map((c) => `${c.id} has ${c.unsent.length} unsent transaction(s)`), ...(Object.values(sockets()).some((v) => v === 'open') ? [] : ['no relay is connected']), ...CH.filter((c) => ['spent-unknown', 'bad-funding'].includes(c.status)).map((c) => `${c.id} is ${c.status}: look at it`), ...CH.filter((c) => (c.pending?.tries ?? 0) >= 4).map((c) => `${c.id}: update ${c.pending.n} unanswered after ${c.pending.tries} tries`), ...CH.filter((c) => c.status === 'punished' && Object.values(c.outputs ?? {}).some((o) => o.mine && o.theirs)).map((c) => `${c.id}: part of the penalty was lost`)];
    const body = { node: pub, network: CHAIN.network, commit: COMMIT, startedAt: new Date(STARTED).toISOString(), height, heightAgeSeconds: Math.round((Date.now() - heightAt) / 1000), stale: io.stale(), saveOk, restoredFromBak, cursor, fee: HUB_FEE, confs: CONFS, opensDeclined: declined, limits: { perPeer: MAX_PER_PEER, channels: MAX_CHANNELS, unfunded: MAX_UNFUNDED, opensPerHour: OPEN_RATE, maxDelay: MAX_DELAY }, relays: sockets(),
      reconciliation: { openChannels: CH.filter((c) => c.status === 'open').length, openValue, unspentPerNode: unspent },
      channels: CH.map((c) => ({ id: c.id, peer: c.peer, role: c.role, status: c.status, n: c.n, ageSeconds: Math.round(Date.now() / 1000 - (c.at ?? 0)), lastMessageAgeSeconds: c.lastMsgAt ? Math.round(Date.now() / 1000 - c.lastMsgAt) : null, fundedHeight: c.fundedHeight ?? null, delay: c.delay, mine: peer.myBal(c), theirs: peer.theirBal(c), htlcs: htlcRows(c), pending: c.pending ? { kind: c.pending.m.kind, n: c.pending.n, tries: c.pending.tries } : null, awaiting: !!c.awaiting, dropped: !!c.droppedIntent, signedAlts: Object.values(c.signedAlt ?? {}).reduce((a, x) => a + x.length, 0), unsent: c.unsent?.length ?? 0, forwards: c.forwards ?? null, funding: `${c.funding.txid}:${c.funding.vout}`, value: c.funding.value, conf: c.spentBy ? null : (c.conf ?? null), spentBy: c.spentBy?.txid ?? null, claims: c.claimed ? Object.fromEntries(Object.entries(c.claimed).map(([k2, v]) => [k2, v.txid])) : null, outputs: c.outputs ?? null })), warnings };
    res.writeHead(io.stale() || !saveOk || restoredFromBak ? 503 : 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body, null, 1)); } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); } });
  server.on('error', (e) => { statusError = `the status page could not listen on ${STATUS_PORT}: ${e.message}`; log('ERR', statusError); });
  server.listen(STATUS_PORT, '127.0.0.1', () => log(`status on http://127.0.0.1:${STATUS_PORT}/`)); }
