import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.resolve(import.meta.dirname, "marl.js");
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "marl-test-"));
// prune asks git about the project; if the temp dir happens to sit inside someone's repo,
// stop git discovering it so these tests always exercise the outside-a-repo path
const env = { ...process.env, GIT_CEILING_DIRECTORIES: os.tmpdir() };

function marl(...args) {
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8" });
  return { out: res.stdout + res.stderr, code: res.status };
}

test("record → prime → search → confirm → prune round trip", () => {
  let r = marl("record", "db", "Use WAL mode for SQLite", "--type", "convention");
  assert.equal(r.code, 0);
  const id = r.out.match(/\[(\w{6})\]/)[1];

  marl("record", "api", "Rate limit is 100/min", "--type", "note", "--tags", "limits");

  r = marl("prime");
  assert.match(r.out, /## db/);
  assert.match(r.out, /WAL mode/);
  assert.match(r.out, /#limits/);

  r = marl("prime", "db");
  assert.match(r.out, /WAL mode/);
  assert.doesNotMatch(r.out, /Rate limit/);

  r = marl("search", "sqlite", "wal");
  assert.match(r.out, /WAL mode/);
  assert.doesNotMatch(r.out, /Rate limit/);

  r = marl("confirm", id);
  assert.match(r.out, /×1/);

  r = marl("prune", "--days", "30", "--dry-run");
  assert.match(r.out, /Nothing stale/); // everything just touched

  // backdate one record, then prune for real
  const file = path.join(cwd, ".marl", "knowledge.jsonl");
  const records = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  records[1].last_used = "2020-01-01T00:00:00.000Z";
  fs.writeFileSync(file, records.map((x) => JSON.stringify(x)).join("\n") + "\n");
  r = marl("prune", "--days", "30");
  assert.match(r.out, /archived api/);
  assert.doesNotMatch(marl("prime").out, /Rate limit/);
  assert.match(fs.readFileSync(path.join(cwd, ".marl", "archive.jsonl"), "utf8"), /Rate limit/);
});

test("prime does not rescue a stale record", () => {
  const file = path.join(cwd, ".marl", "knowledge.jsonl");
  marl("record", "stale", "Old fact");
  const records = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  records.at(-1).created = "2020-01-01T00:00:00.000Z";
  fs.writeFileSync(file, records.map((x) => JSON.stringify(x)).join("\n") + "\n");

  marl("prime"); // must not stamp last_used — otherwise prune is a permanent no-op
  assert.match(marl("prune", "--days", "30", "--dry-run").out, /would archive stale/);
});

test("revise supersedes, drop archives", () => {
  let r = marl("record", "cache", "TTL is 60s", "--type", "convention", "--tags", "redis");
  const id = r.out.match(/\[(\w{6})\]/)[1];
  marl("confirm", id);

  r = marl("revise", id.slice(0, 3), "TTL is 300s"); // id prefix resolves
  assert.equal(r.code, 0);
  const newId = r.out.match(/→ \[(\w{6})\]/)[1];

  r = marl("prime", "cache");
  assert.match(r.out, /TTL is 300s/);
  assert.doesNotMatch(r.out, /60s/);
  assert.doesNotMatch(r.out, /×1/); // confirms reset — corrected knowledge re-earns trust
  assert.match(r.out, /convention/);
  assert.match(r.out, /#redis/); // type and tags carried over

  r = marl("drop", newId, "cache removed entirely");
  assert.equal(r.code, 0);
  assert.doesNotMatch(marl("prime").out, /TTL is/);
  const archived = fs.readFileSync(path.join(cwd, ".marl", "archive.jsonl"), "utf8");
  assert.match(archived, /revised by/);
  assert.match(archived, /cache removed entirely/);
});

test("record warns on near-duplicates and new domains", () => {
  marl("record", "http", "Retry on 429 with exponential backoff");

  let r = marl("record", "http", "Retry on 429 using exponential backoff");
  assert.match(r.out, /similar:/);
  assert.match(r.out, /same fact\?/);
  assert.doesNotMatch(r.out, /new domain/); // http already exists

  r = marl("record", "http", "Timeouts are 30 seconds");
  assert.doesNotMatch(r.out, /similar:/); // unrelated fact, same domain

  r = marl("record", "htp", "Typo domain");
  assert.match(r.out, /new domain "htp" — existing: .*http/);
});

test("prime ranks by confirms and reports what --limit omitted", () => {
  const id = marl("record", "rank", "Proven fact").out.match(/\[(\w{6})\]/)[1];
  marl("record", "rank", "Unproven fact");
  marl("confirm", id);

  let r = marl("prime", "rank");
  assert.ok(r.out.indexOf("Proven") < r.out.indexOf("Unproven"), "confirmed record should lead");

  r = marl("prime", "rank", "--limit", "1");
  assert.match(r.out, /Proven/);
  assert.doesNotMatch(r.out, /Unproven/);
  assert.match(r.out, /1 less-confirmed record\(s\) omitted/);
  assert.equal(marl("prime", "--limit", "0").code, 1);
});

test("finds .marl from a subdirectory", () => {
  const sub = path.join(cwd, "packages", "api");
  fs.mkdirSync(sub, { recursive: true });
  const res = spawnSync(process.execPath, [CLI, "prime", "db"], { cwd: sub, encoding: "utf8" });
  assert.match(res.stdout, /WAL mode/); // parent store, not a new empty one
  assert.ok(!fs.existsSync(path.join(sub, ".marl")));
});

test("survives hand-edited records", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marl-edit-"));
  const file = path.join(dir, ".marl", "knowledge.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: dir, encoding: "utf8" });

  // minimal record typed by hand: no tags, no confirms, no last_used
  fs.writeFileSync(file, JSON.stringify({ id: "aaa111", domain: "db", type: "note", text: "Hand written", created: "2024-01-01T00:00:00.000Z" }) + "\n");
  assert.match(run("prime").stdout, /Hand written/);
  assert.equal(run("confirm", "aaa111").status, 0);

  fs.appendFileSync(file, "{not json\n");
  const bad = run("prime");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /knowledge\.jsonl:2 is not valid JSON/);

  fs.writeFileSync(file, JSON.stringify({ id: "bbb222", domain: "db" }) + "\n");
  assert.match(run("prime").stderr, /missing "type"/);
});

test("init is idempotent and preserves existing settings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marl-init-"));
  const run = (...a) => spawnSync(process.execPath, [CLI, "init", ...a], { cwd: dir, encoding: "utf8" });
  const settingsFile = path.join(dir, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [] }] } }));

  let out = run().stdout;
  assert.match(out, /added agent instructions/);
  assert.match(out, /SessionStart/);
  assert.ok(fs.existsSync(path.join(dir, ".marl")));
  assert.match(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /marl prime/);

  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.equal(settings.model, "opus"); // untouched
  assert.ok(settings.hooks.Stop); // untouched
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, "marl prime");
  assert.deepEqual(settings.hooks.PreToolUse, [{ matcher: "Read|Edit|Write", hooks: [{ type: "command", command: "marl hook" }] }]);

  out = run().stdout;
  assert.match(out, /instructions up to date/);
  assert.match(out, /SessionStart already installed/);
  assert.match(out, /PreToolUse already installed/);
  assert.equal(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8").match(/marl prime/g).length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")), settings); // second run changed nothing
});

