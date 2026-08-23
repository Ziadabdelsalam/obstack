# CloudWatch subscription-filter fixtures — provenance

Captured 2026-08-23 from the vendor's own published reference, verbatim. Not
hand-typed (D254's bar), and not yet wire captures: a real delivery requires an
AWS account with a subscription filter pointed at a deployed forwarder, which
is S5's ground. **D285 registers the upgrade: re-validated against the first
real delivery before any SOON card flips.**

| file | source | retrieved |
|---|---|---|
| `data-message.json` | docs.aws.amazon.com/AmazonCloudWatch/latest/logs/SubscriptionFilters.html — "Example 2: Subscription filters with AWS Lambda", the base64-decoded/decompressed structure | 2026-08-23 |
| `control-message.json` | same page's documented `CONTROL_MESSAGE` type ("mainly for checking if the destination is reachable"), in the same envelope shape with no log events | 2026-08-23 |
| `awslogs-envelope.json` | the wrapper the page states Lambda receives: `{ "awslogs": {"data": "BASE64ENCODED_GZIP_COMPRESSED_DATA"} }`, with `data` built by gzipping + base64-ing `data-message.json` | 2026-08-23 |

The same page documents the setup commands the forwarder README states:
`aws lambda create-function`, `aws lambda add-permission --principal
logs.amazonaws.com`, and `aws logs put-subscription-filter --destination-arn`.
