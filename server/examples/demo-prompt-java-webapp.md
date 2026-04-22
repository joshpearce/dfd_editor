# Demo prompt: live-build a Java web app DFD with data items + directional flows

Paste the **Prompt** section into a Claude Code session with the `dfd-editor`
MCP server available. The agent builds a DFD of a modern Java web app on
AWS from an empty canvas, one layer at a time.

The target diagram is richer than a plain topology: every node gets
**data items** attached, and every request/response flow carries **both**
a forward set (`node1_src_data_item_refs`) and a reverse set
(`node2_src_data_item_refs`) so the editor renders the flow
bidirectionally.

This version of the prompt is **concrete**: every GUID, property, and
data-item-ref is spelled out in the Library section below so a less
sophisticated model can execute it by copy-pasting named objects into
MCP tool calls instead of having to invent payloads.

---

## Prompt

> Execute the 11 steps below **in order**. Do not ask for confirmation.
> Do not change any GUID, classification, property, or ref — paste the
> named objects from the **Library** section verbatim.
>
> ### Setup
>
> - Generate a fresh 6-digit random integer `N` in `100000..999999`.
>   Use a different `N` every run so demo runs do not collide.
> - Set `DIAGRAM_NAME = "Java Web App on AWS #" + N`.
> - Keep the diagram state in a variable called `doc`. Start with:
>
>   ```json
>   {
>     "meta": {
>       "name": "<DIAGRAM_NAME>",
>       "author": "dfd-editor demo",
>       "description": "Modern Java (Spring Boot on ECS Fargate) web app on AWS — built live via MCP demo."
>     },
>     "nodes": [],
>     "containers": [],
>     "data_flows": [],
>     "data_items": []
>   }
>   ```
>
> ### Tools you will call
>
> - `mcp__dfd-editor__create_diagram({"diagram": <doc>})` — returns `{"id": "...", ...}`. Call **once** in Step 1; save the returned id as `DIAGRAM_ID`.
> - `mcp__dfd-editor__display_diagram({"diagram_id": DIAGRAM_ID})` — broadcasts to the browser. Call **once** in Step 1.
> - `mcp__dfd-editor__update_diagram({"diagram_id": DIAGRAM_ID, "diagram": <doc>})` — replaces the stored doc with `<doc>`. Call **once per step** in Steps 2–11.
>
> `update_diagram` **replaces** the full document; do **not** expect it to
> merge. Always send the full accumulated `doc`.
>
> ### Step 1 — create empty diagram and display it
>
> 1. Call `create_diagram` with `diagram = doc` (empty arrays).
> 2. Save returned `id` → `DIAGRAM_ID`.
> 3. Call `display_diagram` with `DIAGRAM_ID`.
>
> ### Step 2 — external entities
>
> `doc.nodes = [EE_USER, EE_STRIPE, EE_SES]`; call `update_diagram(doc)`.
>
> ### Step 3 — edge processes + Cognito
>
> `doc.nodes += [P_CDN, P_ALB, P_COGNITO]`; `update_diagram(doc)`.
>
> ### Step 4 — four Spring Boot ECS Fargate services
>
> `doc.nodes += [P_WEB, P_API, P_AUTH, P_WORKER]`; `update_diagram(doc)`.
>
> ### Step 5 — data stores
>
> `doc.nodes += [DS_REDIS, DS_RDS, DS_S3, DS_SQS]`; `update_diagram(doc)`.
>
> ### Step 6 — trust boundaries + ECS Cluster container
>
> `doc.containers = [TB_INTERNET, TB_PUBLIC_SUBNET, TB_PRIVATE_SUBNET, TB_DATA_TIER, TB_MANAGED_SERVICES, CT_ECS]`; `update_diagram(doc)`.
>
> ### Step 7 — data items
>
> `doc.data_items = [D1, D2, D3, D4, D5, D6, D7, D8, D9, D10, D11, D12, D13, D14, D15, D16, D17, D18, D19, D20, D21, D22, D23, D24, D25, D26]`; `update_diagram(doc)`.
>
> ### Step 8 — client-facing flows
>
> `doc.data_flows = [F1_USER_CDN, F2_CDN_ALB, F3_ALB_WEB]`; `update_diagram(doc)`.
>
> ### Step 9 — auth flows
>
> `doc.data_flows += [F4_WEB_AUTH, F5_AUTH_COGNITO, F6_AUTH_RDS]`; `update_diagram(doc)`.
>
> ### Step 10 — REST API backend flows
>
> `doc.data_flows += [F7_WEB_API, F8_API_RDS, F9_API_REDIS, F10_API_S3, F11_API_SQS, F12_API_STRIPE]`; `update_diagram(doc)`.
>
> ### Step 11 — Background Worker flows
>
> `doc.data_flows += [F13_WORKER_SQS, F14_WORKER_SES]`; `update_diagram(doc)`.
>
> Print `DIAGRAM_ID` as the final line of output.

