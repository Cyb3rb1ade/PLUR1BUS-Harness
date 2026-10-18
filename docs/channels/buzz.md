# Buzz / Nostr

## Setup (DE)

Buzz ist standardmäßig aus. Den privaten Bot-Schlüssel (hex oder nsec) im Secret-Store unter `channels.buzz.private-key` speichern. Niemals den Schlüssel in Config oder Terminal-Argumente kopieren. Unter `channels.buzz` `privateKeySecret` auf diesen Namen setzen, `relays` mit bis zu 16 `wss://`-Adressen und `senderAllowlist` mit hex/npub-Schlüsseln der erlaubten Personen befüllen. Die Relay-Hosts und Ports zusätzlich in der Egress-Policy erlauben; dann `enabled` aktivieren. Nur für lokale Tests ist `ws://127.0.0.1` bzw. `ws://[::1]` erlaubt.

Der Empfänger muss eine signierte NIP-17 DM-Relay-Liste (Kind 10050) veröffentlichen. Antworten gehen ausschließlich an deren Schnittmenge mit den konfigurierten Relays. Fehlt diese, gibt es keine alternative Broadcast-Zustellung. Die Person über den normalen Pairing-Flow verknüpfen: Code erzeugen, `/link <Code>` als DM senden, Claim als Owner bestätigen. Ohne Verknüpfung startet kein Agent-Turn.

## Setup (EN)

Buzz starts disabled. Put the bot private key (hex or nsec) in SecretStore as `channels.buzz.private-key`; set `privateKeySecret` to that reference. Configure `relays` (up to 16 wss URLs), `senderAllowlist` (hex/npub public keys), permit those relay hosts/ports through Egress, then enable. Credentials in relay URLs are refused. Loopback-only ws is a test exception.

Recipients must advertise their DM relays using a signed kind-10050 event. Pair using a normal code, `/link <code>` in a DM, then owner confirmation. Unlinked senders cannot start a turn. The shipped shared direct behaviour profile applies to local commands and replies as well.

## Boundaries

Only signed NIP-59 wraps containing a valid NIP-17 kind-14 one-to-one rumor are admitted. Both outer and seal signatures, author binding, rumor hash, recipient, allowlist, age and size are checked. No custom Buzz kinds, NIP-04, group DMs or files. Inbound text is untrusted. Relays see metadata; Nostr privacy is not anonymity.

Multiple independent relay loops reconnect with capped exponential backoff and jitter. Egress pins vetted addresses. Logs contain fixed event names only. File replay claims are private, fsynced and atomically replaced. Claims precede handling (at-most-once, possible loss on an interrupted turn), retain 65,536 IDs and reject messages older than 48 hours. Relay OK confirms acceptance only.
