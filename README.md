# Portfolio agent: hybrid RAG + tool-calling on Cloudflare Workers

Source for **[hardyalsinghdeora.pages.dev](https://hardyalsinghdeora.pages.dev/)**, the portfolio of Hardyal Singh Deora, Principal Software Engineer and Agentic AI Architect.

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
  knowledge/profile.json → ~50 titled chunks
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
| **No vector database** | ~50 chunks fit in memory. Document vectors are computed once per Worker isolate and cached in KV, so a managed vector DB would add cost and a moving part for no gain at this size. The `search()` interface is the seam where one would plug in. |
| **Bounded loop: ANY → AUTO → NONE** | The first step is forced to retrieve, so answers are grounded. The last step is forced to answer, so cost and latency have a hard ceiling. |
| **Tools return facts only** | Tools are read-only over a public profile. Unknown tools and bad arguments return errors to the model instead of throwing. |
| **Keys and prompt stay server-side** | The browser sends only conversation turns, so the endpoint can't be repurposed as a free Gemini proxy. |
| **Graceful degradation** | If the embedding call fails, the agent falls back to BM25. If the LLM is down or rate-limited, the page falls back to scripted answers. |

More detail, including trade-offs and what I'd do at larger scale, is in [docs/architecture.md](docs/architecture.md).

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
tests/evals.json         retrieval eval set (28 recruiter questions → expected chunks)
.github/workflows/       deploys dist/ to Cloudflare Pages on every push to main
scripts/build.ps1        builds dist/ and bundles src/ into one dist/_worker.js
scripts/dev-server.ps1   local static server with a mocked /api/ask for UI checks
dist/                    deployable output (committed so the repo deploys as-is)
```

## Tests and evals

```bash
powershell -ExecutionPolicy Bypass -File scripts/build.ps1
powershell -ExecutionPolicy Bypass -File scripts/dev-server.ps1
```

Then open `http://localhost:8787/tests/`. It runs the real modules against a mocked Gemini API, with no key and no network:

- **21/21 tests passing:** chunking, BM25, synonym expansion, RRF, hybrid search, embedding cache, BM25 fallback, the agent loop (tool calls, thought-signature echo, step bounds, unknown tools, hidden thoughts), Worker guards (405/400/403/429/503), and a check that working-familiarity skills never leak into production skills.
- **Retrieval eval (BM25 only, the worst case):** hit@5 = 28/28, hit@1 = 22/28.

## Honest skill levels

The profile separates **production skills** from **working familiarity**: things I know from courses and side projects, such as Kubernetes, Kafka, LangGraph, vector databases, Bedrock/Vertex AI and LLM evals. The agent is told to answer at the level the profile states and never upgrade familiarity to production. A test enforces that the two lists stay apart.

## Deploy

The live site is a Cloudflare Pages project in advanced mode, using `_worker.js`.

**Automatic:** every push to `main` runs `.github/workflows/deploy.yml`, which deploys `dist/` with wrangler. It needs two repository secrets: `CLOUDFLARE_API_TOKEN` (with the Cloudflare Pages: Edit permission) and `CLOUDFLARE_ACCOUNT_ID`.

**Manual:**

1. Run `scripts/build.ps1`.
2. Either drag the `dist/` folder into **Pages → Create deployment** (Environment: Production), or run `npx wrangler pages deploy dist`.
3. Under **Settings → Variables and Secrets**, add the secret `GEMINI_API_KEY`.
   - Optional: `GEMINI_MODEL`, `GEMINI_EMBED_MODEL` and `RAG_EMBEDDINGS=off`.
   - Optional KV binding `RATE_KV`, for rate limiting and the embedding cache.

## Updating the knowledge

Edit `knowledge/profile.json` and run the build. That regenerates `src/knowledge.js`, syncs the copy embedded in the page, and rebuilds `dist/`. Embeddings refresh automatically, because the cache key changes with the content.

## Related

- [claude-toolkit](https://github.com/hardyalsinghdeora/claude-toolkit): guardrails and token-cost control for Claude Code agent sessions
- [case-studies](https://github.com/hardyalsinghdeora/case-studies): decision record of a live MySQL → PostgreSQL migration
- [LinkedIn](https://www.linkedin.com/in/hardyalsinghdeora) · [Substack](https://substack.com/@hardyalsingh)

## License

Code is MIT (see [LICENSE](LICENSE)). The profile content in `knowledge/` and `public/` describes me; please don't reuse it as your own.
