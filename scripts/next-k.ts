// Spec numbers across open pull requests, so two PRs never take the same K- number.
//   node scripts/next-k.ts <block>   prints the next free number of a block: 11 gives a number from K-1101 to K-1199.
//   node scripts/next-k.ts --check   fails when this checkout's docs add a number that origin/main or another open PR
//                                    defines with other text, or use one number twice. PR_NUMBER skips this PR's head.
// The numbers are the `- **K-<n>**` lines of every Markdown file under docs/ (see docs/README.md).
// It reads origin/main and the open PR heads with git, and lists the open PRs with gh, so it needs a fetched origin
// and a gh login (GH_TOKEN in CI).
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MARK = "- **K-";
const DOCS = "docs";

const run = (command: string, args: ReadonlyArray<string>) =>
  execFileSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** Each `- **K-<n>** <text>` line of the docs, in order, with the file that holds it. */
function lines(
  files: ReadonlyArray<{ readonly path: string; readonly text: string }>,
): Array<{ readonly number: number; readonly text: string; readonly path: string }> {
  return files.flatMap((file) =>
    file.text.split("\n").flatMap((line) => {
      const rest = line.trimStart();
      if (!rest.startsWith(MARK)) return [];
      const end = rest.indexOf("**", MARK.length);
      const number = Number(rest.slice(MARK.length, end));
      if (end < 0 || !Number.isInteger(number))
        throw new Error(`${file.path} has a K- line that does not parse: ${line}`);
      return [{ number, text: rest.slice(end + 2).trim(), path: file.path }];
    }),
  );
}

const isDoc = (path: string) => path.endsWith(".md");

/** The docs of this checkout. */
function workingDocs() {
  return readdirSync(DOCS, { recursive: true, encoding: "utf8" })
    .map((name) => join(DOCS, name))
    .filter(isDoc)
    .map((path) => ({ path, text: readFileSync(path, "utf8") }));
}

/** The docs of a commit that this clone has. */
function docsAt(ref: string) {
  return run("git", ["ls-tree", "-r", "--name-only", ref, "--", DOCS])
    .split("\n")
    .filter(isDoc)
    .map((path) => ({ path, text: run("git", ["show", `${ref}:${path}`]) }));
}

const definitions = (files: ReturnType<typeof docsAt>): ReadonlyMap<number, string> =>
  new Map(lines(files).map((line) => [line.number, line.text]));

interface Source {
  readonly name: string;
  readonly definitions: ReadonlyMap<number, string>;
}

/** True when HEAD and `head` share a commit that origin/main does not have: two PRs of one stack. */
function sameStack(head: string) {
  const shared = spawnSync("git", ["merge-base", "HEAD", head], { encoding: "utf8" });
  if (shared.status !== 0) return false;
  const onMain = spawnSync("git", [
    "merge-base",
    "--is-ancestor",
    shared.stdout.trim(),
    "origin/main",
  ]).status;
  if (onMain !== 0 && onMain !== 1) throw new Error(`git merge-base --is-ancestor failed for ${head}.`);
  return onMain === 1;
}

/**
 * origin/main first, then the head of every open PR except `skipPr`. With `skipStack`, also except the PRs of this
 * PR's stack: a lower PR may change the text of a number that this PR still carries until its next rebase.
 */
function sources(skipPr: string | undefined, skipStack = false): Array<Source> {
  const main = { name: "origin/main", definitions: definitions(docsAt("origin/main")) };
  const prs = JSON.parse(
    run("gh", ["pr", "list", "--state", "open", "--limit", "200", "--json", "number,headRefOid"]),
  ) as Array<{ readonly number: number; readonly headRefOid: string }>;
  const open = prs
    .filter((pr) => String(pr.number) !== skipPr)
    .flatMap((pr) => {
      // GitHub serves a PR head by its SHA, also from a fork. A head that does not fetch defines nothing.
      const fetched = spawnSync("git", ["fetch", "--quiet", "origin", pr.headRefOid]).status === 0;
      return fetched ? [pr] : [];
    })
    .filter((pr) => !(skipStack && sameStack(pr.headRefOid)))
    .map((pr) => ({ name: `#${pr.number}`, definitions: definitions(docsAt(pr.headRefOid)) }));
  return [main, ...open];
}

function nextFree(block: number, all: ReadonlyArray<Source>) {
  const low = block * 100;
  const used = all
    .flatMap((source) => [...source.definitions.keys()])
    .filter((n) => n > low && n < low + 100);
  const next = used.length === 0 ? low + 1 : Math.max(...used) + 1;
  if (next >= low + 100) throw new Error(`Block ${block} is full.`);
  return next;
}

function clashes(all: ReadonlyArray<Source>): Array<string> {
  const docs = workingDocs();
  const seen = new Map<number, string>();
  const twice = lines(docs).flatMap((line) => {
    const first = seen.get(line.number);
    if (first === undefined) return (seen.set(line.number, line.path), []);
    return [`K-${line.number} appears twice: in ${first} and in ${line.path}.`];
  });
  // New means: not in the docs where this branch left main. An edit of an older requirement is no clash.
  const base = definitions(docsAt(run("git", ["merge-base", "HEAD", "origin/main"]).trim()));
  const taken = [...definitions(docs)]
    .filter(([number]) => !base.has(number))
    .flatMap(([number, text]) =>
      all
        .filter((source) => source.definitions.has(number) && source.definitions.get(number) !== text)
        .map((source) => `K-${number} is new here, and ${source.name} defines it with other text.`),
    );
  return [...twice, ...taken];
}

const [argument] = process.argv.slice(2);
const block = Number(argument);
if (argument === "--check") {
  const found = clashes(sources(process.env["PR_NUMBER"], true));
  for (const clash of found) console.error(clash);
  if (found.length > 0) {
    console.error("Pick a free number with: node scripts/next-k.ts <block>");
    process.exit(1);
  }
  console.log("No K- number of these docs clashes with origin/main or another open PR.");
} else if (Number.isInteger(block) && block >= 1 && block <= 99) {
  console.log(`K-${nextFree(block, sources(undefined))}`);
} else {
  console.error("Usage: node scripts/next-k.ts <block> | --check");
  process.exit(2);
}
