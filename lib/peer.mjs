// The channel protocol, pure: one peer's channels as documents, the messages between peers as JSON bodies (the host signs
// and carries them as relay events), the state machine for opening, updating (payments, HTLCs added, settled, failed),
// closing, and what to do when the funding output is spent. Hosts: hitch.js in a tab, bin/hub.mjs in Node. The host gives
// `io`: send(ch, body), broadcast(hex, what), buildFunding(amount, spk) → { txid, vout, hex }, height(), save(), log, notify.
import { DUST } from './channel.mjs';
export const KIND = 23600; export const MIN_HTLC = 1000, EXPIRY_MARGIN = 12; // blocks an HTLC must keep beyond the delay
const now = () => Math.floor(Date.now() / 1000);

export function makePeer({ C, signer, hash, pub, key, channels, io, opts = {} }) {
  const delay = opts.delay ?? 6, fee = opts.fee ?? 300, hubFee = opts.hubFee ?? 10;
  const CH = channels; const byId = (id) => CH.find((c) => c.id === id);
  const me = (ch) => ch.role, them = (ch) => (ch.role === 'a' ? 'b' : 'a');
  const sha = (hex) => hash.bytesToHex(hash.sha256(hash.hexToBytes(hex)));
  const newRev = () => { const k = signer.randomKey(); return { key: k, pub: signer.pubkeyOf(k) }; };
  const ensureMyRev = (ch, i) => { if (!ch.myRev[i]) { const r = newRev(); ch.myRev[i] = r.key; ch.myRevPub[i] = r.pub; } return ch.myRevPub[i]; };
  const st = (ch, i) => ch.states[i];
  const fullState = (ch, i) => { const s = st(ch, i); return { balA: s.balA, balB: s.balB, htlcs: s.htlcs ?? [], rev: { a: ch.role === 'a' ? ch.myRevPub[i] : ch.theirRevPub[i], b: ch.role === 'b' ? ch.myRevPub[i] : ch.theirRevPub[i] } }; };
  const myCommitAt = (ch, i) => C.commitmentTx(ch, i, { ...fullState(ch, i), owner: me(ch) }); const theirCommitAt = (ch, i) => C.commitmentTx(ch, i, { ...fullState(ch, i), owner: them(ch) });
  const bal = (ch, who, i = ch.n) => (who === 'a' ? st(ch, i).balA : st(ch, i).balB);
  const myBal = (ch) => bal(ch, me(ch)), theirBal = (ch) => bal(ch, them(ch));
  const room = (ch) => myBal(ch) - (ch.role === 'a' ? fee : 0);
  const save = () => io.save(); const log = (t, c) => io.log(t, c); const send = (ch, body) => io.send(ch, body);

  // ---- opening
  async function openChannel(peer, amount, push = 0) {
    if (!/^[0-9a-f]{64}$/.test(peer)) throw new Error('a node id is 64 hex characters'); if (peer === pub) throw new Error('that is this node'); if (!(amount >= 10000)) throw new Error('at least 10,000 sat'); if (!(push >= 0) || push > amount - fee - DUST) throw new Error('push must leave the funder its fee and dust');
    const f = C.fundingScript(pub, peer); const fund = await io.buildFunding(amount, f.spk);
    const ch = { id: fund.txid.slice(0, 16), role: 'a', peer, keys: { a: pub, b: peer }, funding: { txid: fund.txid, vout: fund.vout, value: amount, hex: fund.hex, ...f }, delay, fee, n: 0, states: [{ balA: amount - push, balB: push, htlcs: [] }], myRev: {}, myRevPub: {}, theirRev: {}, theirRevPub: {}, sigs: {}, status: 'proposed', at: now(), pending: null, nextHtlc: 1, preimages: {} };
    ensureMyRev(ch, 0); ensureMyRev(ch, 1); CH.push(ch); save();
    await send(ch, { t: 'open', id: ch.id, funding: { txid: fund.txid, vout: fund.vout, value: amount }, push, delay, fee, a: pub, b: peer, rev: [ch.myRevPub[0], ch.myRevPub[1]] });
    log(`channel ${ch.id} proposed to ${peer.slice(0, 12)}… for ${amount} sat${push ? ` (${push} pushed to them)` : ''}`); return ch; }

  // ---- the next state from the current one, by kind; both sides compute it and must agree
  function nextState(ch, cur, m, sender) { const s = { balA: cur.balA, balB: cur.balB, htlcs: (cur.htlcs ?? []).map((h) => ({ ...h })) }; const other = sender === 'a' ? 'b' : 'a'; const add = (who, v) => { if (who === 'a') s.balA += v; else s.balB += v; };
    if (m.kind === 'pay') { if (!(m.amount >= 1)) throw new Error('bad amount'); add(sender, -m.amount); add(other, m.amount); }
    else if (m.kind === 'add') { const h = m.htlc; if (!h || !(h.amount >= MIN_HTLC) || !/^[0-9a-f]{64}$/.test(h.hash) || !(h.expiry > 0)) throw new Error('bad htlc'); if (h.id !== (cur.htlcs ?? []).reduce((a, x) => Math.max(a, x.id), 0) + 1) throw new Error('bad htlc id'); add(sender, -h.amount); s.htlcs.push({ id: h.id, from: sender, amount: h.amount, hash: h.hash, expiry: h.expiry, route: h.route ?? null }); }
    else if (m.kind === 'settle') { const i = s.htlcs.findIndex((h) => h.id === m.htlcId); if (i < 0) throw new Error('no such htlc'); const h = s.htlcs[i]; if (h.from === sender) throw new Error('the offerer cannot settle'); if (!/^[0-9a-f]{64}$/.test(m.preimage ?? '') || sha(m.preimage) !== h.hash) throw new Error('wrong preimage'); s.htlcs.splice(i, 1); add(sender, h.amount); }
    else if (m.kind === 'fail') { const i = s.htlcs.findIndex((h) => h.id === m.htlcId); if (i < 0) throw new Error('no such htlc'); const h = s.htlcs[i]; if (h.from === sender && io.height() < h.expiry) throw new Error('the offerer may fail only after the expiry'); s.htlcs.splice(i, 1); add(h.from, h.amount); }
    else throw new Error('unknown update kind');
    if (s.balA < 0 || s.balB < 0) throw new Error('a balance would go negative'); if (sender === 'a' && s.balA < fee && s.balA !== 0) throw new Error('the funder must keep its fee'); return s; }

  // ---- an update from me: the new state, my signature on their commitment for it, their next revocation key known ahead
  async function update(ch, m) { if (ch.status !== 'open') throw new Error('the channel is not open'); if (ch.pending) throw new Error('an update is already pending'); if (!ch.theirRevPub[ch.n + 1]) throw new Error('their next revocation key is not known yet');
    const n1 = ch.n + 1; const s = nextState(ch, st(ch, ch.n), m, me(ch)); ch.states[n1] = s; ensureMyRev(ch, n1); ensureMyRev(ch, n1 + 1);
    const sig = C.signFunding(ch, theirCommitAt(ch, n1).tx, key); ch.pending = { n: n1, m, at: now() }; save();
    await send(ch, { t: 'update', id: ch.id, n: n1, ...m, sig, nextRev: ch.myRevPub[n1 + 1] }); }
  const pay = (ch, amount, memo = null) => { if (amount > room(ch)) throw new Error(`at most ${Math.max(0, room(ch))} sat`); return update(ch, { kind: 'pay', amount, memo }); };
  const addHtlc = (ch, { amount, hash: h, expiry, route = null, memo = null }) => { if (amount > room(ch)) throw new Error(`at most ${Math.max(0, room(ch))} sat`); const id = (st(ch, ch.n).htlcs ?? []).reduce((a, x) => Math.max(a, x.id), 0) + 1; return update(ch, { kind: 'add', htlc: { id, amount, hash: h, expiry, route }, memo }); };
  const settleHtlc = (ch, htlcId, preimage) => update(ch, { kind: 'settle', htlcId, preimage });
  const failHtlc = (ch, htlcId, reason = null) => update(ch, { kind: 'fail', htlcId, reason });

  // ---- messages from the other side
  async function onMessage(from, m) {
    if (m.t === 'open') { if (byId(m.id) || m.b !== pub || m.a !== from) return; if (!(m.funding?.value >= 10000) || !(m.delay >= 1) || !(m.fee >= 100) || !Array.isArray(m.rev) || m.rev.length !== 2 || !((m.push ?? 0) >= 0)) return log(`open from ${from.slice(0, 12)}… refused: bad terms`, 'e');
      if (io.acceptOpen && !io.acceptOpen(from, m)) return log(`open from ${from.slice(0, 12)}… declined`, 'e');
      const f = C.fundingScript(m.a, m.b); const push = m.push ?? 0;
      const ch = { id: m.id, role: 'b', peer: from, keys: { a: m.a, b: m.b }, funding: { txid: m.funding.txid, vout: m.funding.vout, value: m.funding.value, ...f }, delay: m.delay, fee: m.fee, n: 0, states: [{ balA: m.funding.value - push, balB: push, htlcs: [] }], myRev: {}, myRevPub: {}, theirRev: {}, theirRevPub: { 0: m.rev[0], 1: m.rev[1] }, sigs: {}, status: 'accepted', at: now(), pending: null, nextHtlc: 1, preimages: {} };
      ensureMyRev(ch, 0); ensureMyRev(ch, 1); const sig = C.signFunding(ch, theirCommitAt(ch, 0).tx, key); CH.push(ch); save();
      await send(ch, { t: 'accept', id: ch.id, rev: [ch.myRevPub[0], ch.myRevPub[1]], sig }); log(`channel ${ch.id} from ${from.slice(0, 12)}…: ${m.funding.value} sat${push ? `, ${push} pushed to me` : ''}; accepted`); io.notify?.('Channel offered', `${m.funding.value} sat from ${from.slice(0, 12)}…`); return; }
    const ch = byId(m.id); if (!ch || ch.peer !== from) return;
    if (m.t === 'accept' && ch.role === 'a' && ch.status === 'proposed') { ch.theirRevPub[0] = m.rev[0]; ch.theirRevPub[1] = m.rev[1]; if (!C.verifyFunding(ch, myCommitAt(ch, 0).tx, ch.peer, m.sig)) return log(`accept for ${ch.id}: their signature does not verify`, 'e');
      ch.sigs[0] = m.sig; const sig = C.signFunding(ch, theirCommitAt(ch, 0).tx, key); ch.status = 'funding'; save(); await send(ch, { t: 'commit', id: ch.id, sig }); await io.broadcast(ch.funding.hex, `funding of ${ch.id}`); log(`channel ${ch.id}: accepted; funding published`); return; }
    if (m.t === 'commit' && ch.role === 'b' && ch.status === 'accepted') { if (!C.verifyFunding(ch, myCommitAt(ch, 0).tx, ch.peer, m.sig)) return log(`commit for ${ch.id}: their signature does not verify`, 'e'); ch.sigs[0] = m.sig; ch.status = 'funding'; save(); log(`channel ${ch.id}: my first commitment is signed; waiting for the funding`); return; }
    if (m.t === 'update') { if (ch.status !== 'open') return; if (m.n !== ch.n + 1) return log(`update for ${ch.id} at state ${m.n}, expected ${ch.n + 1}`, 'e'); if (ch.pending) return log(`update for ${ch.id} while mine is pending; ignored`, 'e');
      let s; try { s = nextState(ch, st(ch, ch.n), m, them(ch)); } catch (e) { return log(`update for ${ch.id} refused: ${e.message}`, 'e'); }
      ch.states[m.n] = s; ch.theirRevPub[m.n + 1] = m.nextRev; ensureMyRev(ch, m.n + 1);
      if (!C.verifyFunding(ch, myCommitAt(ch, m.n).tx, ch.peer, m.sig)) { delete ch.states[m.n]; return log(`update for ${ch.id}: their signature on my new commitment does not verify`, 'e'); }
      ch.sigs[m.n] = m.sig; const sig = C.signFunding(ch, theirCommitAt(ch, m.n).tx, key); const reveal = ch.myRev[ch.n]; const prev = ch.n; ch.n = m.n; save();
      await send(ch, { t: 'ack', id: ch.id, n: m.n, sig, reveal, nextRev: ch.myRevPub[m.n + 1] });
      const gain = bal(ch, me(ch), m.n) - bal(ch, me(ch), prev); log(`channel ${ch.id}: ${m.kind}${m.kind === 'pay' ? ` ${m.amount} sat received` : m.kind === 'add' ? ` htlc ${m.htlc.id} of ${m.htlc.amount} sat, hash ${m.htlc.hash.slice(0, 12)}…` : ` htlc ${m.htlcId}`}${m.memo ? ` "${m.memo}"` : ''}; state ${m.n}`);
      if (m.kind === 'pay') io.notify?.('Payment received', `${m.amount} sat on ${ch.id}${m.memo ? ` · ${m.memo}` : ''}`); if (m.kind === 'settle' && gain > 0) io.notify?.('Payment received', `${gain} sat on ${ch.id} (htlc settled)`);
      await io.onUpdate?.(ch, m, them(ch)); return; }
    if (m.t === 'ack') { const p = ch.pending; if (!p || m.n !== p.n) return; if (!C.verifyFunding(ch, myCommitAt(ch, p.n).tx, ch.peer, m.sig)) return log(`ack for ${ch.id}: their signature does not verify`, 'e');
      if (signer.pubkeyOf(m.reveal) !== ch.theirRevPub[ch.n]) return log(`ack for ${ch.id}: the revealed secret is not state ${ch.n}'s`, 'e');
      ch.theirRev[ch.n] = m.reveal; ch.theirRevPub[p.n + 1] = m.nextRev; ch.sigs[p.n] = m.sig; const reveal = ch.myRev[ch.n]; ch.n = p.n; ch.pending = null; ensureMyRev(ch, p.n + 1); save(); await send(ch, { t: 'revoke', id: ch.id, n: p.n, reveal });
      log(`channel ${ch.id}: my ${p.m.kind}${p.m.kind === 'pay' ? ` of ${p.m.amount} sat` : p.m.kind === 'add' ? ` of htlc ${p.m.htlc.id} (${p.m.htlc.amount} sat)` : ` of htlc ${p.m.htlcId}`} acknowledged; state ${p.n}`); await io.onAcked?.(ch, p.m); return; }
    if (m.t === 'revoke') { if (m.n !== ch.n) return; if (signer.pubkeyOf(m.reveal) !== ch.theirRevPub[ch.n - 1]) return log(`revoke for ${ch.id}: not state ${ch.n - 1}'s secret`, 'e'); ch.theirRev[ch.n - 1] = m.reveal; save(); return; }
    if (m.t === 'close') { if (!['open', 'funding'].includes(ch.status)) return; let tx; try { tx = C.closingTx(ch, fullState(ch, ch.n)); } catch (e) { return log(`close for ${ch.id} refused: ${e.message}`, 'e'); } if (!C.verifyFunding(ch, tx, ch.peer, m.sig)) return log(`close for ${ch.id}: their signature does not verify`, 'e');
      tx.witness = [C.fundingWitness(ch, { [ch.peer]: m.sig, [pub]: C.signFunding(ch, tx, key) })]; const v = C.verifyTx(tx, [C.fundingPrevout(ch)]); if (!v.ok) return log(`close for ${ch.id}: the closing transaction fails: ${v.error}`, 'e');
      ch.status = 'closing'; ch.closeTxid = C.txid(tx); save(); await io.broadcast(C.encode(tx), `cooperative close of ${ch.id}`); log(`channel ${ch.id}: closing cooperatively at state ${ch.n}, ${myBal(ch)} sat to me`); return; }
    if (m.t === 'sync') { await send(ch, { t: 'synced', id: ch.id, n: ch.n, status: ch.status }); return; }
    if (m.t === 'synced') { if (m.n > ch.n && ch.pending) log(`channel ${ch.id}: they are at state ${m.n}, I am at ${ch.n} with an update pending; the pending update is dropped`, 'e'); if (m.n > ch.n && ch.pending) { delete ch.states[ch.pending.n]; ch.pending = null; save(); } return; } }

  // ---- closing
  async function closeChannel(ch) { if (!['open', 'funding'].includes(ch.status)) throw new Error('not open'); const tx = C.closingTx(ch, fullState(ch, ch.n)); const sig = C.signFunding(ch, tx, key); ch.status = 'closing-asked'; ch.closeTxid = C.txid(tx); save(); await send(ch, { t: 'close', id: ch.id, n: ch.n, sig }); log(`channel ${ch.id}: cooperative close asked at state ${ch.n}`); }
  async function forceClose(ch, i = ch.n, why = 'forced') { const c = myCommitAt(ch, i); if (!ch.sigs[i]) throw new Error(`state ${i} was never signed by them`); c.tx.witness = [C.fundingWitness(ch, { [pub]: C.signFunding(ch, c.tx, key), [ch.peer]: ch.sigs[i] })]; const v = C.verifyTx(c.tx, [C.fundingPrevout(ch)]); if (!v.ok) throw new Error(`my commitment fails: ${v.error}`);
    ch.status = 'force-closing'; ch.closeTxid = C.txid(c.tx); ch.closeState = i; save(); await io.broadcast(C.encode(c.tx), `${why} close of ${ch.id} at state ${i}`); log(`channel ${ch.id}: ${why} close published, my commitment ${ch.closeTxid.slice(0, 16)}… at state ${i}${i < ch.n ? ' (AN OLD STATE)' : ''}`, i < ch.n ? 'e' : ''); }

  // ---- the funding output was spent: classify, then answer (sweeps after the delay, claims, the penalty)
  async function onSpend(ch, spend) { if (ch.spentBy?.txid === spend.txid) return afterClose(ch); ch.spentBy = spend;
    if (ch.closeTxid === spend.txid && (ch.status === 'closing' || ch.status === 'closing-asked')) { ch.status = 'closed'; save(); io.notify?.('Channel closed', `${ch.id} settled cooperatively at block ${spend.height}`); return; }
    if (ch.closeTxid === spend.txid && ch.status === 'force-closing') { ch.status = 'closed-mine'; save(); log(`channel ${ch.id}: my commitment is in block ${spend.height}; my outputs can be claimed after ${ch.delay} blocks`); return afterClose(ch); }
    for (let i = 0; i <= ch.n; i++) { const t = theirCommitAt(ch, i); if (C.txid(t.tx) !== spend.txid) continue;
      if (i === ch.n) { ch.status = 'closed-theirs'; ch.closeState = i; save(); io.notify?.('Channel closed by the other side', `${ch.id} at state ${i}, block ${spend.height}`); return afterClose(ch); }
      const secret = ch.theirRev[i]; if (!secret) { ch.status = 'closed-theirs-old'; save(); return log(`channel ${ch.id}: they closed at old state ${i} but I hold no secret for it`, 'e'); }
      const claims = []; const vl = t.kinds.indexOf('to_local'); if (vl >= 0) claims.push(C.sweepTx({ commit: t, txid: spend.txid, vout: vl, value: t.tx.outputs[vl].value, to: io.myScript, fee, delayed: 0, key: secret }));
      for (const h of t.htlcs) claims.push(C.htlcClaim({ commit: t, htlc: h, kind: 'revocation', txid: spend.txid, value: h.amount, to: io.myScript, fee, key: secret }));
      ch.status = 'punishing'; ch.penalties = claims.map((tx) => C.txid(tx)); save(); for (const tx of claims) await io.broadcast(C.encode(tx), `penalty on ${ch.id} (their revoked state ${i})`); io.notify?.('Cheat punished', `${ch.id}: they published revoked state ${i}; ${claims.length} penalty transaction(s) sent`); return; }
    ch.status = 'spent-unknown'; save(); log(`channel ${ch.id}: the funding was spent by ${spend.txid.slice(0, 16)}… which is none of the transactions I know`, 'e'); }
  // after a close by either side's commitment: claim what is mine when it can be claimed
  async function afterClose(ch) { if (!['closed-mine', 'closed-theirs'].includes(ch.status) || !ch.spentBy) return; const mine = ch.status === 'closed-mine'; const c = mine ? myCommitAt(ch, ch.closeState ?? ch.n) : theirCommitAt(ch, ch.closeState ?? ch.n); const conf = io.height() - ch.spentBy.height + 1; ch.claimed ??= {}; let left = 0;
    const claim = async (name, build) => { if (ch.claimed[name]) return; const tx = build(); const prev = [{ value: tx._value, scriptPubKey: tx._spk }]; delete tx._value; delete tx._spk; const v = C.verifyTx(tx, prev); if (!v.ok) return log(`${name} on ${ch.id} fails: ${v.error}`, 'e'); ch.claimed[name] = C.txid(tx); save(); await io.broadcast(C.encode(tx), `${name} on ${ch.id}`); };
    if (mine) { const vl = c.kinds.indexOf('to_local'); if (vl >= 0) { if (conf >= ch.delay) await claim('sweep of to_local', () => Object.assign(C.sweepTx({ commit: c, txid: ch.closeTxid, vout: vl, value: c.tx.outputs[vl].value, to: io.myScript, fee, delayed: ch.delay, key }), { _value: c.tx.outputs[vl].value, _spk: c.toLocal.spk })); else left++; } }
    for (const h of c.htlcs) { const preimage = ch.preimages?.[h.hash]; const iOffered = h.from === me(ch); const csv = mine ? (iOffered ? 'timeout' : 'success') : null; // on my commitment my claims wait the delay
      if (!iOffered && preimage) { if (mine && conf < ch.delay) { left++; continue; } await claim(`claim of htlc ${h.id} with the preimage`, () => Object.assign(C.htlcClaim({ commit: c, htlc: h, kind: 'success', txid: ch.spentBy.txid, value: h.amount, to: io.myScript, fee, key, preimage }), { _value: h.amount, _spk: h.scripts.spk })); }
      else if (iOffered && io.height() >= h.expiry) { if (mine && conf < ch.delay) { left++; continue; } await claim(`refund of htlc ${h.id} after its expiry`, () => Object.assign(C.htlcClaim({ commit: c, htlc: h, kind: 'timeout', txid: ch.spentBy.txid, value: h.amount, to: io.myScript, fee, key }), { _value: h.amount, _spk: h.scripts.spk })); }
      else if (iOffered) left++; }
    if (!left) { ch.status = 'closed'; save(); io.notify?.('Channel settled', `${ch.id}: everything of mine is claimed`); } }

  return { channels: CH, byId, me, them, myBal, theirBal, room, fullState, myCommitAt, theirCommitAt, openChannel, onMessage, pay, addHtlc, settleHtlc, failHtlc, closeChannel, forceClose, onSpend, afterClose, sha, hubFee,
    invoice: (amount, memo, hops = []) => { const preimage = signer.randomKey(); const h = sha(preimage); return { preimage, inv: { p: pub, a: amount, m: memo || undefined, h, r: hops, f: hubFee, i: h.slice(0, 16) } }; },
    sync: (ch) => send(ch, { t: 'sync', id: ch.id, n: ch.n }) };
}
