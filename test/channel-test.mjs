// The channel library against the real kernel: every spend it builds is run through the interpreter with scripts on.
//   SCHEMA=<bitcoin-desktop/schema> BLAKETESTNODE=<path> SIDESTR_LIB=<siding/lib> node test/channel-test.mjs
import { homedir } from 'node:os';
const H = (p) => p.replace(/^~/, homedir());
const SCHEMA = H(process.env.SCHEMA ?? '~/bitcoin-desktop/schema'), BTN = H(process.env.BLAKETESTNODE ?? '~/remote/github.com/bitcoin-blake/blaketestnode'), LIB = H(process.env.SIDESTR_LIB ?? '~/remote/github.com/sidestr/spec/siding/lib');
const [{ loadEngine }, hash, secp, { makeSigner }, { makeChannels, DEFAULT_DELAY }] = await Promise.all([import(`${BTN}/lib/engine.mjs`), import(`${SCHEMA}/codec/hash.js`), import(`${SCHEMA}/codec/secp256k1.js`), import(`${LIB}/schnorr.mjs`), import('../lib/channel.mjs')]);
const k = await loadEngine('btc:testnet4-blake2b'); const signer = makeSigner({ hash, secp }); const C = makeChannels({ k, hash, secp, signer });
let ok = 0, bad = 0; const t = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? ok++ : bad++; };
const keyA = signer.randomKey(), keyB = signer.randomKey(); const a = signer.pubkeyOf(keyA), b = signer.pubkeyOf(keyB);
const f = C.fundingScript(a, b);
const ch = { keys: { a, b }, funding: { txid: 'ab'.repeat(32), vout: 1, value: 100000, ...f }, fee: 300, delay: DEFAULT_DELAY };
const rev = (key) => ({ key, pub: signer.pubkeyOf(key) });
const revA0 = rev(signer.randomKey()), revB0 = rev(signer.randomKey()), revA1 = rev(signer.randomKey()), revB1 = rev(signer.randomKey());
t('the funding output is a taproot script-path output with an unspendable internal key', /^5120[0-9a-f]{64}$/.test(f.spk) && C.internal.length === 64 && f.control.length === 66);

// state 0: the funder holds everything
const s0 = { balA: 100000, balB: 0, rev: { a: revA0.pub, b: revB0.pub } };
const cA0 = C.commitmentTx(ch, 0, { ...s0, owner: 'a' });
t('the funder\'s first commitment pays only a delayed to_local, minus the fee', cA0.kinds.join() === 'to_local' && cA0.tx.outputs[0].value === 99700);
let sigA = C.signFunding(ch, cA0.tx, keyA), sigB = C.signFunding(ch, cA0.tx, keyB);
t('each side\'s signature on it verifies, and a wrong key\'s does not', C.verifyFunding(ch, cA0.tx, a, sigA) && C.verifyFunding(ch, cA0.tx, b, sigB) && !C.verifyFunding(ch, cA0.tx, a, sigB));
cA0.tx.witness = [C.fundingWitness(ch, { [a]: sigA, [b]: sigB })];
t('with both signatures the commitment spends the funding output under the interpreter', C.verifyTx(cA0.tx, [C.fundingPrevout(ch)]).ok === true);
const bad1 = { ...cA0.tx, witness: [C.fundingWitness(ch, { [a]: sigA, [b]: sigA })] };
t('with one signature doubled it does not', C.verifyTx(bad1, [C.fundingPrevout(ch)]).ok === false);

// state 1: A pays B 40,000
const s1 = { balA: 60000, balB: 40000, rev: { a: revA1.pub, b: revB1.pub } };
const cA1 = C.commitmentTx(ch, 1, { ...s1, owner: 'a' }), cB1 = C.commitmentTx(ch, 1, { ...s1, owner: 'b' });
t('after a payment both commitments carry both outputs, the fee on the funder\'s side', cA1.kinds.join() === 'to_local,to_remote' && cA1.local === 59700 && cA1.remote === 40000 && cB1.local === 40000 && cB1.remote === 59700);
for (const c of [cA1, cB1]) c.tx.witness = [C.fundingWitness(ch, { [a]: C.signFunding(ch, c.tx, keyA), [b]: C.signFunding(ch, c.tx, keyB) })];
t('both state-1 commitments verify', C.verifyTx(cA1.tx, [C.fundingPrevout(ch)]).ok && C.verifyTx(cB1.tx, [C.fundingPrevout(ch)]).ok);
t('the two commitments are different transactions of the same state', C.txid(cA1.tx) !== C.txid(cB1.tx));

