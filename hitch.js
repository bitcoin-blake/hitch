// Hitch: payment channels in a tab, Lightning-shaped. The node in the tab (browser/tabnode.js, pinned) funds, watches and
// settles; lib/channel.mjs builds and checks every transaction; the two tabs talk over the relays as kind 23600 events
// signed by their node keys. One channel state at a time per channel; the funder pays the fees; no HTLCs, no routing.
const $ = (id) => document.getElementById(id);
const NODE = 'https://cdn.jsdelivr.net/gh/bitcoin-blake/blaketestnode@f43417b6c53bda007487a8d7738a848c0e6d3792';
const LIB = 'https://cdn.jsdelivr.net/gh/sidestr/spec@fe689e9c723f9bf43393d2dd5b6f924a701c8a18/siding/lib', CDN = 'https://cdn.jsdelivr.net/gh/bitcoin-desktop/schema@v0.0.27';
const CHAIN = 'btc:testnet4-blake2b', KIND = 23600, PARENT_TX_KIND = 23503, BROADCAST_CHAIN = 'sidestr:tally';
const DEFAULT_RELAYS = ['wss://relay.primal.net', 'wss://nostr.oxtr.dev', 'wss://nos.lol', 'wss://nostr.mom'];
const { createTabNode, mib, n } = await import(`${NODE}/browser/tabnode.js`);
const { makeChannels, DEFAULT_DELAY, DEFAULT_FEE, DUST } = await import('./lib/channel.mjs');
const LS = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const q = new URLSearchParams(location.search); if (q.get('embedded') === '1') document.body.classList.add('embedded');
const SNAP_URL = q.get('snapshot') ?? LS.get('hitch:snapshot') ?? LS.get('reef:snapshot') ?? 'https://melvin.me/public/txbt4/utxo-knots-150307.dat';
const BLOCKS_URL = q.get('blocks') ?? LS.get('hitch:blocks') ?? LS.get('reef:blocks') ?? 'https://melvin.me/public/txbt4/txbt4-blocks';
const OPT = (() => { const d = { relays: DEFAULT_RELAYS, delay: DEFAULT_DELAY, fee: DEFAULT_FEE }; try { return { ...d, ...JSON.parse(LS.get('hitch:options') ?? '{}') }; } catch { return d; } })();
const saveOptions = () => LS.set('hitch:options', JSON.stringify(OPT));
const money = (s) => (s / 1e8).toFixed(8) + ' tBTC'; const sats = (s) => `${n(s)} sat`; const now = () => Math.floor(Date.now() / 1000);
const fmt = (t) => new Date(t * 1000).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

// ---- log and notices
const LOG = []; function log(text, cls = '') { LOG.push([now(), text, cls]); if (LOG.length > 500) LOG.shift(); const line = (l) => `<div class="${l[2]}">${fmt(l[0])} ${l[1].replace(/</g, '&lt;')}</div>`; $('log').innerHTML = LOG.slice().reverse().map(line).join(''); $('recent').innerHTML = LOG.slice(-8).reverse().map(line).join('') || 'nothing yet'; }
function notify(title, body) { log(`${title}: ${body}`, 'b'); const el = document.createElement('div'); el.className = 'toast'; el.innerHTML = `<b>${title}</b><br>${body}`; $('toasts').appendChild(el); setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, 7000); if ('Notification' in window && Notification.permission === 'granted') new Notification(`Hitch · ${title}`, { body }); }

// ---- the node in the tab
const tn = createTabNode({ base: NODE, snapshotUrl: SNAP_URL, blocksUrl: BLOCKS_URL }); const node = tn.node;
tn.on('sync', ({ msg, pct, eta }) => { $('syncmsg').textContent = msg; if (pct == null) { $('pb').hidden = true; $('synceta').textContent = ''; } else { $('pb').hidden = false; $('pbi').style.width = Math.max(0, Math.min(100, pct)).toFixed(1) + '%'; $('synceta').textContent = eta ? `${pct.toFixed(0)}% · ${eta}` : `${pct.toFixed(0)}%`; } $('ov-node').textContent = node.synced ? `up to date · ${n(node.height)}` : node.phase; });
tn.on('log', ({ text, level }) => { if (level === 'err') log(text, 'e'); });