test("init adds the file hook to a 0.2.0 project without touching the hooks already there", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marl-upgrade-"));
  const settingsFile = path.join(dir, ".claude", "settings.json");
  const prime = { hooks: [{ type: "command", command: "marl prime" }] };
  const theirs = { matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh" }] };
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks: { SessionStart: [prime], PreToolUse: [theirs] } }));

  const out = spawnSync(process.execPath, [CLI, "init"], { cwd: dir, encoding: "utf8" }).stdout;
  assert.match(out, /SessionStart already installed/);
  assert.match(out, /PreToolUse → marl hook/);
  const { hooks } = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.deepEqual(hooks.SessionStart, [prime]); // not duplicated
  assert.deepEqual(hooks.PreToolUse, [theirs, { matcher: "Read|Edit|Write", hooks: [{ type: "command", command: "marl hook" }] }]);
});

test("init refreshes its own block, leaves the rest of the file alone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marl-block-"));
  const md = path.join(dir, "CLAUDE.md");
  const run = () => spawnSync(process.execPath, [CLI, "init", "--no-hook"], { cwd: dir, encoding: "utf8" });

  fs.writeFileSync(md, "# My project\n\nMy own notes.\n");
  run();
  let text = fs.readFileSync(md, "utf8");
  assert.match(text, /My own notes/);
  assert.match(text, /marl:start/);

  // simulate an outdated block from a previous version
  fs.writeFileSync(md, text.replace(/marl prime[\s\S]*?marl:end/, "OLD INSTRUCTIONS\n<!-- marl:end"));
  assert.match(run().stdout, /updated agent instructions/);
  text = fs.readFileSync(md, "utf8");
  assert.doesNotMatch(text, /OLD INSTRUCTIONS/);
  assert.match(text, /marl revise/);
  assert.match(text, /My own notes/); // surrounding content preserved
  assert.equal(text.match(/marl:start/g).length, 1);

  // a pre-0.2.0 unmarked block is reported, never clobbered
  fs.writeFileSync(md, "# My project\n\nRun `marl prime` at session start.\n");
  assert.match(run().stdout, /unmarked marl instructions/);
  assert.equal(fs.readFileSync(md, "utf8"), "# My project\n\nRun `marl prime` at session start.\n");
});

