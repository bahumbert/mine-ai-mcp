import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Reads .github/workflows/release-windows.yml without running it: the workflow is only ever run on GitHub, so what
// the signing spec (D2) promises is held here as facts about its file.

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  "timeout-minutes"?: number;
};
type Job = {
  "runs-on": string;
  needs?: string | string[];
  if?: string;
  environment?: string;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  env?: Record<string, string>;
  "timeout-minutes"?: number;
  steps: Step[];
};
type Workflow = {
  on: { push?: { tags?: string[] }; workflow_dispatch?: unknown };
  permissions: Record<string, string>;
  env: Record<string, string>;
  defaults: { run: { shell: string } };
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, Job>;
};

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const workflowText = readFileSync(join(repoRoot, ".github", "workflows", "release-windows.yml"), "utf8");
const workflow = Bun.YAML.parse(workflowText) as Workflow;
const { build, sign, release } = workflow.jobs as { build: Job; sign: Job; release: Job };
const manifest = JSON.parse(readFileSync(join(repoRoot, "packaging", "manifest.json"), "utf8")) as { bun: { url: string } };
const allSteps = Object.values(workflow.jobs).flatMap((job) => job.steps);
const label = (step: Step): string => `"${step.name ?? step.uses}"`;

function stepNamed(job: Job, pattern: RegExp): Step {
  const found = job.steps.filter((step) => pattern.test(step.name ?? ""));
  assert.equal(found.length, 1, `exactly one step named like ${pattern}, found ${found.length}`);
  return found[0] as Step;
}
function stepUsing(job: Job, action: string): Step {
  const found = job.steps.filter((step) => step.uses?.startsWith(`${action}@`) === true);
  assert.equal(found.length, 1, `exactly one step using ${action}, found ${found.length}`);
  return found[0] as Step;
}
function assertV4OrLater(step: Step): void {
  assert.match(step.uses ?? "", /@v([4-9]|\d{2,})$/u, label(step));
}

test("triggers, jobs, runners, permissions and gates: a tag push or a manual dispatch; sign and release on a tag only", () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ["push", "workflow_dispatch"]);
  assert.deepEqual(workflow.on.push, { tags: ["pre-alpha-*"] });
  assert.deepEqual(Object.keys(workflow.jobs), ["build", "sign", "release"]);
  for (const [name, job] of Object.entries(workflow.jobs)) assert.match(job["runs-on"], /^(windows-2025|ubuntu-latest)$/u, name);
  assert.equal(build["runs-on"], "windows-2025");
  assert.equal(sign["runs-on"], "windows-2025");
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(build.permissions, { contents: "read" });
  assert.deepEqual(sign.permissions, { actions: "read", contents: "read" });
  assert.equal(sign.environment, "release");
  assert.deepEqual(release.permissions, { contents: "write" });
  assert.equal(release.steps.some((step) => /bun install/u.test(step.run ?? "")), false);
  assert.equal(release.steps.some((step) => step.uses?.startsWith("actions/checkout@") === true), false);
  assert.equal(build.if, undefined);
  assert.deepEqual(sign.needs, "build");
  assert.deepEqual(release.needs, ["build", "sign"]);
  assert.match(sign.if ?? "", /github\.ref_type == 'tag'/u);
  assert.match(sign.if ?? "", /vars\.SIGNPATH_ORGANIZATION_ID/u);
  for (const pattern of [/always\(\)/u, /github\.ref_type == 'tag'/u, /needs\.build\.result == 'success'/u, /needs\.sign\.result == 'success'/u, /needs\.sign\.result == 'skipped'/u]) {
    assert.match(release.if ?? "", pattern);
  }
});

