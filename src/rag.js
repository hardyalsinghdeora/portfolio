// Retrieval over the career profile: chunking, BM25, Gemini embeddings and reciprocal rank fusion.
// Plain ES module with no dependencies, so the same file runs in the Worker, in the browser
// test page, and inside the single-file _worker.js that scripts/build.ps1 produces.

const STOP = new Set(("a an and are as at be but by can do does for from has have how i if in into is it its " +
  "me my of on or our so than that the their them then there these this to was we were what when where which " +
  "who why will with you your about any did tell walk through").split(" "));

// Expands a few terms recruiters use that the profile spells differently.
const SYNONYMS = {
  rag: ["retrieval", "augmented", "generation", "embeddings"],
  llm: ["llm", "agent", "model"],
  ai: ["ai", "llm", "agent", "agentic"],
  agentic: ["agent", "agents", "agentic", "tool"],
  agents: ["agent", "agentic"],
  notice: ["notice", "join", "availability"],
  salary: ["compensation"],
  ctc: ["compensation"],
  relocate: ["relocation", "location"],
  remote: ["remote", "hybrid", "work_mode"],
  postgres: ["postgresql"],
  db: ["database", "postgresql", "mysql"],
  k8s: ["kubernetes"],
  mcp: ["mcp", "model", "context", "protocol"],
  team: ["team", "squad", "engineers", "lead"],
  manage: ["lead", "squad", "mentoring", "leadership"],
};