---

## Library — paste these objects verbatim

All GUIDs are fixed. All `classification`, `trust_level`, `storage_type`,
`privilege_level`, `entity_type`, and boolean values are as specified —
do not invent alternates.

### External entities

`EE_USER`:

```json
{"type":"external_entity","guid":"40000000-0000-0000-0000-000000000001","properties":{"name":"End User","description":"Customer accessing the web app from a browser.","entity_type":"user","out_of_scope":false}}
```

`EE_STRIPE`:

```json
{"type":"external_entity","guid":"40000000-0000-0000-0000-000000000002","properties":{"name":"Stripe","description":"Third-party payment processor.","entity_type":"service","out_of_scope":true}}
```

`EE_SES`:

```json
{"type":"external_entity","guid":"40000000-0000-0000-0000-000000000003","properties":{"name":"Amazon SES","description":"Transactional email sender for receipts and account notifications.","entity_type":"service","out_of_scope":false}}
```

### Processes

`P_CDN`:

```json
{"type":"process","guid":"30000000-0000-0000-0000-000000000001","properties":{"name":"CloudFront CDN","description":"Edge cache and TLS termination for static assets and API routes.","trust_level":"system"}}
```

`P_ALB`:

```json
{"type":"process","guid":"30000000-0000-0000-0000-000000000002","properties":{"name":"Application Load Balancer","description":"Public-facing ALB routing to ECS services by host/path rules.","trust_level":"system"}}
```

`P_WEB`:

```json
{"type":"process","guid":"30000000-0000-0000-0000-000000000003","properties":{"name":"Spring Boot Web Frontend","description":"Spring Boot service on ECS Fargate — serves the Vue SPA, proxies auth and API calls.","trust_level":"authenticated","assumptions":["TLS terminates at the ALB; the ALB→Frontend hop is plaintext HTTP inside the VPC.","Session cookies are HttpOnly, Secure, SameSite=Lax."]}}
```

`P_API`:

```json
{"type":"process","guid":"30000000-0000-0000-0000-000000000004","properties":{"name":"Spring Boot REST API","description":"Spring Boot service on ECS Fargate — CRUD and business-logic endpoints.","trust_level":"authenticated","assumptions":["Every inbound request carries a JWT minted by the Auth Service.","Outbound calls to AWS use the task IAM role, not static keys."]}}
```

`P_AUTH`:

```json
{"type":"process","guid":"30000000-0000-0000-0000-000000000005","properties":{"name":"Auth Service","description":"Spring Boot service on ECS Fargate fronting Cognito — issues short-lived JWTs and runs password flows.","trust_level":"admin"}}
```

`P_WORKER`:

```json
{"type":"process","guid":"30000000-0000-0000-0000-000000000006","properties":{"name":"Background Worker","description":"Spring Boot service on ECS Fargate polling SQS for async jobs (email, billing reconciliation).","trust_level":"authenticated"}}
```

`P_COGNITO`:

```json
{"type":"process","guid":"30000000-0000-0000-0000-000000000007","properties":{"name":"Amazon Cognito","description":"Managed identity provider for user pools and federated sign-in (in-scope).","trust_level":"admin"}}
```

### Data stores

`DS_REDIS`:

```json
{"type":"data_store","guid":"50000000-0000-0000-0000-000000000001","properties":{"name":"ElastiCache Redis","description":"Session cache and rate-limit counters. Volatile; no long-lived PII.","storage_type":"cache","contains_pii":false,"encryption_at_rest":true}}
```

`DS_RDS`:

