import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

it.each([
  ["existing", "publish=false"],
  ["missing", "publish=true"],
])(
  "resumes npm publication when the version is %s",
  async (state, expected) => {
    const fixture = await releaseFixture({
      npm: `#!/bin/sh
case "$RELEASE_TEST_NPM_STATE" in
  existing) echo '"1.0.0"'; exit 0 ;;
  missing) echo 'npm ERR! code E404' >&2; exit 1 ;;
  *) echo 'private-npm-diagnostic' >&2; exit 1 ;;
esac
`,
    });

    await runRelease(fixture, ["npm", "twitter-search-mcp", "1.0.0"], {
      RELEASE_TEST_NPM_STATE: state,
    });

    await expect(readFile(fixture.output, "utf8")).resolves.toBe(
      `${expected}\n`,
    );
  },
);

it("fails closed without echoing unexpected npm diagnostics", async () => {
  const fixture = await releaseFixture({
    npm: `#!/bin/sh
echo 'private-npm-diagnostic' >&2
exit 1
`,
  });

  const error = await runRelease(
    fixture,
    ["npm", "twitter-search-mcp", "1.0.0"],
    {},
  ).catch((caught: unknown) => caught as { stderr: string });

  expect(error.stderr).toContain("Unable to determine npm publication state");
  expect(error.stderr).not.toContain("private-npm-diagnostic");
});

it.each([
  ["same", ["build=false", "repair=false", `digest=sha256:${"a".repeat(64)}`]],
  [
    "version-only",
    [
      "build=false",
      "repair=true",
      `digest=sha256:${"a".repeat(64)}`,
      "missing_tag=ghcr.io/example/twitter-search-mcp:commit-sha",
    ],
  ],
  ["missing", ["build=true", "repair=false"]],
])("resolves the %s GHCR resume state", async (state, expected) => {
  const fixture = await releaseFixture({ docker: fakeDocker });

  await runRelease(
    fixture,
    ["image", "ghcr.io/example/twitter-search-mcp", "1.0.0", "commit-sha"],
    { RELEASE_TEST_IMAGE_STATE: state },
  );

  const output = (await readFile(fixture.output, "utf8")).trim().split("\n");
  expect(output).toEqual(expected);
});

it("refuses conflicting immutable GHCR tags", async () => {
  const fixture = await releaseFixture({ docker: fakeDocker });

  const error = await runRelease(
    fixture,
    ["image", "ghcr.io/example/twitter-search-mcp", "1.0.0", "commit-sha"],
    { RELEASE_TEST_IMAGE_STATE: "conflict" },
  ).catch((caught: unknown) => caught as { stderr: string });

  expect(error.stderr).toContain("resolve to different digests");
});

it.each([
  ["true", "release edit v1.0.0 --title v1.0.0 --notes-file notes.md"],
  ["false", "release create v1.0.0 --title v1.0.0 --notes-file notes.md"],
])(
  "updates or creates the GitHub Release when existing=%s",
  async (exists, expected) => {
    const fixture = await releaseFixture({
      gh: `#!/bin/sh
printf '%s\n' "$*" >> "$RELEASE_TEST_LOG"
if [ "$1 $2" = "release view" ]; then
  [ "$RELEASE_TEST_RELEASE_EXISTS" = "true" ]
  exit $?
fi
exit 0
`,
    });

    await runRelease(fixture, ["release", "v1.0.0", "notes.md"], {
      RELEASE_TEST_RELEASE_EXISTS: exists,
      RELEASE_TEST_LOG: fixture.log,
    });

    const calls = (await readFile(fixture.log, "utf8")).trim().split("\n");
    expect(calls.at(-1)).toBe(expected);
  },
);

const fakeDocker = `#!/bin/sh
reference="$4"
digest_a="sha256:${"a".repeat(64)}"
digest_b="sha256:${"b".repeat(64)}"
case "$RELEASE_TEST_IMAGE_STATE" in
  same) echo "$digest_a" ;;
  version-only)
    case "$reference" in
      *:1.0.0) echo "$digest_a" ;;
      *) echo 'manifest unknown' >&2; exit 1 ;;
    esac
    ;;
  missing) echo 'manifest unknown' >&2; exit 1 ;;
  conflict)
    case "$reference" in
      *:1.0.0) echo "$digest_a" ;;
      *) echo "$digest_b" ;;
    esac
    ;;
esac
`;

type ReleaseFixture = {
  readonly directory: string;
  readonly bin: string;
  readonly output: string;
  readonly log: string;
};

async function releaseFixture(
  tools: Partial<Record<"npm" | "docker" | "gh", string>>,
): Promise<ReleaseFixture> {
  const directory = await mkdtemp(join(tmpdir(), "twitter-search-release-"));
  directories.push(directory);
  const bin = join(directory, "bin");
  await mkdir(bin);
  for (const [name, source] of Object.entries(tools)) {
    const path = join(bin, name);
    await writeFile(path, source);
    await chmod(path, 0o755);
  }
  return {
    directory,
    bin,
    output: join(directory, "github-output"),
    log: join(directory, "calls.log"),
  };
}

async function runRelease(
  fixture: ReleaseFixture,
  arguments_: readonly string[],
  environment: Record<string, string>,
) {
  return await execFileAsync(
    "sh",
    ["scripts/release-state.sh", ...arguments_],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...environment,
        GITHUB_OUTPUT: fixture.output,
        PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
      },
    },
  );
}