// A sweeps its own to_local after the delay
const cA1id = C.txid(cA1.tx); const dest = '5120' + a;
const sweep = C.sweepTx({ commit: cA1, txid: cA1id, vout: 0, value: cA1.local, to: dest, fee: 200, delayed: ch.delay, key: keyA });
const tlPrev = [{ value: cA1.local, scriptPubKey: cA1.toLocal.spk }];
t('the owner sweeps to_local with sequence = delay through the delay leaf', C.verifyTx(sweep, tlPrev).ok === true && sweep.inputs[0].sequence === ch.delay);
const early = C.sweepTx({ commit: cA1, txid: cA1id, vout: 0, value: cA1.local, to: dest, fee: 200, delayed: ch.delay - 1, key: keyA });
t('one block early the delay leaf refuses (CHECKSEQUENCEVERIFY)', C.verifyTx(early, tlPrev).ok === false);
const wrongKey = C.sweepTx({ commit: cA1, txid: cA1id, vout: 0, value: cA1.local, to: dest, fee: 200, delayed: ch.delay, key: keyB });
t('the other key cannot use the delay leaf', C.verifyTx(wrongKey, tlPrev).ok === false);

// B punishes A's revoked state 0 with the revocation secret A handed over
const cA0id = C.txid(cA0.tx); const tl0 = [{ value: cA0.local, scriptPubKey: cA0.toLocal.spk }];
const penalty = C.sweepTx({ commit: cA0, txid: cA0id, vout: 0, value: cA0.local, to: '5120' + b, fee: 200, delayed: 0, key: revA0.key });
t('the revocation secret spends the revoked to_local at once, to the other side', C.verifyTx(penalty, tl0).ok === true && penalty.inputs[0].sequence === 0xfffffffd);
const noSecret = C.sweepTx({ commit: cA0, txid: cA0id, vout: 0, value: cA0.local, to: '5120' + b, fee: 200, delayed: 0, key: keyB });
t('without the secret the revocation leaf refuses', C.verifyTx(noSecret, tl0).ok === false);
const notYet = C.sweepTx({ commit: cA1, txid: cA1id, vout: 0, value: cA1.local, to: '5120' + b, fee: 200, delayed: 0, key: revA0.key });
t('state 0\'s secret does nothing against state 1', C.verifyTx(notYet, tlPrev).ok === false);

// B takes its to_remote from A's commitment by key path
const rem = C.keyPathSpend({ txid: cA1id, vout: 1, value: cA1.remote, spk: C.toRemoteScript(b), to: '5120' + b, fee: 200, key: keyB });
t('to_remote is a plain key-path coin of the other key', C.verifyTx(rem, [{ value: cA1.remote, scriptPubKey: C.toRemoteScript(b) }]).ok === true);