```json
{"type":"data_store","guid":"50000000-0000-0000-0000-000000000002","properties":{"name":"RDS PostgreSQL","description":"Primary relational store: accounts, orders, audit trail.","storage_type":"database","contains_pii":true,"encryption_at_rest":true}}
```

`DS_S3`:

```json
{"type":"data_store","guid":"50000000-0000-0000-0000-000000000003","properties":{"name":"S3 User Uploads","description":"Customer-supplied files (profile photos, attachments). Versioned, KMS-encrypted.","storage_type":"bucket","contains_pii":true,"encryption_at_rest":true}}
```

`DS_SQS`:

```json
{"type":"data_store","guid":"50000000-0000-0000-0000-000000000004","properties":{"name":"SQS Job Queue","description":"Durable queue for async work handed off by the REST API.","storage_type":"queue","contains_pii":false,"encryption_at_rest":true}}
```

### Trust boundaries + ECS Cluster container

`TB_INTERNET`:

```json
{"type":"trust_boundary","guid":"10000000-0000-0000-0000-000000000001","properties":{"name":"Internet","description":"Untrusted network reachable by any client.","privilege_level":"internet"},"children":["40000000-0000-0000-0000-000000000001","40000000-0000-0000-0000-000000000002"]}
```

`TB_PUBLIC_SUBNET`:

```json
{"type":"trust_boundary","guid":"10000000-0000-0000-0000-000000000002","properties":{"name":"AWS Public Subnet","description":"DMZ edge of the VPC; terminates TLS and fronts internal services.","privilege_level":"dmz"},"children":["30000000-0000-0000-0000-000000000001","30000000-0000-0000-0000-000000000002"]}
```

`TB_PRIVATE_SUBNET`:

```json
{"type":"trust_boundary","guid":"10000000-0000-0000-0000-000000000003","properties":{"name":"AWS Private Subnet","description":"Application tier: ECS cluster and in-VPC cache.","privilege_level":"corporate"},"children":["20000000-0000-0000-0000-000000000001","50000000-0000-0000-0000-000000000001"]}
```

`TB_DATA_TIER`:

```json
{"type":"trust_boundary","guid":"10000000-0000-0000-0000-000000000004","properties":{"name":"AWS Data Tier","description":"Durable storage. Network-restricted from the public subnet.","privilege_level":"restricted"},"children":["50000000-0000-0000-0000-000000000002","50000000-0000-0000-0000-000000000003"]}
```

`TB_MANAGED_SERVICES`:

```json
{"type":"trust_boundary","guid":"10000000-0000-0000-0000-000000000005","properties":{"name":"AWS Managed Services","description":"Regional AWS services reached over HTTPS with IAM auth.","privilege_level":"corporate"},"children":["30000000-0000-0000-0000-000000000007","40000000-0000-0000-0000-000000000003","50000000-0000-0000-0000-000000000004"]}
```

`CT_ECS`:

```json
{"type":"container","guid":"20000000-0000-0000-0000-000000000001","properties":{"name":"ECS Cluster","description":"Fargate cluster running the four Spring Boot services."},"children":["30000000-0000-0000-0000-000000000003","30000000-0000-0000-0000-000000000004","30000000-0000-0000-0000-000000000005","30000000-0000-0000-0000-000000000006"]}
```

### Data items (D1–D26)

`D1`:

```json
{"guid":"70000000-0000-0000-0000-000000000001","parent":"40000000-0000-0000-0000-000000000001","identifier":"D1","name":"User Credentials","description":"Username and plaintext password supplied during sign-in.","classification":"secret"}
```

`D2`:

```json
{"guid":"70000000-0000-0000-0000-000000000002","parent":"50000000-0000-0000-0000-000000000002","identifier":"D2","name":"Password Hash","description":"bcrypt hash of the user's password stored in the accounts table.","classification":"secret"}
```

`D3`:

```json
{"guid":"70000000-0000-0000-0000-000000000003","parent":"30000000-0000-0000-0000-000000000005","identifier":"D3","name":"Session JWT","description":"Short-lived access token minted by the Auth Service; carried on every API call.","classification":"secret"}
```

`D4`:

```json
{"guid":"70000000-0000-0000-0000-000000000004","parent":"30000000-0000-0000-0000-000000000005","identifier":"D4","name":"Refresh Token","description":"Long-lived refresh token used to mint new access JWTs without re-auth.","classification":"secret"}
```