// ---- keys: Reef's when this browser has one, else Hitch's own; the same key signs channel transactions and relay messages
let W = null, C = null, R = null; // wallet, channels library, relay helpers
async function init() {
  const [{ makeSigner }, txsign, addr, relay, secp, hash, { createKernel }, { knotsBlake2b }, { verifyNostrEvent }] = await Promise.all([import(`${LIB}/schnorr.mjs`), import(`${LIB}/txsign.mjs`), import(`${LIB}/address.mjs`), import(`${LIB}/relay.mjs`), import(`${CDN}/codec/secp256k1.js`), import(`${CDN}/codec/hash.js`), import(`${CDN}/codec/kernel.js`), import(`${CDN}/codec/overlays/knots-blake2b.js`), import(`${CDN}/codec/nostr.js`)]);
  const j = async (p) => (await fetch(`${CDN}/${p}`)).json();
  const k = createKernel({ core: await j('schema/core.jsonld'), proof: await j('schema/proof.jsonld'), script: await j('schema/script.jsonld'), chain: await j('schema/chain.jsonld'), validate: await j('schema/validate.jsonld'), network: CHAIN, overlays: [knotsBlake2b(await j('schema/overlays/knots-blake2b.jsonld'))] });
  const signer = makeSigner({ hash, secp }); const reef = LS.get('reef:key'); let key = /^[0-9a-f]{64}$/.test(reef ?? '') ? reef : LS.get('hitch:key'); if (!/^[0-9a-f]{64}$/.test(key ?? '')) { key = signer.randomKey(); LS.set('hitch:key', key); }
  const pub = signer.pubkeyOf(key), script = '5120' + pub; const events = relay.makeEvents({ signer, hash });
  W = { k, hash, secp, signer, txsign, key, pub, script, address: addr.scriptToAddress(script, 'tb'), fromReef: key === reef, coins: [], height: null };
  C = makeChannels({ k, hash, secp, signer });
  R = { publish: (event) => relay.publish({ relays: OPT.relays, event }), sign: (o) => events.signEvent(key, o), parentTx: (hex) => events.parentTxEvent(signer.randomKey(), BROADCAST_CHAIN, hex), subscribe: relay.subscribe, verify: verifyNostrEvent };
  $('ov-id').textContent = pub; $('ov-addr').textContent = W.address; $('ov-relays').textContent = OPT.relays.map((u) => u.replace('wss://', '')).join(', ');
  log(`node id ${pub.slice(0, 16)}… (${W.fromReef ? "Reef's key" : 'a key of this tab'}); chain address ${W.address.slice(0, 16)}…`);
  R.sub = relay.subscribe({ relays: OPT.relays, chainId: CHAIN, kind: KIND, verify: verifyNostrEvent, since: 3600, log: () => {}, onEvent: (ev) => onMessage(ev) });
}

// ---- channels: one document each, kept in the tab; both sides can rebuild any state's transactions from it
const CH = (() => { try { return JSON.parse(LS.get('hitch:channels') ?? '[]'); } catch { return []; } })();
const save = () => { LS.set('hitch:channels', JSON.stringify(CH)); render(); };
const byId = (id) => CH.find((c) => c.id === id);
const me = (ch) => ch.role, them = (ch) => (ch.role === 'a' ? 'b' : 'a');
const stateOf = (ch, i) => { const s = ch.states[i]; return { balA: s.balA, balB: s.balB, rev: { a: s.revA, b: s.revB } }; };
const myCommit = (ch, i) => C.commitmentTx(ch, i, { ...stateOf(ch, i), owner: me(ch) }); const theirCommit = (ch, i) => C.commitmentTx(ch, i, { ...stateOf(ch, i), owner: them(ch) });
const myBal = (ch) => (ch.role === 'a' ? ch.states[ch.n].balA : ch.states[ch.n].balB), theirBal = (ch) => (ch.role === 'a' ? ch.states[ch.n].balB : ch.states[ch.n].balA);
const newRev = () => { const key = W.signer.randomKey(); return { key, pub: W.signer.pubkeyOf(key) }; };
const send = async (ch, body) => { const ev = R.sign({ kind: KIND, tags: [['chain', CHAIN], ['p', ch.peer], ['ch', ch.id]], content: JSON.stringify(body) }); const r = await R.publish(ev); const ok = Object.values(r).filter((x) => x === 'ok').length; if (!ok) log(`message ${body.t} reached no relay: ${JSON.stringify(r)}`, 'e'); return ok; };
const broadcast = async (hex, what) => { const r = await R.publish(R.parentTx(hex)); const ok = Object.values(r).filter((x) => x === 'ok').length; log(`${what} published to ${ok}/${OPT.relays.length} relays; a producer with a node broadcasts it`, ok ? '' : 'e'); return ok; };

// revocation keys are announced one state ahead, so a payer can sign the payee's next commitment before the payee has seen it
const revs = (ch) => { const r = ch.myRev; return r; };
function ensureMyRev(ch, i) { if (!ch.myRev[i]) { const r = newRev(); ch.myRev[i] = r.key; ch.myRevPub[i] = r.pub; } return ch.myRevPub[i]; }
function fullState(ch, i) { const s = ch.states[i]; return { balA: s.balA, balB: s.balB, rev: { a: ch.role === 'a' ? ch.myRevPub[i] : ch.theirRevPub[i], b: ch.role === 'b' ? ch.myRevPub[i] : ch.theirRevPub[i] } }; }
const myCommitAt = (ch, i) => C.commitmentTx(ch, i, { ...fullState(ch, i), owner: me(ch) }); const theirCommitAt = (ch, i) => C.commitmentTx(ch, i, { ...fullState(ch, i), owner: them(ch) });

