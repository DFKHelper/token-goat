/**
 * `runner`, `steps` and `job` do not exist outside a step. Name one of them anywhere else in a job
 * and GitHub rejects the entire workflow file: not the job, the file. Run 34409126289 set
 * `TOKEN_GOAT_MODEL_CACHE_DIR: ${{ runner.temp }}/tg-model-cache` in a job-level `env:` block and
 * created zero jobs, so nothing lint, typecheck, the full suite or the pre-push hook had already
 * said counted for anything. The same expression one level down, in a step's `with:`, is correct,
 * which is what makes this easy to write and impossible to see: the file parses as YAML, the
 * expression is well-formed, and the only complaint arrives after a push.
 *
 * This is what the two sibling workflow guards do not cover. `workflow_actions_pinned` reads
 * `uses:` and `workflow_permissions` reads `permissions:`; both are content checks on a file they
 * assume GitHub will accept.
 *
 * PROVENANCE: FORMAT-DERIVED, from the context availability table in GitHub's contexts reference
 * (https://docs.github.com/en/actions/reference/contexts-reference), which allows `github`,
 * `needs`, `strategy`, `matrix`, `vars`, `inputs` and `secrets` in `jobs.<job_id>.env` and only
 * `github`, `needs`, `vars` and `inputs` in `jobs.<job_id>.if`. It is FORMAT-DERIVED and not
 * CAPTURE because it is read off the documentation rather than off a rejection message, so it
 * proves agreement with the documented table; the rejection it was written from is cited above.
 * The table is also why this checks two keys and not every job-level key: see the note on
 * `environment.url` at the function below.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

import { pinnedPopulation } from "./population.js";

const workflowDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".github",
  "workflows",
);

/** Unavailable in the two job-level positions checked below, per the availability table cited above. */
const STEP_ONLY_CONTEXTS = ["runner", "steps", "job"] as const;

function workflowFiles(): string[] {
  // Pinned for the same reason the sibling guards pin: a renamed directory would empty the sweep and every assertion below would pass against nothing.
  return [
    ...pinnedPopulation({
      what: ".github/workflows/*.yml files",
      items: fs
        .readdirSync(workflowDir)
        .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")),
      floor: 3,
      mustInclude: ["ci.yml", "publish.yml"],
    }),
  ];
}

/** Every `${{ ... }}` expression in a value, however deeply nested, paired with the path it sits at. */
function expressionsUnder(
  value: unknown,
  at: string,
): Array<{ at: string; expression: string }> {
  if (typeof value === "string") {
    return [...value.matchAll(/\$\{\{([^}]*)\}\}/g)].map((m) => ({
      at,
      expression: m[1] ?? "",
    }));
  }
  if (Array.isArray(value))
    return value.flatMap((v, i) => expressionsUnder(v, `${at}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) =>
      expressionsUnder(v, `${at}.${k}`),
    );
  }
  return [];
}

/**
 * Job-level offenders, checked only in `env` and `if`.
 *
 * A first draft swept every job-level key and flagged `pages.yml`, whose `deploy.environment.url`
 * is `${{ steps.deployment.outputs.page_url }}`: the canonical Pages pattern, which runs. The
 * availability table gives `jobs.<job_id>.environment.url` its own row allowing `steps`, `runner`
 * and `job`, so a sweep of everything-but-steps is not the rule. These two positions are.
 */
function stepOnlyContextsOutsideSteps(source: string, label: string): string[] {
  const doc = loadYaml(source) as {
    jobs?: Record<string, Record<string, unknown>>;
  };
  const found: string[] = [];
  const file = label;
  for (const [jobId, job] of Object.entries(doc.jobs ?? {})) {
    for (const [key, value] of Object.entries(job)) {
      if (key !== "env" && key !== "if") continue;
      for (const { at, expression } of expressionsUnder(
        value,
        `${jobId}.${key}`,
      )) {
        for (const context of STEP_ONLY_CONTEXTS) {
          // Word-bounded so a key named `runner-label` or a string mentioning steps does not read as a context reference.
          if (new RegExp(`(^|[^\\w.-])${context}\\.`).test(expression)) {
            found.push(
              `${file}: ${at} uses \`${context}\` in \`\${{${expression}}}\``,
            );
          }
        }
      }
    }
  }
  return found;
}

describe("workflow files only name step-scoped contexts inside steps", () => {
  const files = workflowFiles();

  it("finds the workflow files at all, so an empty sweep cannot pass as a clean one", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it.each(files.map((f) => [f]))(
    "%s keeps runner, steps and job out of its job-level env and if",
    (file) => {
      const offenders = stepOnlyContextsOutsideSteps(
        fs.readFileSync(path.join(workflowDir, file), "utf8"),
        file,
      );

      expect(
        offenders,
        `${offenders.join("; ")}. GitHub rejects the whole workflow file for this, creating zero jobs, so no later ` +
          `check reports anything. Move the value into a step: for an environment variable, echo it into $GITHUB_ENV ` +
          `from a step, which reaches every step after it in the same job.`,
      ).toEqual([]);
    },
  );

  // The positive control, run through the same function the real files go through. Without it a walker that never
  // descends, or a pattern that never matches, reads exactly like a clean sweep: which is the failure mode this
  // guard exists to catch one level up.
  //
  // PROVENANCE: HAND-DERIVED. The offending document is the shape run 34409126289 was rejected for, reduced to the
  // three positions that matter, and the expected verdict is computed from the availability table, not from this
  // function's own output.
  it("reports a job-level runner reference, and does not report the same expression inside a step", () => {
    const rejected = [
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    env:",
      "      CACHE: ${{ runner.temp }}/tg-model-cache",
      "    steps:",
      "      - uses: actions/cache/restore@v6",
      "        with:",
      "          path: ${{ runner.temp }}/tg-model-cache",
      "          key: k-${{ runner.os }}",
      "      - if: steps.earlier.outputs.ok == 'true'",
      "        run: echo fine",
      "",
    ].join("\n");

    expect(stepOnlyContextsOutsideSteps(rejected, "rejected.yml")).toEqual([
      "rejected.yml: build.env.CACHE uses `runner` in `${{ runner.temp }}`",
    ]);

    const accepted = rejected.replace(
      "      CACHE: ${{ runner.temp }}/tg-model-cache\n",
      "      CACHE: fixed\n",
    );
    expect(stepOnlyContextsOutsideSteps(accepted, "accepted.yml")).toEqual([]);
  });

  it("does not mistake a job-level value that merely contains the word for a context reference", () => {
    const innocent = [
      "jobs:",
      "  build:",
      "    runs-on: ${{ matrix.runner-label }}",
      "    steps:",
      "      - run: x",
      "",
    ].join("\n");

    expect(stepOnlyContextsOutsideSteps(innocent, "innocent.yml")).toEqual([]);
  });
});
