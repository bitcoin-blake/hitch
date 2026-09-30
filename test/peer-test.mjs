// Three peers in memory, A, a hub and B, joined by a fake relay and a fake chain: opening with a push, a direct payment,
// an invoice paid through the hub with an HTLC, a failed route, a cooperative close, and a penalty on a revoked commitment,
// every transaction that reaches the fake chain checked by the interpreter.
import { homedir } from 'node:os';
const H = (p) => p.replace(/^~/, homedir());
const SCHEMA = H(process.env.SCHEMA ?? '~/bitcoin-desktop/schema'), BTN = H(process.env.BLAKETESTNODE ?? '~/remote/github.com/bitcoin-blake/blaketestnode'), LIB = H(process.env.SIDESTR_LIB ?? '~/remote/github.com/sidestr/spec/siding/lib');
const [{ loadEngine }, hash, secp, { makeSigner }, { makeChannels }, { makePeer }, { makeRouter }] = await Promise.all([import(`${BTN}/lib/engine.mjs`), import(`${SCHEMA}/codec/hash.js`), import(`${SCHEMA}/codec/secp256k1.js`), import(`${LIB}/schnorr.mjs`), import('../lib/channel.mjs'), import('../lib/peer.mjs'), import('../lib/route.mjs')]);
const k = await loadEngine('btc:testnet4-blake2b'); const signer = makeSigner({ hash, secp }); const C = makeChannels({ k, hash, secp, signer });
let ok = 0, bad = 0; const t = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? ok++ : bad++; };
const chain = { height: 152100, broadcasts: [] }; const inbox = []; const peers = {};
function host(name, { hub = false } = {}) { const key = signer.randomKey(), pub = signer.pubkeyOf(key); const channels = []; const invoices = new Map(); let n = 0;
  const io = { myScript: '5120' + pub, height: () => chain.height, save: () => {}, invoiceFor: (h) => invoices.get(h) ?? null, log: (s, c) => { if (process.env.VERBOSE || c === 'e') console.log(`    [${name}] ${s}`); }, notify: () => {},
    send: async (ch, body) => { inbox.push({ to: ch.peer, from: pub, body }); }, broadcast: async (hex, what) => { chain.broadcasts.push({ from: name, hex, what }); return 1; },
    buildFunding: async (amount, spk) => { const txid = hash.bytesToHex(hash.sha256(new TextEncoder().encode(name + (++n) + Math.random()))); return { txid, vout: 0, hex: '00' }; } };
  const peer = makePeer({ C, signer, hash, pub, key, channels, io, opts: { delay: 6, fee: 300, hubFee: 10, pendingTimeout: 0 } }); const router = makeRouter({ peer, io, invoices, hub }); io.onUpdate = router.onUpdate;
  return peers[pub] = { name, pub, key, peer, invoices, channels, io }; }
async function pump() { let guard = 0; while (inbox.length && guard++ < 200) { const m = inbox.shift(); await peers[m.to].peer.onMessage(m.from, m.body); } }
const A = host('A'), HUB = host('hub', { hub: true }), B = host('B');
const confirm = (id) => { for (const p of Object.values(peers)) for (const c of p.channels) if (c.id === id && c.status === 'funding') { c.status = 'open'; c.fundedHeight = chain.height; } };