// cooperative close at state 1
const close = C.closingTx(ch, s1); close.witness = [C.fundingWitness(ch, { [a]: C.signFunding(ch, close, keyA), [b]: C.signFunding(ch, close, keyB) })];
t('a cooperative close pays both balances straight to their keys and verifies', C.verifyTx(close, [C.fundingPrevout(ch)]).ok === true && close.outputs.length === 2 && close.outputs[0].value + close.outputs[1].value === 100000 - 300);
t('a commitment and a close encode and decode through the codec', C.txid(C.decode(C.encode(cA1.tx))) === cA1id && C.decode(C.encode(close)).witness[0].length === 4);
// HTLCs: A offers 20,000 to B, locked to sha256(preimage), expiring at a block height
const preimage = signer.randomKey(); const HH = hash.bytesToHex(hash.sha256(hash.hexToBytes(preimage))); const expiry = 152200;
const revA2 = rev(signer.randomKey()), revB2 = rev(signer.randomKey());
const s2 = { balA: 40000, balB: 40000, rev: { a: revA2.pub, b: revB2.pub }, htlcs: [{ id: 1, from: 'a', amount: 20000, hash: HH, expiry }] };
const hA = C.commitmentTx(ch, 2, { ...s2, owner: 'a' }), hB = C.commitmentTx(ch, 2, { ...s2, owner: 'b' });
t('with an HTLC in flight both commitments carry a third output of its amount', hA.kinds.join() === 'to_local,to_remote,htlc' && hB.kinds.join() === 'to_local,to_remote,htlc' && hA.tx.outputs[2].value === 20000 && hA.htlcs[0].offeredByOwner === true && hB.htlcs[0].offeredByOwner === false);
for (const c of [hA, hB]) c.tx.witness = [C.fundingWitness(ch, { [a]: C.signFunding(ch, c.tx, keyA), [b]: C.signFunding(ch, c.tx, keyB) })];
t('both HTLC-bearing commitments verify', C.verifyTx(hA.tx, [C.fundingPrevout(ch)]).ok && C.verifyTx(hB.tx, [C.fundingPrevout(ch)]).ok);
const hAid = C.txid(hA.tx), hBid = C.txid(hB.tx); const hPrevA = [{ value: 20000, scriptPubKey: hA.htlcs[0].scripts.spk }], hPrevB = [{ value: 20000, scriptPubKey: hB.htlcs[0].scripts.spk }];
// on A's commitment (A offered): B claims at once with the preimage; A refunds after the expiry and the delay
const okB = C.htlcClaim({ commit: hA, htlc: hA.htlcs[0], kind: 'success', txid: hAid, value: 20000, to: '5120' + b, fee: 200, key: keyB, preimage });
t('the receiver claims an offered HTLC with the preimage at once', C.verifyTx(okB, hPrevA).ok === true && okB.inputs[0].sequence === 0xfffffffe);
const badPre = C.htlcClaim({ commit: hA, htlc: hA.htlcs[0], kind: 'success', txid: hAid, value: 20000, to: '5120' + b, fee: 200, key: keyB, preimage: signer.randomKey() });
t('a wrong preimage fails', C.verifyTx(badPre, hPrevA).ok === false);
const toA = C.htlcClaim({ commit: hA, htlc: hA.htlcs[0], kind: 'timeout', txid: hAid, value: 20000, to: '5120' + a, fee: 200, key: keyA });
t('the offerer takes it back after the expiry, waiting the delay on its own commitment', C.verifyTx(toA, hPrevA).ok === true && toA.lockTime === expiry && toA.inputs[0].sequence === ch.delay);
const tooSoon = { ...toA, lockTime: expiry - 1 }; tooSoon.witness = [[C.signLeaf(tooSoon, 0, hPrevA, hA.htlcs[0].scripts.timeout.leaf, keyA), hA.htlcs[0].scripts.timeout.script, hA.htlcs[0].scripts.timeout.control]];
t('before the expiry the timeout leaf refuses (CHECKLOCKTIMEVERIFY)', C.verifyTx(tooSoon, hPrevA).ok === false);
// on B's commitment (B received): B waits the delay to claim with the preimage; A refunds at once after the expiry
const okB2 = C.htlcClaim({ commit: hB, htlc: hB.htlcs[0], kind: 'success', txid: hBid, value: 20000, to: '5120' + b, fee: 200, key: keyB, preimage });
t('on its own commitment the receiver claims with the preimage after the delay', C.verifyTx(okB2, hPrevB).ok === true && okB2.inputs[0].sequence === ch.delay);
const toA2 = C.htlcClaim({ commit: hB, htlc: hB.htlcs[0], kind: 'timeout', txid: hBid, value: 20000, to: '5120' + a, fee: 200, key: keyA });
t('the offerer refunds from the other commitment at once after the expiry', C.verifyTx(toA2, hPrevB).ok === true && toA2.inputs[0].sequence === 0xfffffffe);
const punish = C.htlcClaim({ commit: hA, htlc: hA.htlcs[0], kind: 'revocation', txid: hAid, value: 20000, to: '5120' + b, fee: 200, key: revA2.key });
t('a revoked commitment\'s HTLC output falls to the revocation secret', C.verifyTx(punish, hPrevA).ok === true);
let threw = false; try { C.closingTx(ch, s2); } catch { threw = true; } t('a cooperative close refuses while an HTLC is in flight', threw);
console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
