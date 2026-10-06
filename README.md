# MZR Books bootstrap

This public npm package contains the launcher, not application binaries. It is
currently **unpublished and release-gated**. Authentication is initiated only on
explicit installation or first execution; npm lifecycle scripts are not used.

An authorized device flow obtains short-lived private download access. A signed
manifest and complete binary hash are verified before execution. The trust root
and public OAuth client ID must be populated by the release process. No backend
administrator key, user token or Google credential belongs in this package.

Node 22+ is required for this route. Windows/WSL installations are independent.
Direct browser downloads are a separate release gate. Cache cleanup never removes
the Go client's profile or secure credential store.

Additional local bootstrap actions (not advertised as published npm installs):

- `install-offline --manifest ENVELOPE.json --binary VERIFIED_BINARY`: verify a
  signed, unexpired manifest and platform hash before copying atomically. This
  imports software only, not membership or credentials.
- `unlock --yes`: recover a stopped installer's lock; a live/unknown installer
  and incomplete lock are never silently removed.
- `rollback`: reverify the prior manifest and binary before changing atomic state.

Installation and state changes are locked across processes. Unsafe symlinked
directories and partial files are refused. Downloads remain resumable and
authenticated; all complete bytes must match the signed size and SHA-256.
Explicit proxy support uses pinned Undici with a per-bootstrap dispatcher:
`--bootstrap-proxy http://proxy.example:8080` or `--bootstrap-proxy-env` for
HTTP_PROXY/HTTPS_PROXY/NO_PROXY (lowercase takes precedence). Default is direct.
Proxy URLs with credentials, paths, queries or unsupported schemes are refused;
authenticated proxy provisioning is not implemented through URL passwords.
These bootstrap flags are removed before launching the Go application, which
uses its own standard Go HTTP proxy configuration. TLS verification is never
disabled; trusted enterprise CAs must be provisioned through the supported Node
trust configuration by the operator. Low-level transport errors are redacted.
See [Undici proxy documentation](https://github.com/nodejs/undici/blob/main/docs/docs/api/EnvHttpProxyAgent.md).

Resume requires exact signed total/end/length and complete SHA-256. A short body
stays an untrusted partial for an explicit retry. A complete interrupted partial
is hashed before atomic recovery, without another download. Purge validates the
exact cache targets, refuses unknown content and leaves its lock and application
draft/profile/vault storage intact. Only isolated fixture caches were removed
during tests; no real installed cache was deleted.

Native permission/enterprise TLS and the published cross-platform installation
matrix remain release gates. No package has been published by these changes.
