// Hostile and unlucky inputs against the protocol: malformed messages, expiry games, a double-signed state, a reordered
// revoke, a sync storm, a hub restart in the middle of a forward, a forced close with an HTLC in flight, a failed broadcast.
import { homedir } from 'node:os';
const H = (p) => p.replace(/^~/, homedir());
const SCHEMA = H(process.env.SCHEMA ?? '~/bitcoin-desktop/schema'), BTN = H(process.env.BLAKETESTNODE ?? '~/remote/github.com/bitcoin-blake/blaketestnode'), LIB = H(process.env.SIDESTR_LIB ?? '~/remote/github.com/sidestr/spec/siding/lib');
const [{ loadEngine }, hash, secp, { makeSigner }, { makeChannels }, { makePeer, EXPIRY_MARGIN }, { makeRouter }] = await Promise.all([import(`${BTN}/lib/engine.mjs`), import(`${SCHEMA}/codec/hash.js`), import(`${SCHEMA}/codec/secp256k1.js`), import(`${LIB}/schnorr.mjs`), import('../lib/channel.mjs'), import('../lib/peer.mjs'), import('../lib/route.mjs')]);
const k = await loadEngine('btc:testnet4-blake2b'); const signer = makeSigner({ hash, secp }); const C = makeChannels({ k, hash, secp, signer });
let ok = 0, bad = 0; const t = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`); cond ? ok++ : bad++; };
const chain = { height: 152100, broadcasts: [], refuse: false, spent: new Map(), mine() { for (const b of this.broadcasts) { let tx; try { tx = C.decode(b.hex); } catch { continue; } for (const i of tx.inputs) this.spent.set(`${i.prevout.txid}:${i.prevout.vout}`, { txid: C.txid(tx), height: this.height, hex: b.hex }); } } }; const inbox = []; const peers = {}; let seq = 0;
const settle = async () => { for (let i = 0; i < 12; i++) { await pump(); await new Promise((r) => setTimeout(r, 40)); } };
function host(name, { hub = false, fee = 300, delay = 6, minDelay = 3 } = {}, restore = null) { const key = restore?.key ?? hash.bytesToHex(hash.sha256(new TextEncoder().encode('hitch-test-' + name))), pub = signer.pubkeyOf(key); const channels = restore ? JSON.parse(JSON.stringify(restore.channels)) : []; const invoices = restore?.invoices ?? new Map(); const notes = [];
  const io = { myScript: '5120' + pub, height: () => chain.height, save: () => (io.saveFails ? false : true), findSpend: async (ch, { txid, vout }) => chain.spent.get(`${txid}:${vout}`) ?? null, invoiceFor: (h) => invoices.get(h) ?? null, log: (s, c) => { if (process.env.VERBOSE || (c === 'e' && process.env.ERRS)) console.log(`    [${name}] ${s}`); }, notify: (t, b) => { notes.push(`${t}: ${b}`); },
    send: async (ch, body) => { inbox.push({ to: ch.peer, from: pub, body: JSON.parse(JSON.stringify(body)) }); return 1; }, broadcast: async (hex, what) => { if (chain.refuse) return 0; chain.broadcasts.push({ from: name, hex, what }); return 1; },
    buildFunding: async () => { const txid = hash.bytesToHex(hash.sha256(new TextEncoder().encode(name + (++seq)))); return { txid, vout: 0, hex: '00' }; } };
  const peer = makePeer({ C, signer, hash, pub, key, channels, io, opts: { delay, fee, hubFee: 10, pendingTimeout: 0, hub, minDelay } }); const router = makeRouter({ peer, io, invoices, hub, retryMs: 30 }); const bg = (f) => (...a) => { f(...a).catch((e) => io.log(`router: ${e.message}`, 'e')); }; io.onUpdate = bg(router.onUpdate); io.onDropped = bg(router.onDropped); io.onPreimage = bg(router.onPreimage);
  return peers[pub] = { name, pub, key, peer, invoices, channels, io, router, notes }; }
async function pump(limit = 200) { let guard = 0; while (inbox.length && guard++ < limit) { const m = inbox.shift(); await peers[m.to].peer.onMessage(m.from, m.body); } return guard; }
const confirm = (id) => { for (const p of Object.values(peers)) for (const c of p.channels) if (c.id === id && c.status === 'funding') { c.status = 'open'; c.fundedHeight = chain.height; } };
const snapshot = (p) => JSON.stringify(p.channels);
const A = host('A'), HUB = host('hub', { hub: true }), B = host('B');
const chA = await A.peer.openChannel(HUB.pub, 100000); await pump(); confirm(chA.id); const hubA = HUB.channels.find((c) => c.id === chA.id);

// ---- malformed and hostile messages leave nothing behind
const before = snapshot(HUB);
const evil = [{ t: 'open', id: 'zz', funding: {} }, null, 1, 'x', [], { t: 'update', id: chA.id, n: 2, kind: 'pay', amount: 1.5, sig: 'ab', nextRev: 'x' }, { t: 'update', id: chA.id, n: 2, kind: 'add', htlc: { id: 1, amount: 5000, hash: 'zz', expiry: 1 }, sig: 'ab'.repeat(65), nextRev: 'ab'.repeat(32) },
  { t: 'open', id: '0'.repeat(16), funding: { txid: '0'.repeat(64), vout: 0, value: 100000 }, push: 0, delay: 2 ** 31, fee: 300, a: A.pub, b: HUB.pub, rev: ['ab'.repeat(32), 'cd'.repeat(32)] }, { t: 'open', id: '1'.repeat(16), funding: { txid: '1'.repeat(64), vout: 0, value: 100000 }, push: 0, delay: 1, fee: 300, a: A.pub, b: HUB.pub, rev: ['ab'.repeat(32), 'cd'.repeat(32)] },
  { t: 'ack', id: chA.id, n: 1, sig: 'ab'.repeat(65), reveal: 'zz', nextRev: 'ab'.repeat(32) }, { t: 'revoke', id: chA.id, n: 1, reveal: 'ab'.repeat(32) }, { t: 'sync', id: chA.id, n: 999, status: 'open', pendingN: 5 }, { t: 'close', id: chA.id, n: 7, sig: 'ab'.repeat(65) }];
let threw = 0; for (const m of evil) { try { await HUB.peer.onMessage(A.pub, m); } catch { threw++; } }
t(`${evil.length} malformed or hostile messages are dropped without an exception and without touching the channel`, threw === 0 && snapshot(HUB) === before && HUB.channels.length === 1, `threw ${threw}, changed ${snapshot(HUB) !== before}`);
t('a well-formed message from the wrong sender is ignored', (await HUB.peer.onMessage(B.pub, { t: 'sync', id: chA.id, n: 0, status: 'open' }), snapshot(HUB) === before));
t('the delay floor and the integer rule are enforced at the boundary', HUB.peer.wellFormed({ t: 'open', id: '0'.repeat(16), funding: { txid: '0'.repeat(64), vout: 0, value: 100000.5 }, push: 0, delay: 6, fee: 300, a: A.pub, b: HUB.pub, rev: ['ab'.repeat(32), 'cd'.repeat(32)] }) != null && HUB.peer.wellFormed({ t: 'update', id: chA.id, n: 1, kind: 'pay', amount: 10, sig: 'ab'.repeat(65), nextRev: 'ab'.repeat(32), memo: 'x'.repeat(200) }) != null);

// ---- a payment is final only on the payer's revoke; a withheld revoke blocks further updates both ways
inbox.length = 0; await A.peer.pay(chA, 1000); { const upd = inbox.shift(); await HUB.peer.onMessage(upd.from, upd.body); const ack = inbox.shift(); await A.peer.onMessage(ack.from, ack.body); inbox.length = 0; }
let blocked = false; try { await HUB.peer.pay(hubA, 10); } catch (e) { blocked = /revocation/.test(e.message); }
t('without the payer\'s revoke the receiver holds state 1 signed but not final, and refuses to move on', hubA.n === 1 && hubA.awaiting?.n === 1 && blocked, `n ${hubA.n} awaiting ${JSON.stringify(hubA.awaiting?.n)} blocked ${blocked}`);
await A.peer.resyncAll(true); await pump();
t('the payer\'s resync carries the secret; the state becomes final and updates flow again', !hubA.awaiting && !!hubA.theirRev[0] && (await HUB.peer.pay(hubA, 10), await pump(), hubA.n === 2 && chA.n === 2));

// ---- the double-signed state: a collision loser's signature is tracked and punished once that state number is revoked
await A.peer.pay(chA, 100); await HUB.peer.pay(hubA, 200); await pump(); const loser = A.pub < HUB.pub ? HUB : A; const loserCh = loser === A ? chA : hubA; const winner = loser === A ? HUB : A; const winnerCh = loser === A ? hubA : chA;
const alt = loserCh.signedAlt?.[3]?.[0];
t('the loser remembers the alternative state 3 it signed for the winner', !!alt && chA.n === 3 && hubA.n === 3);
{ const altTx = loser.peer.theirCommitAt(loserCh, 3, alt);
  await loser.peer.onSpend(loserCh, { txid: C.txid(altTx.tx), height: chain.height + 1, hex: '' });
  t('if the winner publishes that alternative before revoking state 3, the loser accepts it as a close it had signed', ['closed-theirs-alt', 'closed'].includes(loserCh.status) && loserCh.closeState === 3 && loserCh.closeStateObj === alt, `status ${loserCh.status} closeState ${loserCh.closeState}`); loserCh.status = 'open'; loserCh.spentBy = null;
  await winner.peer.pay(winnerCh, 50); await pump(); const nB = chain.broadcasts.length; await loser.peer.onSpend(loserCh, { txid: C.txid(altTx.tx), height: chain.height + 1, hex: '' });
  t('once state 3 is revoked the same alternative is punished with the penalty', loserCh.status === 'punishing' && chain.broadcasts.length === nB + 1 && !!loserCh.theirRev[3]); loserCh.status = 'open'; loserCh.spentBy = null; }

// ---- HTLC expiry rules: settle refused after the expiry, fail refused while the receiver holds the preimage
const chB = await B.peer.openChannel(HUB.pub, 100000, 50000); await pump(); confirm(chB.id); const hubB = HUB.channels.find((c) => c.id === chB.id);
const { preimage, inv } = B.peer.invoice(5000, 'x', [HUB.pub]); B.invoices.set(inv.h, { preimage, amount: 5000 });
await A.peer.addHtlc(chA, { amount: 5010, hash: inv.h, expiry: chain.height + 60, route: { to: B.pub } }); await pump(); await settle();
t('a routed payment with the new finality still settles end to end', chB.states[chB.n].balA === 55000 && chA.states[chA.n].htlcs.length === 0);
const { preimage: p2, inv: i2 } = B.peer.invoice(5000, 'late', [HUB.pub]); B.invoices.set(i2.h, { preimage: p2, amount: 5000 });
await A.peer.addHtlc(chA, { amount: 5010, hash: i2.h, expiry: chain.height + 60, route: { to: B.pub } }); { const upd = inbox.shift(); await HUB.peer.onMessage(upd.from, upd.body); const ack = inbox.shift(); await A.peer.onMessage(ack.from, ack.body); const rev = inbox.shift(); await HUB.peer.onMessage(rev.from, rev.body); }
// the hub has forwarded to B (pending in the inbox); B is offline: drain B's messages so it never answers
inbox.splice(0, inbox.length);
const hubDown = hubB; t('the hub forwarded the HTLC downstream and holds it against the upstream one', hubDown.pending?.m.kind === 'add' && hubA.states[hubA.n].htlcs.some((h) => h.hash === i2.h));
chain.height += 65; let failed = null; try { await A.peer.failHtlc(chA, hubA.states[hubA.n].htlcs.find((h) => h.hash === i2.h).id, 'expired'); await pump(); } catch (e) { failed = e.message; }
t('after the expiry the offerer can fail the upstream HTLC when the hub has no preimage, and the amount returns', failed === null && hubA.states[hubA.n].htlcs.every((h) => h.hash !== i2.h) && chA.states[chA.n].balA === chA.states[chA.n - 1].balA + 5010);
{ const late = B.channels.find((c) => c.id === chB.id); let refused = null; hubDown.pending = null; delete hubDown.states[hubDown.n + 1]; // the hub's forward never reached B: pretend it did and B settles late
  hubDown.states[hubDown.n].htlcs.push({ id: 9, from: 'b', amount: 5000, hash: i2.h, expiry: chain.height - 1, route: null }); late.states[late.n].htlcs = hubDown.states[hubDown.n].htlcs.map((h) => ({ ...h }));
  try { await B.peer.settleHtlc(late, 9, p2); await pump(); } catch (e) { refused = e.message; } t('a settle after the expiry is refused on the sender side', /expired/.test(refused ?? '')); hubDown.states[hubDown.n].htlcs.pop(); late.states[late.n].htlcs.pop(); }

// ---- the receiver of an HTLC who knows the preimage refuses a fail from the offerer
{ const { preimage: p3, inv: i3 } = HUB.peer.invoice(2000, 'direct', []); HUB.invoices.set(i3.h, { preimage: p3, amount: 2000 });
  await A.peer.addHtlc(chA, { amount: 2000, hash: i3.h, expiry: chain.height + 40, route: null }); { const upd = inbox.shift(); await HUB.peer.onMessage(upd.from, upd.body); const ack = inbox.shift(); await A.peer.onMessage(ack.from, ack.body); const rev = inbox.shift(); await HUB.peer.onMessage(rev.from, rev.body); inbox.splice(0, inbox.length); }
  const id = hubA.states[hubA.n].htlcs.find((h) => h.hash === i3.h).id; chain.height += 65; const s0 = snapshot(HUB); const failMsg = { t: 'update', id: chA.id, n: hubA.n + 1, kind: 'fail', htlcId: id, sig: 'ab'.repeat(65), nextRev: 'ab'.repeat(32) };
  await HUB.peer.onMessage(A.pub, failMsg); t('a fail for an HTLC whose preimage the receiver holds is refused, even after the expiry', snapshot(HUB) === s0 && hubA.states[hubA.n].htlcs.some((h) => h.id === id)); }

// ---- a hub restart between the forward and the settle: the forward is on the channel document, so the settle still comes back
{ const chB2 = B.channels.find((c) => c.id === chB.id); const { preimage: p4, inv: i4 } = B.peer.invoice(3000, 'restart', [HUB.pub]); B.invoices.set(i4.h, { preimage: p4, amount: 3000 }); chain.height -= 130;
  // clean slate on A–hub: settle the stuck direct HTLC first
  await HUB.peer.tick(); await pump(); // the hub's own settle of the direct HTLC was pending; the tick sends it again
  await A.peer.addHtlc(chA, { amount: 3010, hash: i4.h, expiry: chain.height + 60, route: { to: B.pub } }); { const upd = inbox.shift(); await HUB.peer.onMessage(upd.from, upd.body); const ack = inbox.shift(); await A.peer.onMessage(ack.from, ack.body); const rev = inbox.shift(); await HUB.peer.onMessage(rev.from, rev.body); }
  const fwd = inbox.find((m) => m.body.t === 'update' && m.body.kind === 'add'); t('the hub forwarded downstream before the restart', !!fwd);
  const HUB2 = host('hub2', { hub: true }, { key: HUB.key, channels: HUB.channels, invoices: HUB.invoices }); peers[HUB.pub] = HUB2; // the same node, restarted from its file
  await pump(); await settle();
  const hub2A = HUB2.channels.find((c) => c.id === chA.id), hub2B = HUB2.channels.find((c) => c.id === chB.id);
  t('after the restart the downstream settle is carried upstream: B is paid, the hub keeps its fee, A\'s HTLC is gone', chB2.states[chB2.n].balA === 55000 + 3000 && hub2A.states[hub2A.n].htlcs.length === 0 && hub2A.states[hub2A.n].balB === hubA.states[hubA.n].balB + 3010); }

// ---- a forced close with an HTLC in flight: the receiver claims with the preimage on the chain
{ const HUB3 = peers[HUB.pub]; const hub3A = HUB3.channels.find((c) => c.id === chA.id); const chA2 = A.channels.find((c) => c.id === chA.id);
  const { preimage: p5, inv: i5 } = HUB3.peer.invoice(2500, 'onchain', []); HUB3.invoices.set(i5.h, { preimage: p5, amount: 2500 });
  await A.peer.addHtlc(chA2, { amount: 2500, hash: i5.h, expiry: chain.height + 40, route: null }); { const upd = inbox.shift(); await HUB3.peer.onMessage(upd.from, upd.body); const ack = inbox.shift(); await A.peer.onMessage(ack.from, ack.body); const rev = inbox.shift(); await HUB3.peer.onMessage(rev.from, rev.body); inbox.splice(0, inbox.length); }
  // A force-closes with the HTLC in flight; the hub, holding the preimage, claims the HTLC output at once from A's commitment
  await A.peer.forceClose(chA2); const fc = C.decode(chain.broadcasts.at(-1).hex); const nB = chain.broadcasts.length;
  await HUB3.peer.onSpend(hub3A, { txid: C.txid(fc), height: chain.height, hex: '' });
  const claim = chain.broadcasts.slice(nB).find((b) => /claim of htlc/.test(b.what)); const my = HUB3.peer.theirCommitAt(hub3A, hub3A.n); const h = my.htlcs[0];
  t('the receiver claims the in-flight HTLC with the preimage from the closer\'s commitment, and the claim verifies', !!claim && C.verifyTx(C.decode(claim.hex), [{ value: h.amount, scriptPubKey: h.scripts.spk }]).ok === true);
  // the same close seen by A: its to_local waits the delay; A must not think the channel is settled while the HTLC is unresolved by it
  await A.peer.onSpend(chA2, { txid: C.txid(fc), height: chain.height, hex: '' }); chain.height += 6; await A.peer.afterClose(chA2);
  t('the closer sweeps its to_local after the delay and, its HTLC unresolved, does not call the channel settled', chA2.claimed?.['sweep of to_local'] && chA2.status === 'closed-mine', `claimed ${JSON.stringify(chA2.claimed)} status ${chA2.status} spentBy ${chA2.spentBy?.txid?.slice(0, 8)} unsent ${chA2.unsent?.length}`); }

// ---- a failed broadcast is kept and sent again
{ const chX = await A.peer.openChannel(HUB.pub, 20000); await pump(); confirm(chX.id); await A.peer.pay(chX, 100); await pump();
  chain.refuse = true; await A.peer.forceClose(chX); t('a close that reached no relay is kept as unsent', chX.unsent?.length === 1 && chX.status === 'force-closing'); chain.refuse = false; const nB = chain.broadcasts.length; await A.peer.tick();
  t('the next tick sends it', chain.broadcasts.length === nB + 1 && chX.unsent.length === 0); }

// ---- peers with different fee settings agree, because the channel's fee is the one that counts
{ const Z = host('Z', { fee: 900 }); const chZ = await A.peer.openChannel(Z.pub, 20000); await pump(); confirm(chZ.id); const zCh = Z.channels[0];
  await A.peer.pay(chZ, 19000); await pump(); t('a state leaving the funder between the two peers\' fee settings is accepted by both, since ch.fee rules', chZ.n === 1 && zCh.n === 1 && zCh.states[1].balA === 1000); }

// ---- a sync exchange terminates
{ const n0 = inbox.length; await A.peer.resync(chA, true); const msgs = await pump(50); t('a resync is a bounded exchange, not a storm', msgs < 6, `${msgs} messages`); }
// ================= round two =================
// ---- the two-party revocation key on a live channel: the owner's own per-state secret does not open its commitment's revocation leaf
{ const c = A.peer.myCommitAt(chA, chA.n); const vl = c.kinds.indexOf('to_local'); const prev = [{ value: c.tx.outputs[vl].value, scriptPubKey: c.toLocal.spk }];
  const own = C.sweepTx({ commit: c, txid: C.txid(c.tx), vout: vl, value: c.tx.outputs[vl].value, to: '5120' + A.pub, fee: 300, delayed: 0, key: chA.myRev[chA.n] });
  const chan = C.sweepTx({ commit: c, txid: C.txid(c.tx), vout: vl, value: c.tx.outputs[vl].value, to: '5120' + A.pub, fee: 300, delayed: 0, key: A.key });
  t('the owner cannot take its own to_local at once: neither its per-state secret nor its channel key opens the revocation leaf', C.verifyTx(own, prev).ok === false && C.verifyTx(chan, prev).ok === false); }

// ---- a revoked state carrying an HTLC: the penalty takes the to_local and the HTLC output, and the channel ends punished once they confirm
{ const P = host('P'), Q = host('Q'); const chP = await P.peer.openChannel(Q.pub, 100000, 30000); await pump(); confirm(chP.id); const chQ = Q.channels[0];
  const { preimage: pp, inv: ii } = Q.peer.invoice(4000, 'h', []); Q.invoices.set(ii.h, { preimage: pp, amount: 4000 });
  await P.peer.addHtlc(chP, { amount: 4000, hash: ii.h, expiry: chain.height + 40, route: null }); await settle();
  t('the HTLC was added at state 1 and settled at state 2; state 1 is revoked both ways', chP.n === 2 && chQ.n === 2 && !!chQ.theirRev[1] && !!chP.theirRev[1] && chQ.states[2].balB === 34000);
  const old = P.peer.myCommitAt(chP, 1); old.tx.witness = [C.fundingWitness(chP, { [P.pub]: C.signFunding(chP, old.tx, P.key), [Q.pub]: chP.sigs[1] })];
  t('the revoked commitment carries the HTLC output and would be accepted by the chain', old.kinds.includes('htlc') && C.verifyTx(old.tx, [C.fundingPrevout(chP)]).ok === true);
  const nB = chain.broadcasts.length; await Q.peer.onSpend(chQ, { txid: C.txid(old.tx), height: chain.height, hex: C.encode(old.tx) });
  const pens = chain.broadcasts.slice(nB).map((b) => C.decode(b.hex));
  t('two penalties go out, on the to_local and on the HTLC output, and both verify under the interpreter', chQ.status === 'punishing' && pens.length === 2 && pens.every((tx) => { const v = tx.inputs[0].prevout.vout; const kind = old.kinds[v]; const prev = { value: old.tx.outputs[v].value, scriptPubKey: kind === 'to_local' ? old.toLocal.spk : old.htlcs.find((h) => h.vout === v).scripts.spk }; return C.verifyTx(tx, [prev]).ok === true && tx.outputs[0].scriptPubKey === '5120' + Q.pub; }), `status ${chQ.status} penalties ${pens.length}`);
  t('until the penalties are in a block the channel stays punishing', (await Q.peer.afterClose(chQ), chQ.status === 'punishing'));
  chain.mine(); await Q.peer.afterClose(chQ); t('once both penalties are in a block the channel is punished', chQ.status === 'punished' && Q.notes.some((x) => /Penalty confirmed/.test(x))); }

// ---- the state of my pending update, published by the other side after a lost acknowledgement, is recognised as a close I signed
{ const X = host('X'), Y = host('Y'); const chX = await X.peer.openChannel(Y.pub, 50000); await pump(); confirm(chX.id); const chY = Y.channels[0];
  await X.peer.pay(chX, 1000); { const upd = inbox.shift(); await Y.peer.onMessage(upd.from, upd.body); inbox.length = 0; }
  t('with the acknowledgement lost X is pending at 1 and Y is at 1', chX.pending?.n === 1 && chY.n === 1);
  await Y.peer.forceClose(chY); const fcHex = chain.broadcasts.at(-1).hex; const fc = C.decode(fcHex);
  await X.peer.onSpend(chX, { txid: C.txid(fc), height: chain.height, hex: fcHex });
  t('X recognises the close as the state it had signed for its pending update, not as an unknown spend (nothing of its own to claim, so it settles at once)', ['closed-theirs', 'settling', 'closed'].includes(chX.status) && chX.closeState === 1, `status ${chX.status} closeState ${chX.closeState}`); }

// ---- a state leaving the funder no fee is refused and rejected; an out-of-range secret is dropped, not thrown
{ const X = host('X2'), Y = host('Y2'); const chX = await X.peer.openChannel(Y.pub, 50000); await pump(); confirm(chX.id); const chY = Y.channels[0];
  const s = { balA: 0, balB: 50000, htlcs: [] }; const sig = C.signFunding(chX, X.peer.theirCommitAt(chX, 1, s).tx, X.key); const s0 = snapshot(Y);
  await Y.peer.onMessage(X.pub, { t: 'update', id: chX.id, n: 1, kind: 'pay', amount: 50000, sig, nextRev: signer.pubkeyOf('77'.repeat(32)), nextRevPop: C.popSign('77'.repeat(32), `${chX.id}/a/2`) });
  t('a hand-signed state that leaves the funder no fee is refused, the channel untouched, and a reject sent back', snapshot(Y) === s0 && inbox.some((m) => m.body.t === 'reject' && m.to === X.pub), `changed ${snapshot(Y) !== s0} inbox ${inbox.map((m) => m.body.t)}`); inbox.length = 0;
  let threw = false; try { await Y.peer.onMessage(X.pub, { t: 'revoke', id: chX.id, n: 1, reveal: 'ff'.repeat(32) }); await Y.peer.onMessage(X.pub, { t: 'sync', id: chX.id, n: 1, reveal: 'ff'.repeat(32), status: 'open' }); await Y.peer.onMessage(X.pub, { t: 'ack', id: chX.id, n: 1, sig: 'ab'.repeat(65), reveal: 'ff'.repeat(32), nextRev: 'ab'.repeat(32) }); } catch { threw = true; }
  t('an out-of-range revocation secret in a revoke, a sync or an ack is dropped without an exception', !threw && chY.n === 0); inbox.length = 0;
  // a rejected update of mine: set aside, its signed state remembered, and I am told
  chX.htlcSeq = 5; const { inv: iv } = X.peer.invoice(2000, 'r', []); await X.peer.addHtlc(chX, { amount: 2000, hash: iv.h, expiry: chain.height + 40, route: null }); await pump();
  t('an update the other side refuses comes back as a reject: the sender sets it aside, remembers the state it signed, and is told the payment was not made', !chX.pending && (chX.signedAlt?.[1] ?? []).length === 1 && X.notes.some((x) => /Payment not made/.test(x)) && chX.n === 0 && chY.n === 0, `pending ${!!chX.pending} alt ${JSON.stringify(chX.signedAlt)} notes ${X.notes.length}`);
  // a save that fails withholds the signature: nothing is sent
  X.io.saveFails = true; let err = null; inbox.length = 0; try { await X.peer.pay(chX, 100); } catch (e) { err = e.message; } X.io.saveFails = false;
  t('when the state cannot be saved the update is not sent and the caller is told', /saved/.test(err ?? '') && !chX.pending && inbox.length === 0, `err ${err} inbox ${inbox.length}`); }

// ---- the protective close comes delay + 3 blocks before the expiry and is not held up by a pending settle
{ const X = host('X3'), Y = host('Y3'); const chX = await X.peer.openChannel(Y.pub, 50000); await pump(); confirm(chX.id); const chY = Y.channels[0];
  const { preimage: py, inv: iy } = Y.peer.invoice(3000, 'p', []); Y.invoices.set(iy.h, { preimage: py, amount: 3000 }); const expiry = chain.height + 40;
  await X.peer.addHtlc(chX, { amount: 3000, hash: iy.h, expiry, route: null }); { const upd = inbox.shift(); await Y.peer.onMessage(upd.from, upd.body); const ack = inbox.shift(); await X.peer.onMessage(ack.from, ack.body); const rev = inbox.shift(); await Y.peer.onMessage(rev.from, rev.body); await new Promise((r) => setTimeout(r, 150)); inbox.length = 0; }
  t('Y holds the preimage with its settle unacknowledged (X has gone quiet)', chY.pending?.m.kind === 'settle' && !!Y.peer.knownPreimage(chY, iy.h), `pending ${chY.pending?.m.kind}`);
  chain.height = expiry - 6 - 3 - 1; await Y.peer.tick(); t('one block before the deadline nothing closes', chY.status === 'open');
  chain.height = expiry - 6 - 3; await Y.peer.tick(); t('at delay + 3 blocks before the expiry Y closes to claim on the chain, despite its pending settle', chY.status === 'force-closing', `status ${chY.status}`);
  const fcHex = chain.broadcasts.at(-1).hex; const fc = C.decode(fcHex); await Y.peer.onSpend(chY, { txid: C.txid(fc), height: chain.height, hex: fcHex }); const nB = chain.broadcasts.length; chain.height += 6; await Y.peer.afterClose(chY);
  const claim = chain.broadcasts.slice(nB).find((b) => /claim of htlc/.test(b.what)); const my = Y.peer.myCommitAt(chY, chY.closeState); const h = my.htlcs[0];
  t('after the delay Y claims the HTLC with the preimage from its own commitment, before the expiry', !!claim && C.verifyTx(C.decode(claim.hex), [{ value: h.amount, scriptPubKey: h.scripts.spk }]).ok === true && chain.height < expiry); }

// ---- a preimage revealed on the chain reaches the hub, which settles upstream; HTLC ids never repeat; a resent update is acknowledged again
{ const H2 = host('hub2b', { hub: true }), U = host('U'), V = host('V'); const chU = await U.peer.openChannel(H2.pub, 100000); await pump(); confirm(chU.id); const chV = await V.peer.openChannel(H2.pub, 100000, 50000); await pump(); confirm(chV.id);
  const hubU = H2.channels.find((c) => c.id === chU.id), hubV = H2.channels.find((c) => c.id === chV.id);
  const { preimage: pv, inv: ivv } = V.peer.invoice(5000, 'v', [H2.pub]); V.invoices.set(ivv.h, { preimage: pv, amount: 5000 }); const expiry = chain.height + 60;
  await U.peer.addHtlc(chU, { amount: 5010, hash: ivv.h, expiry, route: { to: V.pub } }); { const upd = inbox.shift(); await H2.peer.onMessage(upd.from, upd.body); const ack = inbox.shift(); await U.peer.onMessage(ack.from, ack.body); const rev = inbox.shift(); await H2.peer.onMessage(rev.from, rev.body); }
  { const fwd = inbox.shift(); t('the hub forwards with the expiry cut by margin + both delays + 3', fwd.body.kind === 'add' && fwd.body.htlc.expiry === expiry - (EXPIRY_MARGIN + 6 + 3 + 6), `expiry ${fwd.body.htlc?.expiry} vs ${expiry}`); await V.peer.onMessage(fwd.from, fwd.body); const ack = inbox.shift(); await H2.peer.onMessage(ack.from, ack.body); const rev = inbox.shift(); await V.peer.onMessage(rev.from, rev.body); await new Promise((r) => setTimeout(r, 150)); inbox.length = 0; }
  t('V holds the preimage and its settle to the hub is lost; the hub still has the HTLC downstream and upstream', chV.pending?.m.kind === 'settle' && H2.peer.htlcs(hubV).some((h) => h.hash === ivv.h) && H2.peer.htlcs(hubU).some((h) => h.hash === ivv.h));
  await V.peer.forceClose(chV); const fcHex = chain.broadcasts.at(-1).hex; const fc = C.decode(fcHex);
  await H2.peer.onSpend(hubV, { txid: C.txid(fc), height: chain.height, hex: fcHex }); t('the hub sees V\'s close as the current state and waits: its offered HTLC is not expired and it has no preimage', hubV.status === 'closed-theirs' && !H2.peer.knownPreimage(hubV, ivv.h));
  await V.peer.onSpend(chV, { txid: C.txid(fc), height: chain.height, hex: fcHex }); chain.height += 6; await V.peer.afterClose(chV); t('V claims the HTLC on the chain with the preimage', /claim of htlc/.test(chain.broadcasts.at(-1).what));
  chain.mine(); await H2.peer.afterClose(hubV); await settle();
  t('the hub reads the preimage from V\'s claim and settles upstream: U\'s HTLC is gone, the hub is paid, U was told', !!H2.peer.knownPreimage(hubV, ivv.h) && H2.peer.htlcs(hubU).length === 0 && hubU.states[hubU.n].balB === 5010 && chU.states[chU.n].balA === 100000 - 5010 && U.notes.some((x) => /Payment sent/.test(x)), `known ${!!H2.peer.knownPreimage(hubV, ivv.h)} upHtlcs ${H2.peer.htlcs(hubU).length} hubBalB ${hubU.states[hubU.n].balB}`);
  // ids never repeat: the next HTLC on U's channel is 2, not 1 again
  const { preimage: pi2, inv: i2 } = H2.peer.invoice(1000, 'id', []); H2.invoices.set(i2.h, { preimage: pi2, amount: 1000 }); const m2 = await U.peer.addHtlc(chU, { amount: 1000, hash: i2.h, expiry: chain.height + 40, route: null });
  t('HTLC ids never repeat on a channel: the second HTLC is 2 although the first is gone', m2.htlc.id === 2); { const upd = inbox.shift(); await H2.peer.onMessage(upd.from, upd.body); }
  // the ack is lost; U's tick sends the update again with a fresh signature; the hub acknowledges again rather than ignoring it
  inbox.length = 0; chU.pending.at -= 1000; await U.peer.tick(); await pump();
  t('an update sent again with a fresh signature is acknowledged again: both sides reach the state', !chU.pending && chU.n === hubU.n && chU.n >= 3 && hubU.states[3].htlcs.some((h) => h.id === 2), `pending ${!!chU.pending} n ${chU.n}/${hubU.n}`); }
// ================= round three =================
// ---- rogue keys: a revocation point without a proof of its secret is refused, in an open and in an update
{ const X = host('X4'), Y = host('Y4'); const chX = await X.peer.openChannel(Y.pub, 50000); await pump(); confirm(chX.id); const chY = Y.channels[0];
  // an open whose basepoint is a point chosen to cancel the other side's (its secret unknown, so its proof is forged with another secret)
  const open = { t: 'open', id: '2'.repeat(16), funding: { txid: '2'.repeat(64), vout: 0, value: 50000 }, push: 0, delay: 6, fee: 300, a: X.pub, b: Y.pub, rev: [signer.pubkeyOf('51'.repeat(32)), signer.pubkeyOf('52'.repeat(32))], revBase: signer.pubkeyOf('53'.repeat(32)), pop: { base: C.popSign('54'.repeat(32), `${'2'.repeat(16)}/a/base`), rev: [C.popSign('51'.repeat(32), `${'2'.repeat(16)}/a/0`), C.popSign('52'.repeat(32), `${'2'.repeat(16)}/a/1`)] } };
  const n0 = Y.channels.length; await Y.peer.onMessage(X.pub, open); t('an open whose basepoint comes with a proof by another secret is refused', Y.channels.length === n0);
  // an update whose next point is announced with a proof by another secret: rejected, the sender's state set aside
  const s1 = { balA: 49000, balB: 1000, htlcs: [] }; const sig = C.signFunding(chX, X.peer.theirCommitAt(chX, 1, s1).tx, X.key); const s0 = snapshot(Y); inbox.length = 0;
  await Y.peer.onMessage(X.pub, { t: 'update', id: chX.id, n: 1, kind: 'pay', amount: 1000, sig, nextRev: signer.pubkeyOf('61'.repeat(32)), nextRevPop: C.popSign('62'.repeat(32), `${chX.id}/a/2`) });
  t('an update whose next revocation point lacks a valid proof is rejected and nothing is kept', snapshot(Y) === s0 && inbox.some((m) => m.body.t === 'reject' && /proof/.test(m.body.reason)), inbox.map((m) => m.body.t + ':' + m.body.reason).join());
  t('a point off the curve is refused the same way (no exception)', (await (async () => { try { await Y.peer.onMessage(X.pub, { t: 'update', id: chX.id, n: 1, kind: 'pay', amount: 1000, sig, nextRev: '00'.repeat(32), nextRevPop: 'ab'.repeat(64) }); return true; } catch { return false; } })()) && chY.n === 0); inbox.length = 0;
  // the delay floor: a host that wants 6 refuses an open at 3, and the shape check refuses below the protocol minimum
  const Z = host('Z4', { minDelay: 6 }); const chZ = { t: 'open', id: '3'.repeat(16), funding: { txid: '3'.repeat(64), vout: 0, value: 50000 }, push: 0, delay: 3, fee: 300, a: X.pub, b: Z.pub, rev: [chX.myRevPub[0], chX.myRevPub[1]], revBase: chX.myRevBasePub, pop: { base: C.popSign(chX.myRevBase, `${'3'.repeat(16)}/a/base`), rev: [C.popSign(chX.myRev[0], `${'3'.repeat(16)}/a/0`), C.popSign(chX.myRev[1], `${'3'.repeat(16)}/a/1`)] } };
  await Z.peer.onMessage(X.pub, chZ); t('the delay floor is enforced: a host wanting 6 refuses an open at 3, and delay 2 is malformed', Z.channels.length === 0 && Z.peer.wellFormed({ ...chZ, delay: 2 }) != null && Z.peer.wellFormed(chZ) == null); inbox.length = 0; }

// ---- after a force close no acknowledgement can draw a revocation out of me; a reorganised close of mine goes back to the mempool, not to 'open'
{ const X = host('X5'), Y = host('Y5'); const chX = await X.peer.openChannel(Y.pub, 50000); await pump(); confirm(chX.id); const chY = Y.channels[0];
  await X.peer.pay(chX, 1000); await pump(); await X.peer.pay(chX, 500); { const upd = inbox.shift(); await Y.peer.onMessage(upd.from, upd.body); } // Y acks 2, the ack is still in flight
  await X.peer.forceClose(chX, 1); t('a force close with an update pending sets the pending aside and remembers the signed state', !chX.pending && (chX.signedAlt?.[2] ?? []).length === 1 && chX.status === 'force-closing');
  const ack = inbox.shift(); inbox.length = 0; await X.peer.onMessage(ack.from, ack.body);
  t('the late acknowledgement is ignored: state 1 stays, no revocation of it goes out', chX.n === 1 && inbox.length === 0 && !Y.channels[0].theirRev[1]);
  await Y.peer.onMessage(X.pub, { t: 'sync', id: chX.id, n: 2, status: 'open', pendingN: null, missing: [1] }); // a sync asking for state 1's secret
  t('a sync asking for the secret of the published state gets nothing', !inbox.some((m) => m.to === Y.pub && m.body.reveals && Object.keys(m.body.reveals).length) && !inbox.some((m) => m.to === Y.pub && m.body.reveal)); inbox.length = 0;
  const fcHex = chain.broadcasts.at(-1).hex; const fc = C.decode(fcHex); await X.peer.onSpend(chX, { txid: C.txid(fc), height: chain.height, hex: fcHex });
  t('my commitment in a block: closed-mine', chX.status === 'closed-mine');
  X.peer.unSpend(chX); t('the block is reorganised away: back to force-closing with the commitment queued for sending again, never to open', chX.status === 'force-closing' && chX.unsent.some((u) => u.txid === chX.closeTxid) && !chX.spentBy);
  await X.peer.tick(); await X.peer.onSpend(chX, { txid: C.txid(fc), height: chain.height + 1, hex: fcHex }); t('when it is mined again the close is recognised as mine', chX.status === 'closed-mine' && chX.spentBy.height === chain.height + 1); }

// ---- a reject answers one attempt: a stale one is ignored; an acknowledgement of a state I set aside is adopted, since my signature was binding
{ const X = host('X6'), Y = host('Y6'); const chX = await X.peer.openChannel(Y.pub, 50000); await pump(); confirm(chX.id); const chY = Y.channels[0];
  await X.peer.pay(chX, 100); const sigA = chX.pending.sig; inbox.length = 0;
  await X.peer.onMessage(Y.pub, { t: 'reject', id: chX.id, n: 1, sig: 'ab'.repeat(65), reason: 'stale' }); t('a reject that does not carry my update\'s signature is ignored', chX.pending?.sig === sigA);
  await X.peer.onMessage(Y.pub, { t: 'reject', id: chX.id, n: 1, sig: sigA, reason: 'test' }); t('the reject for this attempt sets it aside', !chX.pending && (chX.signedAlt?.[1] ?? []).length === 1);
  // Y meanwhile did accept the update (the reject was a lie or a race): its ack arrives for a state X has set aside
  await Y.peer.onMessage(X.pub, { t: 'update', id: chX.id, n: 1, kind: 'pay', amount: 100, sig: sigA, nextRev: chX.myRevPub[2], nextRevPop: C.popSign(chX.myRev[2], `${chX.id}/a/2`) }); const ack = inbox.find((m) => m.body.t === 'ack'); inbox.length = 0;
  await X.peer.onMessage(ack.from, ack.body); await pump();
  t('the acknowledgement of the set-aside state is adopted, the revocation sent, both sides at state 1 with the same balances', chX.n === 1 && chY.n === 1 && chX.states[1].balA === chY.states[1].balA && !!chY.theirRev[0] && X.notes.some((x) => /applied after all/.test(x)), `n ${chX.n}/${chY.n} notes ${X.notes.length}`); }

// ---- a cooperative close crossing an update: the update is rejected, the close is answered on the resync; a force close after a close asked still recognises the cooperative one
{ const X = host('X7'), Y = host('Y7'); const chX = await X.peer.openChannel(Y.pub, 50000, 5000); await pump(); confirm(chX.id); const chY = Y.channels[0];
  await X.peer.closeChannel(chX); await Y.peer.pay(chY, 1000); // both at once: X asks a close, Y proposes an update
  await pump(); await pump();
  t('the update is rejected because a close is signed, Y sets it aside, and the close goes through on the resync', ['closing', 'closed'].includes(chY.status) && ['closing-asked', 'closing', 'closed'].includes(chX.status) && !chY.pending && chain.broadcasts.some((b) => b.what.startsWith('cooperative close of ' + chX.id)), `X ${chX.status} Y ${chY.status} pending ${!!chY.pending}`);
  const coop = chain.broadcasts.find((b) => b.what.startsWith('cooperative close of ' + chX.id)); const coopTx = C.decode(coop.hex);
  await X.peer.forceClose(chX); t('a force close after the close was asked is allowed (the other side may be gone)', chX.status === 'force-closing');
  await X.peer.onSpend(chX, { txid: C.txid(coopTx), height: chain.height, hex: coop.hex }); t('when the cooperative close lands instead, it is recognised as the close, not as an unknown spend', chX.status === 'closed'); }

// ---- the hub closes a downstream channel past its expiry even while its own fail is pending, so the payee cannot claim late with the preimage
{ const H3 = host('hub3c', { hub: true }), U = host('U3'), V = host('V3'); const chU = await U.peer.openChannel(H3.pub, 100000); await pump(); confirm(chU.id); const chV = await V.peer.openChannel(H3.pub, 100000, 50000); await pump(); confirm(chV.id);
  const hubU = H3.channels.find((c) => c.id === chU.id), hubV = H3.channels.find((c) => c.id === chV.id);
  const { preimage: pv, inv: ivv } = V.peer.invoice(5000, 'v', [H3.pub]); const expiry = chain.height + 60;
  await U.peer.addHtlc(chU, { amount: 5010, hash: ivv.h, expiry, route: { to: V.pub } }); { const upd = inbox.shift(); await H3.peer.onMessage(upd.from, upd.body); const ack = inbox.shift(); await U.peer.onMessage(ack.from, ack.body); const rev = inbox.shift(); await H3.peer.onMessage(rev.from, rev.body); }
  { const fwd = inbox.shift(); await V.peer.onMessage(fwd.from, fwd.body); const ack = inbox.shift(); await H3.peer.onMessage(ack.from, ack.body); const rev = inbox.shift(); await V.peer.onMessage(rev.from, rev.body); await new Promise((r) => setTimeout(r, 150)); inbox.length = 0; }
  t('V holds the HTLC without an invoice for it and goes quiet', H3.peer.htlcs(hubV).some((h) => h.hash === ivv.h) && !V.invoices.get(ivv.h));
  const downH = H3.peer.htlcs(hubV).find((h) => h.hash === ivv.h); chain.height = downH.expiry + 1; await H3.peer.tick(); t('past the downstream expiry the hub\'s fail is pending, unanswered', hubV.pending?.m.kind === 'fail');
  await H3.router.tick(); t('the router still closes the downstream channel so the chain decides', hubV.status === 'force-closing', `status ${hubV.status}`); inbox.length = 0; }
console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