// open: the funder builds the funding transaction (kept back until the other side has signed its first commitment) and proposes
async function openChannel(peer, amount) {
  if (!W || !node.synced) throw new Error('the node is not up to date yet'); if (!/^[0-9a-f]{64}$/.test(peer)) throw new Error('a node id is 64 hex characters'); if (peer === W.pub) throw new Error('that is this node'); if (!(amount >= 10000)) throw new Error('at least 10,000 sat');
  const coins = W.coins.filter((c) => mature(c)).sort((x, y) => y.value - x.value); let picked = [], sum = 0, fee = 0; for (const c of coins) { picked.push(c); sum += c.value; fee = Math.ceil(11 + picked.length * 58 + 2 * 43); if (sum >= amount + fee) break; } if (sum < amount + fee) throw new Error(`not enough on-chain coins: ${sats(sum)} available, ${sats(amount + fee)} needed`);
  const f = C.fundingScript(W.pub, peer); const outputs = [{ value: amount, scriptPubKey: f.spk }]; const change = sum - amount - fee; if (change >= DUST) outputs.push({ value: change, scriptPubKey: W.script }); else fee += change;
  const tx = { version: 2, inputs: picked.map((c) => ({ prevout: { txid: c.key.split(':')[0], vout: Number(c.key.split(':')[1]) }, scriptSig: '', sequence: 0xfffffffd })), outputs, lockTime: 0, witness: [] };
  W.txsign.signKeyPath({ k: W.k, hash: W.hash, signer: W.signer }, tx, picked.map((c) => ({ value: c.value, scriptPubKey: W.script })), W.key);
  const txid = C.txid(tx);
  const ch = { id: txid.slice(0, 16), role: 'a', peer, keys: { a: W.pub, b: peer }, funding: { txid, vout: 0, value: amount, hex: C.encode(tx), ...f }, delay: OPT.delay, fee: OPT.fee, n: 0, states: [{ balA: amount, balB: 0 }], myRev: {}, myRevPub: {}, theirRev: {}, theirRevPub: {}, sigs: {}, status: 'proposed', at: now(), pending: null };
  ensureMyRev(ch, 0); ensureMyRev(ch, 1); CH.push(ch); for (const c of picked) W.coins = W.coins.filter((x) => x !== c); save();
  await send(ch, { t: 'open', id: ch.id, funding: { txid, vout: 0, value: amount }, delay: ch.delay, fee: ch.fee, a: W.pub, b: peer, rev: [ch.myRevPub[0], ch.myRevPub[1]] });
  log(`channel ${ch.id} proposed to ${peer.slice(0, 12)}… for ${sats(amount)}; waiting for the other side`); }

