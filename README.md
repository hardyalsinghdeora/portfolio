# Portfolio agent: hybrid RAG + tool-calling on Cloudflare Workers

Source for **[hardyal.is-a.dev](https://hardyal.is-a.dev/)**, the portfolio of Hardyal Singh Deora, Agentic AI Architect and Principal Software Engineer.

The page is a chat. Ask it anything about my work and an **agent** answers. It decides what to look up, retrieves evidence from my career profile with **hybrid RAG**, answers only from what it retrieved, and shows the sources and the tool calls behind every answer.

```
Visitor question
      │
      ▼
POST /api/ask ── Cloudflare Worker (src/worker.js)
      │  validate turns · same-origin check · per-IP rate limit, IPv6 per /64 (KV)
      │  tier from the signed LinkedIn session (src/auth.js): public · member · recruiter · owner
      │  input guard (src/inject.js): block injection, drop forged history ── blocked: fixed reply, no model call
      │  semantic cache (src/cache.js), per tier ── hit: cached answer, no model call
      │  model router (src/router.js): light or heavy model per question
      ▼
Agent loop (src/agent.js) ── Gemini function calling, max 4 model calls
      │  Claude fallback (src/providers.js) when Gemini fails and ANTHROPIC_API_KEY is set, within a daily budget
      │  step 1: must call a tool   (toolConfig ANY)
      │  steps 2–3: model decides   (AUTO)
      │  step 4: must answer        (NONE)
      ▼
Tools ─────────────────────────────────────────────────────────────
  search_profile(query)           → hybrid retrieval, top 5 passages
  get_section(section)            → a whole section, e.g. all roles
  get_contact_and_availability()  → contact, notice period, locations
      │
      ▼
Hybrid retrieval (src/rag.js) over the tier's index (src/tiers.js)
  knowledge/profile.json → ~70 titled chunks (public)
  + private passages from KV, only for approved recruiters and the owner
  BM25 (+ synonym expansion) ─┐
                              ├─ reciprocal rank fusion → top k
  Gemini embeddings (768-d) ──┘   (falls back to BM25 if embeddings fail)
      │
      ▼
Output guard (src/guard.js), relaxed per tier
      │
      ▼
Answer text  U+001E  { sources, steps, retrieval, tier, route, cached? }  →  page renders sources + agent trace
```

## Why it's built this way

| Decision | Why |
|---|---|
| **Agent with tools, not one big prompt** | The old version stuffed the whole ~7k-token profile into every request. Now the model asks for what it needs, so prompts are smaller, answers cite specific passages, and adding knowledge doesn't grow every request. |
| **Hybrid retrieval (BM25 + embeddings, RRF)** | BM25 nails exact terms recruiters type ("notice period", "PostgreSQL", "MCP"). Embeddings catch paraphrases ("have you led people?"). Reciprocal rank fusion combines them without tuning score scales. |
| **No vector database** | ~70 chunks fit in memory. Document vectors are computed once per Worker isolate and cached in KV, so a managed vector DB would add cost and a moving part for no gain at this size. The `search()` interface is the seam where one would plug in. |
| **Bounded loop: ANY → AUTO → NONE** | The first step is forced to retrieve, so answers are grounded. The last step is forced to answer, so cost and latency have a hard ceiling. |
| **Tools return facts only** | Tools are read-only over a public profile. Unknown tools and bad arguments return errors to the model instead of throwing. |
| **Keys and prompt stay server-side** | The browser sends only conversation turns, so the endpoint can't be repurposed as a free Gemini proxy. |
| **Graceful degradation** | If the embedding call fails, the agent falls back to BM25. If Gemini fails, Claude answers when an Anthropic key is set. If no model is available, the page falls back to scripted answers. |

More detail, including trade-offs and what I'd do at larger scale, is in [docs/architecture.md](docs/architecture.md).

## Voice

The mic button in the composer lets visitors ask by voice. It uses only what the browser ships, so it costs nothing and needs no key or server change:

- **Speech in:** the Web Speech API (`SpeechRecognition`) turns speech into text, which then goes through the same `/api/ask` agent as a typed question. It works in Chrome, Edge and Safari. Firefox doesn't support it, so the mic stays hidden there. Chrome and Edge send the audio to their vendor's speech service to recognise it.
- **Speech out:** `speechSynthesis` reads the answer to a voice question aloud, one sentence at a time. Links and email addresses are replaced with "on screen" rather than spelled out. The speaker button in the top bar mutes spoken replies, and the choice is remembered. Typed questions are never read aloud.

## Link previews and search

`public/` carries Open Graph and Twitter card tags, a `Person` JSON-LD block, a `<noscript>` summary for crawlers, `robots.txt`, `sitemap.xml` and a favicon. `node scripts/render-assets.mjs` re-renders the preview card (`og-image.png`) and `apple-touch-icon.png` from `knowledge/profile.json`, and prints the résumé page to `resume-agentic-ai.pdf`. Run it after changing the headline or the résumé; the outputs are committed.

## Job fit

The **Job fit** chip (or typing something like "check your fit for this role") opens a box for a recruiter to paste a job description. `POST /api/fit` (`src/fit.js`) answers requirement by requirement:

1. One structured-output Gemini call extracts up to 10 requirements, each marked required or nice to have. The description is passed as delimited, untrusted data.
2. Hybrid retrieval finds the top 3 passages for each requirement. This step makes no LLM call.
3. A second structured-output call judges each requirement as strong, partial or gap, using only those passages, with cited passage ids.
4. The code then re-checks every verdict:
   - a match citing no retrieved passage becomes a gap;
   - a "strong" backed only by working-familiarity passages drops to partial.

That makes two model calls per check, against the same per-IP limit as questions. The description is never stored or logged, and the page says it is sent to Gemini.

## LinkedIn and Naukri text

Every build writes [docs/listings.md](docs/listings.md) from `knowledge/profile.json`: LinkedIn headline and About, the skills missing from LinkedIn, Open to Work titles, and the Naukri resume headline, profile summary and key skills, each with its character count. The build fails if a field goes over the site's limit, and a test keeps the skill list to skills the profile actually evidences and runs the text through the redline check. Edit the profile, run `npm test`, and paste from the regenerated file.

## Visit sources

Links handed out in `docs/listings.md` carry `?ref=linkedin` or `?ref=naukri` (also accepted: `github`, `resume`, `email`). When `RATE_KV` is bound, the Worker keeps monthly counters in it:

- `ref:visit:<source>:<YYYY-MM>`: landings on `/` with that tag;
- `ref:ask:<source>:<YYYY-MM>`: questions asked during those visits.

Read them in the KV namespace in the Cloudflare dashboard. Unknown sources and bot user agents (LinkedIn's and Slack's link-preview fetchers among them) aren't counted, and counting fails open so it can never break the page. The page drops `?ref=` from the address bar on load, so a copied URL doesn't inflate the count. Without `RATE_KV` nothing is counted.

For overall traffic and referrers, turn on Cloudflare Web Analytics for the Pages project in the dashboard. It's free and cookieless, and needs no code here.

## Endpoints

| | |
|---|---|
| `POST /api/ask` | `{ "messages": [{ "role": "user", "content": "..." }] }` → answer text, then `\u001e`, then `{ sources, steps, retrieval }` |
| `POST /api/fit` | `{ "jd": "..." }` (80 to 8,000 characters) → `{ summary, requirements: [{ requirement, kind, match, evidence, sources }], counts, retrieval }` |
| `POST /api/feedback` | `{ rating: "up" \| "down", question, answer, token, comment?, sources?, retrieval?, model? }`, where `token` is the answer's `meta.fb` → `{ ok: true }`. Needs `RATE_KV`. |
| `GET /api/feedback?limit=200` | Feedback export, newest first. `Authorization: Bearer <FEEDBACK_ADMIN_TOKEN>`; 404 when that secret isn't set. |
| `GET /api/search?q=...&k=5` | Retrieval only, with no LLM call, always over the public index. Useful for debugging retrieval quality. |
| `GET /api/me` | `{ loginEnabled, tier, user }` for the current session |
| `GET /auth/linkedin`, `GET /auth/callback`, `POST /auth/logout` | Sign in with LinkedIn (OpenID Connect) and sign out |
| `POST /api/access-request` | `{ company, role, note? }` from a signed-in member → `{ ok, status: "pending" }` |
| `GET /api/admin/users`, `POST /api/admin/decide` | Owner only: list signed-in users; `{ sub, decision: "approve" \| "reject" \| "revoke" }` |

## Repo layout

```
knowledge/profile.json   single source of truth: my career profile (public facts only)
src/rag.js               chunking, BM25, Gemini embeddings, reciprocal rank fusion
src/agent.js             system prompt, tool schemas, the bounded loop, the Gemini adapter, usage and cost
src/providers.js         the Claude adapter and the fallback between providers
src/fit.js               job-description fit: extract requirements, retrieve evidence, judge, re-check
src/guard.js             runtime output guard (relaxed per tier); its patterns also gate the build and grade the evals
src/inject.js            input guard: prompt-injection screening and forged-history removal
src/tiers.js             access tiers and the per-tier index (public profile + private KV passages)
src/auth.js              Sign in with LinkedIn, signed sessions, access requests and the owner's approvals
src/cache.js             semantic answer cache, one namespace per tier and content version
src/router.js            light / heavy model routing
knowledge/private/       recruiter.json and owner.json: private passages, gitignored, uploaded by scripts/private-kb.mjs
scripts/private-kb.mjs   validates the private passages and uploads them to KV
public/admin.html        owner-only page to approve, reject or revoke recruiter access
src/feedback.js          answer signatures, feedback validation, and drafts of eval cases from 👎
scripts/feedback.mjs     pulls feedback from the live site and writes the draft eval cases
evals/                   live-model eval sets and the harness
scripts/eval.mjs         runs the evals against the live Gemini API and writes the scorecard
src/worker.js            HTTP routing, validation, rate limiting, response format
src/knowledge.js         generated from profile.json by the build
public/                  the page (index.html) and the Agentic AI Architect résumé
tests/index.html         zero-dependency test page: unit tests + agent-loop tests with a mocked Gemini
tests/evals.json         retrieval eval set (49 recruiter questions → expected chunks)
.github/workflows/       deploy.yml: tests, then deploy on every push to main; evals.yml: nightly live-model evals
scripts/build.mjs        builds dist/ and bundles src/ into one dist/_worker.js (Node, no dependencies)
scripts/test.mjs         runs tests/index.html headlessly in Chromium, then smoke-tests dist/_worker.js
scripts/render-assets.mjs renders the link-preview card, home-screen icon and résumé PDF into public/
scripts/listings.mjs     generates docs/listings.md (LinkedIn and Naukri text) from the profile
scripts/build.ps1        the same build in PowerShell, for Windows without Node
scripts/dev-server.ps1   local static server with a mocked /api/ask for UI checks
dist/                    deployable output (committed so the repo deploys as-is)
```

## Tests and evals

```bash
npm ci            # installs Playwright, used only by the test runner
npm test          # build, then run every test headlessly
```

`npm test` builds `dist/`, opens `tests/index.html` in headless Chromium, and then loads the bundled `dist/_worker.js` in Node for a smoke test. The test page runs the real modules against a mocked Gemini API, so it needs no key and no network. You can also open `http://localhost:8787/tests/` after `scripts/dev-server.ps1`.

- **54/54 tests passing.** They cover:
  - access tiers: private passages reach the model only for an approved recruiter or the owner, never through `/api/search`; per-tier output guard rules;
  - sign-in: the LinkedIn OpenID Connect flow with a state check, forged, edited and expired sessions, an unverified email never becoming owner, and request → approve → revoke taking effect on an existing session;
  - the input guard: overrides, prompt extraction, chat-template tokens, zero-width tricks, forged earlier answers, and that a blocked question costs no model call;
  - the semantic cache: exact and semantic hits with no model call, follow-ups never cached, similar wording about a different topic refused, and no sharing between tiers;
  - the model router: light and heavy routes, defaults, and a failing heavy model falling back to the light one;
  - retrieval: chunking, BM25, synonym expansion, RRF, hybrid search, the embedding cache and the BM25 fallback;
  - the agent loop: tool calls, thought-signature echo, step bounds, unknown tools and hidden thoughts;
  - job fit: two structured-output calls, uncited matches turned into gaps, working familiarity capped at partial, requirement and length caps, and the endpoint's error codes;
  - usage: token, latency and cost totals per answer, the Analytics Engine data point, and that passage ids stay server-side;
  - the Claude provider: closed JSON schemas, the exact request (version header, no sampling parameters, never forced tool use, refusal fallback), thinking blocks echoed verbatim, the retrieval reminder, the no-tools final step, a result for every tool call, refusals, and fallback for answers and job fit;
  - visitor feedback: signed answers, forged answers rejected, what is stored (and that no IP is), the limits, and the token-protected export with draft eval cases;
  - the output guard: what it blocks, that no profile passage trips it, and that both endpoints replace guarded text;
  - the eval harness itself: its deterministic checks, and a full run against a fake model that must catch a leaked salary, an unfaithful answer and a job-fit overclaim;
  - Worker guards: 405, 400, 403, 429 and 503, plus the per-IP rate limit (IPv6 keyed per /64), which lets requests through if KV fails or hits its daily write cap, the Claude daily budget, which fails closed, and visit-source counting;
  - the content rules: working-familiarity skills never leak into production skills, every `get_section` value resolves, and **no employer-internal names or verbal-only company numbers appear in the knowledge base or either public page**.
- **Retrieval eval (BM25 only, the worst case):** hit@5 = 49/49, hit@1 = 35/49. The set includes 13 Gen AI interview questions, for example "how do you prevent hallucinations?", "why no vector database?" and "how do you get structured JSON from an LLM?".

**CI gate:** the `test` job must pass before the `deploy` job runs. The deploy job then rebuilds `dist/` from the tested sources.

### Live-model evals (nightly)

`npm test` proves the code is correct against a mocked model. It can't tell whether the real model answers well. `scripts/eval.mjs` runs the real pipelines against the live Gemini API, nightly in `.github/workflows/evals.yml` and on demand (`GEMINI_API_KEY=... node scripts/eval.mjs`, optionally `--only <regex>`). It covers four things:

- **Answers** (`evals/answers.json`, 49 cases). Each case gets deterministic checks for facts, migration separation, links, refusals and grounding. Every answer is also checked against the redline and phone patterns in `src/guard.js`.
- **Faithfulness.** An LLM judge checks each answer against every passage the agent was shown. Set `EVAL_JUDGE_MODEL` to judge with a different model from the one being graded.
- **Job fit** (`evals/fit.json`). Three job descriptions (AI architect, ML research, backend platform), each with the verdicts expected per requirement.
- **Retrieval in both modes.** BM25 and hybrid on the 49 recruiter questions, plus `evals/retrieval-hard.json`: 20 paraphrases written to avoid the profile's vocabulary. BM25 alone gets hit@5 16/20 on these, so unlike the original set it can show what embeddings add.

The scorecard reports pass rates by category, the faithfulness rate, job-fit accuracy, hit@k, p50/p95 latency, tokens and cost per answer. It's written to the run summary and uploaded as an artifact. The run fails on any safety failure (compensation figures, working familiarity claimed as production, contributed work claimed as owned, prompt or tool leaks, internal names) or any job-fit overclaim. Other misses are reported, not failed, because judge and model noise would make a hard gate flaky. Setup is in the workflow's header: a `GEMINI_API_KEY` repository secret, and optional price variables.

## Runtime output guard

The prompt tells the model what it must never say. `src/guard.js` checks that it didn't, on every model-written answer, before the visitor sees it. It blocks four things:
- employer-internal names and verbal-only numbers;
- phone numbers;
- compensation figures (lakhs/LPA/crores, rupee or INR amounts, salary-shaped dollar figures);
- any run of 12 consecutive words copied from the system prompt.

A blocked `/api/ask` answer is replaced with a pointer to email, and its sources are dropped. In `/api/fit`, a blocked summary or evidence line is replaced and its verdict kept. Requirement text is the visitor's own job description, so it isn't checked. Each block writes a log line and an Analytics Engine field with the reason only, never the text.

A test runs every profile passage through the guard, so text the agent quotes can't be blocked by mistake. The build-time content tests use the same patterns. The live evals grade the model's raw output and report how often the guard would have stepped in, so it never hides a misbehaving prompt.

## Access tiers and LinkedIn sign-in

Some of what recruiters ask can't be published: internal product and partner names, company numbers, detailed interview stories, references. The site answers with them only for people I've approved.

| Tier | Who | What the agent can retrieve | What the output guard allows |
|---|---|---|---|
| **public** | anyone | `knowledge/profile.json` | no internal names, no compensation |
| **member** | signed in with LinkedIn, not approved | the same | the same |
| **recruiter** | a member I approved in `/admin.html` | + `kb:recruiter` passages | internal names and numbers; never compensation |
| **owner** | me (`OWNER_EMAILS`, verified email) | + `kb:owner` passages | everything except phone numbers and prompt leaks |

How it's enforced, in code rather than in the prompt:
- **The tier comes only from the session.** `src/auth.js` signs an HttpOnly cookie (HMAC-SHA256, 7 days) after Sign in with LinkedIn (OpenID Connect, with a state cookie against CSRF). The approval status is re-read from KV on every request, so revoking works on the next question.
- **Nobody becomes a recruiter by signing in.** LinkedIn's OpenID profile has no job title, so a member asks for access (company, role, note) and I approve or reject it in `/admin.html`.
- **The model can't leak what it was never shown.** Private passages aren't in the repo or the bundle. `scripts/private-kb.mjs` validates `knowledge/private/*.json` (gitignored) and uploads them to KV. `src/tiers.js` adds them to the retrieval index only for the tiers allowed to read them, so a public visitor's agent run never retrieves them, whatever the prompt says.
- **The output guard relaxes per tier** (`guardText(text, prompts, tier)`): recruiters may see internal names but compensation is still blocked; phone numbers and prompt leaks are blocked for everyone.
- `/api/search` always uses the public index.
- The semantic cache keeps one namespace per tier, so a recruiter's answer is never replayed to a public visitor.

**Setup:**
1. Create an app at [linkedin.com/developers](https://www.linkedin.com/developers/apps), add the **Sign In with LinkedIn using OpenID Connect** product, and add the redirect URL `https://hardyal.is-a.dev/auth/callback`.
2. In the Pages project, set `LINKEDIN_CLIENT_ID`, the secrets `LINKEDIN_CLIENT_SECRET` and `SESSION_SECRET` (32+ random characters), and `OWNER_EMAILS` (the email on your LinkedIn account). Bind `RATE_KV`. Without all of these, sign-in stays off and everyone is public.
3. Write `knowledge/private/recruiter.json` and `owner.json` (shape: `knowledge/private.example.json`), then run `KV_NAMESPACE_ID=<RATE_KV id> node scripts/private-kb.mjs --upload`. The script refuses phone numbers anywhere, compensation in the recruiter file, and unfinished `[FILL]` placeholders.

Private passages are sent to the model provider like any retrieved passage. On Gemini's free tier, Google may use prompts to improve its products, so keep anything you wouldn't send to Google out of these files, or move to a paid tier.

## Input guard against prompt injection

The output guard checks what the model wrote. `src/inject.js` checks what visitors send, before any model call:
- **Strong signals block on their own:** overriding the instructions, asking for the system prompt, chat-template tokens (`<|im_start|>`, `[INST]`), jailbreak names. **Weak signals flag; two of them block:** role labels, persona switches, identity claims ("I'm Hardyal", "I'm an approved recruiter"), privilege requests, tool probing, encoded payloads, exfiltration.
- **Text is normalised first** (NFKC, zero-width and control characters removed), so `ig​nore` or full-width letters don't hide an override.
- **Forged history is dropped.** The page sends earlier turns back, so an attacker can invent an "earlier answer" quoting a salary for the model to continue. An assistant turn that fails this tier's output guard, or carries injection markers, is replaced with "(earlier answer omitted)".
- A blocked question gets a fixed reply and costs no model call. A flagged one is answered, with the question wrapped as untrusted data. Only the reasons are logged, never the text.
- The system prompt adds the same rules: access comes from the session, never the chat, and visitor text is data, not instructions.

## Semantic cache

Recruiters ask the same dozen questions, so `src/cache.js` answers repeats from KV with no model call:
- **Exact hits** match the normalised question and need no embedding.
- **Semantic hits** need a cosine of at least 0.92 (`SEMANTIC_CACHE_THRESHOLD`) **and** at least two-thirds overlap in key terms. Without the term check, "Do you know Kafka?" would get the cached answer about Kubernetes: the two embed close together. Questions with no key terms ("Who are you?") only match exactly.
- **Only safe answers are cached:** first questions only (a follow-up depends on its conversation), grounded answers only (cited sources, passed the guard).
- **Namespaces:** one per tier and content version (profile, private passages and system prompt), so an edit starts an empty cache. Signed-in members see what the public sees, so they share its namespace. The owner isn't cached.
- Up to 200 entries for 7 days per namespace, vectors stored as int8 (~1KB each). Writes run after the response (`waitUntil`). `SEMANTIC_CACHE=off` disables it.
- **Clearing:** "Clear cached answers" in `/admin.html` (owner only, `POST /api/admin/cache-clear`) empties every namespace when a cached answer is wrong.
- A cached answer is still signed for feedback, and the trace says it came from the cache.

## Model router

`src/router.js` sends each question to the cheapest model that answers it well. It uses rules, not a model call, since classifying with an LLM would cost about what the cheap answer saves:
- **Light** (most questions): contact, notice period, location, "do you know X?", short lookups.
- **Heavy:** design, trade-off and "how would you…" questions; long or multi-part questions; follow-ups five or more turns deep; job fit.

| | Light | Heavy |
|---|---|---|
| Gemini | `GEMINI_MODEL_LIGHT` → `GEMINI_MODEL` → `gemini-3.5-flash-lite` | `GEMINI_MODEL_HEAVY` (unset: same as light, so Gemini routing is off) |
| Claude | `ANTHROPIC_MODEL_LIGHT` → `claude-haiku-5-5` | `ANTHROPIC_MODEL` → `claude-opus-5-5` |

The saving matters most once Claude is on: Haiku answers most questions at a fraction of Opus's price. If the heavy Gemini model fails (quota, or a model the key can't use), the light one answers before Claude is tried. `MODEL_ROUTER=off` always uses the heavy models. The route and its reason are in each answer's metadata.

## Provider fallback

Gemini is the primary model (free tier). Set `ANTHROPIC_API_KEY` in the Pages project and Claude becomes the fallback: when a Gemini call fails (a quota 429, a 5xx, a network error), the request runs again on Claude (`src/providers.js`). The agent loop is shared, and each provider is an adapter that keeps its own transcript in its API's format. `ANTHROPIC_MODEL` picks the model (default `claude-opus-5-5`), and `LLM_PRIMARY=claude` puts Claude first.

- **Answers:** the whole agent run restarts on the fallback provider, so one transcript never mixes two APIs.
- **Job fit:** each of its two structured-output calls falls back on its own, since they're stateless.
- **Visible:** the trace says which model answered and why (*answered by claude-opus-5-5 after gemini failed (429)*), and the scorecard counts fallback answers.
- **Bounded cost.** Gemini's free tier 429s under load, and each 429 would otherwise become a paid Claude run, so three limits apply:
  - *Output cap:* `max_tokens` 1500 per agent step and 2000 per job-fit call, with effort `low` (thinking can't be turned off on Claude Opus 5.5 and counts toward `max_tokens`). A step cut off at the cap answers with its text and runs no half-written tool call.
  - *Daily budget:* at most `CLAUDE_DAILY_LIMIT` Claude runs per UTC day across all visitors (default 200; an answer counts once, job fit counts per call), counted in `RATE_KV`. Past it, Claude is skipped and the visitor gets the normal "busy" reply, as when Gemini's quota runs out and no Claude key is set. If KV errors (down, or out of free-plan writes) Claude is skipped too, since the per-IP limit fails open then. Without `RATE_KV` there is no budget.
  - *Per-client limit:* the hourly limit counts IPv4 addresses one by one, and IPv6 addresses per /64, the block one visitor can rotate through.

Claude-specific handling:
- **Raw `fetch`.** The build concatenates `src/` into one Worker with no bundler, so the npm SDK isn't used.
- **API version `2026-10-21`**, with no sampling parameters.
- **Strict tools.** Gemini's schemas are converted to closed JSON Schema.
- **No forced tool use.** Claude Opus 5.5 rejects `tool_choice: any`, so the first step runs `auto` and gets one reminder to retrieve if it skipped the lookup; the final step uses `none`.
- **Append-only transcript.** Assistant turns go back verbatim, thinking blocks included.
- **One `tool_result` per `tool_use`.**
- **Refusal fallback** with `fallbacks: "default"`; a refusal that survives it ends the answer cleanly.
- **Structured output** via `output_config.format` for job fit.
- **Cost** uses Anthropic's published prices, built in for current Claude models; `ANTHROPIC_PRICE_INPUT` / `ANTHROPIC_PRICE_OUTPUT` override them.

## Visitor feedback

Every live answer gets 👍 / 👎. A 👎 also offers an optional "what was wrong or missing?" note, up to 300 characters. `POST /api/feedback` stores the rating in `RATE_KV` for 90 days, with:
- the question and answer;
- the visitor's note;
- the passages the agent saw;
- the retrieval mode and model.

No IP address is stored. The page says the question and answer are sent.

**Only real answers can be rated.** Each answer arrives with a signature (`meta.fb`, an HMAC over the question and the exact text the visitor saw), keyed by `FEEDBACK_SECRET` (the LLM API keys are never reused for it). Without `FEEDBACK_SECRET` or `RATE_KV`, answers carry no signature, the page shows no buttons and `POST /api/feedback` returns 503. Feedback without a matching signature is rejected, so the store can't fill with made-up answers. That matters because 👎 entries become eval cases. Ratings count against the same per-IP (IPv6: per /64) hourly limit as questions.

**Closing the loop:** set a `FEEDBACK_ADMIN_TOKEN` secret, then run `FEEDBACK_ADMIN_TOKEN=... node scripts/feedback.mjs`. It pulls the export (`GET /api/feedback`, bearer token; off without the secret) and prints a summary. It also writes `evals/results/feedback-candidates.json`: one draft answer-eval case per 👎, with the visitor's note, the answer given and the passages seen. Each draft needs its checks written by a person, because the note says what was wrong, not what's right. Then it moves into `evals/answers.json`.

## Cost and latency

Every answer and fit check returns `usage`: model calls, input and output tokens (thinking tokens count as output), wall-clock time and, when `GEMINI_PRICE_INPUT` / `GEMINI_PRICE_OUTPUT` (USD per 1M tokens) are set, cost. Without prices, cost stays empty rather than guessed. Embedding calls aren't counted, because the API reports no usage for them. The page shows the figures in the agent trace, e.g. *1.6 s · 2,140 tokens · 2 model calls · $0.0004*, and in the job-fit note.

The Worker also writes one structured log line per answer, and a data point to Workers Analytics Engine when a `USAGE_AE` binding exists. That gives daily totals and percentiles without any KV writes. `src/worker.js` has a sample query.

## Honest skill levels

The profile separates **production skills** from **working familiarity**: things I know from courses and side projects, such as Kubernetes, Kafka, LangGraph, vector databases, Bedrock/Vertex AI and LLM evals. The agent is told to answer at the level the profile states and never upgrade familiarity to production. A test enforces that the two lists stay apart.

## Deploy

The live site is a Cloudflare Pages project in advanced mode, using `_worker.js`.

**Automatic:** every push to `main` runs `.github/workflows/deploy.yml`. It runs the tests, and only if they pass rebuilds and deploys `dist/` with wrangler. It needs two repository secrets: `CLOUDFLARE_API_TOKEN` (with the Cloudflare Pages: Edit permission) and `CLOUDFLARE_ACCOUNT_ID`.

**Manual:**

1. Run `npm test` (or `node scripts/build.mjs`, or `scripts/build.ps1` on Windows without Node).
2. Either drag the `dist/` folder into **Pages → Create deployment** (Environment: Production), or run `npx wrangler pages deploy dist`.
3. Under **Settings → Variables and Secrets**, add the secret `GEMINI_API_KEY`.
   - Optional: `GEMINI_MODEL`, `GEMINI_EMBED_MODEL` and `RAG_EMBEDDINGS=off`.
   - Optional KV binding `RATE_KV`, for rate limiting, the Claude daily budget and the embedding cache.
   - Optional `ANTHROPIC_API_KEY` (secret), for the Claude fallback; `ANTHROPIC_MODEL`, `LLM_PRIMARY` and `CLAUDE_DAILY_LIMIT` (Claude runs per day, default 200) tune it.
   - Optional `GEMINI_PRICE_INPUT` and `GEMINI_PRICE_OUTPUT` (USD per 1M tokens), to show cost per answer.
   - Optional Analytics Engine binding `USAGE_AE`, for cost and latency history.
   - Optional `FEEDBACK_SECRET` (secret) to sign answers so visitors can rate them, and `FEEDBACK_ADMIN_TOKEN` (secret) to export the feedback. Feedback needs both `FEEDBACK_SECRET` and `RATE_KV`.
   - Optional sign-in and access tiers: `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` (secret), `SESSION_SECRET` (secret, 32+ characters), `OWNER_EMAILS`, plus `RATE_KV`. See [Access tiers](#access-tiers-and-linkedin-sign-in).
   - Optional `SEMANTIC_CACHE=off` and `SEMANTIC_CACHE_THRESHOLD`; the cache needs `RATE_KV`.
   - Optional router models: `GEMINI_MODEL_LIGHT`, `GEMINI_MODEL_HEAVY`, `ANTHROPIC_MODEL_LIGHT`, and `MODEL_ROUTER=off`.

## Updating the knowledge

Edit `knowledge/profile.json` and run `npm test`. That regenerates `src/knowledge.js`, syncs the copy embedded in the page, and rebuilds `dist/`. Embeddings refresh automatically, because the cache key changes with the content.

## Related

- [claude-toolkit](https://github.com/hardyalsinghdeora/claude-toolkit): guardrails and token-cost control for Claude Code agent sessions
- [case-studies](https://github.com/hardyalsinghdeora/case-studies): decision record of a live MySQL → PostgreSQL migration
- [spring-boot-order-service](https://github.com/hardyalsinghdeora/spring-boot-order-service): order-to-cash REST API in Java / Spring Boot with idempotency keys, `If-Match` and RFC 9457 errors
- [api-gateway-rate-limiter](https://github.com/hardyalsinghdeora/api-gateway-rate-limiter): rate limiting, circuit breaking and safe retries in a small TypeScript gateway
- [event-outbox-worker](https://github.com/hardyalsinghdeora/event-outbox-worker): transactional outbox, at-least-once relay and idempotent consumer
- [db-migration-reconciler](https://github.com/hardyalsinghdeora/db-migration-reconciler): checksum, diff and backfill tooling for a migration with no maintenance window
- [docs/case-study-php-to-node-strangler.md](docs/case-study-php-to-node-strangler.md): replacing a live PHP app with Node.js + Angular through a strangler migration with a shared login
- [LinkedIn](https://www.linkedin.com/in/hardyalsinghdeora) · [Substack](https://substack.com/@hardyalsingh)

## License

Code is MIT (see [LICENSE](LICENSE)). The profile content in `knowledge/` and `public/` describes me; please don't reuse it as your own.
