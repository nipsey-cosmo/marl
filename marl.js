#!/usr/bin/env node
// marl — minimal project knowledge store for AI agents. Zero dependencies.
// Records live in .marl/knowledge.jsonl, one JSON object per line.
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// walk up like git: an agent working in packages/api/ must find the project's store,
// not silently start a second one there
function findDir() {
  for (let dir = process.cwd(); ; ) {
    const candidate = path.join(dir, ".marl");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return path.join(process.cwd(), ".marl"); // none anywhere: create here
    dir = parent;
  }
}

const DIR = findDir();
const FILE = path.join(DIR, "knowledge.jsonl");
const ARCHIVE = path.join(DIR, "archive.jsonl");

const TYPES = ["convention", "pattern", "failure", "decision", "note"];
const REQUIRED = ["id", "domain", "type", "text", "created"];

// the file is documented as hand-editable, so treat it as untrusted input
function load(file = FILE) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((raw, i) => {
      let rec;
      try {
        rec = JSON.parse(raw);
      } catch {
        fail(`${file}:${i + 1} is not valid JSON — fix or delete the line`);
      }
      for (const key of REQUIRED) {
        if (typeof rec[key] !== "string") fail(`${file}:${i + 1} is missing "${key}"`);
      }
      return { tags: [], confirms: 0, last_used: null, ...rec };
    });
}

function save(records, file = FILE) {
  fs.mkdirSync(DIR, { recursive: true });
  // atomic: a crash mid-write must not truncate the knowledge base
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""));
  fs.renameSync(tmp, file);
}

function append(records, file) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function fail(msg) {
  console.error(`marl: ${msg}`);
  process.exit(1);
}

function newId(records) {
  let id;
  do id = randomBytes(3).toString("hex");
  while (records.some((r) => r.id === id));
  return id;
}

function find(records, id) {
  const exact = records.find((r) => r.id === id);
  if (exact) return exact;
  const prefixed = records.filter((r) => r.id.startsWith(id));
  if (prefixed.length === 0) fail(`no record with id "${id}"`);
  if (prefixed.length > 1) fail(`id "${id}" is ambiguous: ${prefixed.map((r) => r.id).join(", ")}`);
  return prefixed[0];
}

// ponytail: shared-word overlap, not embeddings — a nudge for agents that skip `marl search`
const words = (s) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);

function similar(text, records) {
  const a = words(text);
  if (!a.size) return [];
  return records
    .map((r) => {
      const b = words(r.text);
      const shared = [...a].filter((w) => b.has(w)).length;
      return { r, shared, overlap: shared / Math.min(a.size, b.size) };
    })
    .filter((h) => h.shared >= 2 && h.overlap >= 0.5)
    .sort((x, y) => y.overlap - x.overlap)
    .slice(0, 3)
    .map((h) => h.r);
}

function archive(records, reason) {
  append(records.map((r) => ({ ...r, archived: new Date().toISOString(), reason })), ARCHIVE);
}

function line(r) {
  const badge = r.confirms > 0 ? `, ×${r.confirms}` : "";
  const tags = r.tags?.length ? ` #${r.tags.join(" #")}` : "";
  return `- [${r.id}] (${r.type}${badge}) ${r.text}${tags}`;
}

const AGENT_BLOCK = `## marl — this project's knowledge store

Run \`marl prime\` at session start and treat the output as project ground truth.

- **Before recording:** \`marl search <keywords>\` — if the fact already exists, \`marl confirm <id>\` instead of duplicating it.
- **Before finishing a task:** record non-obvious learnings — \`marl record <domain> "<text>" --type ${TYPES.join("|")}\`.
- **When a primed record proves correct in practice:** \`marl confirm <id>\`. Confirm means "I applied this and it held", not "I read it" — confirming everything you prime destroys the signal that keeps knowledge alive.
- **When a primed record proves wrong:** \`marl revise <id> "<corrected text>"\`. Never record a contradicting fact alongside the old one. If it no longer applies at all, \`marl drop <id> "<reason>"\`.
- **When committing:** include \`.marl/\` in the same commit as the change that produced the learning.

One fact per record, written so a stranger can act on it without context: gotchas with their resolution (\`failure\`), choices with their reason (\`decision\`), "always do X here" rules (\`convention\`), reusable approaches (\`pattern\`). Do not record anything derivable by reading the code, session-specific state, secrets, or restatements of the task.

Domains are short, stable, lowercase labels (\`db\`, \`api\`, \`auth\`, \`build\`). Reuse an existing one before inventing a new one.
`;