// open A→hub 100,000 and B→hub 100,000 with 50,000 pushed to the hub
const chA = await A.peer.openChannel(HUB.pub, 100000); await pump(); const chB = await B.peer.openChannel(HUB.pub, 100000, 50000); await pump();
t('both channels reach funding on both sides, the push credited', chA.status === 'funding' && chB.status === 'funding' && HUB.channels.length === 2 && HUB.channels[1].states[0].balB === 50000 && chB.states[0].balA === 50000);
t('the first commitments verify under the interpreter on both sides', [A, B, HUB].every((p) => p.channels.every((c) => { const my = p.peer.myCommitAt(c, 0); my.tx.witness = [C.fundingWitness(c, { [p.pub]: C.signFunding(c, my.tx, p.key), [c.peer]: c.sigs[0] })]; return C.verifyTx(my.tx, [C.fundingPrevout(c)]).ok === true; })));
confirm(chA.id); confirm(chB.id);
// a direct payment A → hub
await A.peer.pay(chA, 1000, 'hello'); await pump(); const hubA = HUB.channels.find((c) => c.id === chA.id);
t('a direct payment moves the balance on both sides and revokes state 0 both ways', chA.n === 1 && hubA.n === 1 && chA.states[1].balA === 99000 && hubA.states[1].balB === 1000 && chA.theirRev[0] && hubA.theirRev[0]);
// B issues an invoice routed via the hub; A pays it with an HTLC
const { preimage, inv } = B.peer.invoice(20000, 'coffee', [HUB.pub]); B.invoices.set(inv.h, { preimage, amount: 20000 });
await A.peer.addHtlc(chA, { amount: inv.a + inv.f, hash: inv.h, expiry: chain.height + 40, route: { to: inv.p }, memo: inv.m }); await pump(); await new Promise((r) => setTimeout(r, 1700)); await pump(); await new Promise((r) => setTimeout(r, 1700)); await pump();
const hubB = HUB.channels.find((c) => c.id === chB.id);
t('the HTLC crossed the hub, B settled it with the preimage, the hub settled upstream: B gained 20,000, the hub kept its fee', chB.states[chB.n].balA === 50000 + 20000 && hubB.states[hubB.n].balB === 50000 - 20000 && chA.states[chA.n].balA === 99000 - 20010 && hubA.states[hubA.n].balB === 1000 + 20010 && (chA.states[chA.n].htlcs ?? []).length === 0 && (chB.states[chB.n].htlcs ?? []).length === 0);
t('every commitment along the way still verifies', [A, B, HUB].every((p) => p.channels.every((c) => { const my = p.peer.myCommitAt(c, c.n); my.tx.witness = [C.fundingWitness(c, { [p.pub]: C.signFunding(c, my.tx, p.key), [c.peer]: c.sigs[c.n] })]; return C.verifyTx(my.tx, [C.fundingPrevout(c)]).ok === true; })));
// an invoice for a node the hub has no channel to fails back, and A's balance returns
const stranger = signer.pubkeyOf(signer.randomKey()); const before = chA.states[chA.n].balA;
await A.peer.addHtlc(chA, { amount: 5000, hash: B.peer.sha(signer.randomKey()), expiry: chain.height + 40, route: { to: stranger } }); await pump(); await new Promise((r) => setTimeout(r, 1700)); await pump();
t('an HTLC with no route is failed by the hub and the amount returns to A', chA.states[chA.n].balA === before && (chA.states[chA.n].htlcs ?? []).length === 0);
// cooperative close of B's channel
await B.peer.closeChannel(chB); await pump();
t('a cooperative close is signed by both and reaches the chain', chB.status === 'closing-asked' && hubB.status === 'closing' && chain.broadcasts.some((b) => b.what.startsWith('cooperative close')) && (() => { const tx = C.decode(chain.broadcasts.find((b) => b.what.startsWith('cooperative close')).hex); return C.verifyTx(tx, [C.fundingPrevout(chB)]).ok === true; })());
// the hub cheats on A's channel with its state-1 commitment (A has the secret); A punishes
const oldHub = HUB.peer.myCommitAt(hubA, 1); oldHub.tx.witness = [C.fundingWitness(hubA, { [HUB.pub]: C.signFunding(hubA, oldHub.tx, HUB.key), [A.pub]: hubA.sigs[1] })];
const nB = chain.broadcasts.length; await A.peer.onSpend(chA, { txid: C.txid(oldHub.tx), height: chain.height + 1, hex: C.encode(oldHub.tx) });
const pens = chain.broadcasts.slice(nB); const penTx = pens.length ? C.decode(pens[0].hex) : null; const vl = oldHub.kinds.indexOf('to_local');
t('a revoked commitment from the hub is punished: the penalty spends its to_local to A and verifies', chA.status === 'punishing' && pens.length === 1 && penTx && C.verifyTx(penTx, [{ value: oldHub.tx.outputs[vl].value, scriptPubKey: oldHub.toLocal.spk }]).ok === true && penTx.outputs[0].scriptPubKey === '5120' + A.pub);
// a force close by A at the current state, then the sweep after the delay
const chA2 = await A.peer.openChannel(HUB.pub, 50000); await pump(); confirm(chA2.id); await A.peer.pay(chA2, 2000); await pump();
await A.peer.forceClose(chA2); const fc = chain.broadcasts.at(-1); const fcTx = C.decode(fc.hex); t('a forced close publishes my latest commitment, valid under the interpreter', C.verifyTx(fcTx, [C.fundingPrevout(chA2)]).ok === true && chA2.status === 'force-closing');
await A.peer.onSpend(chA2, { txid: C.txid(fcTx), height: chain.height, hex: fc.hex }); const n1 = chain.broadcasts.length; chain.height += 6; await A.peer.afterClose(chA2);
t('after the delay the to_local is swept to my key and the channel is closed', chain.broadcasts.length === n1 + 1 && chA2.status === 'closed' && (() => { const c = A.peer.myCommitAt(chA2, chA2.n); const sw = C.decode(chain.broadcasts.at(-1).hex); return C.verifyTx(sw, [{ value: c.tx.outputs[0].value, scriptPubKey: c.toLocal.spk }]).ok === true; })());
// ---- resync: lost messages and a collision, on a fresh channel between A and the hub
const chR = await A.peer.openChannel(HUB.pub, 60000, 20000); await pump(); confirm(chR.id); const hubR = HUB.channels.find((c) => c.id === chR.id);
const drop = (t) => { const i = inbox.findIndex((m) => m.body.t === t); if (i >= 0) inbox.splice(i, 1); };
// the ack is lost: A stays pending at 1, the hub is at 1; a resync brings the ack again
await A.peer.pay(chR, 1000); await pump(); // update reaches the hub, which acks
// simulate the loss: rewind A to before the ack by dropping it before delivery
await A.peer.pay(chR, 1000); { const upd = inbox.shift(); await HUB.peer.onMessage(upd.from, upd.body); drop('ack'); }
t('with the acknowledgement lost, A is pending at 2 and the hub is at 2', chR.n === 1 && chR.pending?.n === 2 && hubR.n === 2);
await A.peer.resyncAll(true); await pump();
t('a resync brings the acknowledgement again and A catches up, the revocation exchanged', chR.n === 2 && !chR.pending && hubR.n === 2 && chR.theirRev[1] && hubR.theirRev[1]);
// the update is lost: the tick sends it again
await A.peer.pay(chR, 500); drop('update'); await pump(); t('with the update lost the hub knows nothing and A is pending', hubR.n === 2 && chR.pending?.n === 3);
chR.pending.at -= 1000; await A.peer.tick(); await pump(); t('the tick sends the update again and it completes', chR.n === 3 && hubR.n === 3 && !chR.pending);
// the revoke is lost: the next resync carries the secret
await A.peer.pay(chR, 500); { const upd = inbox.shift(); await HUB.peer.onMessage(upd.from, upd.body); const ack = inbox.shift(); await A.peer.onMessage(ack.from, ack.body); drop('revoke'); }
t('with the revoke lost the hub lacks A\'s secret for state 3', chR.n === 4 && hubR.n === 4 && !hubR.theirRev[3]);
await A.peer.resyncAll(true); await pump(); t('a resync carries the secret; the hub can now punish state 3', !!hubR.theirRev[3]);
// a collision: both propose state 5 at once; the lower key's stands, the other's is retried by its tick
await A.peer.pay(chR, 100); await HUB.peer.pay(hubR, 200); await pump(); const lower = A.pub < HUB.pub ? 'A' : 'hub';
t(`both proposed at once: ${lower}'s update stood and the other side dropped its own`, chR.n === 5 && hubR.n === 5 && chR.states[5].balA === hubR.states[5].balA && (lower === 'A' ? chR.states[5].balA === chR.states[4].balA - 100 : chR.states[5].balA === chR.states[4].balA + 200) && !chR.pending && !hubR.pending);
const loser = lower === 'A' ? HUB : A; const loserCh = lower === 'A' ? hubR : chR;
t('the loser\'s signed state is remembered as an alternative the winner might publish, and is not retried by itself', (loserCh.signedAlt?.[5] ?? []).length === 1 && !!loserCh.droppedIntent);
await A.peer.tick(); await HUB.peer.tick(); await pump();
t('the tick reports the set-aside update and clears it; the states stay at 5', chR.n === 5 && hubR.n === 5 && !loserCh.droppedIntent);
t('every commitment still verifies after the resyncs', [A, HUB].every((p) => p.channels.filter((c) => c.id === chR.id).every((c) => { const my = p.peer.myCommitAt(c, c.n); my.tx.witness = [C.fundingWitness(c, { [p.pub]: C.signFunding(c, my.tx, p.key), [c.peer]: c.sigs[c.n] })]; return C.verifyTx(my.tx, [C.fundingPrevout(c)]).ok === true; })));
console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
