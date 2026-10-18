# Architecture decision record: portfolio agent

**Status:** accepted · **Date:** 2026-10-18 · **Author:** Hardyal Singh Deora

## Context

The portfolio chat used to send the whole career profile (~27k characters, ~7k tokens) as the system prompt on every question, then stream Gemini's answer. It worked, but:

- every question paid for the full profile, and the cost grew with each fact I added;
- answers couldn't say *where* a fact came from;
- the model had no way to look something up twice or ask for a whole section;
- it didn't demonstrate the agent and retrieval work I want to be hired for.

Constraints: Cloudflare Pages free tier, deployment by dashboard drag-and-drop (a single `_worker.js`), no build toolchain, and one Gemini API key.

## Decision

1. **Chunk the profile into ~70 self-contained, titled passages.** There is one chunk per role, system, project, skill group, quick answer and case-study part. Titles double as human-readable sources.
2. **Hybrid retrieval.** BM25 with light stemming and a small synonym map, plus Gemini `gemini-embedding-001` vectors (768-d, normalised, cosine). The two rankings are fused with reciprocal rank fusion (k = 60).
3. **Agent loop with Gemini function calling and three read-only tools.**
   - Step 1 runs with `toolConfig: ANY`, which forces retrieval.
   - The middle steps run with `AUTO`.
   - The final step runs with `NONE`, which forces an answer.
   - The loop is capped at 4 model calls, with at most 3 tool calls per step.
4. **Wire format:** answer text, then U+001E, then JSON metadata. Older clients that ignore the metadata keep working.
5. **Plain ES modules plus a PowerShell bundler.** The modules run unchanged in the Worker, in the browser test page, and concatenated into one `_worker.js`. The build fails on duplicate top-level names.

## Alternatives considered

| Option | Why not (yet) |
|---|---|
| Keep full-context prompting | Simple, but no citations, cost grows with the profile, and no agency. |
| Cloudflare Vectorize + Workers AI embeddings | Needs extra bindings and a separate indexing step. At ~70 chunks, brute-force cosine in memory takes well under a millisecond. Worth it beyond ~10k chunks. |
| Embeddings only | Misses exact-match terms (tech names, "notice period") that BM25 gets right. The eval set includes these. |
| LangChain / LangGraph | A heavy dependency for three tools and a four-step loop. The whole agent is ~150 lines I can explain line by line. |
| Streaming the final answer token by token | The agent's tool steps are non-streaming. Answers are 2–5 sentences, so the latency gain doesn't justify handling a function call mid-stream. Revisit for longer answers. |

## Consequences

- **Cost:**
  - Per question: one query embedding plus 2–3 small generate calls carrying ~1–2k retrieved tokens, instead of ~7k.
  - Per isolate: document embeddings are computed once, then cached in KV for 30 days when `RATE_KV` is bound.
- **Grounding:** the first step must retrieve, the system prompt restricts answers to tool output, and the UI shows sources, so visitors can judge the answer themselves.
- **Failure modes:**
  - Embedding API down → BM25 only (`retrieval: "bm25"` in the metadata).
  - Generate API 429 → page shows its "busy" note and scripted answers.
  - Unknown tool → error returned to the model.
- **Security:** the prompt and key stay server-side, there is a same-origin check and per-IP rate limit, and tools are read-only over public data. The profile contains no phone number or private identifiers. A test enforces the phone-number rule.

## Evaluation

`tests/evals.json` holds 49 questions recruiters actually ask. They include "do you know Kubernetes / LangGraph / Bedrock?" and 13 Gen AI interview questions, such as hallucination control, token cost, structured output and "why no vector database?". Each question lists the chunks that should answer it. On BM25 alone, the worst case, the result is **hit@5 = 49/49** and **hit@1 = 35/49**.

Adding the working-familiarity chunks first regressed one question ("What are you working on right now?" matched the word "working"). The eval caught it, and a synonym for "now" / "currently" fixed it. That's the reason to keep the eval in the build. `npm test` runs it headlessly, and CI won't deploy unless it passes. Expanding the set for Gen AI questions surfaced two more stemming gaps ("backfill" vs "backfilled", "safe" vs "safety"), and both were fixed with synonyms.

Next:
- add an LLM-as-judge pass on answer faithfulness;
- log anonymised retrieval misses, the questions where the top score is low, to grow the eval set.