export function tokenize(text) {
  const out = [];
  for (let w of String(text).toLowerCase().split(/[^a-z0-9+#]+/)) {
    if (!w || STOP.has(w)) continue;
    if (w.length > 4 && w.endsWith("ies")) w = w.slice(0, -3) + "y";
    else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
    out.push(w);
  }
  return out;
}

function expand(tokens) {
  const out = [...tokens];
  for (const t of tokens) if (SYNONYMS[t]) out.push(...tokenize(SYNONYMS[t].join(" ")));
  return out;
}

const list = (a) => (Array.isArray(a) ? a : []).map((x) => "- " + (typeof x === "string" ? x : JSON.stringify(x))).join("\n");

// One chunk per self-contained fact group, small enough that a top-5 retrieval stays well
// under 2k tokens. Each chunk carries a human-readable title, shown to visitors as a source.
export function buildChunks(p) {
  const c = [];
  const add = (id, title, section, text) => c.push({ id, title, section, text: title + "\n" + text });
  const id = p.identity || {};

  add("identity", "About me", "identity",
    `${id.full_name}, ${id.current_title} at ${id.current_employer}. ${id.total_experience_years} years of experience, ` +
    `${id.tenure_at_current_employer} at the current employer. Based in ${id.location} (${id.timezone}).\n` +
    `Headline: ${id.headline}\n${id.one_liner}\n${p.summary || ""}`);
  add("education", "Education and certifications", "identity",
    `${id.education ? `${id.education.degree}, ${id.education.institution}, ${id.education.year}` : ""}\n` +
    list((id.certifications || []).map((x) => `${x.name}, ${x.issuer}, ${x.issued} (verify: ${x.verify})`)));
  add("contact", "Contact and links", "contact",
    Object.entries(p.contact || {}).map(([k, v]) => `${k}: ${v}`).join("\n") +
    "\n" + Object.entries((p.meta && p.meta.human_versions) || {}).map(([k, v]) => `${k}: ${v}`).join("\n"));
  const av = p.availability || {};
  add("availability", "Availability, notice period and location", "availability",
    `Status: ${av.status}\nNotice period: ${av.notice_period}; earliest join: ${av.earliest_join}\n` +
    `Work mode: ${(av.work_mode || []).join(", ")}\nOn-site locations: ${(av.on_site_locations || []).join(", ")}\n` +
    `Relocation: ${av.relocation}`);
  const tg = p.targeting || {};
  add("targeting", "Roles I'm looking for", "targeting",
    `Target roles:\n${list(tg.roles)}\nDomains of strength:\n${list(tg.domains_of_strength)}\nIdeal work: ${tg.ideal_work || ""}`);
  add("metrics", "Headline numbers", "headline_metrics",
    list((p.headline_metrics || []).map((m) => `${m.value} ${m.label}`)));

  for (const [k, v] of Object.entries(p.skills || {})) {
    add("skills-" + k, "Skills: " + k.replace(/_/g, " "), "skills", (v || []).join(", "));
  }
  add("architecture-defaults", "Architectural defaults", "architectural_defaults", list(p.architectural_defaults));

  (p.experience || []).forEach((e, i) => {
    add("exp-" + i, `${e.title}, ${e.company} (${e.from} to ${e.to})`, "experience",
      `${e.location}. ${e.scope ? "Scope: " + e.scope + "\n" : ""}${list(e.highlights)}`);
  });
  (p.systems_owned || []).forEach((s, i) => {
    add("system-" + i, `System owned: ${s.name} (${s.domain})`, "systems_owned", s.summary);
  });

  const m = p.migration_case_study;
  if (m) {
    add("migration-context", "Migration case study: context and options rejected", "migration_case_study",
      `${m.title}\n${m.context}\nOptions rejected:\n${list(m.options_rejected)}\nURL: ${m.url}`);
    add("migration-design", "Migration case study: design", "migration_case_study", list(m.design));
    add("migration-results", "Migration case study: numbers and lessons", "migration_case_study",
      Object.entries(m.numbers || {}).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join("\n") +
      `\nLesson: ${m.lesson}\nWould do differently:\n${list(m.would_do_differently)}\nPrinciples:\n${list(m.principles)}`);
  }

  const ag = p.agentic_ai;
  if (ag) {
    add("agentic-overview", "Agentic AI: positioning and patterns", "agentic_ai",
      `${ag.positioning}\nPatterns used:\n${list(ag.patterns_used)}\nNot yet in record: ${ag.not_yet_in_record}`);
    add("agentic-agents", "Agentic AI: agents in production", "agentic_ai", list(ag.agents_in_production));
    add("agentic-guardrails", "Agentic AI: guardrails, cost control and real-time AI", "agentic_ai",
      `${list(ag.guardrails_and_cost)}\nReal-time AI (contributed): ${ag.real_time_ai_contributed}`);
  }

  add("current-focus", "What I'm working on in 2026", "current_focus_2026", list(p.current_focus_2026));
  (p.projects || []).forEach((pr, i) => {
    add("project-" + i, `Project: ${pr.name}`, "projects",
      `Status: ${pr.status || "n/a"}${pr.url ? "\nURL: " + pr.url : ""}\n${pr.summary}` +
      (pr.tools ? "\nTools:\n" + list(pr.tools) : "") +
      (pr.design_principles ? "\nDesign principles:\n" + list(pr.design_principles) : ""));
  });
  add("principles", "Working principles and leadership philosophy", "working_principles",
    `${list(p.working_principles)}\n${list(p.leadership_philosophy)}`);
  const li = p.linkedin || {};
  add("linkedin", "LinkedIn profile", "linkedin",
    `URL: ${li.url}\nListed skills: ${(li.listed_skills || []).join(", ")}`);
  for (const [k, v] of Object.entries(p.recruiter_quick_answers || {})) {
    add("qa-" + k, "Quick answer: " + k.replace(/_/g, " "), "recruiter_quick_answers", v);
  }
  return c;
}

// --- BM25 ---------------------------------------------------------------------------------

export function buildIndex(chunks) {
  const docs = chunks.map((ch) => tokenize(ch.text));
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const avg = docs.reduce((s, d) => s + d.length, 0) / Math.max(1, docs.length);
  return { chunks, docs, df, avg, N: docs.length };
}

export function bm25(index, query, k1 = 1.4, b = 0.75) {
  const q = expand(tokenize(query));
  const scores = index.docs.map((d) => {
    const tf = new Map();
    for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
    let s = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const n = index.df.get(t) || 0;
      const idf = Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.length / index.avg));
    }
    return s;
  });
  return rank(scores);
}