`D5`:

```json
{"guid":"70000000-0000-0000-0000-000000000005","parent":"30000000-0000-0000-0000-000000000003","identifier":"D5","name":"Session Cookie","description":"HttpOnly, Secure, SameSite=Lax cookie correlating browser to server session.","classification":"secret"}
```

`D6`:

```json
{"guid":"70000000-0000-0000-0000-000000000006","parent":"30000000-0000-0000-0000-000000000007","identifier":"D6","name":"Cognito ID Token","description":"OIDC ID token returned by Cognito after successful auth challenge.","classification":"secret"}
```

`D7`:

```json
{"guid":"70000000-0000-0000-0000-000000000007","parent":"50000000-0000-0000-0000-000000000002","identifier":"D7","name":"User Profile Record","description":"Account row: user_id, display_name, email, created_at, preferences.","classification":"pii"}
```

`D8`:

```json
{"guid":"70000000-0000-0000-0000-000000000008","parent":"50000000-0000-0000-0000-000000000002","identifier":"D8","name":"Customer Email Address","description":"RFC 5322 email address used for login and transactional mail.","classification":"pii"}
```

`D9`:

```json
{"guid":"70000000-0000-0000-0000-000000000009","parent":"50000000-0000-0000-0000-000000000002","identifier":"D9","name":"Shipping Address","description":"Street address, city, postal code attached to an order.","classification":"pii"}
```

`D10`:

```json
{"guid":"70000000-0000-0000-0000-00000000000a","parent":"50000000-0000-0000-0000-000000000002","identifier":"D10","name":"Order Record","description":"Order id, line items, quantities, total amount, status.","classification":"internal"}
```

`D11`:

```json
{"guid":"70000000-0000-0000-0000-00000000000b","parent":"50000000-0000-0000-0000-000000000002","identifier":"D11","name":"Audit Log Entry","description":"Append-only record: timestamp, actor, action, resource, result.","classification":"internal"}
```

`D12`:

```json
{"guid":"70000000-0000-0000-0000-00000000000c","parent":"40000000-0000-0000-0000-000000000001","identifier":"D12","name":"Credit Card PAN","description":"Raw primary account number entered at checkout (tokenized client-side before upstream calls).","classification":"secret"}
```

`D13`:

```json
{"guid":"70000000-0000-0000-0000-00000000000d","parent":"40000000-0000-0000-0000-000000000002","identifier":"D13","name":"Stripe Payment Token","description":"Opaque tokenized card reference issued by Stripe; replaces the PAN on our side.","classification":"secret"}
```

`D14`:

```json
{"guid":"70000000-0000-0000-0000-00000000000e","parent":"40000000-0000-0000-0000-000000000002","identifier":"D14","name":"Stripe Charge Receipt","description":"Charge id, last4, amount, status returned by Stripe after capture.","classification":"secret"}
```

`D15`:

```json
{"guid":"70000000-0000-0000-0000-00000000000f","parent":"50000000-0000-0000-0000-000000000003","identifier":"D15","name":"Profile Photo","description":"User-uploaded avatar image stored in the user-uploads bucket.","classification":"pii"}
```

`D16`:

```json
{"guid":"70000000-0000-0000-0000-000000000010","parent":"50000000-0000-0000-0000-000000000003","identifier":"D16","name":"File Attachment","description":"Customer-supplied document attached to an order or support ticket.","classification":"secret"}
```

`D17`:

```json
{"guid":"70000000-0000-0000-0000-000000000011","parent":"50000000-0000-0000-0000-000000000001","identifier":"D17","name":"Rate Limit Counter","description":"Per-IP, per-route request counter with a short TTL.","classification":"internal"}
```

`D18`:

```json
{"guid":"70000000-0000-0000-0000-000000000012","parent":"50000000-0000-0000-0000-000000000001","identifier":"D18","name":"Cached Session State","description":"Serialized session blob (user_id, roles, csrf token) keyed by session id.","classification":"secret"}
```

`D19`:

```json
{"guid":"70000000-0000-0000-0000-000000000013","parent":"50000000-0000-0000-0000-000000000004","identifier":"D19","name":"Async Job Message","description":"SQS message body: job type, payload, correlation id, enqueue timestamp.","classification":"internal"}
```

