// The channel protocol, pure. One peer's channels are documents; the messages between peers are JSON bodies that the
// host signs and carries as relay events; this module is the state machine. Hosts: hitch.js (a tab), bin/hub.mjs (Node).
//
// Invariants the module keeps, because money depends on them:
//   - a signature I have sent for a state is binding until that state is revoked by the other side: a pending update is
//     never simply dropped; when both sides propose at once the lower key's update stands and the other side's signed
//     state is remembered as an alternative the peer might publish, punishable once the peer revokes that state number;
//   - a payment is final for me only when the other side has revoked the state before it; until then nothing is
//     forwarded, settled or announced, and no further update is accepted or proposed;
//   - a settle is refused after the HTLC's expiry, a fail by the offerer is refused while I hold the preimage, and every
//     preimage I learn is kept so an HTLC can be claimed on the chain after a forced close;
//   - every field of every message is checked for shape before it is used, and nothing is written to the channel
//     until the message has been verified in full.
//
// The host gives `io`: send(ch, body) → relays reached, broadcast(hex, what) → relays reached (0 = failed),
// buildFunding(amount, spk) → { txid, vout, hex }, height(), save(), log(text, cls), notify(title, body),
// myScript, and optionally acceptOpen(from, m), onUpdate(ch, m, sender), onAcked(ch, m), invoiceFor(hash) → { preimage, amount } | null.
import { DUST, MIN_DELAY, MAX_DELAY, MIN_FEE, MAX_FEE, MAX_EXPIRY } from './channel.mjs';
export const KIND = 23600;
export const MIN_OPEN = 10000, MIN_HTLC = 1000, EXPIRY_MARGIN = 12; // sats; blocks an HTLC must keep beyond the delay
export const LIVE = new Set(['proposed', 'accepted', 'funding', 'open', 'closing-asked']);
export const WATCHED = new Set(['funding', 'open', 'closing-asked', 'closing', 'force-closing', 'closed-mine', 'closed-theirs', 'closed-theirs-alt', 'punishing']);
const now = () => Math.floor(Date.now() / 1000);
const HEX64 = /^[0-9a-f]{64}$/, HEX16 = /^[0-9a-f]{16}$/;
const isInt = (x, lo = 0, hi = Number.MAX_SAFE_INTEGER) => Number.isInteger(x) && x >= lo && x <= hi;
const isHex64 = (x) => typeof x === 'string' && HEX64.test(x);
const isSig = (x) => typeof x === 'string' && /^[0-9a-f]{130}$/.test(x);
const MEMO_MAX = 140;

// what each message must look like; anything else is dropped before it touches a channel
function wellFormed(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'not an object';
  if (typeof m.t !== 'string' || typeof m.id !== 'string' || !HEX16.test(m.id)) return 'bad id';
  const memoOk = m.memo == null || (typeof m.memo === 'string' && m.memo.length <= MEMO_MAX);
  switch (m.t) {
    case 'open': return (m.funding && isHex64(m.funding.txid) && isInt(m.funding.vout, 0, 0xffff) && isInt(m.funding.value, MIN_OPEN) && m.id === m.funding.txid.slice(0, 16)
      && isInt(m.push ?? 0, 0) && isInt(m.delay, MIN_DELAY, MAX_DELAY) && isInt(m.fee, MIN_FEE, MAX_FEE) && isHex64(m.a) && isHex64(m.b) && m.a !== m.b
      && Array.isArray(m.rev) && m.rev.length === 2 && m.rev.every(isHex64) && (m.hubFee == null || isInt(m.hubFee, 0, 100000))) ? null : 'bad open';
    case 'accept': return (Array.isArray(m.rev) && m.rev.length === 2 && m.rev.every(isHex64) && isSig(m.sig) && (m.hubFee == null || isInt(m.hubFee, 0, 100000))) ? null : 'bad accept';
    case 'commit': return isSig(m.sig) ? null : 'bad commit';
    case 'ready': return null;
    case 'update': { if (!isInt(m.n, 1) || !isSig(m.sig) || !isHex64(m.nextRev) || !memoOk) return 'bad update';
      if (m.kind === 'pay') return isInt(m.amount, 1) ? null : 'bad pay';
      if (m.kind === 'add') { const h = m.htlc; return (h && isInt(h.id, 1) && isInt(h.amount, MIN_HTLC) && isHex64(h.hash) && isInt(h.expiry, 1, MAX_EXPIRY - 1) && (h.route == null || (typeof h.route === 'object' && isHex64(h.route.to)))) ? null : 'bad add'; }
      if (m.kind === 'settle') return (isInt(m.htlcId, 1) && isHex64(m.preimage)) ? null : 'bad settle';
      if (m.kind === 'fail') return (isInt(m.htlcId, 1) && (m.reason == null || (typeof m.reason === 'string' && m.reason.length <= MEMO_MAX))) ? null : 'bad fail';
      return 'unknown kind'; }
    case 'ack': return (isInt(m.n, 1) && isSig(m.sig) && isHex64(m.reveal) && isHex64(m.nextRev)) ? null : 'bad ack';
    case 'revoke': return (isInt(m.n, 1) && isHex64(m.reveal)) ? null : 'bad revoke';
    case 'close': return (isInt(m.n, 0) && isSig(m.sig)) ? null : 'bad close';
    case 'sync': case 'synced': return (isInt(m.n, 0) && (m.pendingN == null || isInt(m.pendingN, 1)) && (m.reveal == null || isHex64(m.reveal)) && (m.missing == null || (Array.isArray(m.missing) && m.missing.length <= 64 && m.missing.every((i) => isInt(i, 0))))
      && (m.reveals == null || (typeof m.reveals === 'object' && Object.entries(m.reveals).length <= 64 && Object.entries(m.reveals).every(([i, r]) => /^\d+$/.test(i) && isHex64(r)))) && (m.status == null || typeof m.status === 'string')) ? null : 'bad sync';
    default: return 'unknown message';
  }
}

