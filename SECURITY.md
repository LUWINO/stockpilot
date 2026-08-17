# Security

## Reporting a vulnerability

**Do not open a public issue.**

Email **security@stockpilot.dev** with:

- What the issue is and where in the code
- Steps to reproduce, or a proof of concept
- What an attacker could achieve
- Anything you think would help us fix it faster

| | |
|---|---|
| Acknowledgement | Within 2 working days |
| Initial assessment | Within 5 working days |
| Fix for critical issues | Target 14 days |
| Disclosure | Coordinated; we will credit you unless you prefer otherwise |

We will not take legal action against good-faith research that respects user
privacy, avoids service degradation, and does not access data beyond what is
needed to demonstrate the issue.

## Supported versions

| Version | Supported |
|---|---|
| 1.x | ✅ |
| < 1.0 | ❌ |

Security fixes land on the latest minor release of the current major.

---

## Controls

Full analysis in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md). In summary:

**Authentication.** scrypt (N=65536, r=8) with per-hash parameters and in-place
upgrade. Session tokens and API keys stored only as SHA-256 digests. Login
rate-limited per account, so rotating source addresses does not help. Failed
logins run a dummy hash so timing does not enumerate accounts.

**Authorisation.** Five roles, a flat permission matrix with no inheritance, and
a test asserting each role is a strict superset of the one below. Nobody may
grant a role at or above their own, or change their own role.

**Tenant isolation.** PostgreSQL row-level security with `FORCE` on every tenant
table, keyed on a transaction-local setting. Repositories take a transaction
handle, so they cannot be called outside a tenant scope. CI fails the build if any
table lacks RLS.

**Audit integrity.** `stock_movements` and `audit_log` are append-only, enforced
by database triggers. CI asserts the triggers exist.

**Web.** Per-request CSP nonce with `strict-dynamic` and no `unsafe-inline` for
script. HSTS, `X-Content-Type-Options`, `frame-ancestors 'none'`, `base-uri
'none'`. `__Host-` prefixed cookies. CSRF protected by three independent controls
— an HMAC double-submit token, `SameSite=Lax`, and Origin checking.

**Input.** Zod at every boundary; CHECK constraints in the database. Parameterised
SQL throughout.

**Output.** 500 responses carry a correlation id and nothing else. Logs redact any
key matching `pass|secret|token|key|auth|cookie|session|credential|hash`.

**Supply chain.** Six runtime dependencies. No native modules. `--ignore-scripts`
in CI and in the image build. Weekly `npm audit` and CodeQL. Grouped Dependabot.

---

## Known gaps

Stated plainly, because a security document that lists only strengths is not
useful.

| Gap | Impact | Mitigation today |
|---|---|---|
| **No MFA** | Password compromise is sufficient for account takeover | Put SSO or an identity proxy in front for internet-facing deployments |
| **Per-instance rate limiting** | *n* replicas allow *n* × the limit | Edge rate limiting; `RateLimitStore` is swappable |
| **No field-level encryption** | Supplier pricing readable by anyone with database access | Use the database's encryption at rest; restrict database access |
| **No anomaly detection on slow demand poisoning** | A patient attacker could inflate demand within the caps | Value caps bound per-decision and daily exposure; review committed value per SKU over time |

---

## Operator responsibilities

Security is shared. The deployment must also:

- Connect as a **non-superuser** role. Superusers bypass row-level security
  entirely, silently disabling tenant isolation.
- Use `sslmode=require` and keep Postgres off the public internet.
- Store `SESSION_SECRET` in a secret manager, unique per deployment. Rotating it
  invalidates every session, which is the intended way to force a global sign-out.
- Terminate TLS with a current configuration.
- Schedule `stockpilot_purge_expired()` hourly.
- Change or remove the seeded demo credentials.
- Start the agent at `monitor` or `propose`. See [docs/AUTONOMY.md](docs/AUTONOMY.md).

The full list is in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#hardening-checklist).
