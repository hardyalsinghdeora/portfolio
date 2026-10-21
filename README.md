# Portfolio agent: hybrid RAG + tool-calling on Cloudflare Workers

Source for **[hardyalsinghdeora.pages.dev](https://hardyalsinghdeora.pages.dev/)**, the portfolio of Hardyal Singh Deora, Agentic AI Architect and Principal Software Engineer.

The page is a chat. Ask it anything about my work and an **agent** answers. It decides what to look up, retrieves evidence from my career profile with **hybrid RAG**, answers only from what it retrieved, and shows the sources and the tool calls behind every answer.

```
Visitor question
      │
      ▼
POST /api/ask ── Cloudflare Worker (src/worker.js)
      │  validate turns · same-origin check · per-IP rate limit (KV)
      ▼
Agent loop (src/agent.js) ── Gemini function calling, max 4 model calls
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
Hybrid retrieval (src/rag.js)
  knowledge/profile.json → ~70 titled chunks
  BM25 (+ synonym expansion) ─┐
                              ├─ reciprocal rank fusion → top k
  Gemini embeddings (768-d) ──┘   (falls back to BM25 if embeddings fail)
      │
      ▼
Answer text  U+001E  { sources, steps, retrieval }  →  page renders sources + agent trace
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
| **Graceful degradation** | If the embedding call fails, the agent falls back to BM25. If the LLM is down or rate-limited, the page falls back to scripted answers. |

More detail, including trade-offs and what I'd do at larger scale, is in [docs/architecture.md](docs/architecture.md).

## Voice

The mic button in the composer lets visitors ask by voice. It uses only what the browser ships, so it costs nothing and needs no key or server change:

- **Speech in:** the Web Speech API (`SpeechRecognition`) turns speech into text, which then goes through the same `/api/ask` agent as a typed question. It works in Chrome, Edge and Safari. Firefox doesn't support it, so the mic stays hidden there. Chrome and Edge send the audio to their vendor's speech service to recognise it.
- **Speech out:** `speechSynthesis` reads the answer to a voice question aloud, one sentence at a time. Links and email addresses are replaced with "on screen" rather than spelled out. The speaker button in the top bar mutes spoken replies, and the choice is remembered. Typed questions are never read aloud.

## Link previews and search

`public/` carries Open Graph and Twitter card tags, a `Person` JSON-LD block, a `<noscript>` summary for crawlers, `robots.txt`, `sitemap.xml` and a favicon. `node scripts/render-assets.mjs` re-renders the preview card (`og-image.png`) and `apple-touch-icon.png` from `knowledge/profile.json`, and prints the résumé page to `resume-agentic-ai.pdf`. Run it after changing the headline or the résumé; the outputs are committed.

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
| `GET /api/search?q=...&k=5` | Retrieval only, with no LLM call. Useful for debugging retrieval quality. |

## Repo layout

```
knowledge/profile.json   single source of truth: my career profile (public facts only)
src/rag.js               chunking, BM25, Gemini embeddings, reciprocal rank fusion
src/agent.js             system prompt, tool schemas, bounded function-calling loop
src/worker.js            HTTP routing, validation, rate limiting, response format
src/knowledge.js         generated from profile.json by the build
public/                  the page (index.html) and the Agentic AI Architect résumé
tests/index.html         zero-dependency test page: unit tests + agent-loop tests with a mocked Gemini
tests/evals.json         retrieval eval set (49 recruiter questions → expected chunks)
.github/workflows/       runs the tests, then deploys to Cloudflare Pages on every push to main
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

- **29/29 tests passing.** They cover:
  - retrieval: chunking, BM25, synonym expansion, RRF, hybrid search, the embedding cache and the BM25 fallback;
  - the agent loop: tool calls, thought-signature echo, step bounds, unknown tools and hidden thoughts;
  - Worker guards: 405, 400, 403, 429 and 503, plus the per-IP rate limit, which lets requests through if KV fails or hits its daily write cap, and visit-source counting;
  - the content rules: working-familiarity skills never leak into production skills, every `get_section` value resolves, and **no employer-internal names or verbal-only company numbers appear in the knowledge base or either public page**.
- **Retrieval eval (BM25 only, the worst case):** hit@5 = 49/49, hit@1 = 35/49. The set includes 13 Gen AI interview questions, for example "how do you prevent hallucinations?", "why no vector database?" and "how do you get structured JSON from an LLM?".

**CI gate:** the `test` job must pass before the `deploy` job runs. The deploy job then rebuilds `dist/` from the tested sources.

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
   - Optional KV binding `RATE_KV`, for rate limiting and the embedding cache.

## Updating the knowledge

Edit `knowledge/profile.json` and run `npm test`. That regenerates `src/knowledge.js`, syncs the copy embedded in the page, and rebuilds `dist/`. Embeddings refresh automatically, because the cache key changes with the content.

## Related

- [claude-toolkit](https://github.com/hardyalsinghdeora/claude-toolkit): guardrails and token-cost control for Claude Code agent sessions
- [case-studies](https://github.com/hardyalsinghdeora/case-studies): decision record of a live MySQL → PostgreSQL migration
- [docs/case-study-php-to-node-strangler.md](docs/case-study-php-to-node-strangler.md): replacing a live PHP app with Node.js + Angular through a strangler migration with a shared login
- [LinkedIn](https://www.linkedin.com/in/hardyalsinghdeora) · [Substack](https://substack.com/@hardyalsingh)

## License

Code is MIT (see [LICENSE](LICENSE)). The profile content in `knowledge/` and `public/` describes me; please don't reuse it as your own.
