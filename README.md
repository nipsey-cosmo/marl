# marl

Minimal project knowledge store for AI agents. Zero dependencies, plain Node, one file.

Agents record learnings as they work; future sessions prime them back into context. Knowledge lives in `.marl/knowledge.jsonl`, git-tracked with the project.

## Install

```bash
npm install -g github:profesr-chaos/marl
```

Or from a local clone: `npm link`. Pin a release with `#v0.2.0`; check what you have with `marl --version`.

### Upgrading

Re-run the install command — it re-resolves the branch and overwrites the global install. (`npm update -g marl` won't work: this is a git dependency, not a registry package. `npm link` users just `git pull`.) Then re-run `marl init` in each project to refresh the agent instructions in place.

No migration is needed for existing `.marl` data. One behaviour change in 0.2.0: unconfirmed records now genuinely age out, so your first `prune` after upgrading may archive more than you expect — run it with `--dry-run` first.

**0.3.0:** re-run `marl init` in each project — it adds `.marl/.gitattributes` (commit it) and the new file hook. Two behaviour changes: `prune` now needs 10 commits of project activity as well as the days (`--commits 0` restores the old rule), and `prime` no longer prints path-scoped records. Nothing is scoped until you record with `--paths`, so an existing store primes exactly as before.

## Setup

```bash
cd your-project
marl init
```

Creates `.marl/` (with a `.gitattributes` that union-merges the store — see [Branches and merges](#branches-and-merges)), appends the agent loop below to `CLAUDE.md` (or `AGENTS.md` if you have one), and registers two Claude Code hooks in `.claude/settings.json`: `SessionStart` runs `marl prime` at the start of every session, and `PreToolUse` runs `marl hook` when a file is read or edited (see [Path-scoped records](#path-scoped-records)). Your other settings and hooks are kept. `marl init --no-hook` skips the settings change.

The block is fenced by `<!-- marl:start -->` / `<!-- marl:end -->` comments. Re-running `init` rewrites only what's between them, so upgrades refresh the instructions without touching the rest of your file — keep the markers. Instructions written before 0.2.0 have no markers; `init` reports them and leaves them alone rather than guessing where they end, so delete the old block and re-run.

## Usage

```bash
marl record db "Use WAL mode for SQLite" --type convention
marl record api "Retry on 429 with backoff" --type pattern --tags http
marl prime            # all knowledge, markdown — inject into agent context
marl prime db         # one domain
marl prime --limit 40 # cap the context cost; says what it omitted
marl prime --all      # include path-scoped records too
marl search sqlite    # find records
marl confirm a1b2c3   # "I applied this and it was right" — boosts survival
marl revise a1b2c3 "Use WAL mode except in CI"   # this record was wrong
marl drop a1b2c3 "moved to Postgres"             # no longer applies
marl prune --days 90  # archive records nothing has confirmed in 90 days and 10 commits
```

Types: `convention`, `pattern`, `failure`, `decision`, `note`.

Ids accept any unambiguous prefix (`marl confirm a1b`). `revise` archives the old record and creates a replacement carrying its domain, type, tags and paths but with confirms reset — corrected knowledge re-earns trust. Nothing is ever deleted: `revise`, `drop` and `prune` all append to `.marl/archive.jsonl` with a reason.

`record` warns when a new record looks like one that already exists, and when it invents a domain that isn't already in use.

## Path-scoped records

`prime` puts every record in the context at session start, so its cost grows with the store. A fact about one corner of the code can wait until the agent goes there:

```bash
marl record db "Migrations are forward-only" --type convention --paths "src/db/**,migrations/*.sql"
marl for src/db/conn.js   # the records scoped to this file
marl check                # scoped records whose globs match no file any more
```

`--paths` takes comma-separated globs relative to the project root (the directory that holds `.marl`): `**` crosses directories, `*` and `?` stay within one, and there are no braces or negation. They are stored root-relative however you type them: a leading `./` is dropped, an absolute path inside the project is made relative, and a directory (`src/db/`, or `src/db` if it exists) becomes `src/db/**`. A path outside the project is refused. A scoped record is left out of `marl prime`, which ends with a line saying how many it left out; `--all` or `--json` includes them. It shows up when a matching file is touched instead: `marl for <file...>` prints the records for those files, and prints nothing (exit 0) when there are none.

In Claude Code that happens by itself. `marl hook` is a `PreToolUse` hook on `Read|Edit|Write`: it reads the hook JSON on stdin and returns the matching records as `additionalContext`, each at most once per session (parallel tool calls can occasionally show one twice). It makes no permission decision, and on any error it prints nothing and exits 0, so it does not block a tool call. A hook that cannot start at all — `marl` missing from a teammate's `PATH` — is a different matter: on Windows without Git Bash, Claude Code blocks the tool call when a `PreToolUse` hook fails, so `init` registers the hook with `"onFailure": "continue"` (Claude Code v2.1.295 or later). The same command also works registered as a `PostToolUse` hook. Agents without hooks get the same from the `marl for` line in the instructions block.

`marl check` lists scoped records none of whose globs match a project file — the code moved and the scope didn't. In a git repo a project file is one git tracks or would track (ignored files don't count); elsewhere it's a directory walk that skips `.git` and `node_modules`. Directories themselves are not files, so a glob that matches only a directory is orphaned. It only reports: `marl revise <id> ... --paths <new>` re-points a record, `marl drop` retires it. `revise --paths ""` removes the scope.

## The feedback loop

`confirm` stamps `last_used`; `prune` archives whatever stops being confirmed. Knowledge that keeps proving itself keeps living, and `prime` puts the most-confirmed records first so the strongest knowledge leads the context window.

Decay follows project activity, not just the calendar: `prune` archives a record only if it is older than `--days` (default 90) **and** at least `--commits` (default 10) commits have landed on `HEAD` since it was last confirmed (or created). A project left idle for four months keeps its knowledge — nothing happened that could have proved it wrong. Outside a git repo, or if git isn't available, only the days rule applies; `--commits 0` asks for that explicitly.

`prime` is a pure read. Being printed is not evidence a record is useful — only that it exists — so priming can't keep dead knowledge alive.

## Branches and merges

`marl init` writes `.marl/.gitattributes` containing `*.jsonl merge=union`, so branches that each record or confirm merge without conflicts: git keeps both sides' lines. Commit that file. marl reads the result sensibly — an id that appears on several lines collapses to one record (highest `confirms`, latest `last_used`), and an id present in `archive.jsonl` stays archived even if another branch's copy of it came back in the merge. Two branches that each confirmed the same record once merge to ×1, not ×2.

That collapse is only for lines that say the same thing. If one id ends up with two different facts — one branch hand-edited the text, tags or paths while the other confirmed it, or two branches happened to mint the same id — marl stops with an error naming the id instead of silently keeping one: delete the line you don't want, or give one of them a new id.

So a record that one branch dropped, revised or pruned stays gone after the merge, even if the other branch confirmed it in the meantime. To bring one back by hand, remove its line from `archive.jsonl`; if `knowledge.jsonl` no longer has the record either, move the line there.

Existing projects: re-run `marl init` to get the file.

There is no file locking. Parallel `record`s are safe (they append), but a `record` that lands while another process in the same checkout is mid-`confirm`/`revise`/`drop`/`prune` can be lost.

## Agent setup

`marl init` writes this block for you. To add it by hand:

> ## marl — this project's knowledge store
>
> Run `marl prime` at session start and treat the output as project ground truth.
>
> - **Before recording:** `marl search <keywords>` — if the fact already exists, `marl confirm <id>` instead of duplicating it.
> - **Before finishing a task:** record non-obvious learnings — `marl record <domain> "<text>" --type convention|pattern|failure|decision|note`. If the fact is about specific files, add `--paths "src/db/**,migrations/*.sql"`: it then shows up when those files are touched instead of in every session.
> - **Before editing an unfamiliar file:** `marl for <file>` prints the records scoped to it — skip this if a hook already hands them to you when you open the file.
> - **When a primed record proves correct in practice:** `marl confirm <id>`. Confirm means "I applied this and it held", not "I read it" — confirming everything you prime destroys the signal that keeps knowledge alive.
> - **When a primed record proves wrong:** `marl revise <id> "<corrected text>"`. Never record a contradicting fact alongside the old one. If it no longer applies at all, `marl drop <id> "<reason>"`.
> - **When committing:** include `.marl/` in the same commit as the change that produced the learning.

### What to record

One fact per record, written so a stranger can act on it without context. Record things that are true next month and invisible in the code: gotchas with their resolution (`--type failure`), choices with their reason (`--type decision`), "always do X here" rules (`--type convention`), reusable approaches (`--type pattern`). Anything else is a `note`.

Do **not** record: anything derivable by reading the code, session-specific state ("tests currently failing"), secrets or credentials, or restatements of the task itself.

### Domains

Domains are just labels — short, stable, lowercase: `db`, `api`, `auth`, `build`, `deploy`. Reuse existing domains (`marl prime` shows them all) before inventing new ones.

### Output notes

`marl prime` emits plain markdown grouped by domain, safe to inject directly into context; `--json` on `prime`, `search`, `for` and `check` gives raw records instead. All commands exit non-zero on error, except `marl hook`, which always exits 0.

Records are JSONL in `.marl/knowledge.jsonl` — human-readable, git-diffable, and hand-editable: malformed lines are reported by file and line number rather than crashing. Commands find `.marl` by walking up from the current directory, so they work from subdirectories.
