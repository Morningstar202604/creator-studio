---
name: Bug report
about: Something behaves differently from what the documentation says
title: '[bug] '
labels: bug
assignees: ''
---

## What happened

<!-- One sentence. "Pressing X on page Y does Z." -->

## What you expected

<!-- The documentation says it should... -->

## Steps to reproduce

1.
2.
3.

## Environment

| | |
|---|---|
| Creator Studio version | <!-- Settings → About, or `node apps/cli/dist/main.js health` --> |
| Install type | desktop installer / browser + local daemon / CLI only |
| OS | |
| Node version | <!-- `node -v`, only matters for the daemon --> |
| Model provider | <!-- OpenAI-compatible / Anthropic / local / none --> |

## Evidence

<!-- Console output, the daemon log tail, a screenshot. Redact API keys. -->

```
```

## Does it reproduce without a model configured?

<!-- Many failures are model-output problems. If the page works with no key set,
     say so — it narrows the cause immediately. -->
