# thUMBox Platform — Addendum: Optimus Brain Plugin Dashboard Architecture

> **Target spec version:** v2.1
> **Addendum started:** 2026-04-05
> **Last updated:** 2026-04-05
> **Status:** ACCUMULATING
> **Author:** Dustin (UMB Group)
> **For:** Board review
> **How to use:** Each section references the spec section it modifies or introduces.
>   When ready to merge, apply each section to the corresponding
>   location in the Technical PRD and Business PRD. This addendum replaces
>   the fixed-page dashboard design in §7 (Technical PRD) with a plugin-host
>   workspace architecture, and unifies the Optimus Brain dashboard concept
>   across thUMBox appliance customers and UMB Group's internal operational
>   dashboard into a single codebase with permission-gated views.

---

## Change Log

| Date | Section | Summary |
|------|---------|---------|
| 2026-04-05 | §7 (REPLACE) | Replace Optimus Brain dashboard specification with plugin-host workspace architecture |
| 2026-04-05 | §7.1 (REPLACE) | New concept: unified plugin shell with subscription-tier-gated plugins |
| 2026-04-05 | §7.2 (AMEND) | Add dashboard plugin shell to service topology, replace fixed dashboard container |
| 2026-04-05 | §7.3 (REPLACE) | New design principles for plugin architecture |
| 2026-04-05 | §7.4 (NEW) | Plugin API specification |
| 2026-04-05 | §7.5 (NEW) | Data provider layer |
| 2026-04-05 | §7.6 (NEW) | Core plugin registry — Phase 1 plugins |
| 2026-04-05 | §7.7 (NEW) | Workspace presets |
| 2026-04-05 | §7.8 (NEW) | Plugin integrity model |
| 2026-04-05 | §7.9 (NEW) | Permission model — unified access tiers |
| 2026-04-05 | §1.6 (AMEND) | Update dashboard functional requirements for plugin architecture |
| 2026-04-05 | Business PRD §7.2 (AMEND) | Access tier table updated for plugin-level gating |
| 2026-04-05 | DR-12 (NEW) | Decision record: Plugin-host workspace vs. fixed-page dashboard |
| 2026-04-05 | DR-13 (NEW) | Decision record: Unified codebase (customer + internal) vs. separate dashboards |

---

## Strategic Rationale

The current spec defines the Optimus Brain dashboard (Technical PRD §7) as a fixed-page web application with predefined sections: approval queue, sent history, classification log, knowledge base management, persona settings, learning, system status. The Business PRD §7.2 gates features per subscription tier by showing or hiding entire pages.

Meanwhile, UMB Group needs its own internal operational dashboard for fleet monitoring, support triage, aggregate analytics, and OTA deployment management. Building two separate dashboard codebases — one customer-facing, one internal — doubles frontend development and maintenance costs.

**This addendum proposes a single architectural change that solves both problems:**

Build the Optimus Brain as a **plugin-host workspace** — a minimal shell with a composable plugin API. Every view (approval queue, cost tracker, classification analytics, system status, fleet monitor) is a plugin. Subscription tiers and user roles determine which plugins are available. The same shell serves the customer on their appliance and UMB Group operators in a fleet management context.

**Why this matters now (not later):**

The current Phase 1 spec (Technical PRD §14) includes "dashboard with approval queue" as deliverable 6. Building it as a fixed page is faster by ~3–4 days. But every Phase 2 and Phase 3 dashboard change — learning tab, relationship graph explorer, cross-pack insights, fleet management, OpenClaw approval TUI — becomes a rework of a monolith instead of a new plugin. The 3–4 day premium pays for itself before Phase 2 starts.

---

## §7. Optimus Brain Dashboard (REPLACE)

> **Source:** Optimus dashboard plugin architecture analysis, 2026-04-05
> **Spec section affected:** §7 (full section)
> **Change type:** REPLACE

### §7.1 Concept (REPLACE)

The **Optimus Brain** is a plugin-host workspace — a minimal shell with a composable plugin API and typed data provider layer. Every view is a plugin. Users arrange their workspace to match their role. The plugin registry controls which plugins are available based on subscription tier and user role.

```
┌─────────────────────────────────────────────────────────┐
│  SHELL (layout engine, plugin lifecycle, auth)          │
│                                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │ Plugin A │ │ Plugin B │ │ Plugin C │ │ Plugin D │  │
│  │ Approval │ │ Classif. │ │ System   │ │ Learning │  │
│  │ Queue    │ │ Analytics│ │ Status   │ │ Tab      │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘  │
│       │             │            │             │        │
│  ┌────┴─────────────┴────────────┴─────────────┴────┐  │
│  │          DATA PROVIDER LAYER (read-only*)         │  │
│  │  useApprovalQueue() · useClassifications()        │  │
│  │  useSkills() · useSystemStatus() · useContacts()  │  │
│  │  useCostData() · useEmailVolume()                 │  │
│  └───────────────────┬───────────────────────────────┘  │
│                      │                                   │
└──────────────────────┼───────────────────────────────────┘
                       │ REST API + WebSocket (local)
                       ▼
              ┌─────────────────┐
              │  Postgres +     │
              │  Qdrant +       │
              │  SQLite (graph) │
              └─────────────────┘
```

