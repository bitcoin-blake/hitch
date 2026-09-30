// The channel protocol, pure. One peer's channels are documents; the messages between peers are JSON bodies that the
// host signs and carries as relay events; this module is the state machine. Hosts: hitch.js (a tab), bin/hub.mjs (Node).
//
// Invariants the module keeps, because money depends on them:
//   - the revocation key of a commitment is a two-party key (the other side's basepoint plus the owner's per-state
//     point): the owner can never use its own revocation leaf, the other side can only once the state is revoked;
//     every announced point carries a proof of possession, so neither side can choose a point that cancels the other's;
//   - a signature I have sent for a state is binding until that state is revoked by the other side: a pending update is
//     never simply dropped; when both sides propose at once the lower key's update stands and the other side's signed
//     state is remembered as an alternative the peer might publish, punishable once the peer revokes that state number;
//     the same when an update of mine is rejected;
//   - a payment is final for me only when the other side has revoked the state before it; until then nothing is
//     forwarded, settled or announced, and no further update is accepted or proposed;
//   - a signature or a revocation secret leaves this node only after the state it belongs to is saved;
//   - a settle is refused after the HTLC's expiry, a fail by the offerer is refused while I hold the preimage, and every
//     preimage I learn (from a message or from the chain) is kept so an HTLC can be claimed after a forced close;
//   - an HTLC I can claim is taken to the chain `delay + 3` blocks before its expiry if the settle is not acknowledged,
//     whatever else is pending, because my claim on my own commitment waits `delay` blocks and the refund does not;
//   - every field of every message is checked for shape before it is used, and nothing is written to the channel
//     until the message has been verified in full.
//
// The host gives `io`: send(ch, body) → relays reached, broadcast(hex, what) → relays reached (0 = failed),
// buildFunding(amount, spk) → { txid, vout, hex }, height(), save() (false or a throw = not saved), log(text, cls),
// notify(title, body), myScript, and optionally acceptOpen(from, m), onUpdate(ch, m, sender), onAcked(ch, m),
// onDropped(ch, intent), onPreimage(ch, hash, preimage), onPayment(ch, hash, outcome, reason) for HTLCs I offered ('sent' | 'failed' | 'not made'),
// findSpend(ch, { txid, vout, from }) → { txid, height, hex } | null, stale() (no HTLC decisions on a stale chain view).
import { DUST, MIN_DELAY, MAX_DELAY, MIN_FEE, MAX_FEE, MAX_EXPIRY } from './channel.mjs';
export const KIND = 23600;
export const MIN_OPEN = 10000, MIN_HTLC = 1000, EXPIRY_MARGIN = 12, CLAIM_MARGIN = 3; // sats; blocks an HTLC must keep beyond the delay; blocks kept before the on-chain deadline
export const FUNDING_TIMEOUT = 24 * 3600, PROPOSAL_TIMEOUT = 6 * 3600, UNFUNDED_TIMEOUT = 7 * 24 * 3600, MIN_CONF = 2; // seconds before an unconfirmed funding, or an unanswered proposal, is set aside
export const LIVE = new Set(['proposed', 'accepted', 'funding', 'open', 'closing-asked']);
export const WATCHED = new Set(['funding', 'unfunded', 'open', 'closing-asked', 'closing', 'force-closing', 'closed-mine', 'closed-theirs', 'closed-theirs-alt', 'punishing', 'settling']);
export const TERMINAL = new Set(['closed', 'punished', 'abandoned', 'spent-unknown', 'bad-funding']);
export const FOLLOWING = new Set(['closed-mine', 'closed-theirs', 'closed-theirs-alt', 'punishing', 'settling']); // a close whose outputs are still being followed
export const CLOSED_OUT = new Set(['force-closing', 'closing', 'closing-asked']); // a close of mine is signed or published: no update can be made or taken
const now = () => Math.floor(Date.now() / 1000);
const HEX64 = /^[0-9a-f]{64}$/, HEX16 = /^[0-9a-f]{16}$/;
const isInt = (x, lo = 0, hi = Number.MAX_SAFE_INTEGER) => Number.isInteger(x) && x >= lo && x <= hi;
const isHex64 = (x) => typeof x === 'string' && HEX64.test(x);
const isSig = (x) => typeof x === 'string' && /^[0-9a-f]{130}$/.test(x);
const isPop = (x) => typeof x === 'string' && /^[0-9a-f]{128}$/.test(x);
const MEMO_MAX = 140;
const shortText = (x) => x == null || (typeof x === 'string' && x.length <= MEMO_MAX);

// what each message must look like; anything else is dropped before it touches a channel
function wellFormed(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'not an object';
  if (typeof m.t !== 'string' || typeof m.id !== 'string' || !HEX16.test(m.id)) return 'bad id';
  const revOk = Array.isArray(m.rev) && m.rev.length === 2 && m.rev.every(isHex64) && isHex64(m.revBase) && m.pop && typeof m.pop === 'object' && isPop(m.pop.base) && Array.isArray(m.pop.rev) && m.pop.rev.length === 2 && m.pop.rev.every(isPop);
  switch (m.t) {
    case 'open': return (m.funding && isHex64(m.funding.txid) && isInt(m.funding.vout, 0, 0xffff) && isInt(m.funding.value, MIN_OPEN, 21e14) && m.id === m.funding.txid.slice(0, 16)
      && isInt(m.push ?? 0, 0) && isInt(m.delay, MIN_DELAY, MAX_DELAY) && isInt(m.fee, MIN_FEE, MAX_FEE) && isHex64(m.a) && isHex64(m.b) && m.a !== m.b
      && revOk && (m.hubFee == null || isInt(m.hubFee, 0, 100000))) ? null : 'bad open';
    case 'accept': return (revOk && isSig(m.sig) && (m.hubFee == null || isInt(m.hubFee, 0, 100000))) ? null : 'bad accept';
    case 'commit': return isSig(m.sig) ? null : 'bad commit';
    case 'ready': return null;
    case 'update': { if (!isInt(m.n, 1) || !isSig(m.sig) || !isHex64(m.nextRev) || !isPop(m.nextRevPop) || !shortText(m.memo)) return 'bad update';
      if (m.kind === 'pay') return isInt(m.amount, 1, 21e14) ? null : 'bad pay';
      if (m.kind === 'add') { const h = m.htlc; return (h && isInt(h.id, 1) && isInt(h.amount, MIN_HTLC, 21e14) && isHex64(h.hash) && isInt(h.expiry, 1, MAX_EXPIRY - 1) && (h.route == null || (typeof h.route === 'object' && !Array.isArray(h.route) && isHex64(h.route.to)))) ? null : 'bad add'; }
      if (m.kind === 'settle') return (isInt(m.htlcId, 1) && isHex64(m.preimage)) ? null : 'bad settle';
      if (m.kind === 'fail') return (isInt(m.htlcId, 1) && shortText(m.reason)) ? null : 'bad fail';
      return 'unknown kind'; }
    case 'ack': return (isInt(m.n, 1) && isSig(m.sig) && isHex64(m.reveal) && isHex64(m.nextRev) && isPop(m.nextRevPop)) ? null : 'bad ack';
    case 'revoke': return (isInt(m.n, 1) && isHex64(m.reveal)) ? null : 'bad revoke';
    case 'reject': return (isInt(m.n, 1) && isSig(m.sig) && shortText(m.reason)) ? null : 'bad reject';
    case 'close': return (isInt(m.n, 0) && isSig(m.sig)) ? null : 'bad close';
    case 'sync': case 'synced': return (isInt(m.n, 0) && (m.pendingN == null || isInt(m.pendingN, 1)) && (m.reveal == null || isHex64(m.reveal)) && (m.missing == null || (Array.isArray(m.missing) && m.missing.length <= 64 && m.missing.every((i) => isInt(i, 0))))
      && (m.reveals == null || (typeof m.reveals === 'object' && !Array.isArray(m.reveals) && Object.entries(m.reveals).length <= 64 && Object.entries(m.reveals).every(([i, r]) => /^\d+$/.test(i) && isHex64(r)))) && (m.status == null || (typeof m.status === 'string' && m.status.length <= 32))) ? null : 'bad sync';
    default: return 'unknown message';
  }
}

