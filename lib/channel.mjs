// A payment channel between two keys on a taproot chain, in the Lightning shape without the network: a 2-of-2 funding
// output, asymmetric commitment transactions with a revocable to_local (a delay leaf for the owner, a revocation leaf
// whose secret is handed over when the state is replaced), a to_remote paid straight to the other key, cooperative and
// forced closes, and the penalty spend that makes an old commitment a losing move. Pure: browsers and Node alike.
// Deps: the schema kernel `k` (codec, interpreter), `hash` (taggedHash, sha256, hex), `secp` (tapOutputKey, checkTapTweak,
// ckdPubKey, verifySchnorr), and a `signer` (schnorrSign, pubkeyOf, randomKey) from the sidestr library.
export const NUMS_X = '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0'; // BIP 341's H
export const DUST = 330, DEFAULT_FEE = 300, DEFAULT_DELAY = 6; // sats; blocks (about two hours at one block per twenty minutes)
const SIGHASH_ALL = 0x01, SIGHASH_UNIFIED = 0x20;
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const compact = (n) => n < 0xfd ? [n] : n <= 0xffff ? [0xfd, n & 255, n >> 8] : [0xfe, n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24];
const pushNum = (n) => { if (n === 0) return '00'; if (n >= 1 && n <= 16) return (0x50 + n).toString(16); const b = []; let v = n; while (v > 0) { b.push(v & 0xff); v >>= 8; } if (b[b.length - 1] & 0x80) b.push(0); return hex(Uint8Array.from([b.length, ...b])); };
const ZERO32 = '00'.repeat(32);

