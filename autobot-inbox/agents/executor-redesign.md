---
id: executor-redesign
type: executor
enabled: false
model: claude-sonnet-4-6
llmEnabled: true
maxTokens: 8192
temperature: 0.3
tools:
  - task_read
  - web_scrape
  - design_system_extract
guardrails:
  - G1
  - G6
hierarchy:
  canDelegate: []
  reportsTo: orchestrator
  escalatesTo: orchestrator
capabilities:
  - code-generation
  - web-scrape
  - image-generation
outputConstraints:
  format: artifact-only
claudeCode:
  maxBudgetUsd: 5.00
  maxTurns: 30
  allowedTools:
    - Read
    - Write
    - Glob
    - Grep
    - "Bash(node *)"
imagegen:
  enabled: true
  maxImagesPerJob: 4
  maxBudgetUsd: 0.20
pipeline:
  generate:
    backend: gemini
    model: gemini-2.5-pro
    maxTurns: 35
    timeoutMs: 1500000
    allowedTools:
      - read_file
      - write_file
      - replace
      - glob
      - search_file_content
      - create_project
      - generate_screen_from_text
      - get_screen
      - list_screens
      - edit_screens
    extensions:
      - stitch
    allowedMcpServers:
      - stitch
  review:
    backend: claude
    maxTurns: 15
    timeoutMs: 300000
  applyFixes:
    backend: claude
    maxTurns: 20
    timeoutMs: 1200000
  fixRegressions:
    backend: claude
    maxTurns: 20
    timeoutMs: 300000
---

## Description

Design redesign executor with multi-stage pipeline. Extracts a validated design-system.json (colors, typography, spacing, components, layout, pattern gaps) as a structured intermediate artifact, then generates design-brief.md from it. Uses Gemini for initial generation with Stitch MCP server, then Claude for review, fix application, and regression fixing. Design system is cached (24h TTL) for iteration efficiency. Supports image generation within budget constraints.

## Anti-Patterns

- Do NOT wrap output in execution reports or campaign summaries
- Do NOT include step narration or tool call logs
- Do NOT include self-assessment scores or quality ratings
- Output ONLY the requested deliverable