test("supply chain: no submodule, no credential kept, Bun pinned to the manifest's, third-party actions pinned by SHA, nothing cached", () => {
  const checkout = stepUsing(build, "actions/checkout");
  assert.equal(checkout.with?.["persist-credentials"], false);
  assert.doesNotMatch(workflowText, /submodules/u);
  const manifestBun = /bun-v(\d+\.\d+\.\d+)\//u.exec(manifest.bun.url)?.[1];
  assert.ok(manifestBun, "the manifest's bun.url names bun-v<x.y.z>");
  const setupBun = stepUsing(build, "oven-sh/setup-bun");
  assert.equal(setupBun.with?.["bun-version"], manifestBun);
  assert.equal(setupBun.with?.["no-cache"], true);
  const thirdParty = allSteps.filter((step) => /^(oven-sh|signpath)\//u.test(step.uses ?? ""));
  assert.equal(thirdParty.length, 2);
  for (const step of thirdParty) {
    const line = workflowText.split("\n").find((text) => text.includes(step.uses as string)) ?? "";
    const pinned = /@[0-9a-f]{40}$/u.test(step.uses as string) && /# v\d+\.\d+/u.test(line);
    assert.ok(pinned || line.includes("TODO(owner O2)"), `${step.uses} is not pinned by SHA and has no TODO(owner O2)`);
  }
  for (const step of allSteps) {
    assert.doesNotMatch(step.uses ?? "", /^actions\/cache@/u, `${label(step)} caches`);
    assert.equal(step.with?.cache, undefined, `${label(step)} sets cache`);
  }
});

test("data flow: the build writes under RUNNER_TEMP/out, the unsigned setup goes to SignPath, the signed one to signed/, release downloads by sign's result", () => {
  const buildStep = stepNamed(build, /build the setup/iu);
  assert.match(buildStep.run ?? "", /launcher\/src\/build\/build-windows\.ts/u);
  assert.match(buildStep.run ?? "", /--personas packaging\/personas/u);
  assert.match(buildStep.run ?? "", /--version "\$VERSION"/u);
  assert.match(buildStep.run ?? "", /--out "\$RUNNER_TEMP\/out"/u);
  const unsigned = stepUsing(build, "actions/upload-artifact");
  assertV4OrLater(unsigned);
  assert.equal(unsigned.id, "unsigned");
  assert.equal(unsigned.with?.name, "unsigned-setup");
  assert.equal(unsigned.with?.path, "${{ runner.temp }}\\out\\MineAI-Setup-*.exe");
  assert.equal(unsigned.with?.["if-no-files-found"], "error");
  assert.equal(build.outputs?.["artifact-id"], "${{ steps.unsigned.outputs.artifact-id }}");

  const request = stepUsing(sign, "signpath/github-action-submit-signing-request");
  assert.equal(request.id, "sign");
  assert.equal(request.with?.["github-artifact-id"], "${{ needs.build.outputs.artifact-id }}");
  assert.equal(request.with?.["api-token"], "${{ secrets.SIGNPATH_API_TOKEN }}");
  assert.equal(request.with?.["wait-for-completion"], true);
  assert.equal(request.with?.["wait-for-completion-timeout-in-seconds"], 14400);
  assert.equal(request.with?.["output-artifact-directory"], "${{ runner.temp }}\\signed");
  assert.ok((request["timeout-minutes"] ?? 0) * 60 >= 14400, "the step may run as long as the approval wait");
  assert.ok((sign["timeout-minutes"] ?? 0) >= (request["timeout-minutes"] ?? 0), "the job outlives the step");
  const verify = stepNamed(sign, /verify/iu);
  assert.match(verify.run ?? "", /"\$RUNNER_TEMP"\/signed\/MineAI-Setup-\*\.exe/u);
  assert.match(verify.run ?? "", /verify \/pa \/v/u);
  assert.match(verify.run ?? "", /grep -q "Issued to: SignPath Foundation"/u);
  const signed = stepUsing(sign, "actions/upload-artifact");
  assertV4OrLater(signed);
  assert.equal(signed.with?.name, "signed-setup");
  assert.equal(signed.with?.path, "${{ runner.temp }}\\signed\\MineAI-Setup-*.exe");
  assert.equal(signed.with?.["if-no-files-found"], "error");

  const download = stepUsing(release, "actions/download-artifact");
  assertV4OrLater(download);
  assert.match(String(download.with?.name), /needs\.sign\.result == 'success'.*signed-setup.*unsigned-setup/u);
  assert.equal(download.with?.path, "${{ runner.temp }}/release");
});

test("the release is a draft of the downloaded files, says signed only when sign succeeded, refuses a second release, and never overwrites", () => {
  assert.equal(release.env?.SIGNED, "${{ needs.sign.result == 'success' }}");
  assert.equal(release.env?.GH_REPO, "${{ github.repository }}");
  assert.equal(release.env?.VERSION, "${{ needs.build.outputs.version }}");
  const notes = stepNamed(release, /checksum and release notes/iu).run ?? "";
  assert.match(notes, /cd "\$RUNNER_TEMP\/release"/u);
  assert.match(notes, /sha256sum "\$setup" > "\$setup\.sha256"/u);
  assert.match(notes, /if \[ "\$SIGNED" = "true" \]; then[\s\S]*signed by SignPath Foundation[\s\S]*else[\s\S]*unsigned[\s\S]*This build is not signed yet\./u);
  const refusal = stepNamed(release, /refuse a second release/iu);
  assert.match(refusal.run ?? "", /gh api "repos\/\$GITHUB_REPOSITORY\/releases" --paginate --jq '[^']*select\(\.tag_name == \$ENV\.GITHUB_REF_NAME\)/u);
  assert.match(refusal.run ?? "", /exit 1/u);
  const createAt = release.steps.findIndex((step) => /gh release create/u.test(step.run ?? ""));
  assert.ok(createAt > release.steps.indexOf(refusal), "the drafts-included check comes before the create (gh release view does not see drafts)");
  const create = release.steps[createAt] as Step;
  assert.match(create.run ?? "", /gh release create "\$GITHUB_REF_NAME" --draft --verify-tag /u);
  assert.match(create.run ?? "", /--notes-file "\$RUNNER_TEMP\/release-notes\.md" "\$setup" "\$setup\.sha256" release\.txt/u);
  assert.equal(create.env?.GH_TOKEN, "${{ github.token }}");
  assert.equal(refusal.env?.GH_TOKEN, "${{ github.token }}");
  assert.doesNotMatch(workflowText, /--prerelease|--clobber|release upload/u);
});