// ---- messages
async function onMessage(ev) { let m; try { m = JSON.parse(ev.content); } catch { return; } if (!W || !ev.tags.some((t) => t[0] === 'p' && t[1] === W.pub)) return; const from = ev.pubkey;
  try {
    if (m.t === 'open') { if (byId(m.id) || m.b !== W.pub || m.a !== from) return; if (!(m.funding?.value >= 10000) || !(m.delay >= 1) || !(m.fee >= 100) || !Array.isArray(m.rev) || m.rev.length !== 2) return log(`open from ${from.slice(0, 12)}… refused: bad terms`, 'e');
      const f = C.fundingScript(m.a, m.b);
      const ch = { id: m.id, role: 'b', peer: from, keys: { a: m.a, b: m.b }, funding: { txid: m.funding.txid, vout: m.funding.vout, value: m.funding.value, ...f }, delay: m.delay, fee: m.fee, n: 0, states: [{ balA: m.funding.value, balB: 0 }], myRev: {}, myRevPub: {}, theirRev: {}, theirRevPub: { 0: m.rev[0], 1: m.rev[1] }, sigs: {}, status: 'accepted', at: now(), pending: null };
      ensureMyRev(ch, 0); ensureMyRev(ch, 1); const sig = C.signFunding(ch, theirCommitAt(ch, 0).tx, W.key); CH.push(ch); save();
      await send(ch, { t: 'accept', id: ch.id, rev: [ch.myRevPub[0], ch.myRevPub[1]], sig }); log(`channel ${ch.id} from ${from.slice(0, 12)}…: ${sats(m.funding.value)} on their side; accepted, their first commitment signed`); notify('Channel offered', `${sats(m.funding.value)} from ${from.slice(0, 12)}…`); return; }
    const ch = byId(m.id); if (!ch || ch.peer !== from) return;
    if (m.t === 'accept' && ch.role === 'a' && ch.status === 'proposed') { ch.theirRevPub[0] = m.rev[0]; ch.theirRevPub[1] = m.rev[1]; if (!C.verifyFunding(ch, myCommitAt(ch, 0).tx, ch.peer, m.sig)) return log(`accept for ${ch.id}: their signature on my commitment does not verify`, 'e');
      ch.sigs[0] = m.sig; const sig = C.signFunding(ch, theirCommitAt(ch, 0).tx, W.key); ch.status = 'funding'; save(); await send(ch, { t: 'commit', id: ch.id, sig });
      await broadcast(ch.funding.hex, `funding of ${ch.id}`); log(`channel ${ch.id}: accepted; funding ${ch.funding.txid.slice(0, 16)}… published, waiting for a block`); return; }
    if (m.t === 'commit' && ch.role === 'b' && ch.status === 'accepted') { if (!C.verifyFunding(ch, myCommitAt(ch, 0).tx, ch.peer, m.sig)) return log(`commit for ${ch.id}: their signature does not verify`, 'e'); ch.sigs[0] = m.sig; ch.status = 'funding'; save(); log(`channel ${ch.id}: my first commitment is signed; waiting for the funding to confirm`); return; }
    if (m.t === 'update') { if (ch.status !== 'open') return; if (m.n !== ch.n + 1) return log(`update for ${ch.id} at state ${m.n}, expected ${ch.n + 1}`, 'e'); if (ch.pending) return log(`update for ${ch.id} while mine is pending; ignored`, 'e');
      const cur = ch.states[ch.n]; if (m.balA + m.balB !== cur.balA + cur.balB || m.balA < 0 || m.balB < 0) return log(`update for ${ch.id}: balances do not add up`, 'e');
      const gain = ch.role === 'a' ? m.balA - cur.balA : m.balB - cur.balB; if (gain < 0) return log(`update for ${ch.id} would take ${sats(-gain)} from me; refused`, 'e');
      ch.states[m.n] = { balA: m.balA, balB: m.balB }; ch.theirRevPub[m.n + 1] = m.nextRev; ensureMyRev(ch, m.n + 1);
      if (!C.verifyFunding(ch, myCommitAt(ch, m.n).tx, ch.peer, m.sig)) { delete ch.states[m.n]; return log(`update for ${ch.id}: their signature on my new commitment does not verify`, 'e'); }
      ch.sigs[m.n] = m.sig; const sig = C.signFunding(ch, theirCommitAt(ch, m.n).tx, W.key); const reveal = ch.myRev[ch.n]; ch.n = m.n; save();
      await send(ch, { t: 'ack', id: ch.id, n: m.n, sig, reveal, nextRev: ch.myRevPub[m.n + 1] }); log(`channel ${ch.id}: received ${sats(gain)}${m.memo ? ` for "${m.memo}"` : ''}; state ${m.n}`); notify('Payment received', `${sats(gain)} on channel ${ch.id}${m.memo ? ` · ${m.memo}` : ''}`); return; }
    if (m.t === 'ack') { const p = ch.pending; if (!p || m.n !== p.n) return; if (!C.verifyFunding(ch, myCommitAt(ch, p.n).tx, ch.peer, m.sig)) return log(`ack for ${ch.id}: their signature does not verify`, 'e');
      if (W.signer.pubkeyOf(m.reveal) !== ch.theirRevPub[ch.n]) return log(`ack for ${ch.id}: the revealed secret is not state ${ch.n}'s`, 'e');
      ch.theirRev[ch.n] = m.reveal; ch.theirRevPub[p.n + 1] = m.nextRev; ch.sigs[p.n] = m.sig; const reveal = ch.myRev[ch.n]; ch.n = p.n; ch.pending = null; ensureMyRev(ch, p.n + 1); save(); await send(ch, { t: 'revoke', id: ch.id, n: p.n, reveal }); log(`channel ${ch.id}: paid ${sats(p.amount)}${p.memo ? ` for "${p.memo}"` : ''}; state ${p.n}`); return; }
    if (m.t === 'revoke') { if (m.n !== ch.n) return; if (W.signer.pubkeyOf(m.reveal) !== ch.theirRevPub[ch.n - 1]) return log(`revoke for ${ch.id}: not state ${ch.n - 1}'s secret`, 'e'); ch.theirRev[ch.n - 1] = m.reveal; save(); return; }
    if (m.t === 'close') { if (!['open', 'funding'].includes(ch.status)) return; const tx = C.closingTx(ch, fullState(ch, ch.n)); if (!C.verifyFunding(ch, tx, ch.peer, m.sig)) return log(`close for ${ch.id}: their signature does not verify`, 'e');
      tx.witness = [C.fundingWitness(ch, { [ch.peer]: m.sig, [W.pub]: C.signFunding(ch, tx, W.key) })]; const v = C.verifyTx(tx, [C.fundingPrevout(ch)]); if (!v.ok) return log(`close for ${ch.id}: the closing transaction fails: ${v.error}`, 'e');
      ch.status = 'closing'; ch.closeTxid = C.txid(tx); save(); await broadcast(C.encode(tx), `cooperative close of ${ch.id}`); log(`channel ${ch.id}: closing cooperatively at state ${ch.n}, ${sats(myBal(ch))} to me`); return; }
  } catch (e) { log(`message ${m.t} for ${m.id}: ${e.message}`, 'e'); } }