`D20`:

```json
{"guid":"70000000-0000-0000-0000-000000000014","parent":"30000000-0000-0000-0000-000000000006","identifier":"D20","name":"Transactional Email","description":"Rendered receipt or account-notification email ready for SES.","classification":"pii"}
```

`D21`:

```json
{"guid":"70000000-0000-0000-0000-000000000015","parent":"30000000-0000-0000-0000-000000000001","identifier":"D21","name":"Static Web Asset","description":"SPA bundle, CSS, images served from the CDN edge cache.","classification":"public"}
```

`D22`:

```json
{"guid":"70000000-0000-0000-0000-000000000016","parent":"30000000-0000-0000-0000-000000000004","identifier":"D22","name":"API Request Payload","description":"JSON request body for CRUD and business-logic endpoints.","classification":"internal"}
```

`D23`:

```json
{"guid":"70000000-0000-0000-0000-000000000017","parent":"30000000-0000-0000-0000-000000000004","identifier":"D23","name":"API Response Payload","description":"JSON response body returned by the REST API to upstream callers.","classification":"internal"}
```

`D24`:

```json
{"guid":"70000000-0000-0000-0000-000000000018","parent":"50000000-0000-0000-0000-000000000004","identifier":"D24","name":"SQS Send Receipt","description":"MessageId / sequence-number ack returned by SQS after a successful SendMessage.","classification":"internal"}
```

`D25`:

```json
{"guid":"70000000-0000-0000-0000-000000000019","parent":"40000000-0000-0000-0000-000000000003","identifier":"D25","name":"SES Send Receipt","description":"MessageId acknowledgement returned by SES after a successful SendEmail.","classification":"internal"}
```

`D26`:

```json
{"guid":"70000000-0000-0000-0000-00000000001a","parent":"30000000-0000-0000-0000-000000000001","identifier":"D26","name":"Rendered HTML Page","description":"Server-side rendered HTML delivered as the initial document response.","classification":"public"}
```

### Data flows (F1–F14)

Each flow's `node1_src_data_item_refs` is the forward set (node1 → node2)
and `node2_src_data_item_refs` is the reverse set (node2 → node1). Refs
are already populated; do not modify them.

`F1_USER_CDN` — End User ↔ CloudFront, HTTPS/443:

```json
{"guid":"60000000-0000-0000-0000-000000000001","node1":"40000000-0000-0000-0000-000000000001","node2":"30000000-0000-0000-0000-000000000001","properties":{"name":"Browser ↔ CDN","protocol":"HTTPS/443","authenticated":false,"encrypted":true,"node1_src_data_item_refs":["70000000-0000-0000-0000-000000000001","70000000-0000-0000-0000-000000000005","70000000-0000-0000-0000-00000000000c","70000000-0000-0000-0000-000000000016"],"node2_src_data_item_refs":["70000000-0000-0000-0000-000000000015","70000000-0000-0000-0000-00000000001a","70000000-0000-0000-0000-000000000005","70000000-0000-0000-0000-000000000017"]}}
```

`F2_CDN_ALB` — CloudFront ↔ ALB, HTTPS/443:

```json
{"guid":"60000000-0000-0000-0000-000000000002","node1":"30000000-0000-0000-0000-000000000001","node2":"30000000-0000-0000-0000-000000000002","properties":{"name":"CDN origin fetch","protocol":"HTTPS/443","authenticated":false,"encrypted":true,"node1_src_data_item_refs":["70000000-0000-0000-0000-000000000016","70000000-0000-0000-0000-000000000005"],"node2_src_data_item_refs":["70000000-0000-0000-0000-000000000017","70000000-0000-0000-0000-00000000001a"]}}
```

`F3_ALB_WEB` — ALB ↔ Web Frontend, plaintext HTTP/80 inside VPC:

```json
{"guid":"60000000-0000-0000-0000-000000000003","node1":"30000000-0000-0000-0000-000000000002","node2":"30000000-0000-0000-0000-000000000003","properties":{"name":"ALB → Web Frontend (in-VPC)","protocol":"HTTP/80","authenticated":false,"encrypted":false,"node1_src_data_item_refs":["70000000-0000-0000-0000-000000000016","70000000-0000-0000-0000-000000000005"],"node2_src_data_item_refs":["70000000-0000-0000-0000-000000000017","70000000-0000-0000-0000-00000000001a","70000000-0000-0000-0000-000000000005"]}}
```

