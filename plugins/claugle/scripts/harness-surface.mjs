import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HARNESS_CONFIG_NAMES, HARNESS_INSTRUCTION_FILES } from "./policy-engine.mjs";

// What an edit run must leave as it was in the host repo: every file Claude Code or agy reads as
// instructions, every hop of a symlink inside a project or user harness folder, and every script a
// harness config names. Mirroring Claude Code's loader and the shell exactly kept leaving gaps in
// review, so this reads more than they do: every `@` token anywhere, code included, under several
// readings; every word in a harness config, a `!` command line or a frontmatter hook, under the
// spellings a shell or interpreter accepts; in the host working tree that Claude Code reads, not HEAD. Not followed:
// `npm run` or `make` targets, and files a named script loads in turn. Paths are relative to the repo
// root, as git prints them.

const MAX_IMPORT_HOPS = 5;
const MAX_SCANNED_BYTES = 8 * 1024 * 1024;
const PATH_MAX = 4096;
const AT_TOKEN = /@((?:\\.|[^\s\\])+)/g;
const COMMAND_TOKEN = /[^\s"'`;|&<>(){}[\],=]+/g;
const BANG_COMMAND = /!`([^`]+)`|^\s*```!\s*$([\s\S]*?)^\s*```/gm;
// Agent, skill and command frontmatter can declare hooks.
const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*$/m;
const SCRIPT_SUFFIXES = [".js", ".mjs", ".cjs", ".ts", ".py", ".sh"];
const SCRIPT_ENTRIES = ["index.js", "package.json", "__main__.py", "__init__.py"];
// After these, a folder name runs the folder's entry file.
const RUNS_A_FOLDER = /^(?:node|nodejs|deno|bun|tsx|ts-node|python[\d.]*|py|pypy[\d.]*|-m)$/;
const MANAGED_DIRS = ["/etc/claude-code", "/Library/Application Support/ClaudeCode"];
// Symlinks in a user-level harness folder can point into the repo, as in a dotfiles repo. The first two
// hold large caches, so only their direct entries are checked.
const USER_HARNESS_SHALLOW = ["", "plugins", "plugins/marketplaces"];
const USER_HARNESS_DEEP = ["rules", "skills", "agents", "commands", "hooks", "output-styles"];

export const SURFACE_PATHSPECS = Object.freeze([
	...HARNESS_CONFIG_NAMES.flatMap((name) => [`:(glob,icase)**/${name}`, `:(glob,icase)**/${name}/**`]),
	":(exclude,glob,icase)**/.claude/worktrees/**",
]);

// macOS and Windows filesystems ignore case, and macOS stores names decomposed.
export const foldName = (name) => name.normalize("NFC").toLowerCase();
export const isHarnessConfigName = (name) => HARNESS_CONFIG_NAMES.some((config) => foldName(config) === foldName(name));
const isInstructionName = (name) => HARNESS_INSTRUCTION_FILES.some((instruction) => foldName(instruction) === foldName(name));

function importReadings(token) {
	const readings = new Set();
	const atBackslash = token.split(/\\(?! )/)[0];
	for (const cut of [token, token.split("#")[0], atBackslash, atBackslash.split("#")[0]]) {
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

// Both readings of `${NAME:-default}`: the value the variable has, and the default.
function expandCommand(text, vars) {
	const expand = (preferDefault) =>
		text
			.replace(/\$\{(\w+)(?::?[-=+?]([^}]*))?\}/g, (_, name, fallback) => (preferDefault && fallback !== undefined ? fallback : (vars[name] ?? fallback ?? "")))
			.replace(/\$(\w+)/g, (_, name) => vars[name] ?? "")
			.replaceAll('\\"', "");
	return [...new Set([expand(false), expand(true)])];
}

const stringValues = (value) => (value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "string")) : {});

function jsonStrings(value, out = []) {
	if (typeof value === "string") out.push(value);
	else if (value && typeof value === "object") for (const child of Object.values(value)) jsonStrings(child, out);
	return out;
}

// The string values of a JSON config, or the whole text when it does not parse. ~/.claude.json mostly
// holds history and caches; only its mcpServers entries run anything.
function commandStrings(file, text) {
	try {
		const parsed = JSON.parse(text);
		if (path.basename(file) !== ".claude.json") return jsonStrings({ ...parsed, permissions: undefined });
		const servers = [];
		const walk = (value) => {
			if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) key === "mcpServers" ? servers.push(child) : walk(child);
		};
		walk(parsed);
		return jsonStrings(servers);
	} catch {
		return [text];
	}
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

function filesUnder(dir) {
	try {
		return fs.readdirSync(dir, { recursive: true }).slice(0, 2000).map((name) => path.join(dir, name));
	} catch {
		return [];
	}
}

// lstat still throws ENOTDIR when a parent is a file.
function statOf(abs, follow) {
	try {
		return abs.length <= PATH_MAX ? (follow ? fs.statSync : fs.lstatSync)(abs, { throwIfNoEntry: false }) : undefined;
	} catch {
		return undefined;
	}
}
const exists = (abs) => statOf(abs, false) !== undefined;
const isLink = (abs) => statOf(abs, false)?.isSymbolicLink() === true;
const isDir = (abs) => statOf(abs, true)?.isDirectory() === true;

// `listed` holds the repo-relative paths git lists for SURFACE_PATHSPECS, tracked or not.
export function collectHarnessSurface({ hostRepoRoot, listed, sessionProjectDir }) {
	const home = os.homedir();
	const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
	const roots = [...new Set([hostRepoRoot, fs.realpathSync(hostRepoRoot)])];
	const projectDirs = [...new Set([...(sessionProjectDir ? [sessionProjectDir] : []), ...roots])];
	const relOf = (abs) => {
		for (const root of roots) {
			const rel = path.relative(root, abs);
			if (rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
		}
		return null;
	};
	const files = new Set();
	const dirs = new Set();
	const protectChain = (abs, into) => {
		for (const rel of linkChain(abs).map(relOf)) if (rel) into.add(rel);
	};

	// A project's own config runs commands from that project's folder; user and managed configs run
	// them from whichever project Claude Code was started in.
	const projectsOf = (abs) => {
		const parts = abs.split(path.sep);
		const claudeAt = parts.findLastIndex((part) => foldName(part) === ".claude");
		const owner = claudeAt > 0 ? parts.slice(0, claudeAt).join(path.sep) : foldName(path.basename(abs)) === ".mcp.json" ? path.dirname(abs) : null;
		return owner && owner !== home && !abs.startsWith(claudeDir + path.sep) ? [owner] : projectDirs;
	};
	const protectExisting = (candidate) => {
		for (const spelling of [candidate, ...SCRIPT_SUFFIXES.map((suffix) => candidate + suffix)]) if (exists(spelling)) protectChain(spelling, files);
	};
	// `node D` runs what D/package.json names.
	const protectPackageEntries = (manifestPath) => {
		let manifest;
		try {
			manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		} catch {
			return;
		}
		const named = [manifest?.main, manifest?.bin, manifest?.exports].flatMap((value) =>
			typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).filter((entry) => typeof entry === "string") : []
		);
		for (const entry of named) protectExisting(path.resolve(path.dirname(manifestPath), entry));
	};
	const protectScript = (candidate, runsFolder) => {
		if (candidate.length > PATH_MAX) return;
		if (relOf(candidate)) protectChain(candidate, files);
		protectExisting(candidate);
		if (!runsFolder || projectDirs.includes(candidate)) return;
		for (const entry of SCRIPT_ENTRIES) {
			const spelling = path.join(candidate, entry);
			if (!exists(spelling)) continue;
			protectChain(spelling, files);
			if (entry === "package.json") protectPackageEntries(spelling);
		}
	};
	const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	const envOf = (file) => {
		try {
			return stringValues(JSON.parse(fs.readFileSync(file, "utf8"))?.env);
		} catch {
			return {};
		}
	};
	const userEnv = Object.assign({}, ...["settings.json", "settings.local.json"].map((name) => envOf(path.join(claudeDir, name))));
	// Every word counts, not only words that look like paths: `cd tools`, `python3 -m guard` and
	// `node server` name a file or folder by a bare word.
	const scanCommands = (commands, configFile) => {
		for (const projectDir of projectsOf(configFile)) {
			const vars = {
				...process.env,
				...userEnv,
				...Object.assign({}, ...["settings.json", "settings.local.json"].map((name) => envOf(path.join(projectDir, ".claude", name)))),
				...envOf(configFile),
				HOME: home,
				PWD: projectDir,
				CLAUDE_PROJECT_DIR: projectDir,
			};
			const expanded = commands.flatMap((command) => expandCommand(command, vars));
			const words = expanded.flatMap((command) => [...command.matchAll(COMMAND_TOKEN)].map(([token]) => token)).filter((token) => token.length <= PATH_MAX);
			const tokens = words.map((token, i) => ({ token, runsFolder: i > 0 && RUNS_A_FOLDER.test(path.basename(words[i - 1])) }));
			// Any word can be the program: `timeout 5 x`, `FOO=1 x`, `env x`.
			const programs = [...new Set(words)].filter((word) => /^[\w.+-]+$/.test(word));
			const bases = new Set([projectDir, ...roots, path.dirname(configFile), path.dirname(resolveExisting(configFile))]);
			const pathsOf = (token) => {
				const readings = /^[\w.]+$/.test(token) && token.includes(".") ? [token, token.replaceAll(".", "/")] : [token];
				return readings.flatMap((reading) => {
					if (reading.startsWith("~/")) return [path.join(home, reading.slice(2))];
					if (path.isAbsolute(reading)) return [reading, ...[...bases].map((base) => path.join(base, reading))];
					return [...bases].map((base) => path.resolve(base, reading));
				});
			};
			// `cd D && ./f`, `--directory D f`, `PYTHONPATH=D` and the like run f from D, also when D reaches
			// the repo through a link.
			for (let round = 0, before = -1; round < 3 && bases.size !== before; round++) {
				before = bases.size;
				for (const { token } of tokens) for (const candidate of pathsOf(token)) if (isDir(candidate) && (relOf(candidate) || relOf(resolveExisting(candidate)))) bases.add(candidate);
			}
			for (const { token, runsFolder } of tokens) for (const candidate of pathsOf(token)) protectScript(candidate, runsFolder);
			for (const program of programs) for (const dir of pathDirs) if (exists(path.join(dir, program))) protectChain(path.join(dir, program), files);
		}
	};
	const scannedConfigs = new Set();
	const scanConfig = (abs) => {
		if (scannedConfigs.has(abs)) return;
		scannedConfigs.add(abs);
		let text;
		try {
			text = fs.readFileSync(abs, "utf8");
		} catch {
			return;
		}
		scanCommands(commandStrings(abs, text), abs);
	};

	const scanBangText = (text, abs) => {
		const commands = [...text.matchAll(BANG_COMMAND)].map(([, inline, fenced]) => inline ?? fenced);
		const frontmatter = text.startsWith("---") ? text.match(FRONTMATTER)?.[1] : undefined;
		if (frontmatter && /^\s*hooks\s*:/m.test(frontmatter)) commands.push(frontmatter);
		if (commands.length > 0) scanCommands(commands, abs);
	};

	// A command, skill or agent reads `@path` from the folder Claude Code runs in.
	const invokedFromProject = (abs) => abs.split(path.sep).some((part) => ["commands", "skills", "agents"].includes(foldName(part)));
	const fewestHops = new Map();
	const visit = (abs, hops) => {
		if (abs.length > PATH_MAX || fewestHops.get(abs) <= hops) return;
		fewestHops.set(abs, hops);
		const chain = linkChain(abs);
		for (const rel of chain.map(relOf)) if (rel) files.add(rel);
		const real = chain.at(-1);
		const stat = statOf(real, true);
		if (!stat?.isFile()) return;
		if (stat.size > MAX_SCANNED_BYTES) {
			throw new Error(`${real} is over 8 MiB, so claugle cannot tell which files it imports and does not let agy edit this repo.`);
		}
		let text;
		try {
			text = fs.readFileSync(real, "utf8");
		} catch {
			return;
		}
		scanBangText(text, abs);
		if (hops >= MAX_IMPORT_HOPS) return;
		for (const [, token] of text.matchAll(AT_TOKEN)) {
			for (const reading of importReadings(token)) {
				if (reading.startsWith("~/")) visit(path.join(home, reading.slice(2)), hops + 1);
				else if (path.isAbsolute(reading)) visit(path.resolve(reading), hops + 1);
				else for (const base of new Set([path.dirname(abs), path.dirname(real), ...(invokedFromProject(abs) ? projectDirs : [])])) visit(path.resolve(base, reading), hops + 1);
			}
		}
	};
	const read = (file) => {
		const name = foldName(path.basename(file));
		if (name.endsWith(".md")) visit(file, 0);
		if (name.endsWith(".json")) scanConfig(file);
	};
	const followed = new Set();
	const followLink = (abs) => {
		protectChain(abs, dirs);
		const target = resolveExisting(abs);
		if (followed.has(target)) return;
		followed.add(target);
		for (const file of isDir(target) ? filesUnder(target) : [target]) {
			read(file);
			if (file !== target && isLink(file)) followLink(file);
		}
	};

	for (const rel of listed) {
		const abs = path.join(hostRepoRoot, rel);
		if (isInstructionName(path.posix.basename(rel))) visit(abs, 0);
		read(abs);
		if (isLink(abs)) followLink(abs);
	}

	const outside = [
		path.join(home, ".claude.json"),
		path.join(home, ".gemini", "GEMINI.md"),
		...["CLAUDE.md", "settings.json", "settings.local.json", ".claude.json"].map((name) => path.join(claudeDir, name)),
		...filesUnder(path.join(claudeDir, "rules")),
		...MANAGED_DIRS.flatMap((dir) => [
			...["CLAUDE.md", "managed-settings.json", "managed-mcp.json"].map((name) => path.join(dir, name)),
			...filesUnder(path.join(dir, "managed-settings.d")),
		]),
	];
	for (const top of [...projectDirs, ...roots.map(path.dirname), home]) {
		for (let dir = top; ; dir = path.dirname(dir)) {
			outside.push(...["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "GEMINI.md", ".mcp.json"].map((name) => path.join(dir, name)));
			outside.push(...["CLAUDE.md", "settings.json", "settings.local.json"].map((name) => path.join(dir, ".claude", name)));
			outside.push(...filesUnder(path.join(dir, ".claude", "rules")));
			if (path.dirname(dir) === dir) break;
		}
	}
	for (const abs of outside) {
		if (isInstructionName(path.basename(abs))) visit(abs, 0);
		else read(abs);
	}
	for (const harnessDir of new Set([claudeDir, path.join(home, ".claude"), path.join(home, ".gemini"), path.join(home, ".agents")])) {
		const entries = [
			...USER_HARNESS_SHALLOW.flatMap((sub) => {
				const dir = path.join(harnessDir, sub);
				try {
					return [dir, ...fs.readdirSync(dir).map((name) => path.join(dir, name))];
				} catch {
					return [dir];
				}
			}),
			...USER_HARNESS_DEEP.flatMap((sub) => [path.join(harnessDir, sub), ...filesUnder(path.join(harnessDir, sub))]),
		];
		for (const entry of entries) {
			if (isLink(entry)) followLink(entry);
			else if (foldName(entry).endsWith(".md")) visit(entry, 0);
		}
	}
	return { files: [...files], dirs: [...dirs] };
}

// A change to a protected path's folder counts too: replacing that folder with a symlink redirects it.
export function isProtected(file, { protectedFiles, protectedDirs }) {
	const folded = foldName(file);
	const within = (protectedPath) => foldName(protectedPath) === folded || foldName(protectedPath).startsWith(`${folded}/`);
	return protectedFiles.some(within) || protectedDirs.some((dir) => within(dir) || folded.startsWith(`${foldName(dir)}/`));
}