*\* Read-only for observation plugins. Action plugins (approval queue, skill review) use write-capable endpoints gated by authentication and role.*

**What each layer does:**

| Layer | Responsibility | Implementation |
|-------|---------------|----------------|
| **Shell** | Layout persistence (workspaces), plugin lifecycle (load/unload/configure), authentication, command palette, mobile-responsive container | Next.js app shell + `react-grid-layout` (MIT) + `cmdk` (MIT) |
| **Plugin API** | Standard interface plugins implement: `register()`, `onActivate()`, `onDeactivate()`, declared data dependencies, render target, required permission tier | Module registry pattern |
| **Data Providers** | Typed React hooks abstracting Postgres/Qdrant/SQLite queries. Observation plugins use read-only hooks. Action plugins use write-capable hooks gated by auth. | REST + WebSocket subscriptions from local API server |
| **Plugins** | Self-contained React components. Each renders into a pane the user can drag, resize, and stack. | Composable view modules |

**Key architectural distinction:** The dashboard shell and plugin API are the **same codebase** whether running on a customer's appliance (served from `http://device.local:3000`) or in UMB Group's fleet management context. The difference is which plugins are available and what data providers they connect to:

| Context | Data Source | Available Plugins | Auth |
|---------|-----------|-------------------|------|
| Customer appliance (LAN) | Local Postgres, Qdrant, SQLite | Subscription-tier-gated customer plugins | Local username + password (FR-26) |
| UMB Group fleet dashboard | Aggregated telemetry from opt-in appliances (Enterprise tier) | Internal fleet plugins + all customer plugins | UMB Group SSO |

### §7.2 Service Topology (AMEND)

> **Source:** Plugin architecture analysis, 2026-04-05
> **Spec section affected:** Technical PRD §4.2
> **Change type:** AMEND — replace `dashboard` service definition

Replace the existing dashboard service entry in the Docker Compose topology:

| Service | Image | Port | Purpose | Resource Allocation |
|---------|-------|------|---------|-------------------|
| `optimus-brain` | Custom (Next.js) | 3000 | Plugin-host dashboard shell — serves customer-facing workspace with subscription-tier-gated plugins | ~256MB RAM |

The service name changes from `dashboard` to `optimus-brain` to align with the platform branding. The image is a Next.js application (replacing the previous Node.js/React specification). Resource allocation is unchanged.

### §7.3 Design Principles (REPLACE)

| # | Principle | Implementation |
|---|-----------|----------------|
| P1 | **Progressive disclosure** | Community tier sees system status only. Each subscription tier reveals more plugins. No tier sees plugins they can't use — they don't appear in the sidebar. |
| P2 | **Read-only by default** | Data providers are read-only. Action capabilities (approve draft, activate skill, retire skill) are explicit write endpoints with auth checks. A plugin cannot write to the knowledge base even if it tries. |
| P3 | **Cross-pack unification** | One approval queue plugin for all packs. One contact graph plugin. One skills library plugin. Packs are filter dimensions, not separate dashboards. |
| P4 | **Action-oriented** | Every analytics view has a "so what?" — suggested next actions, not just charts. The classification analytics plugin highlights categories with declining accuracy and links to the relevant few-shot examples. |
| P5 | **Local-first** | Dashboard served from the appliance's Next.js instance. No cloud dependency for core functions. Workspace layouts stored in local Postgres. |
| P6 | **Mobile-first interaction** | The approval queue is the primary interaction surface. It must be fully usable at 375px viewport width. Analytics plugins degrade gracefully on mobile but are designed for desktop. |
| P7 | **Boring infrastructure** | Next.js, Tailwind, `react-grid-layout` (MIT), `cmdk` (MIT), `recharts` (MIT). No custom rendering engine. No AGPL dependencies. |

### §7.4 Plugin API (NEW)

#### Plugin Lifecycle

```
1. REGISTER   — Plugin provides manifest (id, name, version, data dependencies,
                default size, category, required tier)
2. ACTIVATE   — Shell calls onActivate(), plugin subscribes to data providers
3. RENDER     — Plugin renders into its assigned pane
4. CONFIGURE  — User can pass settings to plugin (time window, filters, etc.)
5. DEACTIVATE — Shell calls onDeactivate(), plugin unsubscribes, cleans up
```

#### Plugin Manifest Schema

```typescript
interface PluginManifest {
  id: string;                    // e.g., 'optimus.approval-queue'
  name: string;                  // e.g., 'Approval Queue'
  version: string;               // semver
  category: 'workflow' | 'analytics' | 'system' | 'knowledge' | 'fleet' | 'openclaw';
  requiredTier: 'community' | 'base' | 'plus' | 'pro' | 'enterprise' | 'internal';
  dataDependencies: string[];    // e.g., ['drafts', 'classifications']
  writeCapabilities?: string[];  // e.g., ['drafts.approve', 'skills.activate']
  defaultSize: { width: number; height: number };  // grid units
  mobileSupported: boolean;      // if true, renders in mobile layout
  configSchema?: Record<string, ConfigField>;
}
```

