---
title: "ADR-018: JWT Agent Identity — Board Mandate"
description: "Board reverses ADR-015 deferral. JWT-scoped agent identity required for Phase 1 exit."
---

# ADR-018: JWT Agent Identity — Board Mandate

**Date**: 2026-03-07
**Status**: Accepted
**Supersedes**: ADR-015 (JWT Deferral to Phase 2)

## Context

ADR-015 deferred JWT-scoped agent identity to Phase 2, accepting HMAC-signed claims + application-layer session vars as sufficient for Phase 1's threat model.

During the Phase 1 exit audit (2026-03-07), the board (Eric + Dustin) reviewed the deferral and reversed it. The reasoning:

1. **New contributors joining this week** — the single-process, two-person trust assumption no longer holds
2. **Railway deployment tonight** — agents will run on shared infrastructure, not localhost
3. **Spec compliance** — the spec says "JWT identity" and the board wants literal compliance, not equivalent enforcement
4. **Principle alignment** — P2 (infrastructure enforces; prompts advise) demands cryptographic identity, not application-layer identity

## Decision

Implement JWT-scoped agent identity before Phase 1 formally exits.

### Implementation Scope

1. **JWT issuer** — sign agent tokens at process startup with RS256 (reuse the GitHub App PEM key or generate a dedicated signing key)
2. **Token claims** — `{ agent_id, tier, allowed_tools, iat, exp }` per spec §5
3. **Short-lived tokens** — 15-minute TTL, auto-refresh in AgentLoop
4. **DB connection scoping** — each agent's token sets `app.agent_id` via `withAgentScope()` (already implemented) but now validated against the JWT signature
5. **RLS activation** — connect as `autobot_agent` role (defined in seed, not yet used) with RLS policies enforced
6. **Audit log binding** — `state_transitions.agent_id` becomes JWT-verified, not just a string

### Out of Scope (Phase 2)

- Per-agent DB roles (one role per agent, not one shared `autobot_agent` role)
- Token revocation list (kill switch is sufficient for Phase 1)
- External JWT verification (no agents call external APIs with JWT yet)

### Trigger from ADR-015 Met

Conditions 1 and 3 from ADR-015 are now met:
- **Multi-contributor**: New contributors joining this week
- **Network-exposed**: Railway deployment exposes the API port

## Consequences

- ADR-015 is superseded — JWT is no longer deferred
- `AGENT_SIGNING_KEY` env var required (or reuse GitHub App PEM)
- AgentLoop must acquire and refresh JWT tokens
- `withAgentScope()` validates JWT signature before setting session var
- RLS policies become runtime enforcement, not just schema documentation
- Connection pool must support the `autobot_agent` role (Railway Postgres)
