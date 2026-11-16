#!/usr/bin/env node
// marl — minimal project knowledge store for AI agents. Zero dependencies.
// Records live in .marl/knowledge.jsonl, one JSON object per line.
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
const ROOT = path.dirname(DIR); // project root: record paths are relative to it, git runs in it
const FILE = path.join(DIR, "knowledge.jsonl");
const ARCHIVE = path.join(DIR, "archive.jsonl");

const TYPES = ["convention", "pattern", "failure", "decision", "note"];
const REQUIRED = ["id", "domain", "type", "text", "created"];

// the file is documented as hand-editable, so treat it as untrusted input
function parse(file) {
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
      if (rec.paths !== undefined && !Array.isArray(rec.paths)) fail(`${file}:${i + 1} "paths" must be an array of globs`);
      return { tags: [], paths: [], confirms: 0, last_used: null, ...rec };
    });
}

// The active store. `.marl/.gitattributes` makes git union-merge the jsonl files, which
// keeps both sides' lines — so the same id can appear twice (both branches confirmed it),
// and a record one branch archived can come back from a branch that confirmed it.
function load() {
  // archive wins over a resurrected line; safe because revise gives the replacement a new id
  const archived = new Set(parse(ARCHIVE).map((r) => r.id));
  const byId = new Map(); // a Map keeps first-seen order when a key is re-set
  for (const r of parse(FILE)) {
    if (archived.has(r.id)) continue;
    const seen = byId.get(r.id);
    if (!seen) {
      byId.set(r.id, r);
      continue;
    }
    // ponytail: two branches that each confirmed once merge to max (×1), not sum (×2) —
    // an append-only event log of confirms would fix it if the count ever matters
    const last_used = [seen.last_used, r.last_used].filter(Boolean).sort().at(-1) ?? null;
    byId.set(r.id, { ...(r.confirms > seen.confirms ? r : seen), last_used });
  }
  return [...byId.values()];
}

// ponytail: no locking — every caller is load → change → save, so a parallel `marl record`
// in the same checkout that appends between the load and this rename loses its line.
// Upgrade path: a lock file, or make the store an append-only event log.
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

// `marl hook` rides on the user's tool call and must never break it: there, an error is
// thrown for the hook to swallow instead of ending the process with a message and exit 1
let quiet = false;

function fail(msg) {
  if (quiet) throw new Error(msg);
  console.error(`marl: ${msg}`);
  process.exit(1);
}

const csv = (s) => (s ? s.split(",").map((t) => t.trim()).filter(Boolean) : []);
const slash = (p) => p.replaceAll("\\", "/"); // Windows separators → the one form globs are written in

// ponytail: no braces, negation or [classes] — `**` crosses "/", `*` and `?` stay inside a
// segment, everything else is literal. Swap for path.matchesGlob when engines moves to >=22.
function globRe(glob) {
  const re = slash(glob).replace(/\*\*\/|\*\*|\*|\?|[.+^${}()|[\]]/g, (m) =>
    // "**/" also matches zero directories: src/**/x.js must match src/x.js
    m === "**/" ? "(?:.*/)?" : m === "**" ? ".*" : m === "*" ? "[^/]*" : m === "?" ? "[^/]" : `\\${m}`,
  );
  return new RegExp(`^${re}$`);
}

// does any glob of the record match any of these root-relative, "/"-separated files?
const touches = (r, files) => r.paths.map(globRe).some((re) => files.some((f) => re.test(f)));

// a file as given (absolute, or relative to cwd) → root-relative with "/" separators;
// null when it lies outside the project, so that it matches nothing
function rel(file) {
  const r = slash(path.relative(ROOT, path.resolve(slash(file))));
  return r === ".." || r.startsWith("../") || path.isAbsolute(r) ? null : r;
}

const matching = (records, files) => {
  const rels = files.map(rel).filter(Boolean);
  return records.filter((r) => touches(r, rels));
};