// pay: the update that moves `amount` from me to them, with my signature on their new commitment (their next revocation key is known ahead)
async function pay(ch, amount, memo = null) { if (ch.status !== 'open') throw new Error('the channel is not open'); if (ch.pending) throw new Error('an update is already pending'); const room = myBal(ch) - (ch.role === 'a' ? ch.fee : 0); if (!(amount >= 1) || amount > room) throw new Error(`amount must be between 1 and ${sats(Math.max(0, room))}`); if (!ch.theirRevPub[ch.n + 1]) throw new Error('their next revocation key is not known yet');
  const cur = ch.states[ch.n]; const n1 = ch.n + 1; ch.states[n1] = { balA: cur.balA - (ch.role === 'a' ? amount : -amount), balB: cur.balB - (ch.role === 'b' ? amount : -amount) }; ensureMyRev(ch, n1); ensureMyRev(ch, n1 + 1);
  const sig = C.signFunding(ch, theirCommitAt(ch, n1).tx, W.key); ch.pending = { n: n1, amount, memo, at: now() }; save();
  await send(ch, { t: 'update', id: ch.id, n: n1, balA: ch.states[n1].balA, balB: ch.states[n1].balB, sig, nextRev: ch.myRevPub[n1 + 1], memo }); }
async function closeChannel(ch) { if (!['open', 'funding'].includes(ch.status)) throw new Error('not open'); const tx = C.closingTx(ch, fullState(ch, ch.n)); const sig = C.signFunding(ch, tx, W.key); ch.status = 'closing-asked'; ch.closeTxid = C.txid(tx); save(); await send(ch, { t: 'close', id: ch.id, n: ch.n, sig }); log(`channel ${ch.id}: cooperative close asked at state ${ch.n}`); }
async function forceClose(ch, stateIndex = ch.n, why = 'forced') { const i = stateIndex; const c = myCommitAt(ch, i); if (!ch.sigs[i]) throw new Error(`state ${i} was never signed by them`); c.tx.witness = [C.fundingWitness(ch, { [W.pub]: C.signFunding(ch, c.tx, W.key), [ch.peer]: ch.sigs[i] })]; const v = C.verifyTx(c.tx, [C.fundingPrevout(ch)]); if (!v.ok) throw new Error(`my commitment fails: ${v.error}`);
  ch.status = 'force-closing'; ch.closeTxid = C.txid(c.tx); ch.closeState = i; save(); await broadcast(C.encode(c.tx), `${why} close of ${ch.id} at state ${i}`); log(`channel ${ch.id}: ${why} close published, my commitment ${ch.closeTxid.slice(0, 16)}… at state ${i}${i < ch.n ? ' (AN OLD STATE: the other side can take it all)' : ''}`, i < ch.n ? 'e' : ''); }

// ---- the chain: the funding output watched through the tab's own node; a spend classified and answered
const mature = (c) => !c.coinbase || (W.height != null && W.height + 1 - c.height >= 100);
function watch() { if (!W || !node.synced) return; tn.post({ type: 'coins', script: W.script }); for (const ch of CH) if (!['closed', 'proposed', 'accepted'].includes(ch.status)) tn.post({ type: 'coins', script: ch.funding.spk, req: ch.id }); }
tn.on('coins', (m) => { if (!W) return; if (m.script === W.script) { W.coins = m.coins; W.height = m.height; renderBalances(); return; }
  const ch = CH.find((c) => c.funding.spk === m.script && !['closed', 'proposed', 'accepted'].includes(c.status)); if (!ch) return; const key = `${ch.funding.txid}:${ch.funding.vout}`; const coin = m.coins.find((c) => c.key === key);
  if (coin) { const conf = m.height - coin.height + 1; if (ch.status === 'funding' || ch.status === 'proposed') { ch.status = 'open'; ch.fundedHeight = coin.height; save(); notify('Channel open', `${ch.id}: ${sats(ch.funding.value)} funded at block ${n(coin.height)}`); } else if (!ch.fundedHeight) { ch.fundedHeight = coin.height; save(); } ch.conf = conf; renderChannels(); return; }
  if (ch.fundedHeight && !['closed', 'settled'].includes(ch.status) && !ch.spendAsked) { ch.spendAsked = now(); tn.post({ type: 'spend', key, from: ch.fundedHeight, req: ch.id }); } });