export function makeChannels({ k, hash, secp, signer }) {
  const { taggedHash } = hash;
  const unified = k?.params?.unifiedSighashParam != null;
  const leafHash = (script) => { const s = unhex(script); return taggedHash('TapLeaf', Uint8Array.of(0xc0), Uint8Array.from(compact(s.length)), s); };
  const branch = (a, b) => { const [x, y] = hex(a) < hex(b) ? [a, b] : [b, a]; return taggedHash('TapBranch', x, y); };
  // an internal key nobody holds: H tweaked by a tag, so the key path is provably unusable
  const internal = (() => { const t = taggedHash('hitch/nums', new TextEncoder().encode('hitch')); const K = secp.ckdPubKey(unhex('02' + NUMS_X), t); return hex(K.slice(1)); })();
  const output = (root) => { const out = secp.tapOutputKey(unhex(internal), root); if (!out) throw new Error('tap tweak failed'); const parity = secp.checkTapTweak(unhex(internal), root, out, 0) ? 0 : 1; return { key: hex(out), script: '5120' + hex(out), parity }; };
  const control = (parity, sibling = null) => (0xc0 | parity).toString(16).padStart(2, '0') + internal + (sibling ? hex(sibling) : '');

  // ---- the funding output: multi_a(2, a, b) in one leaf
  function fundingScript(pubA, pubB) { const [p, q] = [pubA, pubB].sort(); const script = '20' + p + 'ac' + '20' + q + 'ba' + '52' + '9c'; const leaf = leafHash(script); const o = output(leaf); return { script, leaf: hex(leaf), spk: o.script, outputKey: o.key, control: control(o.parity), signers: [p, q] }; }
  // ---- a to_local output: the owner after `delay` blocks, or the revocation key at once
  function toLocalScript(ownerPub, revPub, delay) { const delayed = pushNum(delay) + 'b2' + '75' + '20' + ownerPub + 'ac'; const revocation = '20' + revPub + 'ac'; const lh = leafHash(delayed), rh = leafHash(revocation); const root = branch(lh, rh); const o = output(root);
    return { spk: o.script, outputKey: o.key, delayed: { script: delayed, leaf: hex(lh), control: control(o.parity, rh) }, revocation: { script: revocation, leaf: hex(rh), control: control(o.parity, lh) } }; }
  const toRemoteScript = (pub) => '5120' + pub;
  // an HTLC output, three leaves: success (the receiver with the preimage), timeout (the offerer after `expiry`), revocation.
  // The commitment's owner waits `delay` blocks on its own claim (CSV), so a revoked commitment's HTLCs can still be punished;
  // the other side claims at once. Tree: branch(branch(success, timeout), revocation).
  function htlcScript({ ownerPub, remotePub, revPub, delay, hash, expiry, offeredByOwner }) {
    const csv = pushNum(delay) + 'b2' + '75', cltv = pushNum(expiry) + 'b1' + '75';
    const success = 'a8' + '20' + hash + '88' + (offeredByOwner ? '' : csv) + '20' + (offeredByOwner ? remotePub : ownerPub) + 'ac';
    const timeout = cltv + (offeredByOwner ? csv : '') + '20' + (offeredByOwner ? ownerPub : remotePub) + 'ac';
    const revocation = '20' + revPub + 'ac';
    const sh = leafHash(success), th = leafHash(timeout), rh = leafHash(revocation); const inner = branch(sh, th); const root = branch(inner, rh); const o = output(root);
    return { spk: o.script, outputKey: o.key, success: { script: success, leaf: hex(sh), control: control(o.parity) + hex(th) + hex(rh), csv: !offeredByOwner }, timeout: { script: timeout, leaf: hex(th), control: control(o.parity) + hex(sh) + hex(rh), csv: offeredByOwner }, revocation: { script: revocation, leaf: hex(rh), control: control(o.parity) + hex(inner) } }; }

  // ---- transactions
  // the commitment held by `owner` (its balance is the delayed side) at state n; `remote` gets its balance at once
  function commitmentTx(ch, n, st) { const me = st.owner, other = st.owner === 'a' ? 'b' : 'a'; const ownerPub = ch.keys[me], remotePub = ch.keys[other]; const bal = { a: st.balA, b: st.balB }; const fee = ch.fee;
    const funderIs = 'a'; const local = bal[me] - (me === funderIs ? fee : 0), remote = bal[other] - (other === funderIs ? fee : 0);
    const tl = toLocalScript(ownerPub, st.rev[me], ch.delay); const outputs = []; const htlcs = [];
    if (local >= DUST) outputs.push({ value: local, scriptPubKey: tl.spk, kind: 'to_local' }); if (remote >= DUST) outputs.push({ value: remote, scriptPubKey: toRemoteScript(remotePub), kind: 'to_remote' });
    for (const h of (st.htlcs ?? []).slice().sort((x, y) => x.id - y.id)) { if (h.amount < DUST) continue; const hs = htlcScript({ ownerPub, remotePub, revPub: st.rev[me], delay: ch.delay, hash: h.hash, expiry: h.expiry, offeredByOwner: h.from === me }); outputs.push({ value: h.amount, scriptPubKey: hs.spk, kind: 'htlc', htlc: h }); htlcs.push({ ...h, vout: outputs.length - 1, scripts: hs, offeredByOwner: h.from === me }); }
    if (!outputs.length) throw new Error('nothing to pay out'); 
    const tx = { version: 2, inputs: [{ prevout: { txid: ch.funding.txid, vout: ch.funding.vout }, scriptSig: '', sequence: 0xfffffffd }], outputs: outputs.map(({ value, scriptPubKey }) => ({ value, scriptPubKey })), lockTime: 0, witness: [[]] };
    return { tx, toLocal: tl, kinds: outputs.map((o) => o.kind), htlcs, local, remote, n, owner: me, delay: ch.delay }; }
  function closingTx(ch, st, feeSplit = null) { if (st.htlcs?.length) throw new Error('HTLCs in flight: settle or fail them first'); const fee = ch.fee; const fa = feeSplit ? feeSplit.a : fee, fb = feeSplit ? feeSplit.b : 0; const outs = []; if (st.balA - fa >= DUST) outs.push({ value: st.balA - fa, scriptPubKey: toRemoteScript(ch.keys.a) }); if (st.balB - fb >= DUST) outs.push({ value: st.balB - fb, scriptPubKey: toRemoteScript(ch.keys.b) });
    return { version: 2, inputs: [{ prevout: { txid: ch.funding.txid, vout: ch.funding.vout }, scriptSig: '', sequence: 0xfffffffd }], outputs: outs, lockTime: 0, witness: [[]] }; }
  const fundingPrevout = (ch) => ({ value: ch.funding.value, scriptPubKey: ch.funding.spk });

  // ---- signatures: script-path, SIGHASH_ALL (unified on this chain)
  function scriptSighash(tx, i, prevouts, leaf) { const ht = SIGHASH_ALL | (unified ? SIGHASH_UNIFIED : 0); let m = unified ? k.interpreter.sighashUnified(tx, i, prevouts, ht, 3, { leafHash: unhex(leaf) }) : k.interpreter.sighashTaproot(tx, i, prevouts, ht, { leafHash: unhex(leaf) }); if (typeof m === 'string') m = unhex(m); return { m, ht }; }
  function signLeaf(tx, i, prevouts, leaf, key) { const { m, ht } = scriptSighash(tx, i, prevouts, leaf); return hex(signer.schnorrSign(m, key)) + ht.toString(16).padStart(2, '0'); }
  function verifyLeafSig(tx, i, prevouts, leaf, pub, sig) { if (!/^[0-9a-f]{130}$/.test(sig ?? '')) return false; const { m, ht } = scriptSighash(tx, i, prevouts, leaf); if (sig.slice(128) !== ht.toString(16).padStart(2, '0')) return false; try { return secp.verifySchnorr(m, unhex(sig.slice(0, 128)), unhex(pub)) === true; } catch { return false; } }
  // the funding spend's witness: signatures in reverse leaf order (first signer's on top), the script, the control block
  function fundingWitness(ch, sigs) { const f = ch.funding; const slots = f.signers.map((p) => sigs[p]).reverse(); if (slots.some((s) => !s)) throw new Error('both signatures are needed'); return [...slots, f.script, f.control]; }
  function signFunding(ch, tx, key) { return signLeaf(tx, 0, [fundingPrevout(ch)], ch.funding.leaf, key); }
  function verifyFunding(ch, tx, pub, sig) { return verifyLeafSig(tx, 0, [fundingPrevout(ch)], ch.funding.leaf, pub, sig); }
  // spend a to_local: after the delay by its owner (sequence = delay), or at once with the revocation secret
  function sweepTx({ commit, txid, vout, value, to, fee, delayed, key }) { const tx = { version: 2, inputs: [{ prevout: { txid, vout }, scriptSig: '', sequence: delayed ? commit.toLocal ? delayed : delayed : 0xfffffffd }], outputs: [{ value: value - fee, scriptPubKey: to }], lockTime: 0, witness: [[]] };
    const leaf = delayed ? commit.toLocal.delayed : commit.toLocal.revocation; const prev = [{ value, scriptPubKey: commit.toLocal.spk }]; const sig = signLeaf(tx, 0, prev, leaf.leaf, key); tx.witness = [[sig, leaf.script, leaf.control]]; return tx; }
  // claim an HTLC output of a commitment: with the preimage (success), after the expiry (timeout), or with the revocation secret
  function htlcClaim({ commit, htlc, kind, txid, value, to, fee, key, preimage = null }) { const leaf = htlc.scripts[kind]; if (!leaf) throw new Error('no such leaf');
    const seq = leaf.csv ? commit.delay ?? 0 : 0xfffffffe; const tx = { version: 2, inputs: [{ prevout: { txid, vout: htlc.vout }, scriptSig: '', sequence: kind === 'revocation' ? 0xfffffffd : seq }], outputs: [{ value: value - fee, scriptPubKey: to }], lockTime: kind === 'timeout' ? htlc.expiry : 0, witness: [[]] };
    const prev = [{ value, scriptPubKey: htlc.scripts.spk }]; const sig = signLeaf(tx, 0, prev, leaf.leaf, key); tx.witness = [kind === 'success' ? [sig, preimage, leaf.script, leaf.control] : [sig, leaf.script, leaf.control]]; return tx; }
  // a to_remote is a plain key-path coin of the other key: any wallet spends it; here for completeness
  function keyPathSpend({ txid, vout, value, spk, to, fee, key }) { const tx = { version: 2, inputs: [{ prevout: { txid, vout }, scriptSig: '', sequence: 0xfffffffd }], outputs: [{ value: value - fee, scriptPubKey: to }], lockTime: 0, witness: [[]] }; const ht = SIGHASH_ALL | (unified ? SIGHASH_UNIFIED : 0); let m = unified ? k.interpreter.sighashUnified(tx, 0, [{ value, scriptPubKey: spk }], ht, 2) : k.interpreter.sighashTaproot(tx, 0, [{ value, scriptPubKey: spk }], ht); if (typeof m === 'string') m = unhex(m); tx.witness = [[hex(signer.schnorrSign(m, key)) + ht.toString(16).padStart(2, '0')]]; return tx; }
  function verifyTx(tx, prevouts) { for (let i = 0; i < tx.inputs.length; i++) { const v = k.interpreter.verifyInput(tx, i, prevouts[i], prevouts, null, { unifiedSighash: unified }); if (v.ok !== true) return { ok: false, input: i, error: v.error ?? v.reason ?? 'script failed' }; } return { ok: true }; }
  const txid = (tx) => k.codec.txid(tx); const encode = (tx) => k.codec.encodeHex('Transaction', tx); const decode = (h) => k.codec.decode('Transaction', h);
  return { internal, fundingScript, toLocalScript, toRemoteScript, htlcScript, htlcClaim, commitmentTx, closingTx, fundingPrevout, signLeaf, verifyLeafSig, fundingWitness, signFunding, verifyFunding, sweepTx, keyPathSpend, verifyTx, txid, encode, decode, unified };
}
