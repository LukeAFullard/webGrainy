/**
 * The GitHub Pages workflow must actually deploy (production readiness review B1).
 *
 * `ci` runs only on a manual dispatch, so it is skipped on every push to main (workflow_run).
 * A job's implicit `if: success()` also fails when any job it depends on, directly or
 * indirectly, was skipped: every job downstream of `ci` therefore needs its own
 * `!cancelled()` condition. Without it the deploy job was skipped while the run showed green,
 * and the site stayed on an old build.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');

/** The lines of one top-level job (two-space indented key under `jobs:`). */
function jobBlock(name: string): string {
  const lines = workflow.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  expect(start, `job "${name}" not found in pages.yml`).toBeGreaterThan(-1);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i]!) || /^\S/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

describe('Pages deploy workflow', () => {
  it('ci runs only on manual dispatch (so it is skipped on pushes to main)', () => {
    expect(jobBlock('ci')).toMatch(/if: github\.event_name == 'workflow_dispatch'/);
  });

  it('build depends on ci and overrides the skipped-dependency rule', () => {
    const build = jobBlock('build');
    expect(build).toMatch(/needs: ci/);
    expect(build).toMatch(/!cancelled\(\)/);
  });

  it('deploy runs whenever build succeeded, even though ci was skipped', () => {
    const deploy = jobBlock('deploy');
    expect(deploy).toMatch(/needs: build/);
    expect(deploy).toContain("if: ${{ !cancelled() && needs.build.result == 'success' }}");
  });

  it('every job downstream of ci states its own condition', () => {
    const jobs = [...workflow.matchAll(/^ {2}([a-z][\w-]*):$/gm)].map((m) => m[1]!);
    const needs = new Map(jobs.map((j) => [j, jobBlock(j).match(/^ {4}needs: \[?([\w, -]+)\]?$/m)?.[1]?.split(/,\s*/) ?? []]));
    const dependsOnCi = (j: string, seen = new Set<string>()): boolean =>
      (needs.get(j) ?? []).some((n) => n === 'ci' || (!seen.has(n) && (seen.add(n), dependsOnCi(n, seen))));
    const downstream = jobs.filter((j) => dependsOnCi(j));
    expect(downstream.sort()).toEqual(['build', 'deploy']);
    for (const j of downstream) expect(jobBlock(j), j).toMatch(/if: [\s\S]*!cancelled\(\)/);
  });
});