export function makePeer({ C, signer, hash, pub, key, channels, io, opts = {} }) {
  const delay = opts.delay ?? 6, fee = opts.fee ?? 300, hubFee = opts.hubFee ?? 10, minDelay = opts.minDelay ?? MIN_DELAY;
  const CH = channels;
  const byId = (id) => CH.find((c) => c.id === id);
  const me = (ch) => ch.role, them = (ch) => (ch.role === 'a' ? 'b' : 'a');
  const sha = (hex) => hash.bytesToHex(hash.sha256(hash.hexToBytes(hex)));
  const log = (t, c) => io.log(t, c);
  const send = (ch, body) => io.send(ch, body);
  const height = () => io.height();
  // a save that reports failure; nothing that binds me (a signature, a secret) leaves before the state is on disk
  const save = () => { try { return io.save(); } catch (e) { log(`save failed: ${e.message}`, 'e'); return false; } };
  const persisted = async (ch, what) => { let r; try { r = await save(); } catch { r = false; } if (r === false) { log(`channel ${ch.id}: the state was NOT saved; ${what} withheld until it can be`, 'e'); io.notify?.('State not saved', `${ch.id}: ${what} withheld; free some storage`); return false; } return true; };

  // ---- keys and states
  const newKey = () => { const k = signer.randomKey(); return { key: k, pub: signer.pubkeyOf(k) }; };
  const ensureMyRev = (ch, i) => { if (!ch.myRev[i]) { const r = newKey(); ch.myRev[i] = r.key; ch.myRevPub[i] = r.pub; } return ch.myRevPub[i]; };
  const st = (ch, i) => ch.states[i];
  // the revocation keys of both commitments at state i: mine needs their basepoint and my secret, theirs their point and my basepoint
  // (channels from before the basepoints fall back to the single per-state key so their documents still read)
  const revs = (ch, i) => { ensureMyRev(ch, i); const mine = ch.theirRevBasePub ? C.revocationPub(ch.theirRevBasePub, ch.myRev[i]) : ch.myRevPub[i]; const tp = ch.theirRevPub[i]; const theirs = tp ? (ch.myRevBase ? C.revocationPub(tp, ch.myRevBase) : tp) : null; return ch.role === 'a' ? { a: mine, b: theirs } : { a: theirs, b: mine }; };
  const popCtx = (ch, who, i) => `${ch.id}/${who}/${i}`; // the point's place: channel, its owner's role, 'base' or the state number
  const myPop = (ch, i) => C.popSign(i === 'base' ? ch.myRevBase : ch.myRev[i], popCtx(ch, me(ch), i));
  const theirPopOk = (ch, i, point, sig) => C.popVerify(point, sig, popCtx(ch, them(ch), i));
  const penaltyKey = (ch, i) => (ch.myRevBase ? C.revocationKey(ch.myRevBase, ch.theirRev[i]) : ch.theirRev[i]);
  const fullState = (ch, i, s = st(ch, i)) => ({ balA: s.balA, balB: s.balB, htlcs: s.htlcs ?? [], rev: revs(ch, i) });
  const myCommitAt = (ch, i, s) => C.commitmentTx(ch, i, { ...fullState(ch, i, s), owner: me(ch) });
  const theirCommitAt = (ch, i, s) => C.commitmentTx(ch, i, { ...fullState(ch, i, s), owner: them(ch) });
  const bal = (ch, who, i = ch.n) => (who === 'a' ? st(ch, i).balA : st(ch, i).balB);
  const myBal = (ch) => bal(ch, me(ch)), theirBal = (ch) => bal(ch, them(ch));
  const room = (ch) => myBal(ch) - (ch.role === 'a' ? ch.fee : 0);
  const htlcs = (ch) => st(ch, ch.n).htlcs ?? [];
  // HTLC ids never repeat on a channel: the next is above every id ever agreed, not just those in flight
  const nextHtlcId = (ch, s) => Math.max(ch.htlcSeq ?? 1, (s.htlcs ?? []).reduce((a, x) => Math.max(a, x.id), 0) + 1);
  const bumpHtlcSeq = (ch, m) => { if (m.kind === 'add') ch.htlcSeq = Math.max(ch.htlcSeq ?? 1, m.htlc.id + 1); };
  // only preimages this node has checked and kept (the router keeps an invoice's after its own checks)
  const knownPreimage = (ch, h) => ch.preimages?.[h] ?? null;
  const rememberPreimage = (ch, h, preimage) => { ch.preimages ??= {}; if (!ch.preimages[h]) ch.preimages[h] = preimage; };
  // a state I signed for the other side at index n that did not become the agreed state; the peer may still publish it
  const rememberAlt = (ch, n, s, m = null) => { ch.signedAlt ??= {}; (ch.signedAlt[n] ??= []).push({ balA: s.balA, balB: s.balB, htlcs: s.htlcs ?? [], m }); };
  // the revocation secrets the other side owes me: every state below the current one
  const missingReveals = (ch) => { const out = []; for (let i = 0; i < ch.n; i++) if (!ch.theirRev[i] && ch.theirRevPub[i]) out.push(i); return out; };
  const awaitingRevoke = (ch) => ch.awaiting != null;
  const dropPending = (ch, why) => { const p = ch.pending; if (!p) return; rememberAlt(ch, p.n, st(ch, p.n), p.m); ch.droppedIntent = { ...p.intent, reason: why }; ch.pending = null; log(`channel ${ch.id}: my update ${p.n} (${p.m.kind}) is set aside: ${why}; the state I signed for it is remembered as one they might publish`, 'e'); };

  // ---- opening
  const openBody = (ch) => ({ t: 'open', id: ch.id, funding: { txid: ch.funding.txid, vout: ch.funding.vout, value: ch.funding.value }, push: ch.states[0].balB, delay: ch.delay, fee: ch.fee, a: ch.keys.a, b: ch.keys.b, rev: [ch.myRevPub[0], ch.myRevPub[1]], revBase: ch.myRevBasePub, pop: { base: myPop(ch, 'base'), rev: [myPop(ch, 0), myPop(ch, 1)] }, hubFee: opts.hub ? hubFee : undefined });
  const acceptBody = (ch) => ({ t: 'accept', id: ch.id, rev: [ch.myRevPub[0], ch.myRevPub[1]], revBase: ch.myRevBasePub, pop: { base: myPop(ch, 'base'), rev: [myPop(ch, 0), myPop(ch, 1)] }, sig: C.signFunding(ch, theirCommitAt(ch, 0).tx, key), hubFee: opts.hub ? hubFee : undefined });
  const newDoc = (fields) => { const base = newKey(); const ch = { myRev: {}, myRevPub: {}, theirRev: {}, theirRevPub: {}, myRevBase: base.key, myRevBasePub: base.pub, theirRevBasePub: null, sigs: {}, at: now(), pending: null, preimages: {}, unsent: [], htlcSeq: 1, ...fields }; ensureMyRev(ch, 0); ensureMyRev(ch, 1); return ch; };
  async function openChannel(peer, amount, push = 0) {
    if (!isHex64(peer)) throw new Error('a node id is 64 hex characters');
    if (peer === pub) throw new Error('that is this node');
    if (!isInt(amount, MIN_OPEN)) throw new Error(`at least ${MIN_OPEN} sat, a whole number`);
    if (!isInt(push, 0) || push > amount - fee - DUST) throw new Error('push must leave the funder its fee and dust');
    const f = C.fundingScript(pub, peer);
    const fund = await io.buildFunding(amount, f.spk);
    const ch = newDoc({ id: fund.txid.slice(0, 16), role: 'a', peer, keys: { a: pub, b: peer }, funding: { txid: fund.txid, vout: fund.vout, value: amount, hex: fund.hex, inputs: fund.inputs ?? null, ...f }, delay, fee, n: 0, states: [{ balA: amount - push, balB: push, htlcs: [] }], status: 'proposed' });
    CH.push(ch); if (!(await persisted(ch, 'the proposal'))) { CH.pop(); throw new Error('the channel could not be saved; nothing was sent'); }
    ch.openAt = now(); await send(ch, openBody(ch));
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
      const h = m.htlc; if (h.id !== nextHtlcId(ch, cur)) throw new Error('bad htlc id');
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
    if (s.balA < ch.fee) throw new Error('the funder must keep its fee'); // a commitment with no fee cannot be mined: never sign one
    return s;
  }

  // ---- an update from me: the next state, my signature on their commitment for it (their next revocation key is known ahead)
  function makeUpdate(ch, intent) {
    const cur = st(ch, ch.n); const m = { ...intent };
    if (m.kind === 'add') m.htlc = { ...m.htlc, id: nextHtlcId(ch, cur) };
    return { m, s: nextState(ch, cur, m, me(ch)) };
  }
  const updateLabel = (m) => `${m.kind}${m.kind === 'pay' ? ` of ${m.amount} sat` : m.kind === 'add' ? ` of htlc ${m.htlc.id} (${m.htlc.amount} sat)` : ` of htlc ${m.htlcId}`}`;
  async function update(ch, intent) {
    if (ch.status !== 'open') throw new Error('the channel is not open');
    if (ch.pending) throw new Error('an update is already pending');
    if (awaitingRevoke(ch)) throw new Error('waiting for their revocation of the previous state');
    if (missingReveals(ch).length) throw new Error(`their revocation secret for state ${missingReveals(ch)[0]} is missing; resyncing first`);
    if (!ch.theirRevPub[ch.n + 1]) throw new Error('their next revocation key is not known yet');
    if (!shortText(intent.memo) || !shortText(intent.reason)) throw new Error(`a memo is at most ${MEMO_MAX} characters`);
    if (intent.kind !== 'pay' && io.stale?.()) throw new Error('my view of the chain is stale; HTLCs wait until it returns');
    const { m, s } = makeUpdate(ch, intent);
    const n1 = ch.n + 1; ch.states[n1] = s; ensureMyRev(ch, n1); ensureMyRev(ch, n1 + 1);
    const sig = C.signFunding(ch, theirCommitAt(ch, n1).tx, key);
    ch.pending = { n: n1, intent, m, sig, at: now(), tries: 1 };
    if (!(await persisted(ch, 'my update'))) { ch.pending = null; ch.states.splice(n1); throw new Error('the state could not be saved; nothing was sent'); }
    await send(ch, { t: 'update', id: ch.id, n: n1, ...m, sig, nextRev: ch.myRevPub[n1 + 1], nextRevPop: myPop(ch, n1 + 1) });
    return m;
  }
  const pay = (ch, amount, memo = null) => { if (!isInt(amount, 1)) throw new Error('a whole number of sat'); if (amount > room(ch)) throw new Error(`at most ${Math.max(0, room(ch))} sat`); return update(ch, { kind: 'pay', amount, memo }); };
  const addHtlc = (ch, { amount, hash: h, expiry, route = null, memo = null }) => { if (!isInt(amount, MIN_HTLC)) throw new Error(`at least ${MIN_HTLC} sat, a whole number`); if (amount > room(ch)) throw new Error(`at most ${Math.max(0, room(ch))} sat`); if (!isHex64(h)) throw new Error('bad hash'); if (!isInt(expiry, 1, MAX_EXPIRY - 1)) throw new Error('bad expiry'); if (route != null && !isHex64(route.to)) throw new Error('bad route'); return update(ch, { kind: 'add', htlc: { amount, hash: h, expiry, route }, memo }); };
  const settleHtlc = (ch, htlcId, preimage) => { rememberPreimage(ch, sha(preimage), preimage); return update(ch, { kind: 'settle', htlcId, preimage }); };
  const failHtlc = (ch, htlcId, reason = null) => update(ch, { kind: 'fail', htlcId, reason: reason == null ? null : String(reason).slice(0, MEMO_MAX) });

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
      case 'reject': return onReject(ch, m);
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
    const ctx = (i) => `${m.id}/a/${i}`; if (!C.popVerify(m.revBase, m.pop.base, ctx('base')) || !C.popVerify(m.rev[0], m.pop.rev[0], ctx(0)) || !C.popVerify(m.rev[1], m.pop.rev[1], ctx(1))) return log(`open from ${from.slice(0, 12)}… refused: a revocation point comes without proof of its secret`, 'e');
    const ch = newDoc({ id: m.id, role: 'b', peer: from, keys: { a: m.a, b: m.b }, funding: { txid: m.funding.txid, vout: m.funding.vout, value: m.funding.value, ...f }, delay: m.delay, fee: m.fee, peerHubFee: m.hubFee ?? null, n: 0, states: [{ balA: m.funding.value - m.push, balB: m.push, htlcs: [] }], status: 'accepted' });
    ch.theirRevPub[0] = m.rev[0]; ch.theirRevPub[1] = m.rev[1]; ch.theirRevBasePub = m.revBase;
    CH.push(ch); if (!(await persisted(ch, 'my acceptance'))) { CH.pop(); return; }
    await send(ch, acceptBody(ch));
    log(`channel ${ch.id} from ${from.slice(0, 12)}…: ${m.funding.value} sat${m.push ? `, ${m.push} pushed to me` : ''}; accepted, their first commitment signed`);
    io.notify?.('Channel accepted', `${m.funding.value} sat from ${from.slice(0, 12)}…; it opens when the funding confirms`);
  }
  async function onAccept(ch, m) {
    if (ch.role !== 'a' || ch.status !== 'proposed') return;
    if (!theirPopOk(ch, 'base', m.revBase, m.pop.base) || !theirPopOk(ch, 0, m.rev[0], m.pop.rev[0]) || !theirPopOk(ch, 1, m.rev[1], m.pop.rev[1])) return log(`accept for ${ch.id}: a revocation point comes without proof of its secret`, 'e');
    const probe = { ...ch, theirRevPub: { ...ch.theirRevPub, 0: m.rev[0], 1: m.rev[1] }, theirRevBasePub: m.revBase };
    if (!C.verifyFunding(ch, C.commitmentTx(probe, 0, { ...fullState(probe, 0), owner: 'a' }).tx, ch.peer, m.sig)) return log(`accept for ${ch.id}: their signature on my commitment does not verify`, 'e');
    ch.theirRevPub[0] = m.rev[0]; ch.theirRevPub[1] = m.rev[1]; ch.theirRevBasePub = m.revBase; ch.peerHubFee = m.hubFee ?? null; ch.sigs[0] = m.sig; ch.status = 'funding';
    if (!(await persisted(ch, 'my signature'))) return;
    await send(ch, { t: 'commit', id: ch.id, sig: C.signFunding(ch, theirCommitAt(ch, 0).tx, key) });
    log(`channel ${ch.id}: accepted; my commitment is signed, theirs sent; the funding goes out when they confirm`);
  }
  async function onCommit(ch, m) {
    if (ch.role !== 'b' || !['accepted', 'funding'].includes(ch.status)) return;
    if (ch.status === 'accepted') { if (!C.verifyFunding(ch, myCommitAt(ch, 0).tx, ch.peer, m.sig)) return log(`commit for ${ch.id}: their signature does not verify`, 'e'); ch.sigs[0] = m.sig; ch.status = 'funding'; if (!(await persisted(ch, 'the opening'))) return; log(`channel ${ch.id}: my first commitment is signed; waiting for the funding`); }
    await send(ch, { t: 'ready', id: ch.id });
  }
  async function onReady(ch) {
    if (ch.role !== 'a' || ch.status !== 'funding' || ch.broadcastAt) return;
    ch.broadcastAt = now(); save();
    const ok = await io.broadcast(ch.funding.hex, `funding of ${ch.id}`); if (!ok) { ch.broadcastAt = null; ch.unsent.push({ name: 'funding', hex: ch.funding.hex, txid: ch.funding.txid }); save(); }
    log(`channel ${ch.id}: funding ${ch.funding.txid.slice(0, 16)}… published, waiting for a block`);
  }
  // an update I will not sign: told to the other side, so it can set its signed state aside (see onReject)
  async function refuse(ch, m, why) { log(`update ${m.n} for ${ch.id} refused: ${why}`, 'e'); await send(ch, { t: 'reject', id: ch.id, n: m.n, sig: m.sig, reason: String(why).slice(0, MEMO_MAX) }); }
  async function onUpdate(ch, m) {
    if (ch.status === 'closing-asked') return refuse(ch, m, 'a cooperative close at the current state is signed; answer it (a resync brings it again)');
    if (ch.status !== 'open') return;
    if (m.n === ch.n && m.nextRev === ch.theirRevPub[ch.n + 1]) { await resendAck(ch); return log(`channel ${ch.id}: their update ${m.n} again; acknowledged again`); }
    if (m.n !== ch.n + 1) return log(`update for ${ch.id} at state ${m.n}, expected ${ch.n + 1}; ignored`);
    if (awaitingRevoke(ch)) { ch.buffered = m; save(); return log(`channel ${ch.id}: their update ${m.n} arrived before their revocation of state ${ch.n - 1}; held`); }
    if (missingReveals(ch).length) return log(`update for ${ch.id} waits: their revocation secret for state ${missingReveals(ch)[0]} is missing`, 'e');
    // verify everything on copies, then commit
    if (m.kind !== 'pay' && io.stale?.()) return log(`update for ${ch.id} waits: my view of the chain is stale (they retry)`, 'e');
    if (!theirPopOk(ch, m.n + 1, m.nextRev, m.nextRevPop)) return refuse(ch, m, 'the next revocation point comes without proof of its secret');
    let s; try { s = nextState(ch, st(ch, ch.n), m, them(ch)); } catch (e) { return refuse(ch, m, e.message); }
    if (!C.verifyFunding(ch, myCommitAt(ch, m.n, s).tx, ch.peer, m.sig)) return refuse(ch, m, 'the signature on my new commitment does not verify');
    if (ch.pending) {
      if (!(ch.peer < pub)) { log(`update for ${ch.id} while mine is pending: mine stands (lower key); theirs is rejected`); return send(ch, { t: 'reject', id: ch.id, n: m.n, sig: m.sig, reason: 'collision: the lower key\'s update stands' }); }
      dropPending(ch, 'they proposed at the same time and the lower key wins'); }
    ch.states[m.n] = s; ch.theirRevPub[m.n + 1] = m.nextRev; ensureMyRev(ch, m.n + 1); ch.sigs[m.n] = m.sig; bumpHtlcSeq(ch, m);
    if (m.kind === 'settle') rememberPreimage(ch, sha(m.preimage), m.preimage);
    const prev = ch.n; ch.n = m.n; ch.awaiting = { n: m.n, m, sender: them(ch), prev, at: now() };
    if (!(await persisted(ch, 'my acknowledgement'))) return;
    await send(ch, { t: 'ack', id: ch.id, n: m.n, sig: C.signFunding(ch, theirCommitAt(ch, m.n).tx, key), reveal: ch.myRev[prev], nextRev: ch.myRevPub[m.n + 1], nextRevPop: myPop(ch, m.n + 1) });
    log(`channel ${ch.id}: their ${updateLabel(m)} signed as state ${m.n}; final when they revoke ${prev}`);
  }
  async function onAck(ch, m) {
    if (!['open', 'closing-asked'].includes(ch.status)) return log(`ack for ${ch.id} while ${ch.status}; ignored`);
    if (!ch.pending && m.n === ch.n + 1) return adoptAlt(ch, m);
    const p = ch.pending; if (!p || m.n !== p.n) return log(`ack for ${ch.id} at ${m.n} with ${p ? `pending ${p.n}` : 'nothing pending'}; ignored`);
    if (!C.verifyFunding(ch, myCommitAt(ch, p.n).tx, ch.peer, m.sig)) return log(`ack for ${ch.id}: their signature does not verify`, 'e');
    if (!theirPopOk(ch, p.n + 1, m.nextRev, m.nextRevPop)) return log(`ack for ${ch.id}: the next revocation point comes without proof of its secret`, 'e');
    if (!takeReveal(ch, ch.n, m.reveal) && ch.theirRev[ch.n] !== m.reveal) return log(`ack for ${ch.id}: the revealed secret is not state ${ch.n}'s`, 'e');
    ch.theirRevPub[p.n + 1] = m.nextRev; ch.sigs[p.n] = m.sig; bumpHtlcSeq(ch, p.m);
    const prev = ch.n; ch.n = p.n; ch.pending = null; ensureMyRev(ch, p.n + 1);
    if (p.m.kind === 'settle') rememberPreimage(ch, sha(p.m.preimage), p.m.preimage);
    if (p.m.kind === 'fail') { const was = (st(ch, prev).htlcs ?? []).find((x) => x.id === p.m.htlcId); if (was && was.from === me(ch)) { io.notify?.('Payment failed', `${was.amount} sat on ${ch.id} came back: ${p.m.reason ?? 'expired'}`); io.onPayment?.(ch, was.hash, 'failed', p.m.reason ?? 'expired'); } }
    if (!(await persisted(ch, 'my revocation'))) return;
    await send(ch, { t: 'revoke', id: ch.id, n: p.n, reveal: ch.myRev[prev] });
    log(`channel ${ch.id}: my ${updateLabel(p.m)} acknowledged; state ${p.n}`);
    await io.onAcked?.(ch, p.m);
  }
  // an acknowledgement of a state I had set aside: the signature I gave for it was binding, so if theirs verifies the state is real
  async function adoptAlt(ch, m) {
    const alts = ch.signedAlt?.[m.n] ?? []; const alt = alts.find((a) => a.m && C.verifyFunding(ch, myCommitAt(ch, m.n, a).tx, ch.peer, m.sig)); if (!alt) return log(`ack for ${ch.id} at ${m.n} matches no state I signed; ignored`);
    if (!theirPopOk(ch, m.n + 1, m.nextRev, m.nextRevPop)) return log(`ack for ${ch.id}: the next revocation point comes without proof of its secret`, 'e');
    if (!takeReveal(ch, ch.n, m.reveal) && ch.theirRev[ch.n] !== m.reveal) return log(`ack for ${ch.id}: the revealed secret is not state ${ch.n}'s`, 'e');
    ch.states[m.n] = { balA: alt.balA, balB: alt.balB, htlcs: alt.htlcs }; ch.theirRevPub[m.n + 1] = m.nextRev; ch.sigs[m.n] = m.sig; bumpHtlcSeq(ch, alt.m); ch.signedAlt[m.n] = alts.filter((a) => a !== alt);
    const prev = ch.n; ch.n = m.n; ensureMyRev(ch, m.n + 1); if (alt.m.kind === 'settle') rememberPreimage(ch, sha(alt.m.preimage), alt.m.preimage);
    if (!(await persisted(ch, 'my revocation'))) return;
    await send(ch, { t: 'revoke', id: ch.id, n: m.n, reveal: ch.myRev[prev] });
    log(`channel ${ch.id}: my ${updateLabel(alt.m)}, set aside earlier, was acknowledged after all; state ${m.n}`, 'e'); io.notify?.('Update applied after all', `${ch.id}: the ${updateLabel(alt.m)} that was set aside has been acknowledged and is in force`);
    if (alt.m.kind === 'add') io.onPayment?.(ch, alt.m.htlc.hash, 'in flight', null); await io.onAcked?.(ch, alt.m);
  }
  function takeReveal(ch, i, secret) { if (i < 0 || ch.theirRev[i] || !ch.theirRevPub[i]) return false; let p = null; try { p = signer.pubkeyOf(secret); } catch {} if (p !== ch.theirRevPub[i]) return false; ch.theirRev[i] = secret; return true; }
  async function onRevoke(ch, m) {
    if (!['open', 'closing-asked'].includes(ch.status) && !ch.awaiting) return log(`revoke for ${ch.id} while ${ch.status}; ignored`);
    if (m.n > ch.n) return log(`revoke for ${ch.id} at ${m.n} ahead of my ${ch.n}; ignored`);
    if (!takeReveal(ch, m.n - 1, m.reveal)) { if (ch.theirRev[m.n - 1]) return; return log(`revoke for ${ch.id}: not state ${m.n - 1}'s secret`, 'e'); }
    save();
    await finalise(ch);
  }
  async function onReject(ch, m) {
    const p = ch.pending; if (!p || p.n !== m.n) return; if (m.sig !== p.sig) return log(`reject for ${ch.id} at ${m.n} answers an earlier attempt; ignored`);
    dropPending(ch, `they refused it: ${m.reason ?? 'no reason given'}`); save();
    await announceDropped(ch);
    if (/cooperative close/.test(m.reason ?? '')) await resync(ch, true);
  }
  async function announceDropped(ch) {
    const d = ch.droppedIntent; if (!d || ch.pending || awaitingRevoke(ch)) return; ch.droppedIntent = null; save();
    log(`channel ${ch.id}: an update of mine was set aside (${d.reason ?? 'collision'}); ${d.kind === 'pay' ? 'the payment was NOT made' : d.kind === 'add' ? 'the HTLC was not added' : 'it was not applied'} and is not retried by itself`, 'e');
    if (d.kind === 'add') io.onPayment?.(ch, d.htlc.hash, 'not made', d.reason ?? 'collision');
    if (d.kind === 'pay' || d.kind === 'add') io.notify?.('Payment not made', `${ch.id}: the payment of ${d.kind === 'pay' ? d.amount : d.htlc.amount} sat was not made (${d.reason ?? 'collision'}); make it again if you still want it`);
    try { await io.onDropped?.(ch, d); } catch (e) { log(`after a dropped update on ${ch.id}: ${e.message}`, 'e'); }
  }
  // their revocation of the state before the one they proposed makes that state final: only now is it acted on
  async function finalise(ch) {
    const w = ch.awaiting; if (!w || !ch.theirRev[w.prev]) return;
    ch.awaiting = null; save();
    const m = w.m; const gain = bal(ch, me(ch), w.n) - bal(ch, me(ch), w.prev); const was = (st(ch, w.prev).htlcs ?? []).find((x) => x.id === m.htlcId);
    if (m.kind === 'pay') io.notify?.('Payment received', `${m.amount} sat on ${ch.id}${m.memo ? ` · ${m.memo}` : ''}`);
    if (m.kind === 'settle' && gain > 0) io.notify?.('Payment received', `${gain} sat on ${ch.id} (htlc ${m.htlcId} settled)`);
    if (m.kind === 'settle' && was && was.from === me(ch)) { io.notify?.('Payment sent', `${was.amount} sat on ${ch.id}: the other side took it with the preimage`); io.onPayment?.(ch, was.hash, 'sent', null); }
    if (m.kind === 'fail' && was && was.from === me(ch)) { io.notify?.('Payment failed', `${was.amount} sat on ${ch.id} came back: ${m.reason ?? 'no reason given'}`); io.onPayment?.(ch, was.hash, 'failed', m.reason ?? null); }
    log(`channel ${ch.id}: state ${w.n} final`);
    try { await io.onUpdate?.(ch, m, w.sender); } catch (e) { log(`after update on ${ch.id}: ${e.message}`, 'e'); }
    await announceDropped(ch);
    if (ch.buffered) { const b = ch.buffered; ch.buffered = null; save(); await onUpdate(ch, b); }
  }
  async function onClose(ch, m) {
    if (!['open', 'funding', 'closing-asked'].includes(ch.status)) return;
    if (m.n !== ch.n) return log(`close for ${ch.id} at state ${m.n}, I am at ${ch.n}; ignored`, 'e');
    if (ch.pending || awaitingRevoke(ch)) return log(`close for ${ch.id} while an update is in flight; ignored, they can ask again`, 'e');
    let tx; try { tx = C.closingTx(ch, fullState(ch, ch.n)); } catch (e) { return log(`close for ${ch.id} refused: ${e.message}`, 'e'); }
    if (!C.verifyFunding(ch, tx, ch.peer, m.sig)) return log(`close for ${ch.id}: their signature does not verify`, 'e');
    tx.witness = [C.fundingWitness(ch, { [ch.peer]: m.sig, [pub]: C.signFunding(ch, tx, key) })];
    const v = C.verifyTx(tx, [C.fundingPrevout(ch)]); if (!v.ok) return log(`close for ${ch.id}: the closing transaction fails: ${v.error}`, 'e');
    ch.status = 'closing'; ch.coopTxid = C.txid(tx); ch.closeTxid = ch.coopTxid; ch.closeHex = C.encode(tx); ch.closeAt = height(); save();
    await publish(ch, 'cooperative close', ch.closeHex, ch.closeTxid);
    log(`channel ${ch.id}: closing cooperatively at state ${ch.n}, ${myBal(ch)} sat to me`);
  }

  // ---- resync: where each side is, the secrets the other side lacks, and whatever was lost on the way
  const mayReveal = (ch, i) => i < ch.n && !(ch.closeTxid && i >= (ch.closeState ?? ch.n)); // never the secret of a commitment I have published
  const syncBody = (ch, t = 'sync') => ({ t, id: ch.id, n: ch.n, status: ch.status, pendingN: ch.pending?.n ?? null, reveal: ch.n > 0 && mayReveal(ch, ch.n - 1) ? ch.myRev[ch.n - 1] : null, missing: missingReveals(ch) });
  async function onSync(ch, m) {
    if (m.reveal) takeReveal(ch, m.n - 1, m.reveal);
    if (m.reveals) for (const [i, r] of Object.entries(m.reveals)) takeReveal(ch, Number(i), r);
    save(); await finalise(ch);
    if (m.t === 'sync') { const reveals = {}; for (const i of m.missing ?? []) if (mayReveal(ch, i) && ch.myRev[i]) reveals[i] = ch.myRev[i]; await send(ch, { ...syncBody(ch, 'synced'), reveals }); }
    await reconcile(ch, m);
  }
  async function resendUpdate(ch) { const p = ch.pending; if (!p) return; p.tries = (p.tries ?? 0) + 1; p.at = now(); if (!(await persisted(ch, 'my update'))) return; await send(ch, { t: 'update', id: ch.id, n: p.n, ...p.m, sig: C.signFunding(ch, theirCommitAt(ch, p.n).tx, key), nextRev: ch.myRevPub[p.n + 1], nextRevPop: myPop(ch, p.n + 1) }); }
  async function resendAck(ch) { const n = ch.n; if (n < 1 || !ch.sigs[n] || !mayReveal(ch, n - 1)) return; if (!(await persisted(ch, 'my acknowledgement'))) return; await send(ch, { t: 'ack', id: ch.id, n, sig: C.signFunding(ch, theirCommitAt(ch, n).tx, key), reveal: ch.myRev[n - 1], nextRev: ch.myRevPub[n + 1], nextRevPop: myPop(ch, n + 1) }); }
  async function reconcile(ch, m) {
    // the opening handshake, by the status each side reports
    if (ch.role === 'a' && ch.status === 'funding') { if (m.status === 'accepted') await send(ch, { t: 'commit', id: ch.id, sig: C.signFunding(ch, theirCommitAt(ch, 0).tx, key) }); else if (m.status === 'funding' || m.status === 'open') await onReady(ch); return; }
    if (ch.role === 'b' && ch.status === 'accepted' && m.status === 'proposed') { await send(ch, acceptBody(ch)); return; }
    if (ch.role === 'b' && ch.status === 'funding' && ['funding', 'open'].includes(m.status ?? '')) await send(ch, { t: 'ready', id: ch.id });
    if (ch.status === 'closing-asked' && ['open', 'funding', 'closing-asked'].includes(m.status ?? '')) { const tx = C.closingTx(ch, fullState(ch, ch.n)); await send(ch, { t: 'close', id: ch.id, n: ch.n, sig: C.signFunding(ch, tx, key) }); }
    if (ch.status !== 'open' && ch.status !== 'closing-asked') return;
    if (m.n === ch.n) {
      if (ch.pending && m.pendingN == null) { log(`channel ${ch.id}: they never saw my update ${ch.pending.n}; sending it again`); await resendUpdate(ch); }
      else if (ch.pending && m.pendingN === ch.pending.n) { if (ch.peer < pub) { dropPending(ch, 'both of us proposed at once and the lower key wins'); save(); await announceDropped(ch); } else { log(`channel ${ch.id}: both pending at ${ch.pending.n}; mine stands, sending it again`); await resendUpdate(ch); } }
      else if (!ch.pending && m.pendingN === ch.n + 1) log(`channel ${ch.id}: they have an update pending that I have not seen; it comes with their retry`);
      return; }
    if (m.n === ch.n - 1 && (m.pendingN === ch.n || m.pendingN == null)) { log(`channel ${ch.id}: they are one state behind; sending my acknowledgement of ${ch.n} again`); await resendAck(ch); return; }
    if (m.n === ch.n + 1 && ch.pending?.n === m.n) { log(`channel ${ch.id}: they reached state ${m.n} on my update but I never got the acknowledgement; they resend it on their resync`); return; }
    if (m.n > ch.n) { log(`channel ${ch.id}: they report state ${m.n}, I am at ${ch.n}; I keep what I signed and wait for their update`, 'e'); return; }
    log(`channel ${ch.id}: they report state ${m.n}, I am at ${ch.n}: they have lost state; a forced close from either side settles at what was signed`, 'e');
  }
  async function resync(ch, force = false) { if (!force && ch.lastSyncAt && now() - ch.lastSyncAt < 30) return; ch.lastSyncAt = now(); await send(ch, syncBody(ch)); }
  async function resyncAll(force = false) { for (const ch of CH) if (LIVE.has(ch.status)) await resync(ch, force); }

  // ---- on every tick: retries with backoff, deadlines on the chain, HTLCs that must move, broadcasts that failed, proposals that died
  async function tick() {
    for (const ch of CH) {
      if (['proposed', 'accepted'].includes(ch.status) && now() - ch.at > (opts.proposalTimeout ?? PROPOSAL_TIMEOUT)) { ch.status = 'abandoned'; save(); log(`channel ${ch.id}: nobody funded it in six hours; abandoned (no coins moved)`); continue; }
      if (ch.status === 'funding' && !ch.fundedHeight && now() - ch.at > FUNDING_TIMEOUT) { ch.status = 'unfunded'; save(); log(`channel ${ch.id}: the funding has not confirmed in a day; set aside (it opens if it ever confirms${ch.role === 'a' ? '; the coins are still yours to spend elsewhere' : ''})`, 'e'); continue; }
      if (ch.status === 'unfunded' && now() - ch.at > UNFUNDED_TIMEOUT) { ch.status = 'abandoned'; save(); log(`channel ${ch.id}: the funding never confirmed in a week; abandoned`); continue; }
      if (CLOSED_OUT.has(ch.status) && ch.status !== 'closing-asked' && !ch.spentBy && ch.closeHex && height() - (ch.closeAt ?? 0) > 3 && !(ch.unsent ?? []).some((u) => u.txid === ch.closeTxid)) { ch.closeAt = height(); save(); await publish(ch, 'close (again, still unconfirmed)', ch.closeHex, ch.closeTxid); }
      if (ch.unsent?.length) for (const u of [...ch.unsent]) { const ok = await io.broadcast(u.hex, `${u.name} of ${ch.id} (again)`); if (ok) { ch.unsent = ch.unsent.filter((x) => x !== u); if (u.name === 'funding') ch.broadcastAt = now(); save(); } }
      if (!LIVE.has(ch.status)) continue;
      if (ch.status === 'proposed' && ch.role === 'a' && now() - (ch.openAt ?? 0) > 90) { ch.openAt = now(); save(); await send(ch, openBody(ch)); log(`channel ${ch.id}: proposal sent again`); }
      const p = ch.pending;
      if (p && p.m.kind === 'add' && height() >= p.m.htlc.expiry - ch.delay - EXPIRY_MARGIN) { dropPending(ch, 'the HTLC would expire before it could be added'); save(); await announceDropped(ch); }
      else if (p && now() - p.at >= Math.min(600, (opts.pendingTimeout ?? 90) * Math.pow(2, Math.max(0, (p.tries ?? 1) - 1)))) { log(`channel ${ch.id}: update ${p.n} unanswered for ${now() - p.at} s (try ${p.tries}); resyncing and sending it again`); await resync(ch); await resendUpdate(ch); }
      if ((ch.awaiting && now() - (ch.awaiting.at ?? 0) > 60) || missingReveals(ch).length) await resync(ch);
      if (ch.status !== 'open') continue;
      await announceDropped(ch);
      const h = height();
      // deadlines on the chain come before anything a pending update could hold up: an HTLC I can claim must be on the
      // chain `delay + CLAIM_MARGIN` blocks before its expiry, because my claim on my own commitment waits `delay` blocks
      const urgent = htlcs(ch).find((x) => x.from !== me(ch) && knownPreimage(ch, x.hash) && h >= x.expiry - ch.delay - CLAIM_MARGIN);
      if (urgent) { log(`channel ${ch.id}: htlc ${urgent.id} is mine to claim and its expiry is near; closing to claim it on the chain`, 'e'); try { await forceClose(ch, ch.n, 'protective'); } catch (e) { log(`protective close of ${ch.id}: ${e.message}`, 'e'); } continue; }
      if (ch.pending || awaitingRevoke(ch) || missingReveals(ch).length) continue;
      for (const x of htlcs(ch)) {
        const iOffered = x.from === me(ch); const preimage = iOffered ? null : knownPreimage(ch, x.hash);
        try {
          if (!iOffered && preimage) { await settleHtlc(ch, x.id, preimage); break; }
          if (iOffered && h >= x.expiry) { await failHtlc(ch, x.id, 'expired'); break; }
        } catch (e) { log(`channel ${ch.id}: htlc ${x.id}: ${e.message}`, 'e'); }
      }
    }
  }

  // ---- closing
  async function closeChannel(ch) {
    if (!['open', 'funding'].includes(ch.status)) throw new Error('not open');
    if (ch.pending || awaitingRevoke(ch)) throw new Error('an update is in flight; try again when it settles');
    const tx = C.closingTx(ch, fullState(ch, ch.n)); const sig = C.signFunding(ch, tx, key);
    ch.status = 'closing-asked'; ch.coopTxid = C.txid(tx); save();
    await send(ch, { t: 'close', id: ch.id, n: ch.n, sig }); log(`channel ${ch.id}: cooperative close asked at state ${ch.n}`);
  }
  async function forceClose(ch, i = ch.n, why = 'forced') {
    if (!ch.sigs[i]) throw new Error(`state ${i} was never signed by them`);
    if (!ch.fundedHeight && ch.status !== 'open') throw new Error('the funding is not confirmed; there is nothing to close yet');
    const c = myCommitAt(ch, i); c.tx.witness = [C.fundingWitness(ch, { [pub]: C.signFunding(ch, c.tx, key), [ch.peer]: ch.sigs[i] })];
    const v = C.verifyTx(c.tx, [C.fundingPrevout(ch)]); if (!v.ok) throw new Error(`my commitment fails: ${v.error}`);
    if (ch.pending) { dropPending(ch, 'the channel is being closed'); }
    ch.status = 'force-closing'; ch.closeTxid = C.txid(c.tx); ch.closeHex = C.encode(c.tx); ch.closeState = i; ch.closeAt = height(); ch.awaiting = null; ch.buffered = null; save();
    await publish(ch, `${why} close`, ch.closeHex, ch.closeTxid);
    log(`channel ${ch.id}: ${why} close published, my commitment ${ch.closeTxid.slice(0, 16)}… at state ${i}${i < ch.n ? ' (AN OLD STATE: the other side can take it all)' : ''}`, i < ch.n ? 'e' : '');
  }
  // a broadcast that reached nobody is kept and sent again on the next tick
  async function publish(ch, name, hex, txid) { const ok = await io.broadcast(hex, `${name} of ${ch.id}`); if (!ok) { ch.unsent ??= []; ch.unsent.push({ name, hex, txid }); save(); } return ok; }

  // ---- the funding output was spent: classify, then answer (sweeps after the delay, claims, the penalty)
  async function onSpend(ch, spend) {
    if (ch.spentBy?.txid === spend.txid) return afterClose(ch);
    ch.preSpend = ch.status; ch.spentBy = { ...spend, at: now() }; ch.outputs = {};
    if (ch.coopTxid === spend.txid) { ch.status = 'closed'; save(); io.notify?.('Channel closed', `${ch.id} settled cooperatively at block ${spend.height}`); return; }
    if (ch.closeTxid === spend.txid) { ch.status = 'closed-mine'; ch.closeStateObj = null; save(); log(`channel ${ch.id}: my commitment is in block ${spend.height}; my outputs can be claimed after ${ch.delay} blocks`); return afterClose(ch); }
    // one of theirs: the current state, the state of my pending update (they hold my signature on it), an alternative I signed, or a revoked one
    const candidates = []; for (let i = 0; i <= ch.n; i++) { candidates.push({ i, s: st(ch, i), alt: false }); for (const s of ch.signedAlt?.[i] ?? []) candidates.push({ i, s, alt: true }); }
    if (ch.pending) candidates.push({ i: ch.pending.n, s: st(ch, ch.pending.n), alt: false }); for (const s of ch.signedAlt?.[ch.n + 1] ?? []) candidates.push({ i: ch.n + 1, s, alt: true });
    for (const { i, s, alt } of candidates) {
      let t; try { t = theirCommitAt(ch, i, s); } catch { continue; } if (C.txid(t.tx) !== spend.txid) continue;
      const revoked = !!ch.theirRev[i];
      ch.closeState = i; ch.closeStateObj = s;
      if (!revoked) { ch.status = alt ? 'closed-theirs-alt' : 'closed-theirs'; save(); io.notify?.('Channel closed by the other side', `${ch.id} at state ${i}${alt ? ' (an alternative I had signed)' : ''}, block ${spend.height}`); return afterClose(ch); }
      const secret = penaltyKey(ch, i); const claims = [];
      const vl = t.kinds.indexOf('to_local'); if (vl >= 0) try { const value = t.tx.outputs[vl].value; claims.push({ name: 'penalty on to_local', vout: vl, tx: C.sweepTx({ commit: t, txid: spend.txid, vout: vl, value, to: io.myScript, fee: ch.fee, delayed: 0, key: secret }), prevout: { value, scriptPubKey: t.toLocal.spk } }); } catch (e) { log(`penalty on ${ch.id}: ${e.message}`, 'e'); }
      for (const h of t.htlcs) try { claims.push({ name: `penalty on htlc ${h.id}`, vout: h.vout, tx: C.htlcClaim({ commit: t, htlc: h, kind: 'revocation', txid: spend.txid, value: h.amount, to: io.myScript, fee: ch.fee, key: secret }), prevout: { value: h.amount, scriptPubKey: h.scripts.spk } }); } catch (e) { log(`penalty on ${ch.id} htlc ${h.id}: ${e.message}`, 'e'); }
      ch.status = 'punishing'; ch.penalties = []; ch.claimed ??= {};
      for (const c of claims) { const v = C.verifyTx(c.tx, [c.prevout]); if (!v.ok) { log(`${c.name} on ${ch.id} fails: ${v.error}`, 'e'); continue; } const txid = C.txid(c.tx); ch.penalties.push(txid); ch.claimed[c.name] = { txid, vout: c.vout, hex: C.encode(c.tx), at: height() }; ch.outputs[c.vout] = { name: c.name, mine: true }; }
      save();
      for (const c of claims) if (ch.penalties.includes(C.txid(c.tx))) await publish(ch, `${c.name} (their revoked state ${i})`, C.encode(c.tx), C.txid(c.tx));
      io.notify?.('Cheat punished', `${ch.id}: they published revoked state ${i}; ${ch.penalties.length} penalty transaction(s) sent`); return;
    }
    ch.status = 'spent-unknown'; save(); log(`channel ${ch.id}: the funding was spent by ${spend.txid.slice(0, 16)}… which is none of the transactions I know`, 'e');
  }
  // the spend was undone by a reorganisation: back to where the channel was, the claims forgotten
  // a close I published stays published: it is in mempools and can confirm later, so the channel never goes back to 'open'
  function unSpend(ch) { if (!ch.spentBy) return; log(`channel ${ch.id}: the spend ${ch.spentBy.txid.slice(0, 16)}… is no longer in the chain; watching again`, 'e'); const back = ch.preSpend ?? 'open'; ch.spentBy = null; ch.claimed = {}; ch.penalties = []; ch.outputs = {}; ch.unsent = (ch.unsent ?? []).filter((u) => u.name === 'funding');
    ch.scanned = {}; ch.closeStateObj = null; if (ch.closeHex && CLOSED_OUT.has(back)) { ch.status = back === 'closing-asked' ? 'closing' : back; ch.unsent.push({ name: 'close (again after a reorganisation)', hex: ch.closeHex, txid: ch.closeTxid }); } else ch.status = back; save(); }
  // after a close by either side's commitment: claim what is mine when it can be claimed; then watch every output until
  // each is settled on the chain (my claim confirmed, or theirs taken, which may reveal a preimage I forward)
  async function afterClose(ch) {
    if (['punishing', 'settling'].includes(ch.status)) return watchOutputs(ch);
    if (!['closed-mine', 'closed-theirs', 'closed-theirs-alt'].includes(ch.status) || !ch.spentBy) return;
    const mine = ch.status === 'closed-mine'; const i = ch.closeState ?? ch.n; const s = ch.closeStateObj ?? st(ch, i);
    const c = mine ? myCommitAt(ch, i, s) : theirCommitAt(ch, i, s); const conf = height() - ch.spentBy.height + 1; ch.claimed ??= {}; ch.outputs ??= {}; let left = 0;
    const claim = async (name, vout, build, prevout) => { if (ch.claimed[name]) return; let tx; try { tx = build(); } catch (e) { return log(`${name} on ${ch.id}: ${e.message}`, 'e'); } const v = C.verifyTx(tx, [prevout]); if (!v.ok) return log(`${name} on ${ch.id} fails: ${v.error}`, 'e'); const txid = C.txid(tx); const hex = C.encode(tx); const ok = await publish(ch, name, hex, txid); ch.claimed[name] = { txid, vout, hex, at: height() }; ch.outputs[vout] = { name, mine: true }; save(); if (!ok) log(`${name} on ${ch.id} reached no relay; kept for the next tick`, 'e'); };
    if (mine) { const vl = c.kinds.indexOf('to_local'); if (vl >= 0) { const value = c.tx.outputs[vl].value; if (conf >= ch.delay) await claim('sweep of to_local', vl, () => C.sweepTx({ commit: c, txid: ch.closeTxid, vout: vl, value, to: io.myScript, fee: ch.fee, delayed: ch.delay, key }), { value, scriptPubKey: c.toLocal.spk }); else left++; } }
    for (const h of c.htlcs) {
      const iOffered = h.from === me(ch); const preimage = iOffered ? null : knownPreimage(ch, h.hash); const prevout = { value: h.amount, scriptPubKey: h.scripts.spk };
      ch.outputs[h.vout] ??= { name: `htlc ${h.id}`, hash: h.hash, iOffered, mine: false };
      if (ch.outputs[h.vout].theirs) continue; // already taken by the other side
      if (!iOffered && preimage) { if (mine && conf < ch.delay) { left++; continue; } await claim(`claim of htlc ${h.id} with the preimage`, h.vout, () => C.htlcClaim({ commit: c, htlc: h, kind: 'success', txid: ch.spentBy.txid, value: h.amount, to: io.myScript, fee: ch.fee, key, preimage }), prevout); }
      else if (iOffered && height() >= h.expiry) { if (mine && conf < ch.delay) { left++; continue; } await claim(`refund of htlc ${h.id} after its expiry`, h.vout, () => C.htlcClaim({ commit: c, htlc: h, kind: 'timeout', txid: ch.spentBy.txid, value: h.amount, to: io.myScript, fee: ch.fee, key }), prevout); }
      else left++; // theirs to claim, or not yet claimable by me
    }
    if (!left) { ch.status = 'settling'; save(); log(`channel ${ch.id}: everything of mine is claimed; waiting for the claims to confirm`); }
    await watchOutputs(ch);
  }
  // every output of the close I care about: a claim of mine confirms, or the other side takes it (an HTLC spend with the preimage is learned)
  async function watchOutputs(ch) {
    if (!io.findSpend || !ch.spentBy || !ch.outputs) return;
    let open = 0;
    for (const [vout, o] of Object.entries(ch.outputs)) {
      if (o.confirmed || o.theirs) continue;
      let sp = null; try { sp = await io.findSpend(ch, { txid: ch.spentBy.txid, vout: Number(vout), from: ch.spentBy.height }); } catch (e) { log(`watch ${ch.id}:${vout}: ${e.message}`, 'e'); open++; continue; }
      if (!sp) { open++; const c = Object.values(ch.claimed ?? {}).find((x) => x.vout === Number(vout)); if (c?.hex && height() - (c.at ?? 0) > 6 && !(ch.unsent ?? []).some((u) => u.txid === c.txid)) { c.at = height(); save(); await publish(ch, `${o.name} (again)`, c.hex, c.txid); } continue; }
      const mineTx = Object.values(ch.claimed ?? {}).find((c) => c.txid === sp.txid);
      if (mineTx) { o.confirmed = sp.height; log(`channel ${ch.id}: ${o.name} confirmed in block ${sp.height}`); }
      else { o.theirs = sp.txid; log(`channel ${ch.id}: ${o.name} was taken by the other side (${sp.txid.slice(0, 16)}…)`, o.mine ? 'e' : '');
        if (o.hash && o.iOffered && !knownPreimage(ch, o.hash)) { let pre = null; try { pre = C.preimageIn(C.decode(sp.hex), o.hash); } catch {} if (pre) { rememberPreimage(ch, o.hash, pre); log(`channel ${ch.id}: the preimage of htlc ${o.name.slice(5)} was read from the chain`); try { await io.onPreimage?.(ch, o.hash, pre); } catch (e) { log(`after a preimage on ${ch.id}: ${e.message}`, 'e'); } } } }
      save();
    }
    if (ch.status === 'settling' && !open && !(ch.unsent?.length)) { ch.status = 'closed'; save(); io.notify?.('Channel settled', `${ch.id}: everything of mine is claimed and confirmed`); }
    if (ch.status === 'punishing' && !open && !(ch.unsent?.length)) { const lost = Object.values(ch.outputs).filter((o) => o.mine && o.theirs).length; ch.status = 'punished'; save(); io.notify?.(lost ? 'Penalty partly lost' : 'Penalty confirmed', `${ch.id}: ${lost ? `${lost} output(s) were taken before the penalty landed` : 'their cheat is punished'}`); }
  }

  return { channels: CH, byId, me, them, myBal, theirBal, room, htlcs, fullState, myCommitAt, theirCommitAt, openChannel, onMessage, pay, addHtlc, settleHtlc, failHtlc, closeChannel, forceClose, onSpend, unSpend, afterClose, watchOutputs, sha, hubFee, resyncAll, resync, tick, missingReveals, awaitingRevoke, rememberPreimage, knownPreimage, wellFormed, dropPending,
    invoice: (amount, memo, hops = [], feeHint = hubFee, expiresIn = 3600) => { const preimage = signer.randomKey(); const h = sha(preimage); return { preimage, inv: { p: pub, a: amount, m: memo || undefined, h, r: hops, f: feeHint, x: now() + expiresIn, i: h.slice(0, 16) } }; } };
}