The `requiredTier` field is the gating mechanism. The shell evaluates the authenticated user's subscription tier against each registered plugin's `requiredTier` at activation time. Plugins for higher tiers are not loaded, not hidden — they don't exist in the plugin registry for that user.

The `internal` tier is reserved for UMB Group fleet management plugins. These are never available on customer appliances.

#### Plugin Implementation Contract

```typescript
interface OptimusPlugin {
  manifest: PluginManifest;
  component: React.ComponentType<PluginProps>;
  onActivate?: (context: PluginContext) => void;
  onDeactivate?: () => void;
}

interface PluginProps {
  config: Record<string, unknown>;
  size: { width: number; height: number };
}

interface PluginContext {
  subscribe: (provider: string) => Unsubscribe;
  getConfig: () => Record<string, unknown>;
  tier: SubscriptionTier;
}
```

### §7.5 Data Provider Layer (NEW)

Data providers are typed React hooks that abstract the underlying data stores. They enforce read-only access for observation and explicit write-capable endpoints for actions.

#### Provider Registry

| Provider | Hook | Data Source | Read/Write | Used By |
|----------|------|-----------|------------|---------|
| `drafts` | `useApprovalQueue()` | Postgres (approval queue) | Read + Write (approve/reject/edit) | Approval Queue plugin |
| `classifications` | `useClassifications()` | Postgres (classification log) | Read-only | Classification Analytics plugin |
| `skills` | `useSkills()` | Postgres (skills table) | Read + Write (activate/reject/retire) | Learning plugin |
| `system` | `useSystemStatus()` | Docker API + system metrics | Read-only | System Status plugin |
| `contacts` | `useContacts()` | SQLite (relationship graph) | Read-only | Contact Explorer plugin |
| `email-volume` | `useEmailVolume()` | Postgres (email processing log) | Read-only | Volume Analytics plugin |
| `cost` | `useCostData()` | Postgres (API usage log) | Read-only | Cost Tracker plugin |
| `knowledge` | `useKnowledgeBase()` | Qdrant + filesystem | Read + Write (add/remove documents) | Knowledge Base plugin |
| `persona` | `usePersona()` | Postgres + JSON (voice profile) | Read + Write (tuning) | Persona Settings plugin |
| `fleet` | `useFleetStatus()` | Aggregated telemetry (cloud) | Read-only | Fleet Monitor plugin (internal) |
| `openclaw` | `useOpenClawStatus()` | Skill Bridge event bus | Read-only | OpenClaw Monitor plugin |

#### Write Capability Enforcement

Write-capable providers require:

1. Authenticated session with a user whose subscription tier meets the plugin's `requiredTier`
2. The specific write capability declared in the plugin manifest's `writeCapabilities` array
3. Server-side validation on the API endpoint — the data provider layer is a convenience, not a security boundary

This mirrors the graduated autonomy principle: the dashboard proposes actions, the API server validates and executes them.

### §7.6 Core Plugin Registry (NEW)

#### Phase 1 Core Plugins

| Plugin ID | Name | Category | Required Tier | Data Dependencies | Write Capabilities | Mobile |
|-----------|------|----------|---------------|-------------------|--------------------|--------|
| `optimus.approval-queue` | Approval Queue | workflow | base | `drafts` | `drafts.approve`, `drafts.reject`, `drafts.edit` | Yes |
| `optimus.sent-history` | Sent History | workflow | base | `drafts` | — | Yes |
| `optimus.classification-log` | Classification Log | analytics | base | `classifications` | — | Partial |
| `optimus.system-status` | System Status | system | community | `system` | — | Yes |
| `optimus.knowledge-base` | Knowledge Base | knowledge | base | `knowledge` | `knowledge.add`, `knowledge.remove` | Partial |
| `optimus.persona-settings` | Persona Settings | knowledge | base | `persona` | `persona.update` | No |
| `optimus.cost-tracker` | API Cost Tracker | analytics | base | `cost` | — | Partial |

#### Phase 2 Plugins

| Plugin ID | Name | Category | Required Tier | Data Dependencies | Write Capabilities | Mobile |
|-----------|------|----------|---------------|-------------------|--------------------|--------|
| `optimus.learning` | Learning (Skills) | workflow | base | `skills` | `skills.activate`, `skills.reject`, `skills.retire` | Yes |
| `optimus.classification-analytics` | Classification Trends | analytics | plus | `classifications` | — | No |
| `optimus.contact-explorer` | Contact & Relationship Graph | analytics | plus | `contacts` | — | No |
| `optimus.email-volume` | Email Volume Analytics | analytics | plus | `email-volume` | — | No |
| `optimus.cross-pack-insights` | Cross-Pack Insights | analytics | plus | `drafts`, `classifications`, `contacts` | — | No |
| `optimus.openclaw-monitor` | OpenClaw Agent Status | openclaw | plus | `openclaw` | — | Partial |

