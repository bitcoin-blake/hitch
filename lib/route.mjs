// After a state becomes final: a payee settles an HTLC that pays one of its invoices (the right amount, enough time left);
// a hub forwards an HTLC with a route to the next channel and carries the settle or the fail back. Forwards are kept on the
// downstream channel document, keyed by the payment hash, so a restart or a second payment in flight cannot lose them.
// Pure; hosts wire onUpdate / onDropped / onPreimage to the peer's io and give `invoices`: a Map hash → { preimage, amount, paid? }.
import { EXPIRY_MARGIN, CLAIM_MARGIN, MIN_HTLC } from './peer.mjs';
export function makeRouter({ peer, io, invoices, hub = false, retryMs = 1500, retries = 20 }) {
  const inv = (h) => { const v = invoices.get(h); if (!v) return null; return typeof v === 'string' ? { preimage: v, amount: 0 } : v; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // an update that cannot go out yet (another pending, or waiting for a revocation) is tried again a few times; the outcome is the last try's
  async function withRetry(fn, what) { for (let i = 0; ; i++) { try { await fn(); return true; } catch (e) { if (/pending|revocation|resyncing/.test(e.message) && i < retries) { await sleep(retryMs); continue; } io.log(`${what}: ${e.message}`, 'e'); return false; } } }
  const upstreamOf = (down, hash) => { const f = down.forwards?.[hash]; return f ? peer.byId(f.up) : peer.channels.find((c) => c.status === 'open' && c.id !== down.id && peer.htlcs(c).some((x) => x.hash === hash && x.from !== peer.me(c))); };
  const upstreamHtlc = (up, hash) => peer.htlcs(up).find((x) => x.hash === hash && x.from !== peer.me(up));
  // the blocks a forward must give up between the upstream and the downstream expiry: the hub has to have the downstream
  // preimage on the chain (or in hand) before its own claim deadline upstream (delay + CLAIM_MARGIN before the upstream expiry)
  const forwardDelta = (up) => EXPIRY_MARGIN + up.delay + CLAIM_MARGIN;
  async function settleUpstream(down, hash, preimage, why) {
    const up = upstreamOf(down, hash); if (!up) return; const upH = upstreamHtlc(up, hash); if (!upH) { if (down.forwards?.[hash]) { delete down.forwards[hash]; io.save(); } return; }
    peer.rememberPreimage(up, hash, preimage); io.log(`htlc ${hash.slice(0, 12)}… ${why}; settling htlc ${upH.id} of ${up.id} upstream`);
    await withRetry(() => peer.settleHtlc(up, upH.id, preimage), 'settle upstream');
    if (down.forwards?.[hash]) { delete down.forwards[hash]; io.save(); }
  }
  async function failUpstream(down, hash, reason) {
    const up = upstreamOf(down, hash); if (!up) return; const upH = upstreamHtlc(up, hash); if (!upH) { if (down.forwards?.[hash]) { delete down.forwards[hash]; io.save(); } return; }
    io.log(`htlc ${hash.slice(0, 12)}… failed downstream; failing htlc ${upH.id} of ${up.id} upstream`);
    await withRetry(() => peer.failHtlc(up, upH.id, reason ?? 'downstream failed'), 'fail upstream');
    if (down.forwards?.[hash]) { delete down.forwards[hash]; io.save(); }
  }
  async function onUpdate(ch, m, sender) {
    if (m.kind === 'add') {
      const h = m.htlc; const i = inv(h.hash);
      if (i) {
        if (i.paid) { io.log(`htlc ${h.id} on ${ch.id} pays an invoice already paid; failing it`); await withRetry(() => peer.failHtlc(ch, h.id, 'invoice already paid'), 'fail'); return; }
        if (h.amount < (i.amount ?? 0)) { io.log(`htlc ${h.id} on ${ch.id} pays ${h.amount} sat for an invoice of ${i.amount}; failing it`); await withRetry(() => peer.failHtlc(ch, h.id, 'amount below the invoice'), 'fail'); return; }
        if (h.expiry < io.height() + ch.delay + EXPIRY_MARGIN) { io.log(`htlc ${h.id} on ${ch.id} leaves too little time; failing it`); await withRetry(() => peer.failHtlc(ch, h.id, 'expiry too close'), 'fail'); return; }
        peer.rememberPreimage(ch, h.hash, i.preimage);
        await withRetry(() => peer.settleHtlc(ch, h.id, i.preimage), 'settle');
        io.log(`invoice ${h.hash.slice(0, 12)}… paid: ${h.amount} sat on ${ch.id}`); io.notify?.('Invoice paid', `${h.amount} sat on ${ch.id}`); io.onInvoicePaid?.(h.hash, h.amount); return; }
      if (hub && h.route?.to) {
        const down = peer.channels.find((c) => c.status === 'open' && c.peer === h.route.to); const amount = h.amount - peer.hubFee, expiry = h.expiry - forwardDelta(ch);
        if (!down || peer.room(down) < amount || amount < MIN_HTLC || expiry <= io.height() + down.delay + EXPIRY_MARGIN) { io.log(`no route for htlc ${h.id} on ${ch.id} to ${h.route.to.slice(0, 12)}…: failing it`); await withRetry(() => peer.failHtlc(ch, h.id, 'no route'), 'fail'); return; }
        if (peer.htlcs(down).some((x) => x.hash === h.hash) || down.forwards?.[h.hash]) { io.log(`htlc ${h.id} on ${ch.id}: the same hash is already forwarded on ${down.id}; failing it`); await withRetry(() => peer.failHtlc(ch, h.id, 'duplicate hash'), 'fail'); return; }
        io.log(`forwarding htlc ${h.id} of ${ch.id} to ${down.id}: ${amount} sat to ${h.route.to.slice(0, 12)}…, fee ${peer.hubFee}, expiry ${expiry}`);
        down.forwards ??= {}; down.forwards[h.hash] = { up: ch.id, htlcId: h.id, at: io.height() }; io.save();
        const ok = await withRetry(() => peer.addHtlc(down, { amount, hash: h.hash, expiry, route: null }), 'forward');
        if (!ok) { delete down.forwards[h.hash]; io.save(); await withRetry(() => peer.failHtlc(ch, h.id, 'could not forward'), 'fail back'); } return; }
      io.log(`htlc ${h.id} on ${ch.id}: no invoice for ${h.hash.slice(0, 12)}…; failing it`); await withRetry(() => peer.failHtlc(ch, h.id, 'unknown hash'), 'fail'); return; }
    if (hub && (m.kind === 'settle' || m.kind === 'fail')) {
      const h = (ch.states[ch.n - 1]?.htlcs ?? []).find((x) => x.id === m.htlcId); if (!h || h.from !== peer.me(ch)) return; // only HTLCs I offered downstream have an upstream
      if (m.kind === 'settle') await settleUpstream(ch, h.hash, m.preimage, `of ${ch.id} settled downstream`); else await failUpstream(ch, h.hash, m.reason); }
  }
  // a forward of mine that was set aside (a collision or a rejection) is failed back upstream at once
  async function onDropped(ch, intent) { if (!hub || intent.kind !== 'add') return; await failUpstream(ch, intent.htlc.hash, 'could not forward'); }
  // a preimage read from the chain (the payee claimed on a closed downstream channel) settles upstream
  async function onPreimage(ch, hash, preimage) { if (!hub) return; await settleUpstream(ch, hash, preimage, `of ${ch.id} was claimed on the chain`); }
  // on every tick: a hub whose forwarded HTLC is still unresolved past its downstream expiry closes the downstream channel, so the chain decides
  async function tick() { if (!hub) return; for (const down of peer.channels) { if (down.status !== 'open' || !down.forwards) continue; for (const [h, f] of Object.entries(down.forwards)) { const up = peer.byId(f.up); const upH = up && upstreamHtlc(up, h); if (!upH) { delete down.forwards[h]; io.save(); continue; } const downH = peer.htlcs(down).find((x) => x.hash === h); if (downH && io.height() > downH.expiry && !down.pending) { io.log(`htlc ${h.slice(0, 12)}… forwarded on ${down.id} is unresolved past its expiry; closing ${down.id} so the chain decides`, 'e'); try { await peer.forceClose(down, down.n, 'protective'); } catch (e) { io.log(`protective close of ${down.id}: ${e.message}`, 'e'); } } } } }
  return { onUpdate, onDropped, onPreimage, tick, forwardDelta };
}