tn.on('spend', async (m) => { if (typeof m.req === 'string' && m.req.endsWith(':penalty')) { const ch = byId(m.req.slice(0, -8)); if (ch && m.found && m.txid === ch.penaltyTxid) { ch.status = 'punished'; save(); notify('Penalty confirmed', `${ch.id}: the penalty is in block ${n(m.height)}; the channel's funds are mine`); } return; }
  const ch = CH.find((c) => c.id === m.req); if (!ch) return; ch.spendAsked = null; if (!m.found) return;
  const spent = { txid: m.txid, height: m.height, hex: m.hex }; if (ch.spentBy?.txid === m.txid) { await afterClose(ch); return; } ch.spentBy = spent;
  if (ch.closeTxid === m.txid && (ch.status === 'closing' || ch.status === 'closing-asked')) { ch.status = 'closed'; save(); notify('Channel closed', `${ch.id} settled cooperatively at block ${n(m.height)}; ${sats(myBal(ch))} to my key`); return; }
  if (ch.closeTxid === m.txid && ch.status === 'force-closing') { ch.status = 'closed-mine'; save(); log(`channel ${ch.id}: my commitment is in block ${n(m.height)}; my ${sats(myBal(ch))} can be swept after ${ch.delay} blocks`); await afterClose(ch); return; }
  // theirs: which state? the latest is fine (my share is a plain coin of my key); an old one is punished with its secret
  for (let i = 0; i <= ch.n; i++) { const t = theirCommitAt(ch, i); if (C.txid(t.tx) !== m.txid) continue;
    if (i === ch.n) { ch.status = 'closed-theirs'; save(); notify('Channel closed by the other side', `${ch.id} at state ${i}, block ${n(m.height)}; my ${sats(myBal(ch))} is a coin of my key now`); return; }
    const secret = ch.theirRev[i]; if (!secret) { ch.status = 'closed-theirs-old'; save(); log(`channel ${ch.id}: they closed at old state ${i} but I hold no secret for it`, 'e'); return; }
    const vout = t.kinds.indexOf('to_local'); if (vout < 0) { ch.status = 'closed-theirs-old'; save(); return; } const value = t.tx.outputs[vout].value;
    const pen = C.sweepTx({ commit: t, txid: m.txid, vout, value, to: W.script, fee: ch.fee, delayed: 0, key: secret }); const v = C.verifyTx(pen, [{ value, scriptPubKey: t.toLocal.spk }]); if (!v.ok) { log(`penalty for ${ch.id} fails: ${v.error}`, 'e'); return; }
    ch.status = 'punishing'; ch.penaltyTxid = C.txid(pen); ch.penaltyVout = vout; save(); await broadcast(C.encode(pen), `penalty on ${ch.id} (their revoked state ${i})`); notify('Cheat punished', `${ch.id}: they published revoked state ${i}; ${sats(value - ch.fee)} taken with the penalty`); return; }
  ch.status = 'spent-unknown'; save(); log(`channel ${ch.id}: the funding was spent by ${m.txid.slice(0, 16)}… which is none of the transactions I know`, 'e'); });
// after my own forced close: sweep the delayed to_local once the delay has passed
async function afterClose(ch) { if (ch.status !== 'closed-mine' || ch.swept) return; const conf = node.height - ch.spentBy.height + 1; if (conf < ch.delay) { ch.sweepAt = ch.spentBy.height + ch.delay; save(); return; } const c = myCommitAt(ch, ch.closeState ?? ch.n); const vout = c.kinds.indexOf('to_local'); if (vout < 0) { ch.status = 'closed'; save(); return; }
  const value = c.tx.outputs[vout].value; const sw = C.sweepTx({ commit: c, txid: ch.closeTxid, vout, value, to: W.script, fee: ch.fee, delayed: ch.delay, key: W.key }); const v = C.verifyTx(sw, [{ value, scriptPubKey: c.toLocal.spk }]); if (!v.ok) return log(`sweep for ${ch.id} fails: ${v.error}`, 'e'); ch.swept = C.txid(sw); ch.status = 'closed'; save(); await broadcast(C.encode(sw), `sweep of ${ch.id}`); notify('Channel settled', `${ch.id}: ${sats(value - ch.fee)} swept to my key after the delay`); }
tn.on('synced', () => { if (!W) return; watch(); for (const ch of CH) { if (ch.status === 'closed-mine') afterClose(ch); if (ch.status === 'punishing' && ch.spentBy && ch.penaltyVout != null) tn.post({ type: 'spend', key: `${ch.spentBy.txid}:${ch.penaltyVout}`, from: ch.spentBy.height, req: ch.id + ':penalty' }); } if (!node.mempoolOn) { node.mempoolOn = true; tn.followMempool({ relays: OPT.relays }); } });