const cmds = {
  init(args) {
    const { values } = parseArgs({ args, options: { "no-hook": { type: "boolean", default: false } } });
    const here = path.join(process.cwd(), ".marl");
    if (fs.existsSync(DIR) && DIR !== here) console.log(`note: existing store at ${DIR} — this creates a separate one`);
    fs.mkdirSync(here, { recursive: true });
    console.log(`store: ${here}`);

    const targets = ["CLAUDE.md", "AGENTS.md"].filter((f) => fs.existsSync(path.join(process.cwd(), f)));
    for (const name of targets.length ? targets : ["CLAUDE.md"]) {
      const file = path.join(process.cwd(), name);
      const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      if (current.includes("marl prime")) {
        console.log(`${name}: already documented`);
        continue;
      }
      fs.writeFileSync(file, (current ? `${current.trimEnd()}\n\n` : "") + AGENT_BLOCK);
      console.log(`${name}: added agent instructions`);
    }
    if (values["no-hook"]) return;

    // step 1 of the loop shouldn't depend on an agent remembering to run a command
    const file = path.join(process.cwd(), ".claude", "settings.json");
    let settings = {};
    if (fs.existsSync(file)) {
      try {
        settings = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        fail(`${file} is not valid JSON — fix it, or run: marl init --no-hook`);
      }
    }
    settings.hooks ??= {};
    settings.hooks.SessionStart ??= [];
    if (JSON.stringify(settings.hooks.SessionStart).includes("marl prime")) {
      console.log("hook: already installed");
      return;
    }
    settings.hooks.SessionStart.push({ hooks: [{ type: "command", command: "marl prime" }] });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
    console.log(`hook: SessionStart → marl prime (${file})`);
  },

  record(args) {
    const { values, positionals } = parseArgs({
      args,
      options: { type: { type: "string", default: "note" }, tags: { type: "string" } },
      allowPositionals: true,
    });
    const [domain, ...text] = positionals;
    if (!domain || text.length === 0) fail("usage: marl record <domain> <text...> [--type t] [--tags a,b]");
    if (!TYPES.includes(values.type)) fail(`type must be one of: ${TYPES.join(", ")}`);
    const existing = load();
    const rec = {
      id: newId(existing),
      domain,
      type: values.type,
      text: text.join(" "),
      tags: values.tags ? values.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
      created: new Date().toISOString(),
      last_used: null,
      confirms: 0,
    };
    // append, not read-modify-write: parallel agents recording at once must not lose records
    append([rec], FILE);
    console.log(`recorded [${rec.id}] in ${domain}`);

    const dupes = similar(rec.text, existing);
    for (const d of dupes) console.log(`  similar: ${d.domain} ${line(d)}`);
    if (dupes.length) console.log(`  → same fact? marl drop ${rec.id} duplicate && marl confirm ${dupes[0].id}`);

    const domains = [...new Set(existing.map((r) => r.domain))].sort();
    if (domains.length && !domains.includes(domain)) {
      console.log(`  new domain "${domain}" — existing: ${domains.join(", ")} (reuse one if it fits)`);
    }
  },

  prime(args) {
    const { values, positionals } = parseArgs({
      args,
      options: { limit: { type: "string" }, json: { type: "boolean", default: false } },
      allowPositionals: true,
    });
    const [domain] = positionals;
    let records = load();
    if (domain) records = records.filter((r) => r.domain === domain);
    if (records.length === 0) {
      if (values.json) return console.log("[]");
      console.log(domain ? `No knowledge for domain "${domain}".` : "No knowledge recorded yet. Use: marl record <domain> <text...>");
      return;
    }
    // most-confirmed first: what survived contact with reality leads the context window
    const byTrust = (a, b) => b.confirms - a.confirms || a.created.localeCompare(b.created);
    let omitted = 0;
    if (values.limit !== undefined) {
      const n = Number(values.limit);
      if (!Number.isFinite(n) || n <= 0) fail("--limit must be a positive number");
      omitted = Math.max(0, records.length - n);
      records = [...records].sort(byTrust).slice(0, n);
    }

    if (values.json) return console.log(JSON.stringify([...records].sort(byTrust)));

    console.log("# Project knowledge (.marl)\n");
    const domains = [...new Set(records.map((r) => r.domain))].sort();
    for (const d of domains) {
      console.log(`## ${d}`);
      for (const r of records.filter((r) => r.domain === d).sort(byTrust)) console.log(line(r));
      console.log("");
    }
    // no silent caps: a truncated prime that looks complete is worse than no prime
    if (omitted) console.log(`_${omitted} less-confirmed record(s) omitted — raise --limit or prime one domain._`);
    // prime is a pure read: being printed is not evidence a record is useful, only that it
    // exists. Stamping last_used here made every record immortal and prune a no-op.
  },

  search(args) {
    const { values, positionals } = parseArgs({
      args,
      options: { json: { type: "boolean", default: false } },
      allowPositionals: true,
    });
    if (positionals.length === 0) fail("usage: marl search <query...> [--json]");
    const terms = positionals.join(" ").toLowerCase().split(/\s+/);
    // ponytail: term-count scoring, BM25 when corpus outgrows a screenful
    const hits = load()
      .map((r) => {
        const hay = `${r.domain} ${r.type} ${r.text} ${r.tags.join(" ")}`.toLowerCase();
        return { r, score: terms.filter((t) => hay.includes(t)).length };
      })
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || b.r.confirms - a.r.confirms);
    if (values.json) return console.log(JSON.stringify(hits.map((h) => h.r)));
    if (hits.length === 0) {
      console.log("No matches.");
      return;
    }
    for (const h of hits) console.log(`${h.r.domain} ${line(h.r)}`);
  },

  revise(args) {
    const { values, positionals } = parseArgs({
      args,
      options: { type: { type: "string" }, tags: { type: "string" } },
      allowPositionals: true,
    });
    const [id, ...text] = positionals;
    if (!id || text.length === 0) fail("usage: marl revise <id> <text...> [--type t] [--tags a,b]");
    if (values.type && !TYPES.includes(values.type)) fail(`type must be one of: ${TYPES.join(", ")}`);
    const records = load();
    const old = find(records, id);
    const rec = {
      ...old,
      id: newId(records),
      type: values.type ?? old.type,
      text: text.join(" "),
      tags: values.tags ? values.tags.split(",").map((t) => t.trim()).filter(Boolean) : old.tags,
      created: new Date().toISOString(),
      last_used: null,
      confirms: 0, // corrected knowledge earns trust again from scratch
      supersedes: old.id,
    };
    archive([old], `revised by ${rec.id}`);
    save([...records.filter((r) => r.id !== old.id), rec]);
    console.log(`revised [${old.id}] → [${rec.id}] ${rec.text}`);
  },

  drop(args) {
    const [id, ...reason] = args;
    if (!id) fail("usage: marl drop <id> [reason...]");
    const records = load();
    const rec = find(records, id);
    archive([rec], reason.join(" ") || "dropped");
    save(records.filter((r) => r.id !== rec.id));
    console.log(`dropped [${rec.id}] ${rec.text}`);
  },

  confirm(args) {
    const [id] = args;
    if (!id) fail("usage: marl confirm <id>");
    const records = load();
    const rec = find(records, id);
    rec.confirms += 1;
    rec.last_used = new Date().toISOString();
    save(records);
    console.log(`confirmed [${rec.id}] (×${rec.confirms}) ${rec.text}`);
  },

  prune(args) {
    const { values } = parseArgs({
      args,
      options: { days: { type: "string", default: "90" }, "dry-run": { type: "boolean", default: false } },
    });
    const days = Number(values.days);
    if (!Number.isFinite(days) || days <= 0) fail("--days must be a positive number");
    const cutoff = Date.now() - days * 86400000;
    const records = load();
    const stale = records.filter((r) => new Date(r.last_used ?? r.created).getTime() < cutoff);
    if (stale.length === 0) {
      console.log("Nothing stale.");
      return;
    }
    for (const r of stale) console.log(`${values["dry-run"] ? "would archive" : "archived"} ${r.domain} ${line(r)}`);
    if (!values["dry-run"]) {
      const staleIds = new Set(stale.map((r) => r.id));
      archive(stale, `unconfirmed for ${days} days`);
      save(records.filter((r) => !staleIds.has(r.id)));
    }
  },
};

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || !cmds[cmd]) {
  console.log(`marl — project knowledge for AI agents

usage:
  marl init [--no-hook]
      set up .marl, agent instructions, and a SessionStart prime hook
  marl record <domain> <text...> [--type ${TYPES.join("|")}] [--tags a,b]
      record one fact; warns on near-duplicates and new domains
  marl prime [domain] [--limit n] [--json]
      print knowledge, most-confirmed first — inject into agent context
  marl search <query...> [--json]
      find records
  marl confirm <id>
      "I applied this and it held" — keeps the record alive
  marl revise <id> <text...> [--type t] [--tags a,b]
      replace a record that turned out wrong
  marl drop <id> [reason...]
      archive a record that no longer applies
  marl prune [--days 90] [--dry-run]
      archive records unconfirmed for N days

ids accept any unambiguous prefix. nothing is deleted — see .marl/archive.jsonl`);
  process.exit(cmd ? 1 : 0);
}
cmds[cmd](rest);
