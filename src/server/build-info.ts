import { execFileSync } from "node:child_process";
import pkg from "../../package.json";

type Env = Record<string, string | undefined>;
type Git = (args: string[]) => string | null;

function runGit(args: string[]): string | null {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Version of the newest stable release tag, without the leading "v". Images get WOLUPS_VERSION from CI. Without it, a
 * git checkout describes its HEAD, and anything else falls back to package.json.
 */
export function buildVersion(env: Env = process.env, git: Git = runGit): string {
  const tag =
    env.WOLUPS_VERSION?.trim() || git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "--exclude", "*-*"]);
  return tag?.replace(/^v/, "") || pkg.version;
}

/** True when `commit` carries the stable tag for this version. */
function isReleaseCommit(commit: string, git: Git, version: string): boolean {
  if (version.includes("-")) return false;
  const tags = git(["tag", "--points-at", commit]);
  return tags?.split("\n").some((tag) => tag.trim() === `v${version}`) ?? false;
}

/**
 * Short commit shown in place of the version for builds that are not a stable release, or null to show the version.
 * Images get WOLUPS_COMMIT and WOLUPS_RELEASE from CI. Without them, a git checkout uses its HEAD.
 */
export function buildCommit(
  env: Env = process.env,
  git: Git = runGit,
  version = buildVersion(env, git),
): string | null {
  if (env.WOLUPS_RELEASE === "true") return null;
  const commit = env.WOLUPS_COMMIT?.trim() || git(["rev-parse", "HEAD"]);
  if (!commit) return null;
  return isReleaseCommit(commit, git, version) ? null : commit.slice(0, 7);
}

export const VERSION = buildVersion();
export const COMMIT = buildCommit(process.env, runGit, VERSION);
