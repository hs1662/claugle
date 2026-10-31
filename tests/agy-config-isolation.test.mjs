import assert from "node:assert/strict";
import os from "node:os";
import { describe, it } from "node:test";
import { buildAgyCliArgs } from "../plugins/claugle/scripts/provider-runner.mjs";

const AGY_PERMISSION_ACTIONS = ["command", "read_file", "write_file", "read_url", "mcp", "execute_url", "unsandboxed"];

describe("agy gets only deny rules it accepts", () => {
	it("every deny entry names an action agy accepts, in plan and accept-edits modes", () => {
		for (const mode of ["plan", "accept-edits"]) {
			const args = buildAgyCliArgs({ prompt: "x", modelSlug: "gemini-3.8-flash-low", mode, cwd: os.tmpdir(), hostRepoRoot: "/home/u/project" });
			const deny = JSON.parse(args[args.indexOf("--settings") + 1]).permissions.deny;
			assert.ok(deny.includes("command(*)"), `${mode}: ${JSON.stringify(deny)}`);
			assert.deepEqual(deny.filter((entry) => !AGY_PERMISSION_ACTIONS.includes(entry.slice(0, entry.indexOf("(")))), [], mode);
		}
	});
});
