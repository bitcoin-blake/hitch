// What happens after an update lands: a payee settles an HTLC whose hash it issued an invoice for; a hub forwards an HTLC
// with a route to the next channel and carries the settle or the fail back. Pure; hosts wire it to the peer's io.onUpdate.
import { EXPIRY_MARGIN } from './peer.mjs';
export function makeRouter({ peer, io, invoices, hub = false }) {
  const forwards = new Map(); // `${downstream channel}:${htlc id}` → { up: channel id, htlcId }
  const later = (fn) => setTimeout(() => fn().catch((e) => io.log('later: ' + e.message, 'e')), 1500);
  const withRetry = async (fn, what) => { try { await fn(); } catch (e) { if (/pending/.test(e.message)) later(() => withRetry(fn, what)); else io.log(`${what}: ${e.message}`, 'e'); } };
  async function onUpdate(ch, m, sender) {
    if (m.kind === 'add') { const h = m.htlc; const preimage = invoices.get(h.hash);
      if (preimage) { await withRetry(() => peer.settleHtlc(ch, h.id, preimage), 'settle'); io.log(`invoice ${h.hash.slice(0, 12)}… paid: ${h.amount} sat on ${ch.id}`); io.notify?.('Invoice paid', `${h.amount} sat on ${ch.id}`); io.onInvoicePaid?.(h.hash, h.amount); return; }
      if (hub && h.route?.to) { const down = peer.channels.find((c) => c.status === 'open' && c.peer === h.route.to); const amount = h.amount - peer.hubFee, expiry = h.expiry - EXPIRY_MARGIN;
        if (!down || peer.room(down) < amount || amount < 1000 || expiry <= io.height() + EXPIRY_MARGIN) { io.log(`no route for htlc ${h.id} on ${ch.id} to ${h.route.to.slice(0, 12)}…: failing it`); await withRetry(() => peer.failHtlc(ch, h.id, 'no route'), 'fail'); return; }
        const id = (down.states[down.n].htlcs ?? []).reduce((a, x) => Math.max(a, x.id), 0) + 1; forwards.set(`${down.id}:${id}`, { up: ch.id, htlcId: h.id });
        io.log(`forwarding htlc ${h.id} of ${ch.id} as htlc ${id} of ${down.id}: ${amount} sat to ${h.route.to.slice(0, 12)}…, fee ${peer.hubFee}`); await withRetry(() => peer.addHtlc(down, { amount, hash: h.hash, expiry, route: null }), 'forward'); return; }
      io.log(`htlc ${h.id} on ${ch.id}: no invoice for ${h.hash.slice(0, 12)}…; failing it`); await withRetry(() => peer.failHtlc(ch, h.id, 'unknown hash'), 'fail'); return; }
    if (hub && (m.kind === 'settle' || m.kind === 'fail')) { const f = forwards.get(`${ch.id}:${m.htlcId}`); if (!f) return; forwards.delete(`${ch.id}:${m.htlcId}`); const up = peer.byId(f.up); if (!up) return;
      if (m.kind === 'settle') { io.log(`htlc ${m.htlcId} of ${ch.id} settled downstream; settling htlc ${f.htlcId} of ${up.id} upstream`); await withRetry(() => peer.settleHtlc(up, f.htlcId, m.preimage), 'settle upstream'); }
      else { io.log(`htlc ${m.htlcId} of ${ch.id} failed downstream; failing htlc ${f.htlcId} of ${up.id} upstream`); await withRetry(() => peer.failHtlc(up, f.htlcId, m.reason ?? 'downstream failed'), 'fail upstream'); } }
    if (!hub && m.kind === 'settle' && sender !== peer.me(ch)) { io.onPaid?.(ch, m); } }
  // remember the preimage of every HTLC settled through a channel, so a claim on chain has it
  return { onUpdate, forwards };
}
