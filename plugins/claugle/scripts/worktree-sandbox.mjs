import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HARNESS_CONFIG_NAMES, HARNESS_INSTRUCTION_FILES, createTaskExecutionId, isSafeTaskId, parseAbsolutePath, parseRelativeGlob } from "./policy-engine.mjs";

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

// With a relative core.hooksPath, git would read hooks from files the model can rewrite inside the
// worktree, and a nested repository's config could name an fsmonitor command that `git add` would run.
function runGit(repoDir, args, options = {}) {
	return execFileSync("git", ["-C", repoDir, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
		encoding: options.encoding ?? "utf8",
		input: options.input,
		stdio: ["pipe", "pipe", "pipe"],
		maxBuffer: 256 * 1024 * 1024,
	});
}

// The model can also rewrite the worktree's `.git` pointer file, so worktree commands name their
// git dir and work tree instead of discovering them.
function runWorktreeGit(lease, args, options) {
	return runGit(lease.worktreePath, ["--git-dir", lease.gitDir, "--work-tree", lease.worktreePath, ...args], options);
}

function escapeRegexChar(ch) {
	return /[.+^$()[\]{}|\\]/.test(ch) ? `\\${ch}` : ch;
}

export function globToRegExp(glob) {
	const normalized = String(glob).replace(/\\/g, "/").trim();
	let i = 0;
	let pattern = "^";

	while (i < normalized.length) {
		if (normalized.startsWith("/**/", i)) {
			pattern += "(?:/|/.+/)";
			i += 4;
			continue;
		}
		if (i === 0 && normalized.startsWith("**/", i)) {
			pattern += "(?:.+/)?";
			i += 3;
			continue;
		}
		if (normalized.startsWith("/**", i) && i + 3 === normalized.length) {
			pattern += "(?:/.*)?";
			i += 3;
			continue;
		}
		if (normalized.startsWith("**", i)) {
			pattern += ".*";
			i += 2;
			continue;
		}
		const ch = normalized[i];
		if (ch === "*") {
			pattern += "[^/]*";
		} else if (ch === "?") {
			pattern += "[^/]";
		} else {
			pattern += escapeRegexChar(ch);
		}
		i += 1;
	}

	pattern += "$";
	return new RegExp(pattern);
}

export function matchesAllowedGlobs(relativeFilePath, allowedGlobs) {
	const normalizedPath = String(relativeFilePath).replace(/\\/g, "/").replace(/^\/+/, "");
	if (!normalizedPath || normalizedPath.split("/").includes("..")) {
		return false;
	}
	for (const glob of allowedGlobs) {
		if (globToRegExp(glob).test(normalizedPath)) {
			return true;
		}
	}
	return false;
}

function forceCleanupWorktree(hostRepoRoot, worktreePath) {
	spawnSync("git", ["-C", hostRepoRoot, "worktree", "remove", "--force", worktreePath], {
		stdio: "ignore",
	});
	fs.rmSync(worktreePath, { recursive: true, force: true });
	spawnSync("git", ["-C", hostRepoRoot, "worktree", "prune"], {
		stdio: "ignore",
	});
}

export function abortWorktreeLease(lease) {
	if (!lease || typeof lease !== "object") {
		return;
	}
	forceCleanupWorktree(lease.hostRepoRoot, lease.worktreePath);
}

// An edit run must leave every file Claude Code or agy reads as instructions as it was, and the folder a
// symlinked harness config folder points to. Mirroring Claude Code's loader exactly kept leaving gaps in
// review, so this reads more than Claude Code does: every `@` token anywhere, code included, under
// several readings, in the host working tree that Claude Code reads (not HEAD), through every symlink hop.
// Paths are relative to the repo root, as git prints them.
const MAX_IMPORT_HOPS = 5;
const MAX_SCANNED_BYTES = 1024 * 1024;
const AT_TOKEN = /@((?:\\.|[^\s\\])+)/g;
const SURFACE_PATHSPECS = [
	...HARNESS_INSTRUCTION_FILES.map((name) => `:(glob,icase)**/${name}`),
	...HARNESS_CONFIG_NAMES.flatMap((name) => [`:(glob)**/${name}`, `:(glob)**/${name}/**`]),
	":(exclude,glob)**/.claude/worktrees/**",
];