test("init writes a union-merge .gitattributes, once, even with --no-hook", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marl-attr-"));
  const run = () => spawnSync(process.execPath, [CLI, "init", "--no-hook"], { cwd: dir, encoding: "utf8" });
  const attrs = path.join(dir, ".marl", ".gitattributes");

  assert.match(run().stdout, /gitattributes: \*\.jsonl merge=union/);
  assert.equal(fs.readFileSync(attrs, "utf8"), "*.jsonl merge=union\n");
  assert.match(run().stdout, /gitattributes: up to date/);
  assert.equal(fs.readFileSync(attrs, "utf8"), "*.jsonl merge=union\n");

  // someone else's attributes are kept
  fs.writeFileSync(attrs, "*.md text");
  run();
  assert.equal(fs.readFileSync(attrs, "utf8"), "*.md text\n*.jsonl merge=union\n");
});

// a store written by hand, the way a union merge leaves it
function handStore(knowledge, archived) {
  // realpath: an absolute file path built from `dir` must agree with the cwd the child sees
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "marl-merge-")));
  const jsonl = (records) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.mkdirSync(path.join(dir, ".marl"));
  fs.writeFileSync(path.join(dir, ".marl", "knowledge.jsonl"), jsonl(knowledge));
  if (archived) fs.writeFileSync(path.join(dir, ".marl", "archive.jsonl"), jsonl(archived));
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: dir, env, encoding: "utf8" });
  return Object.assign(run, { dir, file: path.join(dir, ".marl", "knowledge.jsonl") });
}
// an empty file at a project-relative path, parents included
function touch(dir, file) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), "");
}
const rec =(id, text, extra = {}) => ({ id, domain: "db", type: "note", text, created: "2024-01-01T00:00:00.000Z", ...extra });

test("duplicate ids collapse to one record: max confirms, latest last_used", () => {
  const run = handStore([
    rec("aaa111", "Twice confirmed", { confirms: 1, last_used: "2024-03-01T00:00:00.000Z" }),
    rec("bbb222", "Other fact"),
    rec("aaa111", "Twice confirmed", { confirms: 3, last_used: "2024-02-01T00:00:00.000Z" }),
    rec("aaa111", "Twice confirmed", { confirms: 0, last_used: null }),
  ]); // no archive.jsonl at all — must not crash

  const res = run("prime", "--json");
  assert.equal(res.status, 0);
  const records = JSON.parse(res.stdout);
  assert.equal(records.length, 2);
  assert.equal(records[0].id, "aaa111");
  assert.equal(records[0].confirms, 3);
  assert.equal(records[0].last_used, "2024-03-01T00:00:00.000Z");

  // a rewrite keeps first-seen order and leaves one line per id
  assert.match(run("confirm", "aaa111").stdout, /×4/);
  const lines = fs.readFileSync(run.file, "utf8").trim().split("\n");
  assert.deepEqual(lines.map((l) => JSON.parse(l).id), ["aaa111", "bbb222"]);
});

test("an id in archive.jsonl stays archived even if knowledge.jsonl still has it", () => {
  const dropped = rec("ccc333", "Dropped on one branch", { confirms: 2 });
  const run = handStore(
    [dropped, rec("ddd444", "Still alive")],
    // the archive may hold the same id twice after a union merge — harmless
    [{ ...dropped, archived: "2024-05-01T00:00:00.000Z", reason: "dropped" }, { ...dropped, archived: "2024-05-02T00:00:00.000Z", reason: "dropped" }],
  );

  const out = run("prime").stdout;
  assert.doesNotMatch(out, /Dropped on one branch/);
  assert.match(out, /Still alive/);
  assert.doesNotMatch(run("search", "dropped").stdout, /ccc333/);
  assert.equal(run("confirm", "ccc333").status, 1); // gone means gone
});

const hasGit = spawnSync("git", ["--version"]).status === 0;