#### Phase 3 Plugins

| Plugin ID | Name | Category | Required Tier | Data Dependencies | Write Capabilities | Mobile |
|-----------|------|----------|---------------|-------------------|--------------------|--------|
| `optimus.orchestration` | Multi-Agent Orchestration | system | pro | `system`, `openclaw` | `agents.priority`, `agents.pause` | No |
| `optimus.fine-tuning` | Fine-Tuning Pipeline | system | pro | `persona`, `skills` | `finetune.trigger` | No |
| `optimus.fleet-monitor` | Fleet Management | fleet | enterprise | `fleet` | `fleet.push-update`, `fleet.alert` | No |
| `optimus.audit-trail` | Compliance Audit Export | fleet | enterprise | `drafts`, `classifications`, `skills` | `audit.export` | No |
| `optimus.api-access` | API Explorer | system | pro (read) / enterprise (write) | All | Varies | No |

#### Internal Plugins (UMB Group Only)

| Plugin ID | Name | Category | Required Tier | Purpose |
|-----------|------|----------|---------------|---------|
| `internal.fleet-overview` | Fleet Overview | fleet | internal | Aggregate health across all deployed appliances |
| `internal.support-triage` | Support Triage | fleet | internal | Identify appliances needing attention, connection failures, stale queues |
| `internal.ota-deployment` | OTA Deployment Manager | fleet | internal | Stage, test, and push container updates by release channel |
| `internal.cost-aggregate` | Cloud API Cost Aggregate | fleet | internal | Total API spend across fleet, per-customer breakdown |
| `internal.onboarding-tracker` | Onboarding Pipeline | fleet | internal | Track customer onboarding progress, flag stalled setups |

### §7.7 Workspace Presets (NEW)

Saved layout configurations — which plugins are open, where they sit, what size, what config. Users can create and save custom workspaces on top of presets.

#### Customer-Facing Presets

| Workspace | Plugins | Default For |
|-----------|---------|-------------|
| **Inbox** | Approval queue (full width), system status (sidebar) | Base tier — daily default |
| **Daily Ops** | Approval queue (left), classification log (right), cost tracker (bottom-right), system status (bottom-left) | Plus tier — morning check-in |
| **Learning** | Approval queue (left), learning/skills (right), classification analytics (bottom) | Plus tier — weekly skill review |
| **Analytics** | Classification trends (top-left), email volume (top-right), contact explorer (bottom-left), cross-pack insights (bottom-right) | Plus tier — weekly review |
| **Admin** | System status (top), knowledge base (left), persona settings (right), cost tracker (bottom) | Base tier — configuration |

#### UMB Group Internal Presets

| Workspace | Plugins | Who It's For |
|-----------|---------|-------------|
| **Fleet Health** | Fleet overview (full), OTA deployment (sidebar), cost aggregate (bottom) | Daily ops |
| **Support** | Support triage (left), fleet overview (right), onboarding tracker (bottom) | Support team |
| **Board Review** | Cost aggregate (top), fleet overview (middle), onboarding tracker (bottom) | Weekly board meeting |

#### Workspace Storage

Workspace layouts are stored as JSON in Postgres (`user_workspaces` table). On customer appliances, this is local Postgres. In the fleet context, this is a cloud-hosted Postgres instance used by the UMB Group team.

Schema:

```sql
CREATE TABLE user_workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  is_default BOOLEAN DEFAULT false,
  layout JSONB NOT NULL,  -- react-grid-layout serialized state
  plugin_configs JSONB NOT NULL DEFAULT '{}',  -- per-plugin config overrides
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);
```

### §7.8 Plugin Integrity Model (NEW)

| Property | Approach |
|----------|----------|
| **Registration** | Phase 1–2: all plugins are first-party, registered in code at build time. Phase 3+: manifest-based registration with UMB Group review for community-contributed plugins. |
| **Versioning** | Semver. Plugin manifest includes version. Shell checks compatibility with data provider API version. |
| **Isolation** | Plugins render inside React error boundaries. A crashing plugin shows an error card in its pane — it does not take down the workspace or other plugins. |
| **Data access control** | Plugins declare `dataDependencies` in their manifest. The data provider layer only exposes the declared dependencies. A classification analytics plugin cannot read the knowledge base unless it declares the dependency. |
| **Write gating** | Write capabilities are declared in the manifest AND enforced server-side on the API. The data provider layer is a convenience abstraction, not a security boundary. |
| **Audit** | Plugin activations, configuration changes, and workspace switches are logged in a `dashboard_audit_log` Postgres table. Separate from the email/draft audit trail. |

### §7.9 Permission Model — Unified Access Tiers (NEW)

The plugin architecture collapses the Business PRD §7.2 access tier table and the Technical PRD §1.6 dashboard sections into a single mechanism: **subscription tier → available plugins**.

