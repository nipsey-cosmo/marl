import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.resolve(import.meta.dirname, "marl.js");
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "marl-test-"));

function marl(...args) {
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
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

  out = run().stdout;
  assert.match(out, /instructions up to date/);
  assert.match(out, /already installed/);
  assert.equal(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8").match(/marl prime/g).length, 1);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marl-merge-"));
  const jsonl = (records) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.mkdirSync(path.join(dir, ".marl"));
  fs.writeFileSync(path.join(dir, ".marl", "knowledge.jsonl"), jsonl(knowledge));
  if (archived) fs.writeFileSync(path.join(dir, ".marl", "archive.jsonl"), jsonl(archived));
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: dir, encoding: "utf8" });
  return Object.assign(run, { file: path.join(dir, ".marl", "knowledge.jsonl") });
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
});