test("two branches that record and confirm merge without conflict", { skip: hasGit ? false : "git not on PATH" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marl-git-"));
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: dir, encoding: "utf8" });
  const git = (...a) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  const ok = (res) => (assert.equal(res.status, 0, res.stdout + res.stderr), res);
  const commit = (msg) => (ok(git("add", "-A")), ok(git("commit", "-m", msg)));

  ok(git("init"));
  ok(git("config", "user.name", "marl test"));
  ok(git("config", "user.email", "marl@example.invalid"));
  ok(git("config", "commit.gpgsign", "false")); // a signing setup on the host must not break the test
  fs.writeFileSync(path.join(dir, "README.md"), "# repo\n");
  commit("initial");

  ok(run("init", "--no-hook"));
  const base = ok(run("record", "db", "Base fact everyone shares")).stdout.match(/\[(\w{6})\]/)[1];
  commit("marl: base record");
  const baseSha = ok(git("rev-parse", "HEAD")).stdout.trim();

  ok(git("checkout", "-b", "branch-a"));
  ok(run("record", "api", "Learned on branch A"));
  ok(run("confirm", base));
  commit("branch a");

  ok(git("checkout", "-b", "branch-b", baseSha));
  ok(run("record", "build", "Learned on branch B"));
  ok(run("confirm", base));
  commit("branch b");

  ok(git("checkout", "branch-a"));
  const merge = git("merge", "--no-edit", "branch-b");
  assert.equal(merge.status, 0, merge.stdout + merge.stderr);
  assert.doesNotMatch(merge.stdout + merge.stderr, /CONFLICT/);
  assert.equal(ok(git("status", "--porcelain")).stdout, "");

  const prime = ok(run("prime")).stdout;
  assert.equal(prime.match(/Base fact everyone shares/g).length, 1);
  assert.match(prime, /Learned on branch A/);
  assert.match(prime, /Learned on branch B/);
  assert.equal(JSON.parse(run("prime", "--json").stdout).length, 3);
});

test("prune needs commits as well as days inside a git repo", { skip: hasGit ? false : "git not on PATH" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marl-decay-"));
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: dir, encoding: "utf8" });
  const ok = (res) => (assert.equal(res.status, 0, res.stdout + res.stderr), res);
  const git = (...a) => ok(spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" }));
  // no date commits "now"; otherwise both author and committer date are forced
  const commit = (date) =>
    ok(spawnSync("git", ["-C", dir, "commit", "--allow-empty", "-m", "work"], {
      encoding: "utf8",
      env: date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env,
    }));
  const prune = (...a) => ok(run("prune", "--days", "30", ...a)).stdout;

  git("init");
  git("config", "user.name", "marl test");
  git("config", "user.email", "marl@example.invalid");
  git("config", "commit.gpgsign", "false");

  fs.mkdirSync(path.join(dir, ".marl"));
  const store = path.join(dir, ".marl", "knowledge.jsonl");
  const archiveFile = path.join(dir, ".marl", "archive.jsonl");
  const old = (id, text) => JSON.stringify(rec(id, text, { created: "2020-01-01T00:00:00.000Z" })) + "\n";
  fs.writeFileSync(store, old("eee555", "Idle project fact"));

  // zero commits: --commits 0 is days-only, and must not need git to answer
  assert.match(prune("--commits", "0", "--dry-run"), /would archive db/);

  // commits from before the record don't count against it
  commit("2019-06-01T00:00:00Z");
  commit("2019-06-02T00:00:00Z");
  assert.match(prune("--commits", "2"), /Nothing stale/);

  commit(); // one commit after it: still fewer than --commits
  assert.match(prune("--commits", "2"), /Nothing stale/);
  assert.match(prune(), /Nothing stale/); // default is 10
  assert.ok(!fs.existsSync(archiveFile));

  commit();
  assert.match(prune("--commits", "2"), /archived db/);
  assert.match(fs.readFileSync(archiveFile, "utf8"), /"reason":"unconfirmed for 30 days and 2 commits"/);
  assert.doesNotMatch(run("prime").stdout, /Idle project fact/);

  // --commits 0 for real: archives with the days-only wording
  fs.writeFileSync(store, old("fff666", "Second idle fact"));
  assert.match(prune("--commits", "0"), /archived db/);
  assert.match(fs.readFileSync(archiveFile, "utf8"), /"reason":"unconfirmed for 30 days"/);
});

test("prune outside a git repo is days-only and keeps git quiet", () => {
  const run = handStore([rec("abc123", "No repo here", { created: "2020-01-01T00:00:00.000Z" })]);
  const res = run("prune", "--days", "30", "--commits", "2");
  assert.equal(res.status, 0);
  assert.match(res.stdout, /archived db/);
  assert.equal(res.stderr, ""); // no "fatal: not a git repository"
  assert.match(fs.readFileSync(path.join(path.dirname(run.file), "archive.jsonl"), "utf8"), /"reason":"unconfirmed for 30 days"/);
});

