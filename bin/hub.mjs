#!/usr/bin/env node
// A Hitch hub in Node: accepts channels, routes HTLCs between them for a small fee, watches every funding output through
// the local node's RPC, and answers closes and cheats the way a tab does. The protocol is lib/peer.mjs and lib/route.mjs,
// unchanged; this file is the host: the key, the relays, the chain, the store.
//   SCHEMA=… BLAKETESTNODE=… SIDESTR_LIB=… node bin/hub.mjs --key-file ~/.datstr/hitch-hub.key --data ~/.hitch/hub --relays wss://a,wss://b [--poll 20] [--fee 10]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
const H = (p) => p.replace(/^~/, homedir());
const argv = process.argv.slice(2); const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const SCHEMA = H(process.env.SCHEMA ?? '~/bitcoin-desktop/schema'), BTN = H(process.env.BLAKETESTNODE ?? '~/remote/github.com/bitcoin-blake/blaketestnode'), LIB = H(process.env.SIDESTR_LIB ?? '~/remote/github.com/sidestr/spec/siding/lib');
const KEY_FILE = H(opt('--key-file', '')), DATA = H(opt('--data', '~/.hitch/hub')), RELAYS = String(opt('--relays', '')).split(',').map((s) => s.trim()).filter(Boolean), POLL = Number(opt('--poll', 20)), HUB_FEE = Number(opt('--fee', 10));
if (!KEY_FILE || !RELAYS.length) { console.error('--key-file and --relays are required'); process.exit(2); }
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const [{ loadEngine }, { makeRpc }, { CHAIN }, hash, secp, { makeSigner }, relay, { verifyNostrEvent }, { makeChannels }, { makePeer, KIND }, { makeRouter }] = await Promise.all([import(`${BTN}/lib/engine.mjs`), import(`${BTN}/lib/rpc.mjs`), import(`${BTN}/lib/params.mjs`), import(`${SCHEMA}/codec/hash.js`), import(`${SCHEMA}/codec/secp256k1.js`), import(`${LIB}/schnorr.mjs`), import(`${LIB}/relay.mjs`), import(`${SCHEMA}/codec/nostr.js`), import('../lib/channel.mjs'), import('../lib/peer.mjs'), import('../lib/route.mjs')]);
const k = await loadEngine(CHAIN.network); const signer = makeSigner({ hash, secp }); const C = makeChannels({ k, hash, secp, signer }); const rpc = await makeRpc(CHAIN.conf, CHAIN.network);
await mkdir(DATA, { recursive: true }); let key; if (existsSync(KEY_FILE)) key = (await readFile(KEY_FILE, 'utf8')).trim(); else { key = signer.randomKey(); await writeFile(KEY_FILE, key + '\n', { mode: 0o600 }); log(`new key written to ${KEY_FILE}`); }
if (!/^[0-9a-f]{64}$/.test(key)) { console.error('the key file must hold 32 bytes as hex'); process.exit(2); }
const pub = signer.pubkeyOf(key), script = '5120' + pub; const events = relay.makeEvents({ signer, hash });
const CH_FILE = `${DATA}/channels.json`; const CH = existsSync(CH_FILE) ? JSON.parse(await readFile(CH_FILE, 'utf8')) : []; let height = await rpc('getblockcount');
const io = { myScript: script, height: () => height, save: () => writeFile(CH_FILE, JSON.stringify(CH)).catch((e) => log('save:', e.message)), log: (t, c) => log(c === 'e' ? 'ERR' : '·', t), notify: (t, b) => log(`${t}: ${b}`),
  send: async (ch, body) => { const ev = events.signEvent(key, { kind: KIND, tags: [['chain', CHAIN.network], ['p', ch.peer], ['ch', ch.id]], content: JSON.stringify(body) }); const r = await relay.publish({ relays: RELAYS, event: ev }); const ok = Object.values(r).filter((x) => x === 'ok').length; if (!ok) log(`ERR message ${body.t} reached no relay`, JSON.stringify(r)); return ok; },
  broadcast: async (hex, what) => { try { const txid = await rpc('sendrawtransaction', hex); log(`${what}: sent to the node, ${txid.slice(0, 16)}…`); return 1; } catch (e) { log(`ERR ${what}: the node refused: ${e.message}`); return 0; } },
  buildFunding: async () => { throw new Error('the hub does not fund channels; open one to it, with a push if you want it to pay you back'); },
  acceptOpen: (from, m) => m.funding.value >= 10000 && m.delay >= 3 && m.delay <= 144 && m.fee >= 100 };
const peer = makePeer({ C, signer, hash, pub, key, channels: CH, io, opts: { delay: 6, fee: 300, hubFee: HUB_FEE } }); const router = makeRouter({ peer, io, invoices: new Map(), hub: true }); io.onUpdate = router.onUpdate;
log(`hub ${pub} on ${CHAIN.network}; ${CH.length} channel(s) on file; fee ${HUB_FEE} sat per forward; relays ${RELAYS.map((u) => u.replace('wss://', '')).join(', ')}`);
relay.subscribe({ relays: RELAYS, chainId: CHAIN.network, kind: KIND, verify: verifyNostrEvent, since: 3600, log: (s) => log('·', s), onEvent: async (ev) => { if (!ev.tags.some((t) => t[0] === 'p' && t[1] === pub)) return; let m; try { m = JSON.parse(ev.content); } catch { return; } try { await peer.onMessage(ev.pubkey, m); } catch (e) { log(`ERR message ${m.t} for ${m.id}: ${e.message}`); } } });
// the chain, through the local node: funding outputs confirm or are spent; a spend is found by walking the blocks since the funding
async function watch() { try { height = await rpc('getblockcount'); } catch (e) { return log('ERR rpc:', e.message); }
  for (const ch of CH) { if (['closed', 'proposed', 'accepted', 'punished', 'closed-theirs-old', 'spent-unknown'].includes(ch.status)) continue;
    try { const out = await rpc('gettxout', ch.funding.txid, ch.funding.vout, true);
      if (out && out.confirmations === 0) continue; // in the mempool: not open yet
      if (out) { if (ch.status === 'funding') { ch.status = 'open'; ch.fundedHeight = height - out.confirmations + 1; io.save(); log(`channel ${ch.id} open: ${ch.funding.value} sat at block ${ch.fundedHeight}`); } else if (!ch.fundedHeight) { ch.fundedHeight = height - out.confirmations + 1; io.save(); } ch.conf = out.confirmations; continue; }
      if (!ch.fundedHeight) continue; if (ch.spentBy) { if (['closed-mine', 'closed-theirs'].includes(ch.status)) await peer.afterClose(ch); continue; }
      for (let h = ch.fundedHeight; h <= height; h++) { const b = await rpc('getblock', await rpc('getblockhash', h), 2); const tx = b.tx.find((t) => t.vin.some((i) => i.txid === ch.funding.txid && i.vout === ch.funding.vout)); if (tx) { await peer.onSpend(ch, { txid: tx.txid, height: h, hex: tx.hex }); break; } }
    } catch (e) { log(`ERR watch ${ch.id}:`, e.message); } } }
await watch(); setInterval(watch, POLL * 1000); setTimeout(() => peer.resyncAll().catch((e) => log('ERR resync:', e.message)), 3000); setInterval(() => peer.tick().catch((e) => log('ERR tick:', e.message)), 30000);
