# Mongo-first Dev Runbook

## One-time setup

```bash
cd /opt/workspace/pxm
pnpm install
```

## Start MongoDB

```bash
pnpm db:mongo
```

If the existing local Mongo volume was created before replica set mode, reset it once:

```bash
pnpm db:mongo:reset
```

Check replica set status:

```bash
docker exec -it pxm-mongo mongosh --eval 'rs.status().ok'
```

Expected result:

```text
1
```

Create runtime indexes:

```bash
pnpm db:mongo:init
```

## Run dev servers

Terminal 1:

```bash
pnpm dev:api:mongo
```

Terminal 2:

```bash
pnpm dev:engine:mongo
```

Terminal 3:

```bash
pnpm dev:web
```

Open:

```text
http://localhost:5173
```

API health check:

```bash
curl http://localhost:3011/api/health
```

## Custom Mongo connection

Override the defaults when using a customer-like Mongo cluster:

```bash
MONGODB_URL='mongodb://host1:27017,host2:27017,host3:27017/?replicaSet=rs0' \
MONGO_DB_NAME=pxm_db \
pnpm dev:api:mongo
```

Use the same `MONGODB_URL` and `MONGO_DB_NAME` for `pnpm db:mongo:init` and `pnpm dev:engine:mongo`.

## Connector secret refs

SERVICE node configs can reference secrets without storing raw values:

```json
{
  "secrets_ref": {
    "api_token": "secret://acra/api_token@1"
  }
}
```

For local development, the engine resolves `secret://acra/api_token@1` from:

```bash
PXM_SECRET_ACRA_API_TOKEN=...
```

Explicit environment refs are also supported:

```json
{ "token": "env://SLACK_BOT_TOKEN" }
```

## Credential encryption key

Credential secret은 MongoDB에 AES-256-GCM 암호문으로 저장한다. 로컬 개발은 개발용 fallback key를 사용할 수 있지만, 운영 환경에서는 서버 시작 전에 32자 이상의 전용 키를 반드시 지정한다.

```bash
NODE_ENV=production \
CREDENTIAL_SECRET_KEY='replace-with-a-random-32-byte-or-longer-secret' \
pnpm --filter api start:prod
```

키 원문은 DB나 workflow export에 저장하지 않는다. 운영에서는 배포 secret/KMS를 통해 주입하고, 키 변경 전 기존 credential 재암호화 절차를 별도로 수행해야 한다.