test("globs: ** crosses directories, * and ? stay in one segment, the rest is literal", () => {
  const table = [
    // glob, file, matches?
    ["src/db/**", "src/db/a.js", true],
    ["src/db/**", "src/db/deep/er/a.js", true],
    ["src/db/**", "src/dbx/a.js", false],
    ["src/**/x.js", "src/x.js", true], // "**/" matches zero directories
    ["src/**/x.js", "src/a/b/x.js", true],
    ["src/**/x.js", "src/a/yx.js", false],
    ["**/*.sql", "one.sql", true],
    ["**/*.sql", "a/b/one.sql", true],
    ["migrations/*.sql", "migrations/001.sql", true],
    ["migrations/*.sql", "migrations/old/001.sql", false], // * does not cross "/"
    ["migrations/*.sql", "x/migrations/001.sql", false], // anchored at the project root
    ["src/?.js", "src/a.js", true],
    ["src/?.js", "src/ab.js", false],
    ["src/a?b.js", "src/a/b.js", false], // ? does not match "/"
    ["a.b+(c)[d]{e}^$|.js", "a.b+(c)[d]{e}^$|.js", true], // regex metacharacters are literal
    ["a.js", "abjs", false], // "." is a dot, not "any character"
    ["a+.js", "aa.js", false],
    ["(a|b).js", "a.js", false],
    ["src\\db\\*.js", "src/db/a.js", true], // Windows separators in a hand-edited glob…
    ["src/db/*.js", "src\\db\\a.js", true], // …and in the file argument
    ["src\\db\\**", "src\\db\\deep\\a.js", true],
  ];
  const id = (i) => `g${String(i).padStart(5, "0")}`;
  const run = handStore(table.map(([glob], i) => rec(id(i), `row ${i}`, { paths: [glob] })));
  table.forEach(([glob, file, expected], i) => {
    const res = run("for", file, "--json");
    assert.equal(res.status, 0, res.stderr);
    const hit = JSON.parse(res.stdout).some((r) => r.id === id(i));
    assert.equal(hit, expected, `${glob} ${expected ? "should match" : "should not match"} ${file}`);
  });
});

test("record stores --paths, revise carries or replaces them", () => {
  const run = handStore([rec("aaa111", "Written before paths existed")]);
  const stored = (text) => JSON.parse(run("prime", "--json").stdout).find((r) => r.text === text);
  const newId = (res) => res.stdout.match(/(?:recorded|→) \[(\w{6})\]/)[1];

  // comma list: trimmed, empties dropped, "/" separators
  let id = newId(run("record", "db", "Migrations are forward-only", "--paths", " src\\db\\** , migrations/*.sql,"));
  assert.deepEqual(stored("Migrations are forward-only").paths, ["src/db/**", "migrations/*.sql"]);
  run("record", "db", "Unscoped fact");
  assert.deepEqual(stored("Unscoped fact").paths, []);
  assert.deepEqual(stored("Written before paths existed").paths, []); // load() fills the default

  // line() shows the scope
  assert.match(run("search", "forward-only").stdout, /Migrations are forward-only @src\/db\/\*\* @migrations\/\*\.sql$/m);
  assert.doesNotMatch(run("search", "unscoped").stdout, /@/);

  id = newId(run("revise", id, "Migrations are forward-only, no down scripts"));
  assert.deepEqual(stored("Migrations are forward-only, no down scripts").paths, ["src/db/**", "migrations/*.sql"]);

  id = newId(run("revise", id, "Moved to db/migrate", "--paths", "db\\migrate\\**"));
  assert.deepEqual(stored("Moved to db/migrate").paths, ["db/migrate/**"]);

  run("revise", id, "Applies everywhere now", "--paths", "");
  assert.deepEqual(stored("Applies everywhere now").paths, []);

  // a hand edit that is not a list is reported, not a stack trace
  fs.appendFileSync(run.file, JSON.stringify(rec("bbb222", "Bad paths", { paths: "src/**" })) + "\n");
  const bad = run("prime");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /knowledge\.jsonl:\d+ "paths" must be an array/);
});