| Tier | Available Plugin Categories | Max Concurrent Plugins | Workspace Persistence |
|------|---------------------------|----------------------|----------------------|
| Community | `system` only | 2 | Browser localStorage only |
| Base | `system`, `workflow`, `knowledge` (own pack) | 6 | Local Postgres |
| Plus | All customer categories | 10 | Local Postgres |
| Pro | All customer categories + `system` (advanced) | Unlimited | Local Postgres |
| Enterprise | All customer categories + `fleet` | Unlimited | Local Postgres + cloud sync |
| Internal | All categories | Unlimited | Cloud Postgres |

**Per-plugin tier gating replaces per-page tier gating.** Instead of showing or hiding entire dashboard pages (the current §7.2 approach), each plugin declares its `requiredTier`. The shell renders only the plugins the user's tier permits. This is more granular — a Plus user sees the approval queue AND classification trends but not the fine-tuning pipeline — and more extensible — adding a new feature means adding a new plugin with a tier tag, not restructuring dashboard pages.

**Multi-user support (Phase 3+):** When multi-user access control is added (currently out of scope per Business PRD §15), the permission model extends naturally: each user has a role (admin, reviewer, read-only), and plugins declare a `requiredRole` alongside `requiredTier`. The admin sees persona settings; the reviewer sees only the approval queue.

---

## §1.6 Customer Dashboard — Functional Requirements (AMEND)

> **Source:** Plugin architecture analysis, 2026-04-05
> **Spec section affected:** Technical PRD §1.6
> **Change type:** AMEND

### Amended Requirements

| ID | Requirement | Change |
|----|-------------|--------|
| FR-25 | Web-based dashboard served locally from the appliance, accessible via LAN at `http://device.local:3000` | **Unchanged.** Plugin architecture does not change the access model. |
| FR-26 | Dashboard requires local authentication (username + password, set during first-boot) | **Unchanged.** Authentication gates the shell. Subscription tier is loaded post-auth and determines available plugins. |
| FR-27 | Dashboard sections: approval queue, sent history, classification log, knowledge base management, persona settings, learning (§5.7.1), system status | **Replaced.** Each listed section becomes a plugin (see §7.6). The "sections" concept is replaced by "available plugins" per subscription tier. Add: "Plugin workspace shell with configurable layout, plugin sidebar, and command palette." |
| FR-28 | Mobile-responsive — primary interaction surface is phone browser on the same Wi-Fi network | **Amended.** Mobile responsiveness is per-plugin. The approval queue plugin is mobile-first. Analytics plugins degrade gracefully. The shell provides a mobile-optimized single-plugin view mode (full screen, swipe between plugins). |
| FR-29 | System status page shows: uptime, email connection health, model status, disk usage, queue depth, API cost meter | **Replaced.** System status is a plugin (`optimus.system-status`). Available at Community tier. API cost is a separate plugin (`optimus.cost-tracker`) at Base tier. |

### New Requirements

| ID | Requirement |
|----|------------|
| FR-37 | Dashboard shell supports draggable, resizable plugin panes via `react-grid-layout`. Users can rearrange plugins within their workspace. |
| FR-38 | Workspace presets ship with the appliance. Users can create, save, and switch between custom workspaces. |
| FR-39 | Command palette (Ctrl+K / Cmd+K) for quick navigation: switch workspace, open plugin, search drafts, jump to settings. |
| FR-40 | Plugin sidebar lists available plugins (filtered by subscription tier). Enable/disable toggles per plugin. Badge counts on action plugins (pending drafts, pending skills). |
| FR-41 | Crashing or erroring plugins are isolated — an error boundary displays a recoverable error card without affecting other plugins or the shell. |

---

## Business PRD §7.2 Access Tiers (AMEND)

> **Source:** Plugin architecture analysis, 2026-04-05
> **Spec section affected:** Business PRD §7.2
> **Change type:** AMEND — replace feature matrix with plugin-tier matrix

### Amended Text

Replace the existing §7.2 feature-per-tier table with the following plugin-based access matrix:

| Feature Area | Community | Base | Plus | Pro | Enterprise |
|-------------|-----------|------|------|-----|------------|
| **System status plugin** | ✓ (read-only) | ✓ | ✓ | ✓ | ✓ |
| **Approval queue plugin** | — | ✓ | ✓ | ✓ | ✓ |
| **Sent history plugin** | — | ✓ | ✓ | ✓ | ✓ |
| **Classification log plugin** | — | ✓ | ✓ | ✓ | ✓ |
| **Knowledge base plugin** | — | ✓ | ✓ | ✓ | ✓ |
| **Persona settings plugin** | — | ✓ | ✓ | ✓ | ✓ |
| **Cost tracker plugin** | — | ✓ | ✓ | ✓ | ✓ |
| **Learning/skills plugin** | — | ✓ (own pack) | ✓ (all packs) | ✓ (all + bulk) | ✓ (fleet-wide) |
| **Classification trends plugin** | — | — | ✓ | ✓ | ✓ |
| **Contact/graph explorer plugin** | — | — | ✓ | ✓ | ✓ |
| **Email volume analytics plugin** | — | — | ✓ | ✓ | ✓ |
| **Cross-pack insights plugin** | — | — | ✓ | ✓ | ✓ |
| **OpenClaw monitor plugin** | — | — | ✓ | ✓ | ✓ |
| **Multi-agent orchestration plugin** | — | — | — | ✓ | ✓ |
| **Fine-tuning pipeline plugin** | — | — | — | ✓ | ✓ |
| **Fleet management plugin** | — | — | — | — | ✓ |
| **Audit trail / compliance plugin** | — | — | — | — | ✓ |
| **API explorer plugin** | — | — | — | ✓ (read) | ✓ (read/write) |
| **Custom workspaces** | — | 3 max | 10 max | Unlimited | Unlimited |
| **Command palette** | — | ✓ | ✓ | ✓ | ✓ |
| **Workspace presets** | 1 (Inbox) | 2 (Inbox, Admin) | All | All | All + custom |