// every project file, root-relative: what git tracks or would track (so not ignored files),
// or, outside a repo, a plain walk
function projectFiles() {
  try {
    // -z: NUL-separated and unquoted, so odd file names arrive as they are
    return execFileSync("git", ["-C", ROOT, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\0")
      .filter(Boolean);
  } catch {
    return fs
      .readdirSync(ROOT, { recursive: true })
      .map(slash)
      .filter((f) => !/(^|\/)(\.git|node_modules)\//.test(f));
  }
}

function newId(records) {
  // archived ids are taken too: load() hides any active record whose id is in the archive
  const taken = new Set([...records, ...parse(ARCHIVE)].map((r) => r.id));
  let id;
  do id = randomBytes(3).toString("hex");
  while (taken.has(id));
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

// commits on HEAD after a timestamp, or null when git can't say (no repo, no git, no HEAD)
function commitsSince(iso) {
  try {
    const out = execFileSync("git", ["-C", ROOT, "rev-list", "--count", `--since=${iso}`, "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"], // git's "not a git repository" is not the user's problem
    });
    return /^\d+\s*$/.test(out) ? Number(out) : null;
  } catch {
    return null;
  }
}

function line(r) {
  const badge = r.confirms > 0 ? `, ×${r.confirms}` : "";
  const tags = r.tags?.length ? ` #${r.tags.join(" #")}` : "";
  const paths = r.paths?.length ? ` @${r.paths.join(" @")}` : ""; // the scope, so a reader sees where it applies
  return `- [${r.id}] (${r.type}${badge}) ${r.text}${tags}${paths}`;
}

const VERSION = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "package.json"), "utf8")).version;

// markers so `marl init` can update its own block on upgrade instead of duplicating it
const START = "<!-- marl:start -->";
const END = "<!-- marl:end -->";

const UNION = "*.jsonl merge=union";

const AGENT_BLOCK =`${START}
## marl — this project's knowledge store

Run \`marl prime\` at session start and treat the output as project ground truth.

- **Before recording:** \`marl search <keywords>\` — if the fact already exists, \`marl confirm <id>\` instead of duplicating it.
- **Before finishing a task:** record non-obvious learnings — \`marl record <domain> "<text>" --type ${TYPES.join("|")}\`. If the fact is about specific files, add \`--paths "src/db/**,migrations/*.sql"\`: it then shows up when those files are touched instead of in every session.
- **Before editing an unfamiliar file:** \`marl for <file>\` prints the records scoped to it — skip this if a hook already hands them to you when you open the file.
- **When a primed record proves correct in practice:** \`marl confirm <id>\`. Confirm means "I applied this and it held", not "I read it" — confirming everything you prime destroys the signal that keeps knowledge alive.
- **When a primed record proves wrong:** \`marl revise <id> "<corrected text>"\`. Never record a contradicting fact alongside the old one. If it no longer applies at all, \`marl drop <id> "<reason>"\`.
- **When committing:** include \`.marl/\` in the same commit as the change that produced the learning.

One fact per record, written so a stranger can act on it without context: gotchas with their resolution (\`failure\`), choices with their reason (\`decision\`), "always do X here" rules (\`convention\`), reusable approaches (\`pattern\`). Do not record anything derivable by reading the code, session-specific state, secrets, or restatements of the task.

Domains are short, stable, lowercase labels (\`db\`, \`api\`, \`auth\`, \`build\`). Reuse an existing one before inventing a new one.
${END}
`;

