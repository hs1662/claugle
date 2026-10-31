import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createTaskExecutionId, parseAbsolutePath, parseRelativeGlob } from "./policy-engine.mjs";

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

function runGit(repoDir, args, options = {}) {
	return execFileSync("git", ["-C", repoDir, ...args], {
		encoding: options.encoding ?? "utf8",
		input: options.input,
		stdio: ["pipe", "pipe", "pipe"],
	});
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

export function acquireWorktreeLease(params) {
	const taskId =
		typeof params?.taskId === "string" && params.taskId.length > 0
			? params.taskId
			: createTaskExecutionId();

	const hostRepoRes = parseAbsolutePath(params?.hostRepoRoot);
	if (hostRepoRes.kind === "error") {
		throw new Error(`Invalid hostRepoRoot: ${hostRepoRes.message}`);
	}
	const pluginDataRes = parseAbsolutePath(params?.pluginDataDir);
	if (pluginDataRes.kind === "error") {
		throw new Error(`Invalid pluginDataDir: ${pluginDataRes.message}`);
	}

	const hostRepoRoot = hostRepoRes.value;
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

	const baseCommitSha = runGit(hostRepoRoot, ["rev-parse", "HEAD"]).trim();
	const worktreesRoot = path.join(pluginDataDir, "worktrees");
	fs.mkdirSync(worktreesRoot, { recursive: true });

	const worktreePath = path.join(worktreesRoot, taskId);
	if (fs.existsSync(worktreePath)) {
		forceCleanupWorktree(hostRepoRoot, worktreePath);
	}

	runGit(hostRepoRoot, ["worktree", "add", "--detach", worktreePath, baseCommitSha]);

	const branchName = `claugle/${taskId.startsWith("task-") ? taskId : `task-${taskId}`}`;

	return Object.freeze({
		taskId,
		hostRepoRoot,
		worktreePath,
		baseCommitSha,
		branchName,
		allowedGlobs: Object.freeze(allowedGlobs),
		applyStrategy,
		createdAt,
	});
}

function preserveWorktreeOnBranch(lease) {
	try {
		runGit(lease.worktreePath, ["diff", "--cached", "--quiet", "HEAD"]);
	} catch {
		runGit(lease.worktreePath, [
			"-c",
			"user.name=claugle",
			"-c",
			"user.email=claugle@localhost",
			"commit",
			"-m",
			`chore(claugle): preserve changes for ${lease.taskId}`,
			"--no-gpg-sign",
		]);
	}
	runGit(lease.worktreePath, ["branch", "-f", lease.branchName, "HEAD"]);
}

export function harvestAndReleaseWorktree(arg) {
	const lease = arg && "lease" in arg ? arg.lease : arg;
	if (!lease || typeof lease !== "object") {
		throw new Error("harvestAndReleaseWorktree requires a valid WorktreeLease.");
	}

	try {
		runGit(lease.worktreePath, ["add", "-A"]);

		const diffNamesRaw = runGit(lease.worktreePath, [
			"diff",
			"--cached",
			"--name-only",
			lease.baseCommitSha,
		]);

		const modifiedFiles = diffNamesRaw
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);

		if (modifiedFiles.length === 0) {
			forceCleanupWorktree(lease.hostRepoRoot, lease.worktreePath);
			return Object.freeze({
				kind: "no-changes",
				worktreeCleanedUp: true,
			});
		}

		const violatingFiles = modifiedFiles.filter(
			(file) => !matchesAllowedGlobs(file, lease.allowedGlobs)
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

		const patchBuffer = runGit(
			lease.worktreePath,
			["diff", "--cached", "--binary", lease.baseCommitSha],
			{ encoding: "buffer" }
		);

		let cleanCheckPassed = false;
		try {
			runGit(lease.hostRepoRoot, ["apply", "--check", "--3way", "--whitespace=nowarn"], {
				input: patchBuffer,
			});
			cleanCheckPassed = true;
		} catch {
			cleanCheckPassed = false;
		}

		if (cleanCheckPassed) {
			runGit(lease.hostRepoRoot, ["apply", "--3way", "--whitespace=nowarn"], {
				input: patchBuffer,
			});
			forceCleanupWorktree(lease.hostRepoRoot, lease.worktreePath);
			return Object.freeze({
				kind: "applied-to-host",
				modifiedFiles: Object.freeze(modifiedFiles),
				worktreeCleanedUp: true,
			});
		}

		preserveWorktreeOnBranch(lease);
		forceCleanupWorktree(lease.hostRepoRoot, lease.worktreePath);
		return Object.freeze({
			kind: "preserved-on-branch",
			branchName: lease.branchName,
			modifiedFiles: Object.freeze(modifiedFiles),
			reason: "HOST_CONFLICT_ON_3WAY_APPLY",
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