test("for: files relative to cwd, absolute, from a subdirectory; outside the project matches nothing", () => {
  const run = handStore([
    rec("aaa111", "DB fact", { paths: ["src/db/**"] }),
    rec("bbb222", "Any js fact", { domain: "build", paths: ["**/*.js"] }),
    rec("ccc333", "Unscoped fact"),
    rec("ddd444", "SQL fact", { paths: ["migrations/*.sql"] }),
  ]);
  const from = (cwd, ...a) => spawnSync(process.execPath, [CLI, "for", ...a], { cwd, env, encoding: "utf8" });
  const ids = (res) => (assert.equal(res.status, 0, res.stderr), [...res.stdout.matchAll(/\[(\w{6})\]/g)].map((m) => m[1]));

  // relative to cwd; same line format as search, domain first
  const res = run("for", "src/db/conn.js");
  assert.deepEqual(ids(res), ["aaa111", "bbb222"]);
  assert.match(res.stdout, /^db - \[aaa111\] \(note\) DB fact @src\/db\/\*\*$/m);
  assert.match(res.stdout, /^build - \[bbb222\]/m);

  assert.deepEqual(ids(run("for", path.join(run.dir, "src", "db", "conn.js"))), ["aaa111", "bbb222"]); // absolute
  assert.deepEqual(ids(run("for", "./src/db/../db/conn.js")), ["aaa111", "bbb222"]); // not yet normalised

  // from a subdirectory the file is relative to that cwd, the globs still to the project root
  const sub = path.join(run.dir, "src", "db");
  fs.mkdirSync(sub, { recursive: true });
  assert.deepEqual(ids(from(sub, "conn.js")), ["aaa111", "bbb222"]);
  assert.deepEqual(ids(from(sub, "../../migrations/001.sql")), ["ddd444"]);
  assert.deepEqual(ids(from(sub, path.join(run.dir, "migrations", "001.sql"))), ["ddd444"]);

  // several files: any match counts, each record once
  assert.deepEqual(ids(run("for", "migrations/001.sql", "src/db/a.js", "src/db/b.js")), ["aaa111", "bbb222", "ddd444"]);

  // outside the project root: nothing, even for a glob that starts with **
  assert.equal(run("for", "../elsewhere/x.js").stdout, "");
  assert.equal(run("for", path.join(path.dirname(run.dir), "elsewhere", "x.js")).stdout, "");

  // no match is silence and exit 0 — a hook calls this
  const none = run("for", "README.md");
  assert.equal(none.status, 0);
  assert.equal(none.stdout + none.stderr, "");

  assert.deepEqual(JSON.parse(run("for", "migrations/001.sql", "--json").stdout).map((r) => r.id), ["ddd444"]);
  assert.deepEqual(JSON.parse(run("for", "README.md", "--json").stdout), []);
  assert.equal(run("for").status, 1); // no file is a usage error
});

test("hook: adds matching records as PreToolUse context, once per session, and never fails", () => {
  const run = handStore([
    rec("aaa111", "DB fact", { paths: ["src/db/**"], confirms: 2 }),
    rec("bbb222", "Any js fact", { paths: ["**/*.js"] }),
    rec("ccc333", "Unscoped fact"),
  ]);
  // a private temp dir, so the per-session files are ours to inspect
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "marl-hooktmp-"));
  const hookEnv = { ...env, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  const raw = (input, cwd = run.dir) => spawnSync(process.execPath, [CLI, "hook"], { cwd, env: hookEnv, input, encoding: "utf8" });
  const hook = (file, extra = {}) =>
    raw(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: file }, ...extra }));
  const silent = (res) => {
    assert.equal(res.status, 0);
    assert.equal(res.stdout + res.stderr, "");
  };
  const dbFile = path.join(run.dir, "src", "db", "conn.js"); // Claude Code sends absolute paths

  let res = hook(dbFile, { session_id: "s1" });
  assert.equal(res.status, 0);
  assert.equal(res.stderr, "");
  const out = JSON.parse(res.stdout); // the whole of stdout is one JSON object
  assert.deepEqual(Object.keys(out), ["hookSpecificOutput"]);
  // context only: no permissionDecision, so the hook neither allows nor blocks the call
  assert.deepEqual(Object.keys(out.hookSpecificOutput), ["hookEventName", "additionalContext"]);
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.deepEqual(out.hookSpecificOutput.additionalContext.split("\n"), [
    "Project knowledge (.marl) for src/db/conn.js:",
    "- [aaa111] (note, ×2) DB fact @src/db/**",
    "- [bbb222] (note) Any js fact @**/*.js",
  ]);

  silent(hook(dbFile, { session_id: "s1" })); // same session: already shown
  silent(hook(path.join(run.dir, "src", "api.js"), { session_id: "s1" })); // bbb222 was shown for another file

  // another session, and a subagent of the first one, start with a clean slate
  assert.match(hook(dbFile, { session_id: "s2" }).stdout, /aaa111/);
  assert.match(hook(dbFile, { session_id: "s1", agent_id: "sub1" }).stdout, /aaa111/);
  silent(hook(dbFile, { session_id: "s1", agent_id: "sub1" }));

  // a session that has seen only one of two matching records gets the other
  assert.match(hook(path.join(run.dir, "lib", "x.js"), { session_id: "s3" }).stdout, /bbb222/);
  res = hook(dbFile, { session_id: "s3" });
  assert.match(res.stdout, /aaa111/);
  assert.doesNotMatch(res.stdout, /bbb222/);

  // no session_id: nothing to key on, so no dedupe
  assert.match(hook(dbFile).stdout, /aaa111/);
  assert.match(hook(dbFile).stdout, /aaa111/);

  // the session id is sanitised before it becomes a file name
  assert.match(hook(dbFile, { session_id: "../../evil/s4" }).stdout, /aaa111/);
  assert.deepEqual(fs.readdirSync(tmp).sort(), ["marl-evils4-.json", "marl-s1-.json", "marl-s1-sub1.json", "marl-s2-.json", "marl-s3-.json"]);

  silent(hook(path.join(run.dir, "README.md"), { session_id: "s5" })); // no record matches
  silent(hook(path.join(path.dirname(run.dir), "elsewhere", "x.js"), { session_id: "s5" })); // outside the project
  silent(raw("not json at all")); // garbage stdin
  silent(raw(""));
  silent(raw(JSON.stringify({ session_id: "s5", tool_name: "Bash", tool_input: { command: "ls" } }))); // no file_path
  silent(raw(JSON.stringify({ session_id: "s5" })));
  silent(raw(JSON.stringify({ tool_input: { file_path: "x.js" } }), fs.mkdtempSync(path.join(os.tmpdir(), "marl-nostore-")))); // no store

  // a broken store is an error everywhere else, but the hook must not break the tool call
  fs.appendFileSync(run.file, "{not json\n");
  assert.equal(run("prime").status, 1);
  silent(hook(dbFile, { session_id: "s6" }));
});

