# Remote access

In **Settings → Devices & Remote**, choose `local`, `tailnet` or `network`. The default is `tailnet`; Tailscale must be installed and signed in. When unavailable, Doctor reports the reason and the API opens no network fallback. `local` hides the pairing card. The German version of this page is [../de/remote-access.md](../de/remote-access.md).

Owner and Admin should first enroll TOTP or a passkey locally. Remote login requires a second factor by default. A local password-only cookie does not satisfy that requirement.

`network` requires an HTTPS origin, TLS and explicit confirmation of the security notice. The server generates a self-signed certificate, or you can upload a certificate and matching private key as PEM. Existing certificates are staged first. Keys remain private on the server. Restrict client subnets using CIDRs when appropriate. Restart the API process or daemon after configuration changes; restarting only Core is insufficient. `1staid check` reports a warning while `network` is enabled.

Open a pairing code and use its QR/deep link with certificate fingerprint, or enter the code in a supported client. The client verifies the certificate proof before sending a typed code. Do not bypass a changed-certificate warning. Codes expire and are single use.

For certificate rotation, **Stage** first. Devices receive the next trust over their existing trusted connection and acknowledge it with their device key. Activate afterward. Devices that missed the announcement must pair again. The API is never published through Funnel.