const cmds = {
  init(args) {
    const { values } = parseArgs({ args, options: { "no-hook": { type: "boolean", default: false } } });
    const here = path.join(process.cwd(), ".marl");
    if (fs.existsSync(DIR) && DIR !== here) console.log(`note: existing store at ${DIR} — this creates a separate one`);
    fs.mkdirSync(here, { recursive: true });
    console.log(`store: ${here}`);

    // union merge: two branches that each append a record must not conflict on merge
    const attrs = path.join(here, ".gitattributes");
    const had = fs.existsSync(attrs) ? fs.readFileSync(attrs, "utf8") : "";
    if (had.split(/\r?\n/).includes(UNION)) {
      console.log("gitattributes: up to date");
    } else {
      fs.writeFileSync(attrs, (had && !had.endsWith("\n") ? `${had}\n` : had) + `${UNION}\n`);
      console.log(`gitattributes: ${UNION} (${attrs})`);
    }

    const targets = ["CLAUDE.md", "AGENTS.md"].filter((f) => fs.existsSync(path.join(process.cwd(), f)));
    for (const name of targets.length ? targets : ["CLAUDE.md"]) {
      const file = path.join(process.cwd(), name);
      const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      const from = current.indexOf(START);
      const to = current.indexOf(END);
      if (from !== -1 && to > from) {
        const updated = current.slice(0, from) + AGENT_BLOCK.trimEnd() + current.slice(to + END.length);
        if (updated === current) {
          console.log(`${name}: instructions up to date`);
          continue;
        }
        fs.writeFileSync(file, updated);
        console.log(`${name}: updated agent instructions`);
      } else if (current.includes("marl prime")) {
        // pre-0.2.0 block, no markers — its bounds aren't knowable, so don't guess at them
        console.log(`${name}: has unmarked marl instructions — delete them and re-run to get the current block`);
      } else {
        fs.writeFileSync(file, (current ? `${current.trimEnd()}\n\n` : "") + AGENT_BLOCK);
        console.log(`${name}: added agent instructions`);
      }
    }
    if (values["no-hook"]) return;

    // the loop shouldn't depend on an agent remembering to run a command: prime at session
    // start, path-scoped records when a matching file is read or edited
    const wanted = {
      SessionStart: { hooks: [{ type: "command", command: "marl prime" }] },
      PreToolUse: { matcher: "Read|Edit|Write", hooks: [{ type: "command", command: "marl hook" }] },
    };
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
    let changed = false;
    for (const [event, entry] of Object.entries(wanted)) {
      const { command } = entry.hooks[0];
      const installed = (settings.hooks[event] ??= []);
      if (JSON.stringify(installed).includes(command)) {
        console.log(`hook: ${event} already installed`);
        continue;
      }
      installed.push(entry);
      changed = true;
      console.log(`hook: ${event} → ${command} (${file})`);
    }
    if (!changed) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  },

  record(args) {
    const { values, positionals } = parseArgs({
      args,
      options: { type: { type: "string", default: "note" }, tags: { type: "string" }, paths: { type: "string" } },
      allowPositionals: true,
    });
    const [domain, ...text] = positionals;
    if (!domain || text.length === 0) fail("usage: marl record <domain> <text...> [--type t] [--tags a,b] [--paths glob,glob]");
    if (!TYPES.includes(values.type)) fail(`type must be one of: ${TYPES.join(", ")}`);
    const existing = load();
    const rec = {
      id: newId(existing),
      domain,
      type: values.type,
      text: text.join(" "),
      tags: csv(values.tags),
      paths: csv(values.paths).map(slash),
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
      options: { limit: { type: "string" }, all: { type: "boolean", default: false }, json: { type: "boolean", default: false } },
      allowPositionals: true,
    });
    const [domain] = positionals;
    let records = load();
    if (domain) records = records.filter((r) => r.domain === domain);
    // a path-scoped record costs context in every session but matters only near its files, so
    // markdown leaves it to `marl for` and the hook. --json is raw data: it keeps everything.
    const total = records.length;
    if (!values.all && !values.json) records = records.filter((r) => !r.paths.length);
    const scoped = total - records.length;
    if (total === 0) {
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
    if (scoped) console.log(`_${scoped} path-scoped record(s) not shown — they appear when you touch matching files (marl for <file>, or marl prime --all)._`);
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

  for(args) {
    const { values, positionals } = parseArgs({
      args,
      options: { json: { type: "boolean", default: false } },
      allowPositionals: true,
    });
    if (positionals.length === 0) fail("usage: marl for <file...> [--json]");
    const hits = matching(load(), positionals);
    if (values.json) return console.log(JSON.stringify(hits));
    // no match prints nothing: a hook or a script calls this, and silence is the answer
    for (const r of hits) console.log(`${r.domain} ${line(r)}`);
  },

  // Claude Code PreToolUse hook: hook JSON on stdin, context for the model on stdout.
  // The output carries no permissionDecision, so it takes no part in allowing the tool call.
  hook() {
    quiet = true;
    try {
      const input = JSON.parse(fs.readFileSync(0, "utf8"));
      const file = input.tool_input.file_path;
      let hits = matching(load(), [file]);
      // once per session (per subagent: each has its own context) — the same record on every
      // Read under src/db is noise. No session_id, no memory.
      const session = input.session_id && `${input.session_id}-${input.agent_id ?? ""}`.replace(/[^A-Za-z0-9_-]/g, "");
      if (session) {
        // ponytail: no lock — parallel tool calls can show a record twice, never lose one.
        // A context compaction also forgets what was shown; `marl for <file>` brings it back.
        const seenFile = path.join(os.tmpdir(), `marl-${session}.json`);
        const seen = fs.existsSync(seenFile) ? JSON.parse(fs.readFileSync(seenFile, "utf8")) : [];
        hits = hits.filter((r) => !seen.includes(r.id));
        if (hits.length) fs.writeFileSync(seenFile, JSON.stringify([...seen, ...hits.map((r) => r.id)]));
      }
      if (hits.length === 0) return;
      const additionalContext = [`Project knowledge (.marl) for ${rel(file)}:`, ...hits.map(line)].join("\n");
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name ?? "PreToolUse", additionalContext } }));
    } catch {
      // bad stdin, broken store, unwritable tmp: say nothing, exit 0
    }
  },

  check(args) {
    const { values } = parseArgs({ args, options: { json: { type: "boolean", default: false } } });
    const files = projectFiles();
    const orphans = load().filter((r) => r.paths.length && !touches(r, files));
    if (values.json) return console.log(JSON.stringify(orphans));
    if (orphans.length === 0) {
      console.log("Nothing orphaned.");
      return;
    }
    // read-only: a moved directory doesn't make a fact wrong, so whoever reads this decides
    for (const r of orphans) console.log(`orphaned ${r.domain} ${line(r)}`);
    console.log('→ still true? marl revise <id> ... --paths <new>; gone? marl drop <id> "<reason>"');
  },

  revise(args) {
    const { values, positionals } = parseArgs({
      args,
      options: { type: { type: "string" }, tags: { type: "string" }, paths: { type: "string" } },
      allowPositionals: true,
    });
    const [id, ...text] = positionals;
    if (!id || text.length === 0) fail("usage: marl revise <id> <text...> [--type t] [--tags a,b] [--paths glob,glob]");
    if (values.type && !TYPES.includes(values.type)) fail(`type must be one of: ${TYPES.join(", ")}`);
    const records = load();
    const old = find(records, id);
    const rec = {
      ...old,
      id: newId(records),
      type: values.type ?? old.type,
      text: text.join(" "),
      tags: values.tags ? csv(values.tags) : old.tags,
      paths: values.paths === undefined ? old.paths : csv(values.paths).map(slash), // --paths "" unscopes
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
      options: {
        days: { type: "string", default: "90" },
        commits: { type: "string", default: "10" },
        "dry-run": { type: "boolean", default: false },
      },
    });
    const days = Number(values.days);
    if (!Number.isFinite(days) || days <= 0) fail("--days must be a positive number");
    if (!/^\d+$/.test(values.commits)) fail("--commits must be a non-negative integer");
    const minCommits = Number(values.commits);
    const cutoff = Date.now() - days * 86400000;
    const records = load();
    // wall time alone archives everything in a project that merely sat idle; a record is only
    // stale if the project also moved on without anyone confirming it
    let useGit = minCommits > 0;
    const reasons = new Map();
    const stale = records.filter((r) => {
      const at = new Date(r.last_used ?? r.created);
      if (!(at.getTime() < cutoff)) return false;
      const n = useGit ? commitsSince(at.toISOString()) : null;
      if (n === null) useGit = false; // git can't answer here: days-only, and don't ask again
      else if (n < minCommits) return false;
      reasons.set(r.id, `unconfirmed for ${days} days` + (n === null ? "" : ` and ${n} commits`));
      return true;
    });
    if (stale.length === 0) {
      console.log("Nothing stale.");
      return;
    }
    for (const r of stale) console.log(`${values["dry-run"] ? "would archive" : "archived"} ${r.domain} ${line(r)}`);
    if (!values["dry-run"]) {
      const staleIds = new Set(stale.map((r) => r.id));
      for (const r of stale) archive([r], reasons.get(r.id));
      save(records.filter((r) => !staleIds.has(r.id)));
    }
  },
};

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "--version" || cmd === "-v") {
  console.log(VERSION);
  process.exit(0);
}
if (!cmd || !cmds[cmd]) {
  console.log(`marl ${VERSION} — project knowledge for AI agents

usage:
  marl init [--no-hook]
      set up .marl, agent instructions, and the Claude Code hooks (prime at session start, hook on file access)
  marl record <domain> <text...> [--type ${TYPES.join("|")}] [--tags a,b] [--paths "src/db/**,migrations/*.sql"]
      record one fact; --paths scopes it to matching files; warns on near-duplicates and new domains
  marl prime [domain] [--limit n] [--all] [--json]
      print knowledge, most-confirmed first — inject into agent context.
      path-scoped records are left out (and counted) unless --all or --json
  marl search <query...> [--json]
      find records
  marl for <file...> [--json]
      print the path-scoped records whose globs match these files; silent when none do
  marl hook
      Claude Code PreToolUse hook: hook JSON on stdin → matching records as context, once per session
  marl check [--json]
      list path-scoped records whose globs match no project file (read-only)
  marl confirm <id>
      "I applied this and it held" — keeps the record alive
  marl revise <id> <text...> [--type t] [--tags a,b] [--paths glob,glob]
      replace a record that turned out wrong; type, tags and paths carry over unless given
  marl drop <id> [reason...]
      archive a record that no longer applies
  marl prune [--days 90] [--commits 10] [--dry-run]
      archive records unconfirmed for N days AND N commits (days only outside git, or --commits 0)

ids accept any unambiguous prefix. globs: ** crosses directories, * and ? stay within one;
paths are relative to the directory that holds .marl. nothing is deleted — see .marl/archive.jsonl`);
  process.exit(cmd ? 1 : 0);
}
cmds[cmd](rest);
