# Hitch

**Payment channels in a browser tab, in the Lightning shape.** A 2-of-2 funding output on txbt4 (the BLAKE2b testnet4), asymmetric commitment transactions with a revocable to_local, penalties for old states, cooperative and forced closes. The tab's own node funds, watches and settles; two tabs pay each other over the relays without touching the chain.

Live: https://bitcoin-blake.github.io/hitch/

## What it is, and is not

Hitch is the Lightning construction without the Lightning network. There are no Lightning nodes on this chain to talk to, and a tab has no TCP, so the peer is another tab and the transport is Nostr. It is a demonstration of the mechanics on a chain where everything else, the node, the mempool and the mining, already runs in a tab: [Reef](https://github.com/bitcoin-blake/reef), [Bight](https://github.com/bitcoin-blake/bight), [Winch](https://github.com/bitcoin-blake/winch). It is not compatible with Lightning peers, routes only through a hub you have a channel with (no gossip, no pathfinding, no onion), and is not private: channel messages are signed, not encrypted, so amounts and memos are readable on the relays.

## How it works

- **The keys.** Reef's key in this browser when there is one (same origin, same storage), so Reef's coins fund channels and Reef sees what comes back; else a key Hitch keeps. The same key signs the channel's transactions and the relay messages, so the node id is the key.
- **Funding.** The funder builds a transaction from its on-chain coins to a taproot output whose one leaf is `multi_a(2, a, b)` under an unspendable internal key, and keeps it back until the other side has signed the funder's first commitment. Then it goes out as a kind 23503 event, which a sidestr producer with a node broadcasts; the tab sees it confirm in its own UTXO set.
- **Commitments.** Each side holds its own commitment for the current state: its balance in a to_local with two leaves (its own key after `delay` blocks, or a revocation key at once) and the other's balance paid straight to the other's key. A state is replaced by an update: the payer signs the payee's next commitment, the payee signs the payer's and reveals the secret of its old revocation key, the payer reveals its own. Revocation keys are announced one state ahead so the payer can sign first. Every transaction is built by `lib/channel.mjs` and checked by the kernel's interpreter before it is used; `test/channel-test.mjs` runs the constructions and pins the scripts as golden vectors; `test/peer-test.mjs` and `test/adversarial-test.mjs` run three peers in memory through payments, routing, lost and reordered messages, a collision, a cheat, a restart and a forced close with an HTLC in flight.
- **Closing.** Cooperative: both sign one transaction paying the balances to the keys. Forced: publish your latest commitment; your share waits `delay` blocks, then the tab sweeps it. Cheating: publish an old commitment; the other tab, watching the funding output through its own node, recognises the revoked state, spends its to_local with the revealed secret, and takes it all. The Cheat button on a channel exists to show that.
- **Invoices.** `hitch1…` strings naming the node, an amount, a payment hash, the hubs the node has channels with, and an expiry; paying one is an HTLC that the issuer settles with the preimage.

Fees are a fixed amount per channel transaction, agreed at open and paid by the funder. The delay is 6 blocks by default, about two hours here; a tab refuses channels with a shorter one. A payment is final only when the payer has revoked the state before it; until then nothing is forwarded, settled or announced. Keep the tab open while anything is in flight or a close is being watched: a closed tab cannot punish a cheat.

## The first run (30 September 2026)

Two tabs on one machine, each its own node, over the live txbt4 chain with blocks about twenty minutes apart.

| step | block | what happened |
|---|---|---|
| open | 152,081 | A proposed 100,000 sat to B; accepted, both first commitments signed, funding published, in 8 s |
| pay | – | A paid B's 5,000 sat invoice; B pushed 1,000 back; state 2, both revocation secrets exchanged |
| close | 152,082 | A asked, B signed and published; 4,000 sat to B's key, the rest to A's |
| cheat | 152,083 | on a second channel A paid 30,000 then published its revoked state 0 |
| penalty | 152,084 | B's tab found the old commitment in its own chain within 40 s, spent its to_local with the revealed secret: 99,400 sat to B, accepted by the Knots node |

## Through a hub

HTLCs are in since the second night: a hash-locked output in each commitment with three leaves (the receiver with the preimage, the offerer after the expiry, the revocation key), the commitment's owner waiting the delay on its own claims so a revoked commitment's HTLCs can still be punished. An invoice carries the payment hash and the node ids of the issuer's hubs; paying it is an HTLC on a channel to the issuer, or to one of its hubs with the route, and the issuer settles with the preimage. `bin/hub.mjs` runs the same protocol in Node over the local node's RPC: it accepts channels (open one to it with a push if you want it to pay you back), forwards HTLCs for a fee and carries settles and fails back. The protocol is `lib/peer.mjs` and `lib/route.mjs`, pure; `test/peer-test.mjs` runs A, a hub and B in memory.

First routed payment, 30 September 2026, on the live chain: A opened 100,000 sat to the estate's hub, B opened 100,000 with 50,000 pushed to the hub (block 152,086); B issued a 20,000 sat invoice naming the hub; A's HTLC of 20,010 crossed the hub as an HTLC of 20,000 to B, B settled with the preimage, the hub settled upstream; 25 seconds end to end, nothing on the chain.

## Name

A hitch ties a line to something. Reef the knot, Bight the slack, Winch the pull, Hitch the tie.

## Licence

AGPL-3.0-or-later.
