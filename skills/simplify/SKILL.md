---
name: simplify
description: Post-implementation cleanup. Reviews recent code changes with parallel sub-agents (reuse, quality, efficiency), aggregates findings, and applies worthwhile fixes. Use after finishing a feature, before opening a PR. Requires the spawn_agent tool from pi-spawn-agents.
---

# Simplify

Post-implementation review and cleanup using parallel sub-agents.

## When to Use

- After finishing a feature implementation
- After a bug fix, before committing
- After prototyping code you want to keep
- Before opening a PR

## How It Works

1. Get the diff of recent changes
2. Spawn 3 parallel review agents, each with a different focus
3. Aggregate their findings
4. Apply only the changes that genuinely improve the code
5. Summarize what was changed

## Instructions

### Step 1: Get the diff

Run `git diff` to capture uncommitted changes. If there are no uncommitted changes, use `git diff HEAD~1` to review the last commit. If the user provided a focus hint (e.g., `/skill:simplify focus on the scraper module`), note it for the reviewers.

Store the full diff output — you'll pass it as context to each reviewer.

### Step 2: Spawn reviewers

Use `spawn_agent` with 3 parallel agents. Pass the diff as `context` to each one.

```
spawn_agent(agents: [
  { prompt: <REUSE_PROMPT>, context: <diff> },
  { prompt: <QUALITY_PROMPT>, context: <diff> },
  { prompt: <EFFICIENCY_PROMPT>, context: <diff> }
])
```

Use these reviewer prompts:

**Reuse reviewer:**
```
You are reviewing a code diff for code reuse opportunities. Your job is to find places where:

- New code duplicates existing utilities, helpers, or patterns already in the codebase
- The same logic appears in multiple places in the diff and could be extracted
- Hand-rolled implementations exist where a standard library function or existing helper would work
- Similar patterns are repeated with minor variations that could be unified

For each finding, specify:
- The file and approximate location
- What the current code does
- What it should use instead (be specific — name the existing function, module, or pattern)
- Why this matters (not just "DRY" — explain the concrete benefit)

Only report findings you're confident about. If you need to check whether a utility exists, use the read tool to look. Do NOT suggest creating new abstractions just for the sake of it — only flag reuse of things that already exist or clear duplication within the diff.

If you find nothing worth flagging, say so. An empty report is better than noise.
```

**Quality reviewer:**
```
You are reviewing a code diff for code quality issues. Your job is to find:

- Redundant or unnecessary state (variables that could be derived, flags that duplicate other conditions)
- Functions with too many parameters that should use an options object or be split
- Copy-paste code within the diff that should be a shared function
- Leaky abstractions (implementation details exposed where they shouldn't be)
- Stringly-typed code that should use enums, constants, or typed objects
- Poor naming that obscures intent
- Missing or incorrect error handling
- Overly complex logic that could be simplified without changing behavior

For each finding, specify:
- The file and approximate location
- What the issue is
- A concrete suggestion for fixing it (not vague — show what the code should look like)
- Whether it's a real problem or a style preference (be honest)

Do NOT flag:
- Formatting or whitespace issues (that's what formatters are for)
- Minor naming preferences that don't affect clarity
- "I would have done it differently" opinions that aren't objectively better

If you find nothing worth flagging, say so.
```

**Efficiency reviewer:**
```
You are reviewing a code diff for efficiency issues. Your job is to find:

- Unnecessary work: redundant iterations, repeated computations that could be cached, O(n²) where O(n) is possible
- Missed concurrency: independent async operations that run sequentially but could be parallelized
- Hot-path bloat: heavy operations (logging, serialization, allocation) in tight loops or frequently-called paths
- Resource leaks: unclosed handles, missing cleanup, connections that aren't released
- TOCTOU patterns: check-then-act where the state could change between check and act
- Unnecessary memory copies or allocations

For each finding, specify:
- The file and approximate location
- What the performance issue is
- The concrete fix (not "optimize this" — show what should change)
- Whether it matters in practice (a micro-optimization in cold code isn't worth the complexity)

Do NOT flag:
- Premature optimization opportunities that would make code harder to read for negligible gain
- Theoretical issues that won't manifest at the actual scale of this code
- "Use a more efficient data structure" when the dataset is always small

If you find nothing worth flagging, say so.
```

### Step 3: Aggregate and filter

Read all 3 reviewer outputs. For each finding, decide:

- **Apply** — the suggestion is correct, improves the code, and doesn't add unnecessary complexity
- **Skip** — the suggestion is technically valid but would over-engineer, is a style preference, or the benefit doesn't justify the change

Be opinionated. The goal is to make the code genuinely better, not to satisfy every reviewer. If a suggestion would make the code harder to read for a marginal improvement, skip it.

### Step 4: Apply fixes

For each finding you decided to apply, make the edit using your normal edit tools. Work through them one at a time.

### Step 5: Summarize

Tell the user:
- How many findings each reviewer reported
- How many you applied vs skipped (and briefly why you skipped the ones you skipped)
- What changed (list each applied fix in one line)

If you applied nothing, say so — "all 3 reviewers came back clean" or "found 4 suggestions but none were worth the complexity" is a valid outcome.
