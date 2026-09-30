# Hitch

**Payment channels in a browser tab, in the Lightning shape.** A 2-of-2 funding output on txbt4 (the BLAKE2b testnet4), asymmetric commitment transactions with a revocable to_local, penalties for old states, cooperative and forced closes. The tab's own node funds, watches and settles; two tabs pay each other over the relays without touching the chain.

Live: https://bitcoin-blake.github.io/hitch/

## What it is, and is not

Hitch is the Lightning construction without the Lightning network. There are no Lightning nodes on this chain to talk to, and a tab has no TCP, so the peer is another tab and the transport is Nostr. It is a demonstration of the mechanics on a chain where everything else, the node, the mempool and the mining, already runs in a tab: [Reef](https://github.com/bitcoin-blake/reef), [Bight](https://github.com/bitcoin-blake/bight), [Winch](https://github.com/bitcoin-blake/winch). It is not compatible with Lightning peers, has no HTLCs and no routing (payments are direct, on a channel between the two parties), and is not private: channel messages are signed, not encrypted.

## How it works

- **The keys.** Reef's key in this browser when there is one (same origin, same storage), so Reef's coins fund channels and Reef sees what comes back; else a key Hitch keeps. The same key signs the channel's transactions and the relay messages, so the node id is the key.
- **Funding.** The funder builds a transaction from its on-chain coins to a taproot output whose one leaf is `multi_a(2, a, b)` under an unspendable internal key, and keeps it back until the other side has signed the funder's first commitment. Then it goes out as a kind 23503 event, which a sidestr producer with a node broadcasts; the tab sees it confirm in its own UTXO set.
- **Commitments.** Each side holds its own commitment for the current state: its balance in a to_local with two leaves (its own key after `delay` blocks, or a revocation key at once) and the other's balance paid straight to the other's key. A state is replaced by an update: the payer signs the payee's next commitment, the payee signs the payer's and reveals the secret of its old revocation key, the payer reveals its own. Revocation keys are announced one state ahead so the payer can sign first. Every transaction is built by `lib/channel.mjs` and checked by the kernel's interpreter before it is used; `test/channel-test.mjs` runs the constructions (17 checks).
- **Closing.** Cooperative: both sign one transaction paying the balances to the keys. Forced: publish your latest commitment; your share waits `delay` blocks, then the tab sweeps it. Cheating: publish an old commitment; the other tab, watching the funding output through its own node, recognises the revoked state, spends its to_local with the revealed secret, and takes it all. The Cheat button on a channel exists to show that.
- **Invoices.** `hitch1…` strings naming the node, an amount and a memo; paying one is an update on a channel to that node.

Fees are a fixed amount per channel transaction, paid by the funder. The delay is 6 blocks by default, about two hours here.

## Name

A hitch ties a line to something. Reef the knot, Bight the slack, Winch the pull, Hitch the tie.

## Licence

AGPL-3.0-or-later.