function rank(scores) {
  return scores.map((s, i) => ({ i, s })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
}

// --- Embeddings (Gemini) ------------------------------------------------------------------

const EMBED_DIM = 768;
const EMBED_API = "https://generativelanguage.googleapis.com/v1beta/models/";
let docVectorCache = null; // { key, vectors } kept for the life of the Worker isolate

function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

async function embed(env, texts, taskType, fetchImpl) {
  const model = env.GEMINI_EMBED_MODEL || "gemini-embedding-001";
  const out = [];
  for (let i = 0; i < texts.length; i += 100) {
    const res = await fetchImpl(`${EMBED_API}${model}:batchEmbedContents`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        requests: texts.slice(i, i + 100).map((text) => ({
          model: "models/" + model, content: { parts: [{ text }] }, taskType, outputDimensionality: EMBED_DIM,
        })),
      }),
    });
    if (!res.ok) throw new Error("embed " + res.status);
    const data = await res.json();
    for (const e of data.embeddings || []) out.push(normalize(e.values));
  }
  if (out.length !== texts.length) throw new Error("embed count mismatch");
  return out;
}

async function docVectors(env, chunks, fetchImpl) {
  const key = (env.GEMINI_EMBED_MODEL || "") + ":" + chunks.length + ":" + chunks.map((c) => c.text.length).join(",");
  if (docVectorCache && docVectorCache.key === key) return docVectorCache.vectors;
  // A KV binding (optional) lets a cold isolate skip re-embedding the profile.
  const kvKey = "emb:" + (await hash(key + chunks.map((c) => c.text).join("\u0000")));
  if (env.RATE_KV) {
    const hit = await env.RATE_KV.get(kvKey, "json").catch(() => null);
    if (hit && hit.length === chunks.length) return (docVectorCache = { key, vectors: hit }).vectors;
  }
  const vectors = await embed(env, chunks.map((c) => c.text), "RETRIEVAL_DOCUMENT", fetchImpl);
  docVectorCache = { key, vectors };
  if (env.RATE_KV) await env.RATE_KV.put(kvKey, JSON.stringify(vectors), { expirationTtl: 60 * 60 * 24 * 30 }).catch(() => {});
  return vectors;
}

async function hash(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// --- Hybrid search ------------------------------------------------------------------------

// Reciprocal rank fusion: robust to the two scorers living on different scales.
export function rrf(rankings, k = 60) {
  const score = new Map();
  for (const r of rankings) r.forEach((x, pos) => score.set(x.i, (score.get(x.i) || 0) + 1 / (k + pos + 1)));
  return [...score.entries()].map(([i, s]) => ({ i, s })).sort((a, b) => b.s - a.s);
}

export async function search(index, query, { k = 5, env = {}, fetchImpl = fetch } = {}) {
  const lexical = bm25(index, query);
  let mode = "bm25", ranked = lexical;
  if (env.GEMINI_API_KEY && env.RAG_EMBEDDINGS !== "off") {
    try {
      const [vectors, [qv]] = await Promise.all([
        docVectors(env, index.chunks, fetchImpl),
        embed(env, [query], "RETRIEVAL_QUERY", fetchImpl),
      ]);
      const semantic = rank(vectors.map((v) => dot(v, qv))).slice(0, 20);
      ranked = rrf([lexical.slice(0, 20), semantic]);
      mode = "hybrid";
    } catch (err) {
      console.warn("embeddings unavailable, using BM25 only:", err && err.message);
    }
  }
  return { mode, hits: ranked.slice(0, k).map((x) => ({ ...index.chunks[x.i], score: +x.s.toFixed(4) })) };
}
