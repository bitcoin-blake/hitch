// Hostile and unlucky inputs against the protocol: malformed messages, expiry games, a double-signed state, a reordered
// revoke, a sync storm, a hub restart in the middle of a forward, a forced close with an HTLC in flight, a failed broadcast.
import { homedir } from 'node:os';
const H = (p) => p.replace(/^~/, homedir());
const SCHEMA = H(process.env.SCHEMA ?? '~/bitcoin-desktop/schema'), BTN = H(process.env.BLAKETESTNODE ?? '~/remote/github.com/bitcoin-blake/blaketestnode'), LIB = H(process.env.SIDESTR_LIB ?? '~/remote/github.com/sidestr/spec/siding/lib');
const [{ loadEngine }, hash, secp, { makeSigner }, { makeChannels }, { makePeer, EXPIRY_MARGIN }, { makeRouter }] = await Promise.all([import(`${BTN}/lib/engine.mjs`), import(`${SCHEMA}/codec/hash.js`), import(`${SCHEMA}/codec/secp256k1.js`), import(`${LIB}/schnorr.mjs`), import('../lib/channel.mjs'), import('../lib/peer.mjs'), import('../lib/route.mjs')]);
const k = await loadEngine('btc:testnet4-blake2b'); const signer = makeSigner({ hash, secp }); const C = makeChannels({ k, hash, secp, signer });
let ok = 0, bad = 0; const t = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`); cond ? ok++ : bad++; };
const chain = { height: 152100, broadcasts: [], refuse: false }; const inbox = []; const peers = {};
function host(name, { hub = false, fee = 300, delay = 6 } = {}, restore = null) { const key = restore?.key ?? signer.randomKey(), pub = signer.pubkeyOf(key); const channels = restore ? JSON.parse(JSON.stringify(restore.channels)) : []; const invoices = restore?.invoices ?? new Map(); let n = 0;
  const io = { myScript: '5120' + pub, height: () => chain.height, save: () => {}, invoiceFor: (h) => invoices.get(h) ?? null, log: (s, c) => { if (process.env.VERBOSE || (c === 'e' && process.env.ERRS)) console.log(`    [${name}] ${s}`); }, notify: () => {},
    send: async (ch, body) => { inbox.push({ to: ch.peer, from: pub, body: JSON.parse(JSON.stringify(body)) }); return 1; }, broadcast: async (hex, what) => { if (chain.refuse) return 0; chain.broadcasts.push({ from: name, hex, what }); return 1; },
    buildFunding: async () => { const txid = hash.bytesToHex(hash.sha256(new TextEncoder().encode(name + (++n) + Math.random()))); return { txid, vout: 0, hex: '00' }; } };
  const peer = makePeer({ C, signer, hash, pub, key, channels, io, opts: { delay, fee, hubFee: 10, pendingTimeout: 0, hub } }); const router = makeRouter({ peer, io, invoices, hub }); io.onUpdate = router.onUpdate;
  return peers[pub] = { name, pub, key, peer, invoices, channels, io, router }; }
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
t('fourteen malformed or hostile messages are dropped without an exception and without touching the channel', threw === 0 && snapshot(HUB) === before && HUB.channels.length === 1, `threw ${threw}, changed ${snapshot(HUB) !== before}`);
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
{ const altTx = C.commitmentTx(loserCh, 3, { ...alt, rev: { a: loserCh.role === 'a' ? loserCh.myRevPub[3] : loserCh.theirRevPub[3], b: loserCh.role === 'b' ? loserCh.myRevPub[3] : loserCh.theirRevPub[3] }, owner: loser.peer.them(loserCh) });
  await loser.peer.onSpend(loserCh, { txid: C.txid(altTx.tx), height: chain.height + 1, hex: '' });
  t('if the winner publishes that alternative before revoking state 3, the loser accepts it as a close it had signed', ['closed-theirs-alt', 'closed'].includes(loserCh.status) && loserCh.closeState === 3 && loserCh.closeStateObj === alt, `status ${loserCh.status} closeState ${loserCh.closeState}`); loserCh.status = 'open'; loserCh.spentBy = null;
  await winner.peer.pay(winnerCh, 50); await pump(); const nB = chain.broadcasts.length; await loser.peer.onSpend(loserCh, { txid: C.txid(altTx.tx), height: chain.height + 1, hex: '' });
  t('once state 3 is revoked the same alternative is punished with the penalty', loserCh.status === 'punishing' && chain.broadcasts.length === nB + 1 && !!loserCh.theirRev[3]); loserCh.status = 'open'; loserCh.spentBy = null; }

// ---- HTLC expiry rules: settle refused after the expiry, fail refused while the receiver holds the preimage
const chB = await B.peer.openChannel(HUB.pub, 100000, 50000); await pump(); confirm(chB.id); const hubB = HUB.channels.find((c) => c.id === chB.id);
const { preimage, inv } = B.peer.invoice(5000, 'x', [HUB.pub]); B.invoices.set(inv.h, { preimage, amount: 5000 });
await A.peer.addHtlc(chA, { amount: 5010, hash: inv.h, expiry: chain.height + 40, route: { to: B.pub } }); await pump(); await new Promise((r) => setTimeout(r, 1700)); await pump();
t('a routed payment with the new finality still settles end to end', chB.states[chB.n].balA === 55000 && chA.states[chA.n].htlcs.length === 0);
const { preimage: p2, inv: i2 } = B.peer.invoice(5000, 'late', [HUB.pub]); B.invoices.set(i2.h, { preimage: p2, amount: 5000 });
await A.peer.addHtlc(chA, { amount: 5010, hash: i2.h, expiry: chain.height + 40, route: { to: B.pub } }); { const upd = inbox.shift(); await HUB.peer.onMessage(upd.from, upd.body); const ack = inbox.shift(); await A.peer.onMessage(ack.from, ack.body); const rev = inbox.shift(); await HUB.peer.onMessage(rev.from, rev.body); }
// the hub has forwarded to B (pending in the inbox); B is offline: drain B's messages so it never answers
inbox.splice(0, inbox.length);
const hubDown = hubB; t('the hub forwarded the HTLC downstream and holds it against the upstream one', hubDown.pending?.m.kind === 'add' && hubA.states[hubA.n].htlcs.some((h) => h.hash === i2.h));
chain.height += 45; let failed = null; try { await A.peer.failHtlc(chA, hubA.states[hubA.n].htlcs.find((h) => h.hash === i2.h).id, 'expired'); await pump(); } catch (e) { failed = e.message; }
t('after the expiry the offerer can fail the upstream HTLC when the hub has no preimage, and the amount returns', failed === null && hubA.states[hubA.n].htlcs.every((h) => h.hash !== i2.h) && chA.states[chA.n].balA === chA.states[chA.n - 1].balA + 5010);
{ const late = B.channels.find((c) => c.id === chB.id); let refused = null; hubDown.pending = null; delete hubDown.states[hubDown.n + 1]; // the hub's forward never reached B: pretend it did and B settles late
  hubDown.states[hubDown.n].htlcs.push({ id: 9, from: 'b', amount: 5000, hash: i2.h, expiry: chain.height - 1, route: null }); late.states[late.n].htlcs = hubDown.states[hubDown.n].htlcs.map((h) => ({ ...h }));
  try { await B.peer.settleHtlc(late, 9, p2); await pump(); } catch (e) { refused = e.message; } t('a settle after the expiry is refused on the sender side', /expired/.test(refused ?? '')); hubDown.states[hubDown.n].htlcs.pop(); late.states[late.n].htlcs.pop(); }

// ---- the receiver of an HTLC who knows the preimage refuses a fail from the offerer
{ const { preimage: p3, inv: i3 } = HUB.peer.invoice(2000, 'direct', []); HUB.invoices.set(i3.h, { preimage: p3, amount: 2000 });
  await A.peer.addHtlc(chA, { amount: 2000, hash: i3.h, expiry: chain.height + 40, route: null }); { const upd = inbox.shift(); await HUB.peer.onMessage(upd.from, upd.body); const ack = inbox.shift(); await A.peer.onMessage(ack.from, ack.body); const rev = inbox.shift(); await HUB.peer.onMessage(rev.from, rev.body); inbox.splice(0, inbox.length); }
  const id = hubA.states[hubA.n].htlcs.find((h) => h.hash === i3.h).id; chain.height += 45; const s0 = snapshot(HUB); const failMsg = { t: 'update', id: chA.id, n: hubA.n + 1, kind: 'fail', htlcId: id, sig: 'ab'.repeat(65), nextRev: 'ab'.repeat(32) };
  await HUB.peer.onMessage(A.pub, failMsg); t('a fail for an HTLC whose preimage the receiver holds is refused, even after the expiry', snapshot(HUB) === s0 && hubA.states[hubA.n].htlcs.some((h) => h.id === id)); }

// ---- a hub restart between the forward and the settle: the forward is on the channel document, so the settle still comes back
{ const chB2 = B.channels.find((c) => c.id === chB.id); const { preimage: p4, inv: i4 } = B.peer.invoice(3000, 'restart', [HUB.pub]); B.invoices.set(i4.h, { preimage: p4, amount: 3000 }); chain.height -= 90;
  // clean slate on A–hub: settle the stuck direct HTLC first
  await HUB.peer.tick(); await pump(); // the hub's own settle of the direct HTLC was pending; the tick sends it again
  await A.peer.addHtlc(chA, { amount: 3010, hash: i4.h, expiry: chain.height + 40, route: { to: B.pub } }); { const upd = inbox.shift(); await HUB.peer.onMessage(upd.from, upd.body); const ack = inbox.shift(); await A.peer.onMessage(ack.from, ack.body); const rev = inbox.shift(); await HUB.peer.onMessage(rev.from, rev.body); }
  const fwd = inbox.find((m) => m.body.t === 'update' && m.body.kind === 'add'); t('the hub forwarded downstream before the restart', !!fwd);
  const HUB2 = host('hub2', { hub: true }, { key: HUB.key, channels: HUB.channels, invoices: HUB.invoices }); peers[HUB.pub] = HUB2; // the same node, restarted from its file
  await pump(); await new Promise((r) => setTimeout(r, 1700)); await pump();
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
console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
