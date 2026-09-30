// After a state becomes final: a payee settles an HTLC that pays one of its invoices (the right amount, enough time left);
// a hub forwards an HTLC with a route to the next channel and carries the settle or the fail back. Forwards are kept on the
// downstream channel document, keyed by the payment hash, so a restart or a second payment in flight cannot lose them.
// Pure; hosts wire `onUpdate` to the peer's io.onUpdate and give `invoices`: a Map hash → { preimage, amount, paid? }.
import { EXPIRY_MARGIN, MIN_HTLC } from './peer.mjs';
export function makeRouter({ peer, io, invoices, hub = false }) {
  const inv = (h) => { const v = invoices.get(h); if (!v) return null; return typeof v === 'string' ? { preimage: v, amount: 0 } : v; };
  const later = (fn, ms = 1500) => setTimeout(() => fn().catch((e) => io.log('later: ' + e.message, 'e')), ms);
  // an update that cannot go out yet (another pending, or waiting for a revocation) is tried again a few times
  const withRetry = async (fn, what, tries = 20) => { try { await fn(); return true; } catch (e) { if (/pending|revocation|resyncing/.test(e.message) && tries > 0) { later(() => withRetry(fn, what, tries - 1)); return true; } io.log(`${what}: ${e.message}`, 'e'); return false; } };
  const upstreamOf = (down, h) => { const f = down.forwards?.[h.hash]; return f ? peer.byId(f.up) : peer.channels.find((c) => c.status === 'open' && c.id !== down.id && peer.htlcs(c).some((x) => x.hash === h.hash && x.from !== peer.me(c))); };
  async function onUpdate(ch, m, sender) {
    if (m.kind === 'add') {
      const h = m.htlc; const i = inv(h.hash);
      if (i) {
        if (h.amount < (i.amount ?? 0)) { io.log(`htlc ${h.id} on ${ch.id} pays ${h.amount} sat for an invoice of ${i.amount}; failing it`); await withRetry(() => peer.failHtlc(ch, h.id, 'amount below the invoice'), 'fail'); return; }
        if (h.expiry < io.height() + ch.delay + EXPIRY_MARGIN) { io.log(`htlc ${h.id} on ${ch.id} leaves too little time; failing it`); await withRetry(() => peer.failHtlc(ch, h.id, 'expiry too close'), 'fail'); return; }
        peer.rememberPreimage(ch, h.hash, i.preimage);
        await withRetry(() => peer.settleHtlc(ch, h.id, i.preimage), 'settle');
        io.log(`invoice ${h.hash.slice(0, 12)}… paid: ${h.amount} sat on ${ch.id}`); io.notify?.('Invoice paid', `${h.amount} sat on ${ch.id}`); io.onInvoicePaid?.(h.hash, h.amount); return; }
      if (hub && h.route?.to) {
        const down = peer.channels.find((c) => c.status === 'open' && c.peer === h.route.to); const amount = h.amount - peer.hubFee, expiry = h.expiry - EXPIRY_MARGIN;
        if (!down || peer.room(down) < amount || amount < MIN_HTLC || expiry <= io.height() + down.delay + EXPIRY_MARGIN) { io.log(`no route for htlc ${h.id} on ${ch.id} to ${h.route.to.slice(0, 12)}…: failing it`); await withRetry(() => peer.failHtlc(ch, h.id, 'no route'), 'fail'); return; }
        io.log(`forwarding htlc ${h.id} of ${ch.id} to ${down.id}: ${amount} sat to ${h.route.to.slice(0, 12)}…, fee ${peer.hubFee}`);
        const ok = await withRetry(async () => { await peer.addHtlc(down, { amount, hash: h.hash, expiry, route: null }); down.forwards ??= {}; down.forwards[h.hash] = { up: ch.id, htlcId: h.id, at: io.height() }; io.save(); }, 'forward');
        if (!ok) await withRetry(() => peer.failHtlc(ch, h.id, 'could not forward'), 'fail back'); return; }
      io.log(`htlc ${h.id} on ${ch.id}: no invoice for ${h.hash.slice(0, 12)}…; failing it`); await withRetry(() => peer.failHtlc(ch, h.id, 'unknown hash'), 'fail'); return; }
    if (hub && (m.kind === 'settle' || m.kind === 'fail')) {
      const cur = ch.states[ch.n - 1] ?? ch.states[ch.n]; const h = (cur.htlcs ?? []).find((x) => x.id === m.htlcId) ?? (ch.states[ch.n - 1]?.htlcs ?? []).find((x) => x.id === m.htlcId); if (!h) return;
      const up = upstreamOf(ch, h); if (!up) return;
      const upH = peer.htlcs(up).find((x) => x.hash === h.hash && x.from !== peer.me(up)); if (!upH) { if (ch.forwards) { delete ch.forwards[h.hash]; io.save(); } return; }
      if (m.kind === 'settle') { peer.rememberPreimage(up, h.hash, m.preimage); io.log(`htlc ${h.id} of ${ch.id} settled downstream; settling htlc ${upH.id} of ${up.id} upstream`); await withRetry(() => peer.settleHtlc(up, upH.id, m.preimage), 'settle upstream'); }
      else { io.log(`htlc ${h.id} of ${ch.id} failed downstream; failing htlc ${upH.id} of ${up.id} upstream`); await withRetry(() => peer.failHtlc(up, upH.id, m.reason ?? 'downstream failed'), 'fail upstream'); }
      if (ch.forwards) { delete ch.forwards[h.hash]; io.save(); } }
  }
  // on every tick: a hub whose upstream HTLC is nearing expiry with the downstream one unresolved closes the downstream channel, so the chain decides
  async function tick() { if (!hub) return; for (const down of peer.channels) { if (down.status !== 'open' || !down.forwards) continue; for (const [h, f] of Object.entries(down.forwards)) { const up = peer.byId(f.up); const upH = up && peer.htlcs(up).find((x) => x.hash === h); if (!upH) { delete down.forwards[h]; io.save(); continue; } if (io.height() >= upH.expiry - Math.floor(EXPIRY_MARGIN / 2) && peer.htlcs(down).some((x) => x.hash === h)) { io.log(`htlc ${h.slice(0, 12)}… forwarded on ${down.id} is unresolved with the upstream expiry near; closing ${down.id} so the chain decides`, 'e'); try { await peer.forceClose(down, down.n, 'protective'); } catch (e) { io.log(`protective close of ${down.id}: ${e.message}`, 'e'); } } } } }
  return { onUpdate, tick };
}