// ---- invoices: hitch1 + base64url of { p: node id, a: sats, m: memo, i: id }
const b64u = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); const unb64u = (s) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
function makeInvoice(amount, memo) { const inv = { p: W.pub, a: amount, m: memo || undefined, i: W.signer.randomKey().slice(0, 16) }; return 'hitch1' + b64u(JSON.stringify(inv)); }
function parseInvoice(s) { s = s.trim(); if (!s.startsWith('hitch1')) throw new Error('not a Hitch invoice'); const inv = JSON.parse(unb64u(s.slice(6))); if (!/^[0-9a-f]{64}$/.test(inv.p) || !(inv.a >= 1)) throw new Error('bad invoice'); return inv; }

// ---- rendering
const stLabel = (s) => ({ proposed: ['proposed', 'pend'], accepted: ['accepted, waiting for their signature', 'pend'], funding: ['funding, waiting for a block', 'pend'], open: ['open', 'open'], 'closing-asked': ['close asked', 'pend'], closing: ['closing', 'pend'], 'force-closing': ['force closing', 'pend'], 'closed-mine': ['closed by me, delay running', 'pend'], 'closed-theirs': ['closed by them', 'closed'], closed: ['closed', 'closed'], punishing: ['punishing a cheat', 'bad'], punished: ['closed: their cheat punished', 'closed'], 'closed-theirs-old': ['closed by them at an old state', 'bad'], 'spent-unknown': ['spent by an unknown transaction', 'bad'] }[s] ?? [s, '']);
function renderChannels() { const el = $('chlist'); el.innerHTML = CH.length ? CH.slice().reverse().map((ch) => { const tot = ch.funding.value; const mine = myBal(ch), theirs = theirBal(ch); const [lbl, cls] = stLabel(ch.status);
    return `<div class="chan"><div class="hd"><b>${ch.id}</b><span class="st ${cls}">${lbl}</span><span class="mut">with ${ch.peer.slice(0, 12)}… · ${ch.role === 'a' ? 'I funded' : 'they funded'} ${sats(tot)} · state ${ch.n}${ch.conf ? ` · ${ch.conf} conf` : ''}${ch.pending ? ' · update pending' : ''}</span></div>
    <div class="bar2" title="mine ${sats(mine)} · theirs ${sats(theirs)}"><i style="width:${(mine / tot * 100).toFixed(1)}%"></i><i class="r" style="width:${(theirs / tot * 100).toFixed(1)}%"></i></div>
    <div class="row" style="margin-top:6px;font-size:12px"><span>mine <b class="mono">${sats(mine)}</b></span><span class="mut">theirs ${sats(theirs)}</span><span class="fill" style="flex:1"></span>${ch.status === 'open' ? `<button class="q" data-act="close" data-ch="${ch.id}">Close</button><button class="q" data-act="force" data-ch="${ch.id}" title="publish my latest commitment; my share waits ${ch.delay} blocks">Force close</button>${ch.n > 0 ? `<button class="q" data-act="cheat" data-ch="${ch.id}" title="publish an OLD commitment of mine: the other side should punish it (a test)">Cheat</button>` : ''}` : ''}<button class="q" data-act="forget" data-ch="${ch.id}" title="remove from this tab (the chain is unaffected)">Forget</button></div></div>`; }).join('') : '<div class="mut">no channels yet: open one to another tab\'s node id, or wait for one to be opened to you</div>';
  el.querySelectorAll('button[data-act]').forEach((b) => { b.onclick = async () => { const ch = byId(b.dataset.ch); try { if (b.dataset.act === 'close') await closeChannel(ch); else if (b.dataset.act === 'force') await forceClose(ch); else if (b.dataset.act === 'cheat') await forceClose(ch, ch.n - 1, 'CHEATING'); else if (b.dataset.act === 'forget') { if (ch.status === 'open' && !confirm('This channel is open. Forgetting it here does not close it; the funds stay in the 2-of-2. Continue?')) return; CH.splice(CH.indexOf(ch), 1); save(); } } catch (e) { log(`${b.dataset.act} ${ch.id}: ${e.message}`, 'e'); } }; });
  $('push-ch').innerHTML = CH.filter((c) => c.status === 'open').map((c) => `<option value="${c.id}">${c.id} · mine ${sats(myBal(c))} · with ${c.peer.slice(0, 10)}…</option>`).join('') || '<option value="">no open channel</option>'; renderBalances(); }
function renderBalances() { if (!W) return; const open = CH.filter((c) => c.status === 'open'); const local = open.reduce((a, c) => a + myBal(c), 0), remote = open.reduce((a, c) => a + theirBal(c), 0); let avail = 0, imm = 0; for (const c of W.coins) (mature(c) ? (avail += c.value) : (imm += c.value));
  $('ch-local').textContent = money(local); $('ch-remote').textContent = money(remote); $('avail').textContent = money(avail); $('immature').textContent = money(imm); $('ch-count').textContent = `${open.length} open, ${CH.length} in all`; }
