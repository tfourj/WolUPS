import { describe, expect, test } from "bun:test";
import pkg from "../package.json";
import { buildCommit, buildVersion } from "../src/server/build-info";

const SHA = "3f05798c1a2b4d5e6f708192a3b4c5d6e7f80912";

/** Fake git that answers rev-parse with `head`, describe with `describe` and tag lookups with `tags`. */
function git(head: string | null, tags: string[] = [], describe: string | null = null) {
  return (args: string[]) => {
    if (args[0] === "rev-parse") return head;
    if (args[0] === "describe") return describe;
    return tags.join("\n") || null;
  };
}

describe("buildVersion", () => {
  test("uses the version from the environment", () => {
    expect(buildVersion({ WOLUPS_VERSION: "1.2.3" }, git(null, [], "v1.0.0"))).toBe("1.2.3");
  });

  test("describes the newest release tag of a git checkout", () => {
    expect(buildVersion({}, git(SHA, [], "v1.2.3"))).toBe("1.2.3");
  });

  test("falls back to package.json", () => {
    expect(buildVersion({ WOLUPS_VERSION: "" }, git(null))).toBe(pkg.version);
  });
});

describe("buildCommit", () => {
  test("shows the version for stable release images", () => {
    expect(buildCommit({ WOLUPS_RELEASE: "true", WOLUPS_COMMIT: SHA }, git(null), "1.2.3")).toBeNull();
  });

  test("shortens the commit from the environment", () => {
    expect(buildCommit({ WOLUPS_RELEASE: "false", WOLUPS_COMMIT: SHA }, git(null), "1.2.3")).toBe("3f05798");
  });

  test("falls back to the git HEAD", () => {
    expect(buildCommit({ WOLUPS_COMMIT: "" }, git(SHA), "1.2.3")).toBe("3f05798");
  });

  test("shows the version when HEAD is the stable tag", () => {
    expect(buildCommit({}, git(SHA, ["v1.2.3"]), "1.2.3")).toBeNull();
    expect(buildCommit({}, git(SHA, ["deploy", "v1.2.3"]), "1.2.3")).toBeNull();
  });

  test("shows the commit for other tags", () => {
    expect(buildCommit({}, git(SHA, ["v1.2.2"]), "1.2.3")).toBe("3f05798");
    expect(buildCommit({}, git(SHA, ["v1.3.0-rc.1"]), "1.3.0-rc.1")).toBe("3f05798");
  });

  test("shows the version without a commit", () => {
    expect(buildCommit({}, git(null), "1.2.3")).toBeNull();
  });
});
