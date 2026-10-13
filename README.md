# mzrbook

Installer and launcher for **MZR Books**, the team book-tracking command line app.

This package is only the launcher. The application itself is private: it is
downloaded after you sign in, and only for accounts that are active members of
the MZR Books team.

```sh
npm install --global mzrbook      # or:  npx mzrbook
mzrbook
```

The first run:

1. checks your Node.js, operating system and processor (Windows, Linux or macOS,
   on x64 or arm64),
2. prints a sign-in link and a short code - open it in any browser, on any
   device, and check the code matches,
3. downloads the build for your machine and verifies it before it is ever run,
4. starts MZR Books. After that, `mzrbook` just opens it.

`mzr` is a short alias for the same command.

## Everyday commands

| Command | What it does |
|---|---|
| `mzrbook` | Open MZR Books (installs it first if needed). |
| `mzrbook update [--channel stable\|beta] [--version X.Y.Z]` | Install a newer signed build. When the app is already signed in it updates itself without another browser approval. |
| `mzrbook install [--no-browser]` | Install without opening the app. |
| `mzrbook doctor [--offline]` | Check this machine, the installed build and the services. Needs no sign-in and changes nothing. |
| `mzrbook rollback` | Return to the previous verified build. |
| `mzrbook unlock --yes` | Clear a lock left by an interrupted install (normally automatic). |
| `mzrbook uninstall [--purge-cache]` | Remove the launcher's cache. Your drafts, profile and saved sign-in stay. |

Stopping is always safe: Ctrl+C, closing the terminal or losing the connection
never installs anything unverified, partial downloads resume, and a leftover
lock clears itself on the next run.

Requires **Node.js 22 or newer**. Behind a proxy:
`--bootstrap-proxy http://proxy.example:8080`, or `--bootstrap-proxy-env` to use
`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`.

## What makes it safe to install

- **No install scripts.** Nothing runs when you `npm install` this package - no
  `preinstall`, `install`, `postinstall` or `prepare`. It works with
  `npm install --ignore-scripts` and with npm 12's default of blocking scripts.
- **One pinned dependency** (`undici`, exact version, integrity-locked), no git or
  URL dependencies. The published files are an allowlist: `bin/`, `lib/`, a
  config file and this README.
- **Published with provenance** from the public repository
  <https://github.com/zainriaz-dev/mzr-cli> through npm trusted publishing: no
  long-lived npm token exists, and the version page links to the exact commit
  and workflow that built it.
- **Nothing is trusted from the network blindly.** The release list is signed with
  an Ed25519 key held in Google Cloud KMS. This package pins the public key and
  verifies the signature, the expiry and the platform entry before downloading;
  the finished file must match the signed size and SHA-256 or it is deleted and
  never started.
- **Private downloads.** The download link is issued only after the sign-in
  approval, and the launcher refuses any link outside its fixed list of HTTPS
  hosts. TLS verification is never disabled.
- **No secrets here.** The package holds no passwords, tokens or keys; the sign-in
  approval lives only in memory and the installed app keeps its own credentials in
  your system's secure store.

Report a security problem privately to the repository owners rather than in a
public issue.

## Where things are installed

| System | Location |
|---|---|
| Windows | `%LOCALAPPDATA%\MZRBooks` |
| macOS | `~/Library/Caches/mzr-books` |
| Linux | `$XDG_CACHE_HOME/mzr-books` or `~/.cache/mzr-books` |

For offline machines, an administrator can import an already signed build with
`mzrbook install-offline --manifest ENVELOPE.json --binary FILE`; the same
signature and hash checks apply, and it grants no membership.
