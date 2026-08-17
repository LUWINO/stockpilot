# Deployment

Two processes and a database:

```
        ┌──────────┐        ┌──────────────┐
  ─────▶│  web     │───────▶│              │
        │  (n)     │        │  PostgreSQL  │
        └──────────┘        │              │
        ┌──────────┐        │              │
        │  agent   │───────▶│              │
        │  (1–n)   │        └──────────────┘
        └──────────┘
```

The agent is a **separate process**, not a thread in the web server. A sweep over
a large catalogue must not compete with user requests for the event loop, and the
agent must keep running while the web tier is redeployed.

Running several agent replicas is safe — an advisory lock means only one
evaluates a given organisation at a time, and the others skip rather than queue.

---

## Requirements

| | Minimum | Recommended |
|---|---|---|
| Node | 22.12 | 22 LTS latest |
| PostgreSQL | 15 | 17 or 18 |
| Web memory | 512 MB | 1 GB |
| Agent memory | 512 MB | 1 GB per 10k SKU/site pairs |
| Database | 2 vCPU, 4 GB | Sized to catalogue; see DATA-MODEL |

Password hashing uses ~64 MB per concurrent login by design. Size the web tier
for the number of *simultaneous sign-ins*, not the number of users.

---

## Configuration

Full reference in [`.env.example`](../.env.example). Everything is validated at
startup, and the process refuses to boot on a bad value — listing every problem
at once rather than one per restart.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | ✅ | Must include `sslmode=require` in production |
| `SESSION_SECRET` | ✅ | ≥ 32 chars. `openssl rand -base64 48` |
| `APP_URL` | | Must be HTTPS in production — cookies are `Secure` |
| `ALLOWED_ORIGINS` | | Extra browser origins, comma separated |
| `AGENT_INTERVAL_MINUTES` | | Default 60 |
| `AGENT_ENABLED` | | `false` disables the agent entirely |
| `RATE_LIMIT_PER_MINUTE` | | Default 600, per instance |
| `LOG_LEVEL` | | `debug` \| `info` \| `warn` \| `error` |

In production the startup check additionally refuses: a non-TLS database URL, a
non-HTTPS `APP_URL`, and a `SESSION_SECRET` that looks like a placeholder. These
are the settings that are harmless locally and dangerous in production — exactly
the class of mistake that survives review because it looks fine on a laptop.

**Never bake secrets into an image.** Use your platform's secret manager. The
Dockerfile passes placeholders at build time that never reach the runtime image.

---

## Docker

```bash
docker build -t stockpilot:1.0.0 .

docker run -d --name stockpilot-web \
  -p 3000:3000 \
  -e DATABASE_URL="postgres://…?sslmode=require" \
  -e SESSION_SECRET="$(openssl rand -base64 48)" \
  -e APP_URL="https://stock.example.com" \
  -e NODE_ENV=production \
  stockpilot:1.0.0

docker run -d --name stockpilot-agent \
  -e DATABASE_URL="postgres://…?sslmode=require" \
  -e SESSION_SECRET="…" \
  -e NODE_ENV=production \
  stockpilot:1.0.0 \
  node --experimental-strip-types src/worker/main.ts
```

The image is multi-stage: the runtime stage has no compiler, no dev dependencies
and no npm, so a compromised process cannot install anything. It runs as the
unprivileged `node` user.

---

## Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: stockpilot-web
spec:
  replicas: 3
  selector:
    matchLabels: { app: stockpilot, component: web }
  template:
    metadata:
      labels: { app: stockpilot, component: web }
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      containers:
        - name: web
          image: stockpilot:1.0.0
          ports: [{ containerPort: 3000 }]
          env:
            - name: NODE_ENV
              value: production
            - name: DATABASE_URL
              valueFrom: { secretKeyRef: { name: stockpilot, key: database-url } }
            - name: SESSION_SECRET
              valueFrom: { secretKeyRef: { name: stockpilot, key: session-secret } }
          # Liveness must NOT check the database. If it did, a brief database
          # blip would restart every healthy pod and turn a short outage into a
          # cascading one.
          livenessProbe:
            httpGet: { path: /api/v1/health?probe=liveness, port: 3000 }
            initialDelaySeconds: 15
            periodSeconds: 20
          # Readiness does check it, so an instance that cannot serve is removed
          # from the load balancer without being killed.
          readinessProbe:
            httpGet: { path: /api/v1/health, port: 3000 }
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            requests: { cpu: 250m, memory: 512Mi }
            limits:   { memory: 1Gi }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: [ALL] }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: stockpilot-agent
spec:
  replicas: 1
  selector:
    matchLabels: { app: stockpilot, component: agent }
  template:
    metadata:
      labels: { app: stockpilot, component: agent }
    spec:
      # The agent commits money. Give it time to finish a cycle rather than
      # killing it mid-transaction.
      terminationGracePeriodSeconds: 120
      containers:
        - name: agent
          image: stockpilot:1.0.0
          command: ['node', '--experimental-strip-types', 'src/worker/main.ts']
          env:
            - name: DATABASE_URL
              valueFrom: { secretKeyRef: { name: stockpilot, key: database-url } }
            - name: SESSION_SECRET
              valueFrom: { secretKeyRef: { name: stockpilot, key: session-secret } }
          resources:
            requests: { cpu: 500m, memory: 512Mi }
            limits:   { memory: 2Gi }
```

Prefer a `CronJob` with `RUN_ONCE=true` if your platform is happier with
scheduled work than long-lived processes. Set `concurrencyPolicy: Forbid`;
the advisory lock makes an overlap harmless, but there is no reason to create one.

---

## Migrations

```bash
npm run db:migrate
```

Run **before** rolling out new application code. Migrations are additive and
forward-only; there are no down migrations, because a down migration that has
never been tested is a false sense of safety. Roll back by restoring a backup.

For zero-downtime releases with a schema change, use the expand/contract pattern:
deploy the additive migration, deploy code that writes both old and new, backfill,
deploy code that reads the new, then remove the old in a later release.

CI proves the migrations apply cleanly to an **empty** database on every commit —
which is what a new customer will do, and the case that otherwise never gets
tested.

---

## Managed platforms

Any host that runs a Node server works. Two constraints:

1. **The agent needs somewhere to live.** A serverless web deployment still
   needs a scheduled invocation of the agent — either a container, a cron job, or
   a scheduled function calling `POST /api/v1/agent/run` with an `agent:run` key.
2. **Connection pooling.** Serverless platforms open a connection per instance.
   Put PgBouncer or your provider's pooler in front, in *transaction* mode.

Transaction-mode pooling is compatible with the tenant scoping here: the org id
is set with `set_config(..., true)`, which is transaction-local, so it travels
with the transaction rather than the connection.

---

## Hardening checklist

- [ ] `SESSION_SECRET` is unique to this deployment and stored in a secret manager
- [ ] `DATABASE_URL` uses `sslmode=require`
- [ ] `APP_URL` is HTTPS and matches the real hostname
- [ ] Postgres is not reachable from the public internet
- [ ] The application's database role is **not** a superuser (superusers bypass RLS)
- [ ] Automated backups on, with a **restore actually tested**
- [ ] `stockpilot_purge_expired()` scheduled hourly
- [ ] Seeded demo credentials removed or changed
- [ ] Log destination scrubs nothing extra — redaction already happens at source
- [ ] Agent starts at `monitor` or `propose`; see [AUTONOMY.md](AUTONOMY.md)

The superuser point deserves emphasis: row-level security does not apply to a
superuser. Connecting as one silently disables tenant isolation entirely.