function render() { renderChannels(); }

// ---- the page
document.querySelectorAll('.tool button[data-p]').forEach((b) => { b.onclick = () => { document.querySelectorAll('.tool button[data-p]').forEach((x) => x.classList.toggle('on', x === b)); document.querySelectorAll('.page').forEach((p) => p.classList.toggle('on', p.id === 'p-' + b.dataset.p)); }; });
document.querySelectorAll('#menu > div').forEach((m) => { m.onclick = (e) => { const open = m.classList.contains('open'); document.querySelectorAll('#menu > div').forEach((x) => x.classList.remove('open')); if (!open && !e.target.closest('.dd')) m.classList.add('open'); }; }); document.addEventListener('click', (e) => { if (!e.target.closest('#menu')) document.querySelectorAll('#menu > div').forEach((x) => x.classList.remove('open')); });
$('op-go').onclick = async () => { try { $('op-out').textContent = 'proposing…'; await openChannel($('op-peer').value.trim().toLowerCase(), Math.round(Number($('op-amt').value))); $('op-out').textContent = 'proposed; waiting for the other side'; } catch (e) { $('op-out').textContent = e.message; } };
$('push-go').onclick = async () => { try { const ch = byId($('push-ch').value); if (!ch) throw new Error('no open channel'); await pay(ch, Math.round(Number($('push-amt').value))); $('push-out').textContent = 'update sent'; } catch (e) { $('push-out').textContent = e.message; } };
$('pay-go').onclick = async () => { try { const inv = parseInvoice($('pay-inv').value); const ch = CH.find((c) => c.status === 'open' && c.peer === inv.p && myBal(c) - (c.role === 'a' ? c.fee : 0) >= inv.a); if (!ch) throw new Error('no open channel to that node with enough on my side'); await pay(ch, inv.a, inv.m ?? null); $('pay-out').textContent = `paying ${sats(inv.a)} on ${ch.id}`; } catch (e) { $('pay-out').textContent = e.message; } };
$('pay-paste').onclick = async () => { try { $('pay-inv').value = await navigator.clipboard.readText(); } catch {} };
$('inv-go').onclick = () => { const s = makeInvoice(Math.round(Number($('inv-amt').value)), $('inv-memo').value.trim()); $('inv-out').value = s; try { const qr = qrcode(0, 'M'); qr.addData(s); qr.make(); $('inv-qr').innerHTML = qr.createSvgTag({ cellSize: 3, margin: 0 }); } catch {} };
$('inv-copy').onclick = async () => { try { await navigator.clipboard.writeText($('inv-out').value); $('inv-copy').textContent = 'Copied'; setTimeout(() => { $('inv-copy').textContent = 'Copy'; }, 1500); } catch {} };
$('m-nodeid').onclick = async () => { try { await navigator.clipboard.writeText(W.pub); notify('Copied', 'this node id is on the clipboard'); } catch {} };
$('m-exit').onclick = () => { $('win').style.display = 'none'; }; $('dot-close').onclick = () => { $('win').style.display = 'none'; };
$('m-readme').onclick = () => window.open('https://github.com/bitcoin-blake/hitch#readme', '_blank', 'noopener'); $('m-source').onclick = () => window.open('https://github.com/bitcoin-blake/hitch', '_blank', 'noopener');
$('m-about').onclick = () => $('about').showModal(); $('about-ok').onclick = () => $('about').close();
$('m-options').onclick = () => { $('o-relays').value = OPT.relays.join('\n'); $('o-delay').value = OPT.delay; $('o-fee').value = OPT.fee; $('o-snapshot').value = SNAP_URL; $('o-blocks').value = BLOCKS_URL; $('options').showModal(); }; $('o-cancel').onclick = () => $('options').close();
$('o-ok').onclick = () => { const relays = $('o-relays').value.split(/\s+/).filter((r) => /^wss?:\/\//.test(r)); OPT.relays = relays.length ? relays : DEFAULT_RELAYS; OPT.delay = Math.max(1, Math.round(Number($('o-delay').value) || DEFAULT_DELAY)); OPT.fee = Math.max(100, Math.round(Number($('o-fee').value) || DEFAULT_FEE)); saveOptions(); const s = $('o-snapshot').value.trim(), b = $('o-blocks').value.trim(); if (s) LS.set('hitch:snapshot', s); if (b) LS.set('hitch:blocks', b); $('options').close(); location.search = ''; };
if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
window.hitch = { tn, node, CH, get W() { return W; }, get C() { return C; }, pay, openChannel, closeChannel, forceClose };
try { await init(); } catch (e) { log('could not start: ' + e.message, 'e'); }
render(); log('Hitch started');
try { await tn.start(); } catch (e) { $('syncmsg').textContent = 'Error: could not start the node: ' + e.message; }