`F4_WEB_AUTH` — Web Frontend ↔ Auth Service, HTTPS/443 (mTLS):

```json
{"guid":"60000000-0000-0000-0000-000000000004","node1":"30000000-0000-0000-0000-000000000003","node2":"30000000-0000-0000-0000-000000000005","properties":{"name":"Sign-in / token refresh","protocol":"HTTPS/443 (mTLS)","authenticated":false,"encrypted":true,"node1_src_data_item_refs":["70000000-0000-0000-0000-000000000001","70000000-0000-0000-0000-000000000005"],"node2_src_data_item_refs":["70000000-0000-0000-0000-000000000003","70000000-0000-0000-0000-000000000004","70000000-0000-0000-0000-000000000005"]}}
```

`F5_AUTH_COGNITO` — Auth Service ↔ Cognito, HTTPS/443 (IAM):

```json
{"guid":"60000000-0000-0000-0000-000000000005","node1":"30000000-0000-0000-0000-000000000005","node2":"30000000-0000-0000-0000-000000000007","properties":{"name":"Cognito AdminInitiateAuth","protocol":"HTTPS/443 (IAM)","authenticated":true,"encrypted":true,"node1_src_data_item_refs":["70000000-0000-0000-0000-000000000001"],"node2_src_data_item_refs":["70000000-0000-0000-0000-000000000006"]}}
```

`F6_AUTH_RDS` — Auth Service ↔ RDS PostgreSQL, PostgreSQL/5432 (TLS):

```json
{"guid":"60000000-0000-0000-0000-000000000006","node1":"30000000-0000-0000-0000-000000000005","node2":"50000000-0000-0000-0000-000000000002","properties":{"name":"User-account lookup","protocol":"PostgreSQL/5432 (TLS)","authenticated":true,"encrypted":true,"node1_src_data_item_refs":["70000000-0000-0000-0000-000000000007","70000000-0000-0000-0000-000000000002"],"node2_src_data_item_refs":["70000000-0000-0000-0000-000000000007","70000000-0000-0000-0000-000000000002","70000000-0000-0000-0000-000000000008"]}}
```

`F7_WEB_API` — Web Frontend ↔ REST API, HTTPS/443 (mTLS):

```json
{"guid":"60000000-0000-0000-0000-000000000007","node1":"30000000-0000-0000-0000-000000000003","node2":"30000000-0000-0000-0000-000000000004","properties":{"name":"API call (JWT-bearing)","protocol":"HTTPS/443 (mTLS)","authenticated":true,"encrypted":true,"node1_src_data_item_refs":["70000000-0000-0000-0000-000000000016","70000000-0000-0000-0000-000000000003"],"node2_src_data_item_refs":["70000000-0000-0000-0000-000000000017"]}}
```

`F8_API_RDS` — REST API ↔ RDS PostgreSQL, PostgreSQL/5432 (TLS):

```json
{"guid":"60000000-0000-0000-0000-000000000008","node1":"30000000-0000-0000-0000-000000000004","node2":"50000000-0000-0000-0000-000000000002","properties":{"name":"Application query","protocol":"PostgreSQL/5432 (TLS)","authenticated":true,"encrypted":true,"node1_src_data_item_refs":["70000000-0000-0000-0000-000000000016","70000000-0000-0000-0000-000000000007","70000000-0000-0000-0000-000000000009","70000000-0000-0000-0000-00000000000a","70000000-0000-0000-0000-00000000000b"],"node2_src_data_item_refs":["70000000-0000-0000-0000-000000000007","70000000-0000-0000-0000-000000000008","70000000-0000-0000-0000-000000000009","70000000-0000-0000-0000-00000000000a","70000000-0000-0000-0000-00000000000b"]}}
```

`F9_API_REDIS` — REST API ↔ ElastiCache Redis, Redis/6379 (TLS):