The underlying access control mechanism is the plugin's `requiredTier` manifest field, not a per-page visibility toggle. This means new plugins can be added to any tier without restructuring the dashboard — they simply declare their tier and the shell handles the rest.

---

## DR-12: Plugin-Host Workspace vs. Fixed-Page Dashboard (NEW)

> **Source:** Optimus dashboard plugin architecture analysis, 2026-04-05
> **Spec section affected:** §7, §1.6, Business PRD §7.2
> **Change type:** NEW

### Decision: Replace fixed-page dashboard with plugin-host workspace architecture

**Type:** Strategic
**Date:** 2026-04-05
**Decided by:** Pending board review
**Status:** Proposed
**Spec sections affected:** Technical PRD §7, §1.6, §4.2; Business PRD §7.2

### Context

The Phase 1 dashboard (Technical PRD §7, deliverable 6) is specified as a fixed-page web application. Phase 2 adds a Learning tab, relationship graph explorer, and OpenClaw approval TUI integration. Phase 3 adds fleet management, fine-tuning controls, and compliance audit. Each phase requires restructuring the dashboard layout, adding new pages, and retrofitting the navigation model. Meanwhile, UMB Group needs an internal fleet management dashboard — a separate codebase from the customer-facing product.

### Evaluation

**Opportunity (4/5):** Eliminates dashboard rework across phase transitions. Each new feature is a plugin drop-in rather than a monolith restructure. Subscription-tier gating is granular (per-plugin) rather than coarse (per-page). Unified codebase for customer and internal dashboards. Board members / operators get role-appropriate views without building separate dashboards.

**Risk (2/5):** 3–4 day additional upfront build cost. Slightly more complex initial architecture. Plugin API surface area to maintain. Mitigated: the API is small (manifest + lifecycle hooks + data hooks), and the grid layout library is battle-tested.

**Feasibility (5/5):** No novel technology. `react-grid-layout` is MIT-licensed, used by Grafana, Datadog, and Jupyter. `cmdk` is Vercel-maintained. Data provider hooks are standard React patterns over existing REST/WebSocket APIs. All dependencies pass the §18 AGPL firewall equivalent (no AGPL, all MIT).

### Alternatives Considered

| Option | Pros | Cons | Why Not |
|--------|------|------|---------|
| Fixed-page dashboard (current spec) | Simpler initial build (~3–4 days faster). Clear page-per-feature mental model. | Every phase transition is a rework. Subscription gating is coarse (show/hide pages). Two separate codebases for customer and internal dashboards. | Trades 3–4 days now for weeks of rework later. |
| Fork Obsidian (proprietary) or Logseq (AGPL) | Rich existing UI. Large plugin ecosystem. | Obsidian is closed source — cannot fork. Logseq is AGPLv3 — disqualified per licensing constraints. | Legal and licensing blockers. |
| Grafana-style dashboarding | Proven plugin model. Excellent chart library. | Grafana is AGPLv3. Grafana Cloud is overkill for an appliance dashboard. Not designed for action-oriented workflows (approve/reject/edit). | AGPL license. Wrong paradigm (monitoring dashboards, not workflow dashboards). |
| Build customer dashboard + separate internal dashboard | Each codebase is simpler individually. | Double the frontend development and maintenance. Divergent UX over time. Feature parity drift. | Cost multiplier on every feature. |

### Recommendation

PROCEED

### Kill Criteria

- Plugin shell + 2 core plugins (approval queue, system status) exceed 5 days of build time
- Grid layout library introduces > 100ms render latency on T2 hardware (Jetson Orin Nano)
- Plugin API requires > 50 lines of boilerplate per plugin

### Cost Impact

- Build cost: +3–4 days upfront (vs. fixed-page)
- Monthly operating impact: $0 — no new infrastructure
- Payback: First Phase 2 dashboard feature (Learning tab) is a plugin drop-in instead of a page restructure, saving ~2–3 days. Breakeven before Phase 2.

### Confidence

4/5

---

## DR-13: Unified Codebase (Customer + Internal) vs. Separate Dashboards (NEW)

> **Source:** Plugin architecture analysis, 2026-04-05
> **Spec section affected:** §7, Business PRD §7.2
> **Change type:** NEW