test("prime leaves path-scoped records out, says so, and --all shows them", () => {
  const notice = (n) => new RegExp(`_${n} path-scoped record\\(s\\) not shown — .*marl for <file>.*marl prime --all`);
  const run = handStore([
    rec("aaa111", "Unscoped proven", { confirms: 3 }),
    rec("bbb222", "Unscoped other"),
    rec("ccc333", "Scoped db fact", { paths: ["src/db/**"], confirms: 9 }),
    rec("ddd444", "Scoped api fact", { domain: "api", paths: ["src/api/**"] }),
  ]);

  let out = run("prime").stdout;
  assert.match(out, /Unscoped proven/);
  assert.match(out, /Unscoped other/);
  assert.doesNotMatch(out, /Scoped/);
  assert.doesNotMatch(out, /## api/); // a domain with nothing to show gets no heading
  assert.match(out, notice(2));

  out = run("prime", "--all").stdout;
  assert.match(out, /Scoped db fact @src\/db\/\*\*/);
  assert.match(out, /Scoped api fact/);
  assert.doesNotMatch(out, /path-scoped record/);

  // --json is raw data: always everything
  assert.equal(JSON.parse(run("prime", "--json").stdout).length, 4);

  // --limit counts what would be shown, and both omissions are reported
  out = run("prime", "--limit", "1").stdout;
  assert.match(out, /Unscoped proven/);
  assert.doesNotMatch(out, /Unscoped other/);
  assert.match(out, /_1 less-confirmed record\(s\) omitted/);
  assert.match(out, notice(2));
  out = run("prime", "--all", "--limit", "1").stdout;
  assert.match(out, /Scoped db fact/); // ×9 leads once scoped records take part
  assert.match(out, /_3 less-confirmed record\(s\) omitted/);

  // a domain where every record is scoped still gets the notice
  out = run("prime", "api").stdout;
  assert.match(out, notice(1));
  assert.doesNotMatch(out, /No knowledge/);

  // …and so does a whole store
  const scopedOnly = handStore([rec("eee555", "Only scoped", { paths: ["src/**"] })]);
  out = scopedOnly("prime").stdout;
  assert.match(out, notice(1));
  assert.doesNotMatch(out, /No knowledge recorded yet/);
  assert.doesNotMatch(out, /Only scoped/);
  assert.match(scopedOnly("prime", "--all").stdout, /Only scoped/);

  assert.match(handStore([])("prime").stdout, /No knowledge recorded yet/); // truly empty is still said plainly
});

const HINT = '→ still true? marl revise <id> ... --paths <new>; gone? marl drop <id> "<reason>"';

test("check flags records whose globs match no file git knows about", { skip: hasGit ? false : "git not on PATH" }, () => {
  const run = handStore([
    rec("aaa111", "Tracked file fact", { paths: ["src/db/**"] }),
    rec("bbb222", "One live glob is enough", { paths: ["gone/**", "migrations/*.sql"] }), // untracked, not ignored
    rec("ccc333", "Orphaned fact", { domain: "legacy", paths: ["lib/legacy/**", "old/*.js"] }),
    rec("ddd444", "Ignored build output", { paths: ["build/**"] }),
    rec("eee555", "Unscoped fact"),
  ]);
  const git = (...a) => {
    const res = spawnSync("git", ["-C", run.dir, ...a], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stdout + res.stderr);
  };
  touch(run.dir, "src/db/conn.js");
  fs.writeFileSync(path.join(run.dir, ".gitignore"), "build/\n");
  git("init");
  git("config", "user.name", "marl test");
  git("config", "user.email", "marl@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-m", "initial");
  touch(run.dir, "migrations/001.sql"); // exists but not committed yet: still a project file
  touch(run.dir, "build/out.js"); // on disk, but ignored — only the git listing leaves it out
  const before = fs.readFileSync(run.file, "utf8");

  const res = run("check");
  assert.equal(res.status, 0);
  assert.deepEqual(res.stdout.trim().split("\n"), [
    "orphaned legacy - [ccc333] (note) Orphaned fact @lib/legacy/** @old/*.js",
    "orphaned db - [ddd444] (note) Ignored build output @build/**",
    HINT,
  ]);
  assert.deepEqual(JSON.parse(run("check", "--json").stdout).map((r) => r.id), ["ccc333", "ddd444"]);

  // read-only: nothing archived, nothing rewritten
  assert.equal(fs.readFileSync(run.file, "utf8"), before);
  assert.ok(!fs.existsSync(path.join(run.dir, ".marl", "archive.jsonl")));

  // works from a subdirectory too: globs and the file list are both relative to the project root
  const sub = spawnSync(process.execPath, [CLI, "check", "--json"], { cwd: path.join(run.dir, "src", "db"), env, encoding: "utf8" });
  assert.deepEqual(JSON.parse(sub.stdout).map((r) => r.id), ["ccc333", "ddd444"]);

  touch(run.dir, "lib/legacy/x.js");
  run("drop", "ddd444", "build dir removed");
  assert.equal(run("check").stdout, "Nothing orphaned.\n");
  assert.deepEqual(JSON.parse(run("check", "--json").stdout), []);
});

test("check outside a git repo walks the directory, skipping .git and node_modules", () => {
  const run = handStore([
    rec("aaa111", "Live fact", { paths: ["src/db/*.js"] }),
    rec("bbb222", "Orphaned fact", { paths: ["src/api/**"] }),
    rec("ccc333", "Dependency internals", { paths: ["**/node_modules/**"] }),
    rec("ddd444", "Git internals", { paths: [".git/**"] }),
    rec("eee555", "Unscoped fact"),
  ]);
  touch(run.dir, "src/db/conn.js");
  touch(run.dir, "node_modules/pkg/index.js");
  touch(run.dir, "packages/a/node_modules/pkg/index.js");
  touch(run.dir, ".git/hooks/x"); // not a repository git accepts, so this is still the fallback

  const res = run("check");
  assert.equal(res.status, 0);
  assert.equal(res.stderr, ""); // git's complaint about the missing repo stays out of the way
  assert.deepEqual(res.stdout.trim().split("\n"), [
    "orphaned db - [bbb222] (note) Orphaned fact @src/api/**",
    "orphaned db - [ccc333] (note) Dependency internals @**/node_modules/**",
    "orphaned db - [ddd444] (note) Git internals @.git/**",
    HINT,
  ]);

  touch(run.dir, "src/api/deep/handler.js");
  assert.deepEqual(JSON.parse(run("check", "--json").stdout).map((r) => r.id), ["ccc333", "ddd444"]);
});

test("--version reports the package version", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "package.json"), "utf8"));
  assert.equal(marl("--version").out.trim(), pkg.version);
  assert.match(marl("--help").out, new RegExp(`marl ${pkg.version}`));
});

test("--json emits parseable records", () => {
  const records = JSON.parse(marl("prime", "db", "--json").out);
  assert.equal(records[0].text, "Use WAL mode for SQLite");
  assert.equal(records[0].domain, "db");
  assert.deepEqual(JSON.parse(marl("prime", "nosuchdomain", "--json").out), []);
  assert.deepEqual(JSON.parse(marl("search", "zzzznomatch", "--json").out), []);
  assert.equal(JSON.parse(marl("search", "sqlite", "--json").out)[0].text, "Use WAL mode for SQLite");
});

test("errors exit non-zero", () => {
  assert.equal(marl("record", "db").code, 1);
  assert.equal(marl("record", "db", "x", "--type", "bogus").code, 1);
  assert.equal(marl("confirm", "nope00").code, 1);
  assert.equal(marl("revise", "nope00", "x").code, 1);
  assert.equal(marl("drop").code, 1);
  assert.equal(marl("frobnicate").code, 1);
  for (const bad of ["1.5", "abc", "", "-1"]) {
    const r = marl("prune", `--commits=${bad}`);
    assert.equal(r.code, 1, `--commits "${bad}"`);
    assert.match(r.out, /--commits must be a non-negative integer/);
  }
});
