# obstack CloudWatch Logs forwarder

Forwards an AWS CloudWatch Logs subscription-filter delivery to obstack's
`/v1/integrations/cloudwatch` endpoint. One dependency-free file
(`forwarder.mjs`), deployed as a Lambda in **your** AWS account.

**Status, honestly: this artifact is built and CI-exercised, and obstack's
hosted ingest endpoint is not public yet.** Point it at your own self-hosted
obstack ingest (compose or the Helm chart, with the ingest ingress enabled) and
it works today; the hosted connector stays marked "Coming soon" in the product
until the public endpoint exists.

## What it does

CloudWatch delivers `{"awslogs": {"data": "<base64(gzip(JSON))>"}}`. This
function undoes that envelope and POSTs the decoded JSON on, unchanged, with
your ingest key as a bearer token. All mapping — timestamps, service naming,
attributes — happens in obstack's ingest service, not here.

- A `CONTROL_MESSAGE` (AWS's reachability probe) is acknowledged and **not**
  forwarded: it is not telemetry anyone sent.
- A non-2xx answer from obstack **throws**, so AWS applies its own retry and
  dead-letter behaviour rather than the logs disappearing quietly.
- **No trace context is invented.** CloudWatch's envelope carries none, so these
  logs arrive without trace ids and correlate by time and service, never by a
  trace id guessed out of message text.

## Configuration

Both are required; the function refuses to run without them.

| variable | value |
|---|---|
| `OBSTACK_INGEST_URL` | full route URL, e.g. `https://ingest.example.com/v1/integrations/cloudwatch` |
| `OBSTACK_API_KEY` | an obstack ingest key (`ok_…`) for the workspace these logs belong to |

## Deploy

Build the zip:

```sh
npm run package   # writes dist/cloudwatch-forwarder.zip
```

Then, with your own role, log group and region (the commands are AWS's
documented subscription-filter pattern):

```sh
# 1. create the function
aws lambda create-function \
  --function-name obstack-cloudwatch-forwarder \
  --zip-file fileb://dist/cloudwatch-forwarder.zip \
  --role <lambda-execution-role-arn> \
  --handler forwarder.handler \
  --runtime nodejs22.x \
  --environment "Variables={OBSTACK_INGEST_URL=https://ingest.example.com/v1/integrations/cloudwatch,OBSTACK_API_KEY=ok_...}"

# 2. let CloudWatch Logs invoke it
aws lambda add-permission \
  --function-name obstack-cloudwatch-forwarder \
  --statement-id obstack-cloudwatch-forwarder \
  --principal logs.amazonaws.com \
  --action lambda:InvokeFunction \
  --source-arn "arn:aws:logs:<region>:<account-id>:log-group:<log-group>:*" \
  --source-account <account-id>

# 3. subscribe a log group to it
aws logs put-subscription-filter \
  --log-group-name <log-group> \
  --filter-name obstack \
  --filter-pattern "" \
  --destination-arn arn:aws:lambda:<region>:<account-id>:function:obstack-cloudwatch-forwarder
```

Repeat step 3 per log group. An empty `--filter-pattern` forwards everything;
narrow it if you want less.

## Test

```sh
npm test
```

Runs against the captured AWS envelope fixture that obstack's own ingest tests
read, so the two halves of this connector cannot drift onto different payloads.