### Decision: Ship a single dashboard codebase with tier-gated plugins for both customer-facing and UMB Group internal use

**Type:** Strategic
**Date:** 2026-04-05
**Decided by:** Pending board review
**Status:** Proposed
**Spec sections affected:** Technical PRD §7; Business PRD §7.2, §11

### Context

UMB Group needs fleet management visibility: aggregate appliance health, OTA deployment staging, support triage, cloud API cost tracking. This is an internal tool. The customer-facing Optimus Brain dashboard is a separate product. Building them as separate codebases doubles frontend work.

### Evaluation

**Opportunity (4/5):** One codebase, one plugin API, one set of UI components. Internal plugins reuse the same shell, layout engine, and component library as customer plugins. UMB Group operators learn one tool. Customer-facing improvements automatically benefit internal tooling.

**Risk (2/5):** Internal plugins must never leak to customer appliances. Mitigated: `internal` tier plugins are excluded from customer-facing Docker images at build time (not just hidden — absent from the bundle). The `requiredTier: 'internal'` field is enforced at both the shell level and the API level.

**Feasibility (4/5):** Standard multi-tenant pattern. Build-time plugin bundling (include/exclude by tier) is a solved problem. The data provider layer already abstracts the data source — swapping local Postgres for cloud Postgres for fleet data is a configuration change, not an architectural one.

### Alternatives Considered

| Option | Pros | Cons | Why Not |
|--------|------|------|---------|
| Separate internal dashboard | Clean separation. Zero risk of customer exposure. | Double the frontend work. Divergent UX. Every shared component must be duplicated or extracted to a shared library (which is effectively the same as a unified codebase with more indirection). | Cost multiplier. |
| Use Grafana for internal monitoring only | Battle-tested monitoring tool. Rich alerting. | AGPLv3 license concern. Doesn't integrate with customer-facing approval workflows. Two completely different tools for one team. | Wrong tool for action-oriented workflows. |

### Recommendation

PROCEED

### Kill Criteria

- Internal plugin code appears in customer-facing Docker image (detected by automated build verification)
- Internal data providers create network dependencies from customer appliances to UMB Group cloud (the appliance must operate fully offline)

### Cost Impact

- Build cost: $0 incremental (unified codebase is cheaper than two codebases)
- Monthly operating impact: Cloud hosting for fleet data providers (~$20–50/mo, scales with fleet size)
- Savings: ~40–60% reduction in total dashboard development hours over Phase 1–3

### Confidence

4/5

---

## Build vs. Fork Analysis — Selected Dependencies

All dependencies are MIT-licensed and pass licensing constraints.

| Library | Purpose | License | Stars | Why This One |
|---------|---------|---------|-------|-------------|
| `react-grid-layout` | Draggable/resizable grid panes | MIT | 19K+ | Most mature React grid layout. Used by Grafana, Datadog, Jupyter. Handles drag, resize, responsive breakpoints, serialization. |
| `cmdk` | Command palette (Ctrl+K / Cmd+K) | MIT | 10K+ | Vercel-maintained. Keyboard-first. Composable. Tiny bundle. |
| `recharts` | Charts inside plugins | MIT | 23K+ | Already specified in the thUMBox stack. Simple API. React-native. |
| `@supabase/supabase-js` or raw `pg` | Data provider layer | MIT / MIT | — | If the dashboard uses Supabase for auth/realtime, use their client. Otherwise, raw Postgres client with WebSocket wrapper. |

**What we build ourselves (~500–800 lines of layout scaffolding):**

| Component | Lines (est.) | Complexity |
|-----------|-------------|------------|
| Grid layout config + responsive breakpoints | ~200 | Low |
| Workspace persistence (JSON serialization → Postgres) | ~150 | Low |
| Plugin sidebar (enable/disable, tier-gated list) | ~200 | Low |
| Plugin lifecycle manager (register, activate, deactivate, error boundary) | ~200 | Medium |
| Command palette integration | ~100 | Low |

The remaining 90% of the work — the actual plugins, data providers, API endpoints, and business logic — is thUMBox-specific regardless of layout approach.

---

## Implementation Cost & Timeline Impact

| Component | Effort | Phase | Notes |
|-----------|--------|-------|-------|
| Shell (layout engine, workspace persistence, plugin lifecycle) | 3–4 days | Phase 1 | Grid layout, drag/resize, save/load workspaces, error boundaries |
| Plugin API + data provider layer | 2–3 days | Phase 1 | Typed hooks, REST/WebSocket integration, tier gating |
| Phase 1 core plugins (7 plugins per §7.6) | 5–7 days | Phase 1 | Approval queue (~2 days), system status (~1 day), others (~0.5–1 day each) |
| **Phase 1 total** | **10–14 days** | | vs. ~7–10 days for fixed-page dashboard |
| Phase 2 plugins (6 plugins per §7.6) | 6–10 days | Phase 2 | Learning tab (~2 days), analytics plugins (~1–2 days each) |
| Phase 3 plugins (4 customer + 5 internal) | 8–12 days | Phase 3 | Fleet and compliance plugins |

