# Your account and passkeys

For a native or VPS installation, open the **Your account** wizard step. Read the one-time proof locally from the private `run/api-bootstrap.token` file, enter a username and a password of at least 12 characters, then choose **Create account**. The proof expires after 15 minutes. Restarting the API before account creation rotates an expired proof. Successful creation consumes it permanently and removes the proof file; the reusable Owner token can no longer sign in.

The bundled desktop installer creates the Owner account and marks bootstrap completed; there is no proof in this variant.

Under **Settings → Security**, name and add a passkey. Use a browser address with a domain name: `localhost` locally or your configured HTTPS remote host. Raw IP addresses cannot act as a WebAuthn relying-party domain in Chromium. Your authenticator must support discoverable credentials and verify you (for example, a device PIN or biometric unlock). ES256 and Ed25519 keys are supported, with up to 20 keys per account. Use the name field with **Rename** to change an existing name, or **Revoke** to remove a key. Each credential change ends existing sessions; sign in again afterward.

On the login page choose username/password mode, enter your username, then **Use a passkey**. If you enter a password first and have an enrolled passkey, the next step can also use that passkey. TOTP enrollment, confirmation and removal are available in the same Security section; save the backup codes shown after confirmation before navigating away.

A signed assertion with a counter that repeats or moves backward is refused and emits a clone warning in the audit log. Authenticators that always report zero are supported. OIDC is scheduled after M3.