export function makePeer({ C, signer, hash, pub, key, channels, io, opts = {} }) {
  const delay = opts.delay ?? 6, fee = opts.fee ?? 300, hubFee = opts.hubFee ?? 10, minDelay = opts.minDelay ?? MIN_DELAY;
  const CH = channels;
  const byId = (id) => CH.find((c) => c.id === id);
  const me = (ch) => ch.role, them = (ch) => (ch.role === 'a' ? 'b' : 'a');
  const sha = (hex) => hash.bytesToHex(hash.sha256(hash.hexToBytes(hex)));
  const save = () => io.save();
  const log = (t, c) => io.log(t, c);
  const send = (ch, body) => io.send(ch, body);
  const height = () => io.height();

  // ---- keys and states
  const newRev = () => { const k = signer.randomKey(); return { key: k, pub: signer.pubkeyOf(k) }; };
  const ensureMyRev = (ch, i) => { if (!ch.myRev[i]) { const r = newRev(); ch.myRev[i] = r.key; ch.myRevPub[i] = r.pub; } return ch.myRevPub[i]; };
  const st = (ch, i) => ch.states[i];
  const revs = (ch, i) => ({ a: ch.role === 'a' ? ch.myRevPub[i] : ch.theirRevPub[i], b: ch.role === 'b' ? ch.myRevPub[i] : ch.theirRevPub[i] });
  const fullState = (ch, i, s = st(ch, i)) => ({ balA: s.balA, balB: s.balB, htlcs: s.htlcs ?? [], rev: revs(ch, i) });
  const myCommitAt = (ch, i, s) => C.commitmentTx(ch, i, { ...fullState(ch, i, s), owner: me(ch) });
  const theirCommitAt = (ch, i, s) => C.commitmentTx(ch, i, { ...fullState(ch, i, s), owner: them(ch) });
  const bal = (ch, who, i = ch.n) => (who === 'a' ? st(ch, i).balA : st(ch, i).balB);
  const myBal = (ch) => bal(ch, me(ch)), theirBal = (ch) => bal(ch, them(ch));
  const room = (ch) => myBal(ch) - (ch.role === 'a' ? ch.fee : 0);
  const htlcs = (ch) => st(ch, ch.n).htlcs ?? [];
  const nextHtlcId = (s) => (s.htlcs ?? []).reduce((a, x) => Math.max(a, x.id), 0) + 1;
  const knownPreimage = (ch, h) => ch.preimages?.[h] ?? io.invoiceFor?.(h)?.preimage ?? null;
  const rememberPreimage = (ch, h, preimage) => { ch.preimages ??= {}; if (!ch.preimages[h]) ch.preimages[h] = preimage; };
  // a state I signed for the other side at index n that did not become the agreed state; the peer may still publish it
  const rememberAlt = (ch, n, s) => { ch.signedAlt ??= {}; (ch.signedAlt[n] ??= []).push({ balA: s.balA, balB: s.balB, htlcs: s.htlcs ?? [] }); };
  // the revocation secrets the other side owes me: every state below the current one
  const missingReveals = (ch) => { const out = []; for (let i = 0; i < ch.n; i++) if (!ch.theirRev[i] && ch.theirRevPub[i]) out.push(i); return out; };
  const awaitingRevoke = (ch) => ch.awaiting != null;

  // ---- opening
  async function openChannel(peer, amount, push = 0) {
    if (!isHex64(peer)) throw new Error('a node id is 64 hex characters');
    if (peer === pub) throw new Error('that is this node');
    if (!isInt(amount, MIN_OPEN)) throw new Error(`at least ${MIN_OPEN} sat, a whole number`);
    if (!isInt(push, 0) || push > amount - fee - DUST) throw new Error('push must leave the funder its fee and dust');
    const f = C.fundingScript(pub, peer);
    const fund = await io.buildFunding(amount, f.spk);
    const ch = { id: fund.txid.slice(0, 16), role: 'a', peer, keys: { a: pub, b: peer }, funding: { txid: fund.txid, vout: fund.vout, value: amount, hex: fund.hex, ...f },
      delay, fee, n: 0, states: [{ balA: amount - push, balB: push, htlcs: [] }], myRev: {}, myRevPub: {}, theirRev: {}, theirRevPub: {}, sigs: {}, status: 'proposed', at: now(), pending: null, preimages: {}, unsent: [] };
    ensureMyRev(ch, 0); ensureMyRev(ch, 1);
    CH.push(ch); save();
    await send(ch, { t: 'open', id: ch.id, funding: { txid: fund.txid, vout: fund.vout, value: amount }, push, delay, fee, a: pub, b: peer, rev: [ch.myRevPub[0], ch.myRevPub[1]], hubFee: opts.hub ? hubFee : undefined });
    log(`channel ${ch.id} proposed to ${peer.slice(0, 12)}… for ${amount} sat${push ? ` (${push} pushed to them)` : ''}`);
    return ch;
  }

  // ---- the next state from the current one, by kind; both sides compute it and must agree
  function nextState(ch, cur, m, sender) {
    const s = { balA: cur.balA, balB: cur.balB, htlcs: (cur.htlcs ?? []).map((h) => ({ ...h })) };
    const other = sender === 'a' ? 'b' : 'a';
    const add = (who, v) => { if (who === 'a') s.balA += v; else s.balB += v; };
    if (m.kind === 'pay') { add(sender, -m.amount); add(other, m.amount); }
    else if (m.kind === 'add') {
      const h = m.htlc; if (h.id !== nextHtlcId(cur)) throw new Error('bad htlc id');
      if (h.expiry <= height() + ch.delay + EXPIRY_MARGIN) throw new Error('the htlc would expire too soon');
      if (s.htlcs.some((x) => x.hash === h.hash)) throw new Error('an htlc with that hash is already in flight');
      add(sender, -h.amount); s.htlcs.push({ id: h.id, from: sender, amount: h.amount, hash: h.hash, expiry: h.expiry, route: h.route ?? null }); }
    else if (m.kind === 'settle') {
      const i = s.htlcs.findIndex((h) => h.id === m.htlcId); if (i < 0) throw new Error('no such htlc');
      const h = s.htlcs[i]; if (h.from === sender) throw new Error('the offerer cannot settle');
      if (sha(m.preimage) !== h.hash) throw new Error('wrong preimage');
      if (height() >= h.expiry) throw new Error('the htlc has expired; it settles on the chain or not at all');
      s.htlcs.splice(i, 1); add(sender, h.amount); }
    else if (m.kind === 'fail') {
      const i = s.htlcs.findIndex((h) => h.id === m.htlcId); if (i < 0) throw new Error('no such htlc');
      const h = s.htlcs[i];
      if (h.from === sender) { if (height() < h.expiry) throw new Error('the offerer may fail only after the expiry'); if (knownPreimage(ch, h.hash)) throw new Error('I hold the preimage: it settles, on the chain if need be'); }
      s.htlcs.splice(i, 1); add(h.from, h.amount); }
    else throw new Error('unknown update kind');
    if (s.balA < 0 || s.balB < 0) throw new Error('a balance would go negative');
    if (s.balA !== 0 && s.balA < ch.fee) throw new Error('the funder must keep its fee');
    return s;
  }

  // ---- an update from me: the next state, my signature on their commitment for it (their next revocation key is known ahead)
  function makeUpdate(ch, intent) {
    const cur = st(ch, ch.n); const m = { ...intent };
    if (m.kind === 'add') m.htlc = { ...m.htlc, id: nextHtlcId(cur) };
    return { m, s: nextState(ch, cur, m, me(ch)) };
  }
  async function update(ch, intent) {
    if (ch.status !== 'open') throw new Error('the channel is not open');
    if (ch.pending) throw new Error('an update is already pending');
    if (awaitingRevoke(ch)) throw new Error('waiting for their revocation of the previous state');
    if (missingReveals(ch).length) throw new Error(`their revocation secret for state ${missingReveals(ch)[0]} is missing; resyncing first`);
    if (!ch.theirRevPub[ch.n + 1]) throw new Error('their next revocation key is not known yet');
    const { m, s } = makeUpdate(ch, intent);
    const n1 = ch.n + 1; ch.states[n1] = s; ensureMyRev(ch, n1); ensureMyRev(ch, n1 + 1);
    const sig = C.signFunding(ch, theirCommitAt(ch, n1).tx, key);
    ch.pending = { n: n1, intent, m, at: now(), tries: 1 }; save();
    await send(ch, { t: 'update', id: ch.id, n: n1, ...m, sig, nextRev: ch.myRevPub[n1 + 1] });
    return m;
  }
  const pay = (ch, amount, memo = null) => { if (!isInt(amount, 1)) throw new Error('a whole number of sat'); if (amount > room(ch)) throw new Error(`at most ${Math.max(0, room(ch))} sat`); return update(ch, { kind: 'pay', amount, memo }); };
  const addHtlc = (ch, { amount, hash: h, expiry, route = null, memo = null }) => { if (!isInt(amount, MIN_HTLC)) throw new Error(`at least ${MIN_HTLC} sat, a whole number`); if (amount > room(ch)) throw new Error(`at most ${Math.max(0, room(ch))} sat`); if (!isHex64(h)) throw new Error('bad hash'); if (!isInt(expiry, 1, MAX_EXPIRY - 1)) throw new Error('bad expiry'); return update(ch, { kind: 'add', htlc: { amount, hash: h, expiry, route }, memo }); };
  const settleHtlc = (ch, htlcId, preimage) => { rememberPreimage(ch, sha(preimage), preimage); return update(ch, { kind: 'settle', htlcId, preimage }); };
  const failHtlc = (ch, htlcId, reason = null) => update(ch, { kind: 'fail', htlcId, reason });

  // ---- messages from the other side
  async function onMessage(from, m) {
    const bad = wellFormed(m); if (bad) return log(`message from ${String(from).slice(0, 12)}… dropped: ${bad}`, 'e');
    if (!isHex64(from)) return;
    if (m.t === 'open') return onOpen(from, m);
    const ch = byId(m.id); if (!ch || ch.peer !== from) return;
    switch (m.t) {
      case 'accept': return onAccept(ch, m);
      case 'commit': return onCommit(ch, m);
      case 'ready': return onReady(ch);
      case 'update': return onUpdate(ch, m);
      case 'ack': return onAck(ch, m);
      case 'revoke': return onRevoke(ch, m);
      case 'close': return onClose(ch, m);
      case 'sync': case 'synced': return onSync(ch, m);
    }
  }
  async function onOpen(from, m) {
    if (byId(m.id) || m.b !== pub || m.a !== from) return;
    if (m.delay < minDelay) return log(`open from ${from.slice(0, 12)}… refused: delay ${m.delay} is below my floor of ${minDelay}`, 'e');
    if (m.push > m.funding.value - m.fee - DUST) return log(`open from ${from.slice(0, 12)}… refused: the push leaves the funder nothing`, 'e');
    if (io.acceptOpen && !io.acceptOpen(from, m)) return log(`open from ${from.slice(0, 12)}… declined`, 'e');
    const f = C.fundingScript(m.a, m.b);
    const ch = { id: m.id, role: 'b', peer: from, keys: { a: m.a, b: m.b }, funding: { txid: m.funding.txid, vout: m.funding.vout, value: m.funding.value, ...f },
      delay: m.delay, fee: m.fee, peerHubFee: m.hubFee ?? null, n: 0, states: [{ balA: m.funding.value - m.push, balB: m.push, htlcs: [] }], myRev: {}, myRevPub: {}, theirRev: {}, theirRevPub: { 0: m.rev[0], 1: m.rev[1] }, sigs: {}, status: 'accepted', at: now(), pending: null, preimages: {}, unsent: [] };
    ensureMyRev(ch, 0); ensureMyRev(ch, 1);
    const sig = C.signFunding(ch, theirCommitAt(ch, 0).tx, key);
    CH.push(ch); save();
    await send(ch, { t: 'accept', id: ch.id, rev: [ch.myRevPub[0], ch.myRevPub[1]], sig, hubFee: opts.hub ? hubFee : undefined });
    log(`channel ${ch.id} from ${from.slice(0, 12)}…: ${m.funding.value} sat${m.push ? `, ${m.push} pushed to me` : ''}; accepted, their first commitment signed`);
    io.notify?.('Channel accepted', `${m.funding.value} sat from ${from.slice(0, 12)}…; it opens when the funding confirms`);
  }
  async function onAccept(ch, m) {
    if (ch.role !== 'a' || ch.status !== 'proposed') return;
    const rp = { ...ch.theirRevPub, 0: m.rev[0], 1: m.rev[1] }; const probe = { ...ch, theirRevPub: rp };
    if (!C.verifyFunding(ch, C.commitmentTx(probe, 0, { ...st(ch, 0), rev: { a: ch.myRevPub[0], b: rp[0] }, owner: 'a' }).tx, ch.peer, m.sig)) return log(`accept for ${ch.id}: their signature on my commitment does not verify`, 'e');
    ch.theirRevPub[0] = m.rev[0]; ch.theirRevPub[1] = m.rev[1]; ch.peerHubFee = m.hubFee ?? null; ch.sigs[0] = m.sig; ch.status = 'funding'; save();
    await send(ch, { t: 'commit', id: ch.id, sig: C.signFunding(ch, theirCommitAt(ch, 0).tx, key) });
    log(`channel ${ch.id}: accepted; my commitment is signed, theirs sent; the funding goes out when they confirm`);
  }
  async function onCommit(ch, m) {
    if (ch.role !== 'b' || !['accepted', 'funding'].includes(ch.status)) return;
    if (ch.status === 'accepted') { if (!C.verifyFunding(ch, myCommitAt(ch, 0).tx, ch.peer, m.sig)) return log(`commit for ${ch.id}: their signature does not verify`, 'e'); ch.sigs[0] = m.sig; ch.status = 'funding'; save(); log(`channel ${ch.id}: my first commitment is signed; waiting for the funding`); }
    await send(ch, { t: 'ready', id: ch.id });
  }
  async function onReady(ch) {
    if (ch.role !== 'a' || ch.status !== 'funding' || ch.broadcastAt) return;
    ch.broadcastAt = now(); save();
    const ok = await io.broadcast(ch.funding.hex, `funding of ${ch.id}`); if (!ok) { ch.broadcastAt = null; ch.unsent.push({ name: 'funding', hex: ch.funding.hex, txid: ch.funding.txid }); save(); }
    log(`channel ${ch.id}: funding ${ch.funding.txid.slice(0, 16)}… published, waiting for a block`);
  }
  async function onUpdate(ch, m) {
    if (ch.status !== 'open') return;
    if (m.n === ch.n && m.sig === ch.sigs[ch.n]) { await resendAck(ch); return log(`channel ${ch.id}: their update ${m.n} again; acknowledged again`); }
    if (m.n !== ch.n + 1) return log(`update for ${ch.id} at state ${m.n}, expected ${ch.n + 1}; ignored`);
    if (awaitingRevoke(ch)) { ch.buffered = m; save(); return log(`channel ${ch.id}: their update ${m.n} arrived before their revocation of state ${ch.n - 1}; held`); }
    if (missingReveals(ch).length) return log(`update for ${ch.id} refused: their revocation secret for state ${missingReveals(ch)[0]} is missing`, 'e');
    // verify everything on copies, then commit
    let s; try { s = nextState(ch, st(ch, ch.n), m, them(ch)); } catch (e) { return log(`update for ${ch.id} refused: ${e.message}`, 'e'); }
    const mine1 = ensureMyRev(ch, m.n); const probe = { ...ch, theirRevPub: { ...ch.theirRevPub, [m.n + 1]: m.nextRev } };
    if (!C.verifyFunding(ch, C.commitmentTx(probe, m.n, { ...s, rev: { a: ch.role === 'a' ? mine1 : ch.theirRevPub[m.n], b: ch.role === 'b' ? mine1 : ch.theirRevPub[m.n] }, owner: me(ch) }).tx, ch.peer, m.sig)) return log(`update for ${ch.id}: their signature on my new commitment does not verify`, 'e');
    if (ch.pending) {
      if (!(ch.peer < pub)) return log(`update for ${ch.id} while mine is pending: mine stands (lower key); theirs is ignored until they take mine`);
      log(`update for ${ch.id} while mine is pending: theirs stands (lower key); the state I signed for ${ch.pending.n} is remembered as one they might publish`);
      rememberAlt(ch, ch.pending.n, st(ch, ch.pending.n)); ch.droppedIntent = ch.pending.intent; ch.pending = null; }
    ch.states[m.n] = s; ch.theirRevPub[m.n + 1] = m.nextRev; ensureMyRev(ch, m.n + 1); ch.sigs[m.n] = m.sig;
    if (m.kind === 'settle') rememberPreimage(ch, sha(m.preimage), m.preimage);
    const prev = ch.n; ch.n = m.n; ch.awaiting = { n: m.n, m, sender: them(ch), prev }; save();
    await send(ch, { t: 'ack', id: ch.id, n: m.n, sig: C.signFunding(ch, theirCommitAt(ch, m.n).tx, key), reveal: ch.myRev[prev], nextRev: ch.myRevPub[m.n + 1] });
    log(`channel ${ch.id}: their ${m.kind}${m.kind === 'pay' ? ` of ${m.amount} sat` : m.kind === 'add' ? ` of htlc ${m.htlc.id} (${m.htlc.amount} sat)` : ` of htlc ${m.htlcId}`} signed as state ${m.n}; final when they revoke ${prev}`);
  }
  async function onAck(ch, m) {
    const p = ch.pending; if (!p || m.n !== p.n) return log(`ack for ${ch.id} at ${m.n} with ${p ? `pending ${p.n}` : 'nothing pending'}; ignored`);
    if (!C.verifyFunding(ch, C.commitmentTx({ ...ch, theirRevPub: { ...ch.theirRevPub, [p.n + 1]: m.nextRev } }, p.n, { ...fullState(ch, p.n), owner: me(ch) }).tx, ch.peer, m.sig)) return log(`ack for ${ch.id}: their signature does not verify`, 'e');
    if (signer.pubkeyOf(m.reveal) !== ch.theirRevPub[ch.n]) return log(`ack for ${ch.id}: the revealed secret is not state ${ch.n}'s`, 'e');
    ch.theirRev[ch.n] = m.reveal; ch.theirRevPub[p.n + 1] = m.nextRev; ch.sigs[p.n] = m.sig;
    const prev = ch.n; ch.n = p.n; ch.pending = null; ensureMyRev(ch, p.n + 1);
    if (p.m.kind === 'settle') rememberPreimage(ch, sha(p.m.preimage), p.m.preimage);
    save();
    await send(ch, { t: 'revoke', id: ch.id, n: p.n, reveal: ch.myRev[prev] });
    log(`channel ${ch.id}: my ${p.m.kind}${p.m.kind === 'pay' ? ` of ${p.m.amount} sat` : p.m.kind === 'add' ? ` of htlc ${p.m.htlc.id} (${p.m.htlc.amount} sat)` : ` of htlc ${p.m.htlcId}`} acknowledged; state ${p.n}`);
    await io.onAcked?.(ch, p.m);
  }
  function takeReveal(ch, i, secret) { if (i < 0 || ch.theirRev[i] || !ch.theirRevPub[i]) return false; if (signer.pubkeyOf(secret) !== ch.theirRevPub[i]) return false; ch.theirRev[i] = secret; return true; }
  async function onRevoke(ch, m) {
    if (m.n > ch.n) return log(`revoke for ${ch.id} at ${m.n} ahead of my ${ch.n}; ignored`);
    if (!takeReveal(ch, m.n - 1, m.reveal)) { if (ch.theirRev[m.n - 1]) return; return log(`revoke for ${ch.id}: not state ${m.n - 1}'s secret`, 'e'); }
    save();
    await finalise(ch);
  }
  // their revocation of the state before the one they proposed makes that state final: only now is it acted on
  async function finalise(ch) {
    const w = ch.awaiting; if (!w || !ch.theirRev[w.prev]) return;
    ch.awaiting = null; save();
    const m = w.m; const gain = bal(ch, me(ch), w.n) - bal(ch, me(ch), w.prev);
    if (m.kind === 'pay') io.notify?.('Payment received', `${m.amount} sat on ${ch.id}${m.memo ? ` · ${m.memo}` : ''}`);
    if (m.kind === 'settle' && gain > 0) io.notify?.('Payment received', `${gain} sat on ${ch.id} (htlc ${m.htlcId} settled)`);
    log(`channel ${ch.id}: state ${w.n} final`);
    try { await io.onUpdate?.(ch, m, w.sender); } catch (e) { log(`after update on ${ch.id}: ${e.message}`, 'e'); }
    if (ch.buffered) { const b = ch.buffered; ch.buffered = null; save(); await onUpdate(ch, b); }
  }
  async function onClose(ch, m) {
    if (!['open', 'funding', 'closing-asked'].includes(ch.status)) return;
    if (m.n !== ch.n) return log(`close for ${ch.id} at state ${m.n}, I am at ${ch.n}; ignored`, 'e');
    let tx; try { tx = C.closingTx(ch, fullState(ch, ch.n)); } catch (e) { return log(`close for ${ch.id} refused: ${e.message}`, 'e'); }
    if (!C.verifyFunding(ch, tx, ch.peer, m.sig)) return log(`close for ${ch.id}: their signature does not verify`, 'e');
    tx.witness = [C.fundingWitness(ch, { [ch.peer]: m.sig, [pub]: C.signFunding(ch, tx, key) })];
    const v = C.verifyTx(tx, [C.fundingPrevout(ch)]); if (!v.ok) return log(`close for ${ch.id}: the closing transaction fails: ${v.error}`, 'e');
    ch.status = 'closing'; ch.closeTxid = C.txid(tx); save();
    await publish(ch, 'cooperative close', C.encode(tx), ch.closeTxid);
    log(`channel ${ch.id}: closing cooperatively at state ${ch.n}, ${myBal(ch)} sat to me`);
  }

  // ---- resync: where each side is, the secrets the other side lacks, and whatever was lost on the way
  const syncBody = (ch, t = 'sync') => ({ t, id: ch.id, n: ch.n, status: ch.status, pendingN: ch.pending?.n ?? null, reveal: ch.n > 0 ? ch.myRev[ch.n - 1] : null, missing: missingReveals(ch) });
  async function onSync(ch, m) {
    if (m.reveal) takeReveal(ch, m.n - 1, m.reveal);
    if (m.reveals) for (const [i, r] of Object.entries(m.reveals)) takeReveal(ch, Number(i), r);
    save(); await finalise(ch);
    if (m.t === 'sync') { const reveals = {}; for (const i of m.missing ?? []) if (i < ch.n && ch.myRev[i]) reveals[i] = ch.myRev[i]; await send(ch, { ...syncBody(ch, 'synced'), reveals }); }
    await reconcile(ch, m);
  }
  async function resendUpdate(ch) { const p = ch.pending; if (!p) return; p.tries = (p.tries ?? 0) + 1; p.at = now(); save(); await send(ch, { t: 'update', id: ch.id, n: p.n, ...p.m, sig: C.signFunding(ch, theirCommitAt(ch, p.n).tx, key), nextRev: ch.myRevPub[p.n + 1] }); }
  async function resendAck(ch) { const n = ch.n; if (n < 1 || !ch.sigs[n]) return; await send(ch, { t: 'ack', id: ch.id, n, sig: C.signFunding(ch, theirCommitAt(ch, n).tx, key), reveal: ch.myRev[n - 1], nextRev: ch.myRevPub[n + 1] }); }
  async function reconcile(ch, m) {
    // the opening handshake, by the status each side reports
    if (ch.role === 'a' && ch.status === 'funding') { if (m.status === 'accepted') await send(ch, { t: 'commit', id: ch.id, sig: C.signFunding(ch, theirCommitAt(ch, 0).tx, key) }); else if (m.status === 'funding' || m.status === 'open') await onReady(ch); return; }
    if (ch.role === 'b' && ch.status === 'accepted' && m.status === 'proposed') { await send(ch, { t: 'accept', id: ch.id, rev: [ch.myRevPub[0], ch.myRevPub[1]], sig: C.signFunding(ch, theirCommitAt(ch, 0).tx, key), hubFee: opts.hub ? hubFee : undefined }); return; }
    if (ch.role === 'b' && ch.status === 'funding' && ['funding', 'open'].includes(m.status ?? '')) await send(ch, { t: 'ready', id: ch.id });
    if (ch.status === 'closing-asked' && ['open', 'funding', 'closing-asked'].includes(m.status ?? '')) { const tx = C.closingTx(ch, fullState(ch, ch.n)); await send(ch, { t: 'close', id: ch.id, n: ch.n, sig: C.signFunding(ch, tx, key) }); }
    if (ch.status !== 'open' && ch.status !== 'closing-asked') return;
    if (m.n === ch.n) {
      if (ch.pending && m.pendingN == null) { log(`channel ${ch.id}: they never saw my update ${ch.pending.n}; sending it again`); await resendUpdate(ch); }
      else if (ch.pending && m.pendingN === ch.pending.n) { if (ch.peer < pub) { log(`channel ${ch.id}: both of us have an update pending at ${ch.pending.n}; theirs stands, mine is remembered`); rememberAlt(ch, ch.pending.n, st(ch, ch.pending.n)); ch.droppedIntent = ch.pending.intent; ch.pending = null; save(); } else { log(`channel ${ch.id}: both pending at ${ch.pending.n}; mine stands, sending it again`); await resendUpdate(ch); } }
      else if (!ch.pending && m.pendingN === ch.n + 1) log(`channel ${ch.id}: they have an update pending that I have not seen; it comes with their retry`);
      return; }
    if (m.n === ch.n - 1 && (m.pendingN === ch.n || m.pendingN == null)) { log(`channel ${ch.id}: they are one state behind; sending my acknowledgement of ${ch.n} again`); await resendAck(ch); return; }
    if (m.n === ch.n + 1 && ch.pending?.n === m.n) { log(`channel ${ch.id}: they reached state ${m.n} on my update but I never got the acknowledgement; they resend it on their resync`); return; }
    if (m.n > ch.n) { log(`channel ${ch.id}: they report state ${m.n}, I am at ${ch.n}; I keep what I signed and wait for their update`, 'e'); return; }
    log(`channel ${ch.id}: they report state ${m.n}, I am at ${ch.n}: they have lost state; a forced close from either side settles at what was signed`, 'e');
  }
  async function resync(ch, force = false) { if (!force && ch.lastSyncAt && now() - ch.lastSyncAt < 30) return; ch.lastSyncAt = now(); await send(ch, syncBody(ch)); }
  async function resyncAll(force = false) { for (const ch of CH) if (LIVE.has(ch.status)) await resync(ch, force); }

  // ---- on every tick: retries with backoff, HTLCs that must move, broadcasts that failed, proposals that died
  async function tick() {
    for (const ch of CH) {
      if (['proposed', 'accepted'].includes(ch.status) && now() - ch.at > 6 * 3600) { ch.status = 'abandoned'; save(); log(`channel ${ch.id}: nobody funded it in six hours; abandoned (no coins moved)`); continue; }
      if (ch.unsent?.length) for (const u of [...ch.unsent]) { const ok = await io.broadcast(u.hex, `${u.name} of ${ch.id} (again)`); if (ok) { ch.unsent = ch.unsent.filter((x) => x !== u); if (u.name === 'funding') ch.broadcastAt = now(); save(); } }
      if (!LIVE.has(ch.status)) continue;
      const p = ch.pending;
      if (p && now() - p.at >= Math.min(600, (opts.pendingTimeout ?? 90) * Math.pow(2, Math.max(0, (p.tries ?? 1) - 1)))) { log(`channel ${ch.id}: update ${p.n} unanswered for ${now() - p.at} s (try ${p.tries}); resyncing and sending it again`); await resync(ch); await resendUpdate(ch); }
      if (ch.status !== 'open') continue;
      if (ch.droppedIntent && !ch.pending && !awaitingRevoke(ch)) { log(`channel ${ch.id}: an update of mine was set aside after a collision; ${ch.droppedIntent.kind === 'pay' ? 'the payment was NOT made' : 'it was not applied'} and is not retried by itself`, 'e'); io.notify?.('Update not applied', `${ch.id}: ${ch.droppedIntent.kind === 'pay' ? `the payment of ${ch.droppedIntent.amount} sat was not made` : 'an update was set aside'}; make it again if you still want it`); ch.droppedIntent = null; save(); }
      if (ch.pending || awaitingRevoke(ch) || missingReveals(ch).length) continue;
      const h = height();
      for (const x of htlcs(ch)) {
        const iOffered = x.from === me(ch); const preimage = iOffered ? null : knownPreimage(ch, x.hash);
        try {
          if (!iOffered && preimage && h < x.expiry - 1) { await settleHtlc(ch, x.id, preimage); break; }
          if (!iOffered && preimage && h >= x.expiry - 1) { log(`channel ${ch.id}: htlc ${x.id} is mine to claim but about to expire; closing to claim it on the chain`, 'e'); await forceClose(ch, ch.n, 'protective'); break; }
          if (iOffered && h >= x.expiry) { await failHtlc(ch, x.id, 'expired'); break; }
        } catch (e) { log(`channel ${ch.id}: htlc ${x.id}: ${e.message}`, 'e'); }
      }
    }
  }

  // ---- closing
  async function closeChannel(ch) {
    if (!['open', 'funding'].includes(ch.status)) throw new Error('not open');
    const tx = C.closingTx(ch, fullState(ch, ch.n)); const sig = C.signFunding(ch, tx, key);
    ch.status = 'closing-asked'; ch.closeTxid = C.txid(tx); save();
    await send(ch, { t: 'close', id: ch.id, n: ch.n, sig }); log(`channel ${ch.id}: cooperative close asked at state ${ch.n}`);
  }
  async function forceClose(ch, i = ch.n, why = 'forced') {
    if (!ch.sigs[i]) throw new Error(`state ${i} was never signed by them`);
    const c = myCommitAt(ch, i); c.tx.witness = [C.fundingWitness(ch, { [pub]: C.signFunding(ch, c.tx, key), [ch.peer]: ch.sigs[i] })];
    const v = C.verifyTx(c.tx, [C.fundingPrevout(ch)]); if (!v.ok) throw new Error(`my commitment fails: ${v.error}`);
    ch.status = 'force-closing'; ch.closeTxid = C.txid(c.tx); ch.closeState = i; save();
    await publish(ch, `${why} close`, C.encode(c.tx), ch.closeTxid);
    log(`channel ${ch.id}: ${why} close published, my commitment ${ch.closeTxid.slice(0, 16)}… at state ${i}${i < ch.n ? ' (AN OLD STATE: the other side can take it all)' : ''}`, i < ch.n ? 'e' : '');
  }
  // a broadcast that reached nobody is kept and sent again on the next tick
  async function publish(ch, name, hex, txid) { const ok = await io.broadcast(hex, `${name} of ${ch.id}`); if (!ok) { ch.unsent ??= []; ch.unsent.push({ name, hex, txid }); save(); } return ok; }

  // ---- the funding output was spent: classify, then answer (sweeps after the delay, claims, the penalty)
  async function onSpend(ch, spend) {
    if (ch.spentBy?.txid === spend.txid) return afterClose(ch);
    ch.spentBy = spend;
    if (ch.closeTxid === spend.txid && ['closing', 'closing-asked'].includes(ch.status)) { ch.status = 'closed'; save(); io.notify?.('Channel closed', `${ch.id} settled cooperatively at block ${spend.height}`); return; }
    if (ch.closeTxid === spend.txid && ch.status === 'force-closing') { ch.status = 'closed-mine'; save(); log(`channel ${ch.id}: my commitment is in block ${spend.height}; my outputs can be claimed after ${ch.delay} blocks`); return afterClose(ch); }
    // one of theirs: the current state, an alternative I signed at some state, or a revoked one
    const candidates = []; for (let i = 0; i <= ch.n; i++) { candidates.push({ i, s: st(ch, i), alt: false }); for (const s of ch.signedAlt?.[i] ?? []) candidates.push({ i, s, alt: true }); }
    for (const { i, s, alt } of candidates) {
      const t = theirCommitAt(ch, i, s); if (C.txid(t.tx) !== spend.txid) continue;
      const revoked = !!ch.theirRev[i];
      if (!revoked) { ch.status = alt ? 'closed-theirs-alt' : 'closed-theirs'; ch.closeState = i; ch.closeStateObj = s; save(); io.notify?.('Channel closed by the other side', `${ch.id} at state ${i}${alt ? ' (an alternative I had signed)' : ''}, block ${spend.height}`); return afterClose(ch); }
      const secret = ch.theirRev[i]; const claims = [];
      const vl = t.kinds.indexOf('to_local'); if (vl >= 0) try { claims.push(C.sweepTx({ commit: t, txid: spend.txid, vout: vl, value: t.tx.outputs[vl].value, to: io.myScript, fee: ch.fee, delayed: 0, key: secret })); } catch (e) { log(`penalty on ${ch.id}: ${e.message}`, 'e'); }
      for (const h of t.htlcs) try { claims.push(C.htlcClaim({ commit: t, htlc: h, kind: 'revocation', txid: spend.txid, value: h.amount, to: io.myScript, fee: ch.fee, key: secret })); } catch (e) { log(`penalty on ${ch.id} htlc ${h.id}: ${e.message}`, 'e'); }
      ch.status = 'punishing'; ch.closeState = i; ch.penalties = claims.map((tx) => C.txid(tx)); save();
      for (const tx of claims) await publish(ch, `penalty (their revoked state ${i})`, C.encode(tx), C.txid(tx));
      io.notify?.('Cheat punished', `${ch.id}: they published revoked state ${i}; ${claims.length} penalty transaction(s) sent`); return;
    }
    ch.status = 'spent-unknown'; save(); log(`channel ${ch.id}: the funding was spent by ${spend.txid.slice(0, 16)}… which is none of the transactions I know`, 'e');
  }
  // after a close by either side's commitment: claim what is mine when it can be claimed; done when nothing of mine is left
  async function afterClose(ch) {
    if (!['closed-mine', 'closed-theirs', 'closed-theirs-alt'].includes(ch.status) || !ch.spentBy) return;
    const mine = ch.status === 'closed-mine'; const i = ch.closeState ?? ch.n; const s = ch.closeStateObj ?? st(ch, i);
    const c = mine ? myCommitAt(ch, i, s) : theirCommitAt(ch, i, s); const conf = height() - ch.spentBy.height + 1; ch.claimed ??= {}; let left = 0;
    const claim = async (name, build, prevout) => { if (ch.claimed[name]) return; let tx; try { tx = build(); } catch (e) { return log(`${name} on ${ch.id}: ${e.message}`, 'e'); } const v = C.verifyTx(tx, [prevout]); if (!v.ok) return log(`${name} on ${ch.id} fails: ${v.error}`, 'e'); const txid = C.txid(tx); const ok = await publish(ch, name, C.encode(tx), txid); ch.claimed[name] = txid; save(); if (!ok) log(`${name} on ${ch.id} reached no relay; kept for the next tick`, 'e'); };
    if (mine) { const vl = c.kinds.indexOf('to_local'); if (vl >= 0) { const value = c.tx.outputs[vl].value; if (conf >= ch.delay) await claim('sweep of to_local', () => C.sweepTx({ commit: c, txid: ch.closeTxid, vout: vl, value, to: io.myScript, fee: ch.fee, delayed: ch.delay, key }), { value, scriptPubKey: c.toLocal.spk }); else left++; } }
    for (const h of c.htlcs) {
      const iOffered = h.from === me(ch); const preimage = iOffered ? null : knownPreimage(ch, h.hash); const prevout = { value: h.amount, scriptPubKey: h.scripts.spk };
      if (!iOffered && preimage) { if (mine && conf < ch.delay) { left++; continue; } await claim(`claim of htlc ${h.id} with the preimage`, () => C.htlcClaim({ commit: c, htlc: h, kind: 'success', txid: ch.spentBy.txid, value: h.amount, to: io.myScript, fee: ch.fee, key, preimage }), prevout); }
      else if (iOffered && height() >= h.expiry) { if (mine && conf < ch.delay) { left++; continue; } await claim(`refund of htlc ${h.id} after its expiry`, () => C.htlcClaim({ commit: c, htlc: h, kind: 'timeout', txid: ch.spentBy.txid, value: h.amount, to: io.myScript, fee: ch.fee, key }), prevout); }
      else left++; // theirs to claim, or not yet claimable by me
    }
    if (!left && !(ch.unsent?.length)) { ch.status = 'closed'; save(); io.notify?.('Channel settled', `${ch.id}: everything of mine is claimed`); }
  }

  return { channels: CH, byId, me, them, myBal, theirBal, room, htlcs, fullState, myCommitAt, theirCommitAt, openChannel, onMessage, pay, addHtlc, settleHtlc, failHtlc, closeChannel, forceClose, onSpend, afterClose, sha, hubFee, resyncAll, resync, tick, missingReveals, awaitingRevoke, rememberPreimage, knownPreimage, wellFormed,
    invoice: (amount, memo, hops = [], feeHint = hubFee, expiresIn = 3600) => { const preimage = signer.randomKey(); const h = sha(preimage); return { preimage, inv: { p: pub, a: amount, m: memo || undefined, h, r: hops, f: feeHint, x: now() + expiresIn, i: h.slice(0, 16) } }; } };
}