**Net cost of the plugin architecture: ~3–4 extra days in Phase 1.** Each subsequent phase saves 2–3 days by avoiding dashboard restructuring. The investment breaks even during Phase 2.

---

## Interaction with OpenClaw Addendum

The OpenClaw addendum (`addendum-openclaw-integration.md`) includes a `[NEEDS_CLARIFICATION]` on whether the NemoClaw approval TUI should be integrated into the dashboard. The plugin architecture resolves this cleanly:

**Resolution:** The NemoClaw approval TUI becomes an OpenClaw plugin (`optimus.openclaw-monitor`) at Plus+ tier. It surfaces NemoClaw's sandboxed action queue within the Optimus Brain workspace rather than requiring a separate terminal interface. This reduces onboarding friction for non-technical SMB operators.

The Skill Bridge events (§23.5 in the OpenClaw addendum) flow into the data provider layer via a new `openclaw` data provider, which the OpenClaw monitor plugin consumes. This is a clean integration point — the plugin reads from the event bus, the shell handles the layout.

---

## Open Questions

| # | Question | Impact |
|---|----------|--------|
| OQ-1 | Should workspace layouts sync to the cloud for Plus+ users, or is local-only sufficient for all customer tiers? | Affects: workspace storage schema, cloud dependency for non-Enterprise tiers. Recommendation: local-only for Phase 1–2. Cloud sync for Enterprise in Phase 3. |
| OQ-2 | Should the command palette support natural-language search (e.g., "show me emails from KeHE") or is keyword-only sufficient? | Affects: command palette complexity, potential integration with local LLM for query parsing. Recommendation: keyword-only for Phase 1. NL search is a Phase 3 enhancement. |
| OQ-3 | Should community-contributed plugins be supported in Phase 3+, and if so, what is the review/approval process? | Affects: plugin API stability guarantees, security review process, potential revenue from plugin marketplace. Recommendation: defer to Phase 3 planning. Design the manifest schema to accommodate third-party plugins but do not build the review pipeline yet. |
| OQ-4 | The Optimus dashboard proposal references Supabase for data storage and auth. The thUMBox PRD specifies raw Postgres. Should the dashboard use Supabase client libraries for realtime subscriptions, or should we build a lighter WebSocket layer on raw Postgres + LISTEN/NOTIFY? | Affects: dependency count, bundle size, auth model. Recommendation: raw Postgres + LISTEN/NOTIFY for the appliance (lighter, no cloud dependency). Supabase for the fleet dashboard if UMB Group uses Supabase elsewhere. |

---

## Phase Activation

- **Phase 1:** Shell + plugin API + 7 core plugins. Single-user auth. Local workspace persistence. Preset workspaces only (no custom creation). Internal plugins built but not shipped to customer images.
- **Phase 2:** 6 additional plugins (learning, analytics, OpenClaw). Custom workspace creation. Mobile-optimized single-plugin view. Badge counts on action plugins.
- **Phase 3:** Fleet plugins. Multi-user roles. Enterprise cloud sync. Community plugin path evaluated.

## Measurement

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SM-50 | Dashboard shell load time | < 2 seconds on T1 hardware | Automated test |
| SM-51 | Plugin activation time | < 500ms per plugin on T2 hardware | Performance profiling |
| SM-52 | Plugin crash isolation | Crashing plugin does not affect other active plugins (100% isolation) | Integration test with intentionally failing plugin |
| SM-53 | Workspace save/restore fidelity | Restored workspace matches saved layout exactly (pixel-level grid positions, plugin configs) | Automated round-trip test |
| SM-54 | Mobile approval queue usability | Approve/edit/reject actions completable at 375px viewport without horizontal scrolling | Manual QA |
| SM-55 | Internal plugin exclusion from customer builds | Zero internal-tier plugins present in customer Docker image | Automated build verification |

---

## Ecosystem References

| Source | Key Takeaway | Applicability |
|--------|-------------|---------------|
| Obsidian interaction model | Draggable panes, split views, workspace persistence, command palette, plugin sidebar — the UX patterns we want | Interaction design inspiration only. Obsidian is proprietary (closed source). |
| Grafana dashboard architecture | Plugin-based dashboarding with typed data sources. Proven at scale. | Architectural validation. Grafana itself is AGPLv3 — disqualified as a dependency. We adopt the pattern, not the code. |
| `react-grid-layout` (MIT, 19K+ stars) | Battle-tested draggable/resizable grid for React. Used by Grafana, Datadog, Jupyter. | Direct dependency for shell layout engine. |
| `cmdk` (MIT, Vercel-maintained) | Keyboard-first command palette. Composable. Tiny bundle. | Direct dependency for command palette. |
| Optimus Dashboard Plugin Architecture Proposal (internal, 2026-04-05) | Plugin-host workspace for the Optimus project board dashboard. Same architecture pattern adapted for thUMBox. | Direct inspiration. Unified approach across UMB Group products. |