function importReadings(token) {
	const readings = new Set();
	for (const cut of [token, token.split("#")[0]]) {
		for (const text of [cut, cut.replace(/\\(.)/g, "$1")]) {
			for (const head of [text, text.split(/[)\]>"'`*]/)[0]]) {
				readings.add(head);
				readings.add(head.replace(/^[(<["'`*_]+/, "").replace(/[*_)\]}>`'".,;:!?]+$/, ""));
			}
		}
	}
	readings.delete("");
	return readings;
}

function resolveExisting(abs) {
	const rest = [];
	for (let probe = abs; ; probe = path.dirname(probe)) {
		try {
			return path.join(fs.realpathSync(probe), ...rest);
		} catch {
			if (path.dirname(probe) === probe) return abs;
			rest.unshift(path.basename(probe));
		}
	}
}

function linkChain(abs) {
	const hops = [abs];
	try {
		for (let p = abs; hops.length < 40 && fs.lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink(); ) {
			p = path.resolve(resolveExisting(path.dirname(p)), fs.readlinkSync(p));
			hops.push(p);
		}
	} catch {}
	return [...hops, ...hops.map(resolveExisting)];
}

function markdownUnder(dir) {
	try {
		return fs.readdirSync(dir, { recursive: true }).filter((name) => name.endsWith(".md")).slice(0, 2000).map((name) => path.join(dir, name));
	} catch {
		return [];
	}
}

function collectHarnessSurface(hostRepoRoot) {
	const roots = [...new Set([hostRepoRoot, fs.realpathSync(hostRepoRoot)])];
	const relOf = (abs) => {
		for (const root of roots) {
			const rel = path.relative(root, abs);
			if (rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
		}
		return null;
	};
	const files = new Set();
	const dirs = new Set();
	const fewestHops = new Map();
	const visit = (abs, hops) => {
		if (fewestHops.get(abs) <= hops) return;
		fewestHops.set(abs, hops);
		const chain = linkChain(abs);
		for (const rel of chain.map(relOf)) if (rel) files.add(rel);
		const real = chain.at(-1);
		let text;
		try {
			if (fs.statSync(real).size > MAX_SCANNED_BYTES) return;
			text = fs.readFileSync(real, "utf8");
		} catch {
			return;
		}
		if (hops >= MAX_IMPORT_HOPS) return;
		for (const [, token] of text.matchAll(AT_TOKEN)) {
			for (const reading of importReadings(token)) {
				if (reading.startsWith("~/")) visit(path.join(os.homedir(), reading.slice(2)), hops + 1);
				else if (path.isAbsolute(reading)) visit(path.resolve(reading), hops + 1);
				else for (const base of new Set([path.dirname(abs), path.dirname(real)])) visit(path.resolve(base, reading), hops + 1);
			}
		}
	};

	const instructionName = (rel) => HARNESS_INSTRUCTION_FILES.some((name) => name.toLowerCase() === path.posix.basename(rel).toLowerCase());
	const listed = runGit(hostRepoRoot, ["ls-files", "-z", "--cached", "--others", "--", ...SURFACE_PATHSPECS]).split("\0").filter(Boolean);
	for (const rel of listed) {
		const abs = path.join(hostRepoRoot, rel);
		if (instructionName(rel) || (rel.split("/").includes(".claude") && rel.endsWith(".md"))) visit(abs, 0);
		if (!HARNESS_CONFIG_NAMES.includes(path.posix.basename(rel)) || !fs.lstatSync(abs, { throwIfNoEntry: false })?.isSymbolicLink()) continue;
		const target = resolveExisting(abs);
		const targetRel = relOf(target);
		if (targetRel) dirs.add(targetRel);
		if (path.posix.basename(rel) === ".claude") for (const md of markdownUnder(target)) visit(md, 0);
	}
	const outside = ["/etc/claude-code/CLAUDE.md", path.join(os.homedir(), ".gemini", "GEMINI.md")];
	for (const top of [...roots.map(path.dirname), os.homedir()]) {
		for (let dir = top; ; dir = path.dirname(dir)) {
			outside.push(...["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "GEMINI.md", ".claude/CLAUDE.md"].map((name) => path.join(dir, name)));
			outside.push(...markdownUnder(path.join(dir, ".claude", "rules")));
			if (path.dirname(dir) === dir) break;
		}
	}
	for (const abs of outside) visit(abs, 0);
	return { files: [...files], dirs: [...dirs] };
}

function isProtected(file, { protectedFiles, protectedDirs }) {
	return protectedFiles.includes(file) || protectedDirs.some((dir) => file === dir || file.startsWith(`${dir}/`));
}

export function acquireWorktreeLease(params) {
	if (params?.taskId !== undefined && !isSafeTaskId(params.taskId)) {
		throw new Error(`Unsafe worktree task id: ${JSON.stringify(params.taskId)}`);
	}
	const taskId = params?.taskId ?? createTaskExecutionId();

	const requestDirRes = parseAbsolutePath(params?.hostRepoRoot);
	if (requestDirRes.kind === "error") {
		throw new Error(`Invalid hostRepoRoot: ${requestDirRes.message}`);
	}
	const pluginDataRes = parseAbsolutePath(params?.pluginDataDir);
	if (pluginDataRes.kind === "error") {
		throw new Error(`Invalid pluginDataDir: ${pluginDataRes.message}`);
	}

	const pluginDataDir = pluginDataRes.value;
	const rawGlobs =
		Array.isArray(params?.allowedGlobs) && params.allowedGlobs.length > 0
			? params.allowedGlobs
			: ["**/*"];

	const allowedGlobs = [];
	for (const rawGlob of rawGlobs) {
		const parsed = parseRelativeGlob(rawGlob);
		if (parsed.kind === "error") {
			throw new Error(parsed.message);
		}
		allowedGlobs.push(parsed.value);
	}

	const applyStrategy =
		params?.applyStrategy === "branch-only" ? "branch-only" : "patch-if-clean";
	const createdAt = Number.isFinite(Number(params?.nowMs))
		? Math.floor(Number(params.nowMs))
		: Date.now();

	const requestDir = requestDirRes.value;
	const hostRepoRoot = runGit(requestDir, ["rev-parse", "--show-toplevel"]).trim();
	const cwdPrefix = runGit(requestDir, ["rev-parse", "--show-prefix"]).trim();
	let baseCommitSha;
	try {
		baseCommitSha = runGit(hostRepoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
	} catch {
		throw new Error(`${hostRepoRoot} has no commits yet, so claugle cannot create an isolated worktree for edits.`);
	}
	const worktreesRoot = path.join(pluginDataDir, "worktrees");
	fs.mkdirSync(worktreesRoot, { recursive: true });

	const worktreePath = path.join(worktreesRoot, taskId);
	if (fs.existsSync(worktreePath)) {
		forceCleanupWorktree(hostRepoRoot, worktreePath);
	}

	const surface = collectHarnessSurface(hostRepoRoot);
	runGit(hostRepoRoot, ["worktree", "add", "--detach", worktreePath, baseCommitSha]);
	const gitDir = runGit(worktreePath, ["rev-parse", "--absolute-git-dir"]).trim();
	const executionCwd = path.join(worktreePath, cwdPrefix);
	fs.mkdirSync(executionCwd, { recursive: true });

	const branchName = `claugle/${taskId}`;

	return Object.freeze({
		taskId,
		hostRepoRoot,
		cwdPrefix,
		worktreePath,
		gitDir,
		executionCwd,
		baseCommitSha,
		branchName,
		allowedGlobs: Object.freeze(allowedGlobs),
		protectedFiles: Object.freeze(surface.files),
		protectedDirs: Object.freeze(surface.dirs),
		applyStrategy,
		createdAt,
	});
}

function preserveWorktreeOnBranch(lease) {
	runWorktreeGit(lease, [
		"-c",
		"user.name=claugle",
		"-c",
		"user.email=claugle@localhost",
		"commit",
		"-m",
		`chore(claugle): preserve changes for ${lease.taskId}`,
		"--no-gpg-sign",
	]);
	runWorktreeGit(lease, ["branch", "-f", lease.branchName, "HEAD"]);
}

// A `.git` below the worktree root is a repository the model created or rewrote. git would read
// its config, so harvest stops before running any git command over it.
function findNestedGitEntries(worktreePath) {
	const found = [];
	const pending = [worktreePath];
	while (pending.length > 0) {
		const dir = pending.pop();
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.name === ".git") {
				if (dir !== worktreePath) found.push(path.relative(worktreePath, full));
				continue;
			}
			if (entry.isDirectory()) pending.push(full);
		}
	}
	return found.sort();
}

export function harvestAndReleaseWorktree(arg) {
	const lease = arg && "lease" in arg ? arg.lease : arg;
	if (!lease || typeof lease !== "object") {
		throw new Error("harvestAndReleaseWorktree requires a valid WorktreeLease.");
	}

	try {
		const nestedGitPaths = findNestedGitEntries(lease.worktreePath);
		if (nestedGitPaths.length > 0) {
			forceCleanupWorktree(lease.hostRepoRoot, lease.worktreePath);
			return Object.freeze({
				kind: "rejected-nested-git",
				nestedGitPaths: Object.freeze(nestedGitPaths),
				worktreeCleanedUp: true,
			});
		}

		runWorktreeGit(lease, ["add", "-A"]);

		// Plumbing output ignores user diff config and never quotes non-ASCII names.
		const changedFiles = runWorktreeGit(lease, ["diff-index", "--cached", "--name-only", "-z", lease.baseCommitSha])
			.split("\0")
			.filter(Boolean);
		const modifiedFiles = changedFiles.map((file) => path.posix.relative(lease.cwdPrefix, file));

		if (modifiedFiles.length === 0) {
			forceCleanupWorktree(lease.hostRepoRoot, lease.worktreePath);
			return Object.freeze({
				kind: "no-changes",
				worktreeCleanedUp: true,
			});
		}

		const violatingFiles = modifiedFiles.filter(
			(file, i) =>
				isProtected(changedFiles[i], lease) ||
				file.split("/").some((name) => HARNESS_CONFIG_NAMES.includes(name)) ||
				!matchesAllowedGlobs(file, lease.allowedGlobs)
		);

		if (violatingFiles.length > 0) {
			forceCleanupWorktree(lease.hostRepoRoot, lease.worktreePath);
			return Object.freeze({
				kind: "rejected-glob-violation",
				violatingFiles: Object.freeze(violatingFiles),
				worktreeCleanedUp: true,
			});
		}

		if (lease.applyStrategy === "branch-only") {
			preserveWorktreeOnBranch(lease);
			forceCleanupWorktree(lease.hostRepoRoot, lease.worktreePath);
			return Object.freeze({
				kind: "preserved-on-branch",
				branchName: lease.branchName,
				modifiedFiles: Object.freeze(modifiedFiles),
				reason: "BRANCH_ONLY_STRATEGY",
				worktreeCleanedUp: true,
			});
		}

		const patchBuffer = runWorktreeGit(lease, ["diff-index", "--cached", "-p", "--binary", lease.baseCommitSha], {
			encoding: "buffer",
		});

		// Without --index or --3way, git apply writes only the working tree, and it writes nothing
		// unless every hunk applies.
		try {
			runGit(lease.hostRepoRoot, ["apply", "--whitespace=nowarn"], { input: patchBuffer });
		} catch {
			preserveWorktreeOnBranch(lease);
			forceCleanupWorktree(lease.hostRepoRoot, lease.worktreePath);
			return Object.freeze({
				kind: "preserved-on-branch",
				branchName: lease.branchName,
				modifiedFiles: Object.freeze(modifiedFiles),
				reason: "HOST_CONFLICT_ON_3WAY_APPLY",
				worktreeCleanedUp: true,
			});
		}
		forceCleanupWorktree(lease.hostRepoRoot, lease.worktreePath);
		return Object.freeze({
			kind: "applied-to-host",
			modifiedFiles: Object.freeze(modifiedFiles),
			worktreeCleanedUp: true,
		});
	} catch (err) {
		forceCleanupWorktree(lease.hostRepoRoot, lease.worktreePath);
		throw err;
	}
}

export function reconcileStaleWorktrees(params) {
	const pluginDataDir = params?.pluginDataDir;
	const hostRepoRoot = params?.hostRepoRoot;
	const nowMs = Number.isFinite(Number(params?.nowMs)) ? Math.floor(Number(params.nowMs)) : Date.now();
	const maxAgeMs = Number.isFinite(Number(params?.maxAgeMs))
		? Math.max(0, Math.floor(Number(params.maxAgeMs)))
		: TWO_HOURS_MS;

	const worktreesRoot = path.join(pluginDataDir, "worktrees");
	let entries = [];
	try {
		entries = fs.readdirSync(worktreesRoot, { withFileTypes: true });
	} catch {
		return Object.freeze({
			prunedWorktrees: Object.freeze([]),
			retainedWorktrees: Object.freeze([]),
		});
	}

	const cutoffMs = nowMs - maxAgeMs;
	const prunedWorktrees = [];
	const retainedWorktrees = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const fullPath = path.join(worktreesRoot, entry.name);
		let stat;
		try {
			stat = fs.statSync(fullPath);
		} catch {
			continue;
		}

		if (stat.mtimeMs <= cutoffMs) {
			if (hostRepoRoot) {
				forceCleanupWorktree(hostRepoRoot, fullPath);
			} else {
				fs.rmSync(fullPath, { recursive: true, force: true });
			}
			prunedWorktrees.push(fullPath);
		} else {
			retainedWorktrees.push(fullPath);
		}
	}

	return Object.freeze({
		prunedWorktrees: Object.freeze(prunedWorktrees),
		retainedWorktrees: Object.freeze(retainedWorktrees),
	});
}
