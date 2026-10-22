# agent-progress

A Claude Code mod modelled on johnnyvizz/claude-kit `savvy-progress` 1.2.1, rewritten for general use.

- **Band above the prompt**: the plan's title, a progress bar, the phase and accepted tasks out of planned, a button that opens the agents pane, and a dismiss. It appears once the main session reports a plan.
- **Agents pane** (`/agents-info` toggles it; `/agents-info open` opens it without toggling): running, finished and planned subagents with model, effort, self-reported steps, context fill, estimated cost and elapsed time.

## Tools it adds

- `mcp__agent-progress__progress`: the main session reports the plan, phase and accepted tasks. A call from a subagent is ignored.
- `mcp__agent-progress__step`: a subagent reports its own steps. While a plan is live, each new subagent's brief gets one line asking for these reports.

## Differences from savvy-progress

- Works with any subagent type; it is not tied to the savvy-flow skill or its five tiers.
- Text drawing on every surface; no SVG artwork, crab costumes or animation.
- English only.

## Settings

`autoOpen`: `plan` (default) opens the pane when a plan is reported; `any` also opens it once per session when any subagent starts.

## Cost

Cost is an estimate from token counts and the price table in `hooks/register.tsx`, copied from savvy-progress (list prices as of 2026-10-10) and not checked against Anthropic's published prices. It is not a bill.