test("runner setup: Git Bash without path conversion, one concurrency group per ref, a timeout on every job and step, Inno 6.7.3 pinned by SHA-256", () => {
  assert.equal(workflow.env.MSYS_NO_PATHCONV, "1");
  assert.equal(workflow.defaults.run.shell, "bash");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.concurrency.group, "release-${{ github.ref_name }}");
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    assert.ok(job["timeout-minutes"], `job ${jobName} has a timeout`);
    for (const step of job.steps) assert.ok(step["timeout-minutes"], `${jobName}: step ${label(step)} has a timeout-minutes`);
  }
  const install = stepNamed(build, /install inno/iu);
  assert.equal(install["timeout-minutes"], 10);
  assert.equal(stepNamed(build, /build the setup/iu)["timeout-minutes"], 60);
  assert.match(workflow.env.INNO_URL ?? "", /innosetup-6\.7\.3\.exe$/u);
  assert.match(workflow.env.INNO_SHA256 ?? "", /^[0-9a-f]{64}$/u);
  assert.match(install.run ?? "", /sha256sum -c/u);
  assert.match(install.run ?? "", /\/VERYSILENT \/SUPPRESSMSGBOXES \/NORESTART \/CURRENTUSER/u);
  assert.match(install.run ?? "", /\/DIR=\$\{RUNNER_TEMP\}/u);
  assert.match(install.run ?? "", /INNO_SETUP=.*>> "\$GITHUB_ENV"/u);
  assert.doesNotMatch(allSteps.map((step) => step.run ?? "").join("\n"), /--sign-command/u);
  for (const step of allSteps) {
    if (typeof step.with?.path === "string") assert.match(step.with.path, /^\$\{\{ runner\.temp \}\}/u, `path of ${label(step)}`);
  }
});

test("the tag guard accepts pre-alpha-X.Y.Z and refuses everything else", () => {
  const guard = stepNamed(build, /guard/iu);
  assert.equal(guard.if, "github.ref_type == 'tag'");
  const source = /=~ (\^pre-alpha-\([^ ]+\)\$) \]\]/u.exec(guard.run ?? "")?.[1];
  assert.ok(source, "the guard compares GITHUB_REF_NAME with a regex");
  const pattern = new RegExp(source, "u");
  for (const accepted of ["pre-alpha-0.2.0", "pre-alpha-0.10.0", "pre-alpha-12.0.1"]) assert.ok(pattern.test(accepted), accepted);
  for (const refused of ["v0.2.0", "pre-alpha-0.2", "pre-alpha-0.2.0-rc1", "main", "pre-alpha-", "xpre-alpha-0.2.0", "pre-alpha-0.2.0\n"]) {
    assert.equal(pattern.test(refused), false, refused);
  }
  assert.match(guard.run ?? "", /release-windows: tag '\$GITHUB_REF_NAME' is not pre-alpha-X\.Y\.Z\./u);
  assert.match(guard.run ?? "", /exit 1/u);
});

test("the version is the tag's on a tag run and the manifest's on a branch run, read after Bun is installed", () => {
  const guard = stepNamed(build, /guard/iu);
  assert.match(guard.run ?? "", /echo "version=\$\{BASH_REMATCH\[1\]\}" >> "\$GITHUB_OUTPUT"/u);
  assert.match(guard.run ?? "", /echo "tagged=true" >> "\$GITHUB_OUTPUT"/u);
  const manifestStep = stepNamed(build, /manifest/iu);
  assert.equal(manifestStep.if, "github.ref_type != 'tag'");
  assert.match(manifestStep.run ?? "", /bun -e/u);
  assert.match(manifestStep.run ?? "", /packaging\/manifest\.json/u);
  assert.match(manifestStep.run ?? "", /echo "version=\$version" >> "\$GITHUB_OUTPUT"/u);
  assert.ok(build.steps.indexOf(manifestStep) > build.steps.indexOf(stepUsing(build, "oven-sh/setup-bun")));
  assert.equal(build.outputs?.version, "${{ steps.guard.outputs.version || steps.manifest.outputs.version }}");
  assert.equal(build.outputs?.tagged, "${{ steps.guard.outputs.tagged || 'false' }}");
  assert.equal(stepNamed(build, /build the setup/iu).env?.VERSION, "${{ steps.guard.outputs.version || steps.manifest.outputs.version }}");
});

test("untrusted input never sits inside a run script: every ${{ }} reaches a script through env", () => {
  for (const step of allSteps) assert.doesNotMatch(step.run ?? "", /\$\{\{/u, `run of ${label(step)}`);
});
