# Security policy

## Reporting a vulnerability

Please **don't** open a public issue for a security problem. Report it privately through
[GitHub security advisories](https://github.com/AbdelrhmanX7/syllabi/security/advisories/new) instead.

Include what's affected (app, server, Android build), how to reproduce it, and what an attacker could do with
it. You'll get a reply within a few days. Once a fix ships you'll be credited, unless you'd rather not be.

## Supported versions

Only the latest release and the `master` branch get security fixes.

## Self-hosting

If you run your own server, keep it behind TLS and follow the exposure notes in
[`apps/server/README.md`](apps/server/README.md): the API binds to localhost, and the databases and storage are
never published.
