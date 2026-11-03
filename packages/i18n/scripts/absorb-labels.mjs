// For a branch made before the label split (ADR 0022), during `git merge origin/main` or at a
// `git rebase origin/main` stop that conflicts on the label files. git may report src/en.json as
// deleted or "renamed" into src/en/platform.json (with conflict markers); either way this reads the
// three versions from git itself, not from the working tree:
//   base   the old files where the branch diverged (merge base; the parent at a rebase stop)
//   branch the branch's old files (HEAD while merging; the commit being replayed while rebasing)
//   main   main's module files (MERGE_HEAD while merging; HEAD while rebasing)
// and applies the branch's changes to main's files as a three-way merge:
//   added keys   → into src/<locale>/<prefix>.json, after the same key as in the old file
//   changed keys → their new value
//   removed keys → removed
// It rewrites src/<locale>/ (and index.ts), deletes src/{en,de}.json, and writes nothing when main
// changed the same key.
//   pnpm --filter @durby/i18n labels:absorb
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import process from 'node:process';
import { LOCALES, legacyPath, modulePath, prefixOf, SRC, writeModules } from './label-files.mjs';

// From the repository root: ls-tree and --git-path answer relative to the working directory.
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });
const ref = (name) => {
  try {
    return git('rev-parse', '--verify', '--quiet', name).trim();
  } catch {
    return null;
  }
};

/** Which commits hold the base, the branch's and main's labels. */
function sides() {
  // REBASE_HEAD can outlive a finished rebase: only trust it while git's rebase state exists.
  const inRebase = ['rebase-merge', 'rebase-apply'].some((d) =>
    existsSync(resolve(root, git('rev-parse', '--git-path', d).trim())),
  );
  const rebasing = inRebase ? ref('REBASE_HEAD') : null;
  if (rebasing) return { base: `${rebasing}^`, branch: rebasing, main: 'HEAD' };
  const merging = ref('MERGE_HEAD');
  if (merging) {
    return { base: git('merge-base', 'HEAD', merging).trim(), branch: 'HEAD', main: merging };
  }
  throw new Error('No merge or rebase in progress (run it after git stops on the label files)');
}

const inRepo = (path) => relative(root, path);
const show = (commit, path) => JSON.parse(git('show', `${commit}:${inRepo(path)}`));

/** main's module files of a locale, by prefix, each an ordered [key, value] list. */
function mainModules(commit, locale) {
  const dir = inRepo(`${SRC}/${locale}`);
  const files = git('ls-tree', '--name-only', `${commit}:${dir}`)
    .split('\n')
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (files.length === 0) throw new Error(`${commit} has no ${dir}/*.json: is it the split main?`);
  return new Map(
    files.map((f) => [f.slice(0, -5), Object.entries(show(commit, `${SRC}/${locale}/${f}`))]),
  );
}

const { base, branch: branchCommit, main } = sides();
const conflicts = [];
const plans = LOCALES.map((l) => {
  const before = show(base, legacyPath(l));
  const branch = show(branchCommit, legacyPath(l));
  const modules = mainModules(main, l);
  const current = new Map([...modules.values()].flat());
  const summary = { added: [], changed: [], removed: [] };

  for (const key of Object.keys(before)) {
    if (key in branch) continue;
    if (current.has(key) && current.get(key) !== before[key]) {
      conflicts.push(`${l} ${key}: removed here, changed on main`);
    } else if (current.has(key)) {
      summary.removed.push(key);
    }
  }
  for (const [key, value] of Object.entries(branch)) {
    if (key in before) {
      if (value === before[key]) continue;
      if (current.has(key) && current.get(key) !== before[key] && current.get(key) !== value) {
        conflicts.push(`${l} ${key}: changed here and on main`);
      } else if (!current.has(key)) {
        conflicts.push(`${l} ${key}: changed here, removed on main`);
      } else {
        summary.changed.push(key);
      }
    } else if (current.has(key) && current.get(key) !== value) {
      conflicts.push(`${l} ${key}: added here and on main with different text`);
    } else if (!current.has(key)) {
      summary.added.push(key);
    }
  }
  return { l, branch, modules, summary };
});

if (conflicts.length > 0) {
  process.stderr.write(
    `Not absorbed (nothing written); fix these by hand in src/<locale>/<prefix>.json:\n${conflicts
      .map((c) => `  ${c}\n`)
      .join('')}`,
  );
  process.exit(1);
}

for (const { l, branch, modules, summary } of plans) {
  const removed = new Set(summary.removed);
  for (const [prefix, entries] of modules) {
    modules.set(
      prefix,
      entries
        .filter(([key]) => !removed.has(key))
        .map(([key, value]) => [key, summary.changed.includes(key) ? branch[key] : value]),
    );
  }
  // An added key goes after the nearest key before it (in the branch's file) with the same prefix,
  // else before the nearest one after it, else at the end of its file (a new file for a new prefix).
  const order = Object.keys(branch);
  for (const key of summary.added) {
    const prefix = prefixOf(key);
    const entries = modules.get(prefix) ?? [];
    const at = order.indexOf(key);
    const keys = entries.map(([k]) => k);
    const before = order
      .slice(0, at)
      .reverse()
      .find((k) => prefixOf(k) === prefix && keys.includes(k));
    const after = order.slice(at + 1).find((k) => prefixOf(k) === prefix && keys.includes(k));
    const index = before ? keys.indexOf(before) + 1 : after ? keys.indexOf(after) : entries.length;
    entries.splice(index, 0, [key, branch[key]]);
    modules.set(prefix, entries);
  }
  for (const [prefix, entries] of modules) if (entries.length === 0) modules.delete(prefix);
  // The working tree may hold conflict markers or files main no longer has: rewrite all of it.
  for (const file of existsSync(`${SRC}/${l}`) ? readdirSync(`${SRC}/${l}`) : []) {
    if (file.endsWith('.json') && !modules.has(file.slice(0, -5))) {
      rmSync(modulePath(l, file.slice(0, -5)));
    }
  }
  writeModules(l, modules);
  rmSync(legacyPath(l), { force: true });
  process.stdout.write(
    `${l}: ${summary.added.length} added, ${summary.changed.length} changed, ${summary.removed.length} removed (base ${base.slice(0, 12)})\n`,
  );
  for (const [what, keys] of Object.entries(summary)) {
    for (const key of keys) process.stdout.write(`  ${what} ${key}\n`);
  }
}
process.stdout.write(
  'Next: git add -A packages/i18n/src, then git commit --no-edit (or git rebase --continue).\n',
);