```json
{"guid":"60000000-0000-0000-0000-000000000009","node1":"30000000-0000-0000-0000-000000000004","node2":"50000000-0000-0000-0000-000000000001","properties":{"name":"Session / rate-limit cache","protocol":"Redis/6379 (TLS)","authenticated":true,"encrypted":true,"node1_src_data_item_refs":["70000000-0000-0000-0000-000000000012","70000000-0000-0000-0000-000000000011"],"node2_src_data_item_refs":["70000000-0000-0000-0000-000000000012","70000000-0000-0000-0000-000000000011"]}}
```

`F10_API_S3` — REST API ↔ S3 User Uploads, HTTPS/443 (S3 SigV4):

```json
{"guid":"60000000-0000-0000-0000-00000000000a","node1":"30000000-0000-0000-0000-000000000004","node2":"50000000-0000-0000-0000-000000000003","properties":{"name":"User-upload read/write","protocol":"HTTPS/443 (S3 SigV4)","authenticated":true,"encrypted":true,"node1_src_data_item_refs":["70000000-0000-0000-0000-00000000000f","70000000-0000-0000-0000-000000000010"],"node2_src_data_item_refs":["70000000-0000-0000-0000-00000000000f","70000000-0000-0000-0000-000000000010"]}}
```

`F11_API_SQS` — REST API ↔ SQS Job Queue, HTTPS/443 (SQS SendMessage):

```json
{"guid":"60000000-0000-0000-0000-00000000000b","node1":"30000000-0000-0000-0000-000000000004","node2":"50000000-0000-0000-0000-000000000004","properties":{"name":"Enqueue async job","protocol":"HTTPS/443 (SQS SendMessage)","authenticated":true,"encrypted":true,"node1_src_data_item_refs":["70000000-0000-0000-0000-000000000013"],"node2_src_data_item_refs":["70000000-0000-0000-0000-000000000018"]}}
```

`F12_API_STRIPE` — REST API ↔ Stripe, HTTPS/443:

```json
{"guid":"60000000-0000-0000-0000-00000000000c","node1":"30000000-0000-0000-0000-000000000004","node2":"40000000-0000-0000-0000-000000000002","properties":{"name":"Charge payment","protocol":"HTTPS/443","authenticated":true,"encrypted":true,"node1_src_data_item_refs":["70000000-0000-0000-0000-00000000000d","70000000-0000-0000-0000-00000000000e"],"node2_src_data_item_refs":["70000000-0000-0000-0000-00000000000e"]}}
```

`F13_WORKER_SQS` — Background Worker ↔ SQS Job Queue, HTTPS/443 (SQS ReceiveMessage):

```json
{"guid":"60000000-0000-0000-0000-00000000000d","node1":"30000000-0000-0000-0000-000000000006","node2":"50000000-0000-0000-0000-000000000004","properties":{"name":"Poll job queue","protocol":"HTTPS/443 (SQS ReceiveMessage)","authenticated":true,"encrypted":true,"node1_src_data_item_refs":["70000000-0000-0000-0000-000000000013"],"node2_src_data_item_refs":["70000000-0000-0000-0000-000000000013"]}}
```

`F14_WORKER_SES` — Background Worker ↔ Amazon SES, HTTPS/443 (SES SendEmail):

```json
{"guid":"60000000-0000-0000-0000-00000000000e","node1":"30000000-0000-0000-0000-000000000006","node2":"40000000-0000-0000-0000-000000000003","properties":{"name":"Send transactional email","protocol":"HTTPS/443 (SES SendEmail)","authenticated":true,"encrypted":true,"node1_src_data_item_refs":["70000000-0000-0000-0000-000000000014","70000000-0000-0000-0000-000000000008"],"node2_src_data_item_refs":["70000000-0000-0000-0000-000000000019"]}}
```

---

## Notes on enums (for reference; all library objects already comply)

- `classification` ∈ `{unclassified, internal, pii, secret, public}`
- `entity_type` ∈ `{user, service, system, device}`
- `trust_level` ∈ `{public, authenticated, admin, system}`
- `storage_type` ∈ `{database, cache, file, queue, bucket}`
- `privilege_level` ∈ `{internet, dmz, corporate, restricted}`
- Node `type` ∈ `{process, external_entity, data_store}`
- Container `type` ∈ `{trust_boundary, container}`

For the formal JSON Schema, call `mcp__dfd-editor__get_diagram_schema`.
