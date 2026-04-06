/**
 * Railway Deploy Client for Project Campaigns
 *
 * Deploys campaign-created GitHub repos to Railway for live preview URLs.
 * Uses Railway's GraphQL API (https://backboard.railway.app/graphql/v2).
 * Auth via RAILWAY_TOKEN env var (Bearer token, P2 — never in LLM prompts).
 *
 * Graceful degradation: if RAILWAY_TOKEN is not set or API fails,
 * the campaign continues producing code output — deploy is non-blocking.
 */

import { query } from '../../lib/db.js';

const RAILWAY_API = 'https://backboard.railway.app/graphql/v2';

/**
 * Execute a Railway GraphQL query/mutation.
 * @param {string} queryStr - GraphQL query string
 * @param {Object} variables - Query variables
 * @returns {Promise<Object>} Response data
 */
async function railwayGql(queryStr, variables = {}) {
  const token = process.env.RAILWAY_TOKEN;
  if (!token) throw new Error('RAILWAY_TOKEN not configured');

  const res = await fetch(RAILWAY_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: queryStr, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Railway API error (${res.status}): ${text}`);
  }

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`Railway GraphQL error: ${json.errors[0].message}`);
  }
  return json.data;
}

/**
 * Create a Railway project.
 * @param {string} name - Project name
 * @returns {Promise<string>} Railway project ID
 */
export async function createRailwayProject(name) {
  const data = await railwayGql(
    `mutation($input: ProjectCreateInput!) {
      projectCreate(input: $input) { id }
    }`,
    { input: { name } }
  );
  return data.projectCreate.id;
}

/**
 * Create a Railway service linked to a GitHub repo.
 * @param {string} projectId - Railway project ID
 * @param {string} repoFullName - GitHub repo (e.g., "staqsIO/my-project")
 * @returns {Promise<string>} Railway service ID
 */
export async function createRailwayService(projectId, repoFullName) {
  const data = await railwayGql(
    `mutation($input: ServiceCreateInput!) {
      serviceCreate(input: $input) { id }
    }`,
    { input: { projectId, source: { repo: repoFullName } } }
  );
  return data.serviceCreate.id;
}

/**
 * Poll until deployment succeeds or timeout.
 * @param {string} serviceId - Railway service ID
 * @param {number} [timeoutMs=300000] - Max wait time (default 5 min)
 * @returns {Promise<string>} Deployment status
 */
export async function waitForDeploy(serviceId, timeoutMs = 300_000) {
  const start = Date.now();
  const pollIntervalMs = 10_000;

  while (Date.now() - start < timeoutMs) {
    const data = await railwayGql(
      `query($serviceId: String!) {
        deployments(first: 1, input: { serviceId: $serviceId }) {
          edges { node { id status } }
        }
      }`,
      { serviceId }
    );

    const deployment = data.deployments?.edges?.[0]?.node;
    if (!deployment) {
      await sleep(pollIntervalMs);
      continue;
    }

    if (deployment.status === 'SUCCESS') return 'SUCCESS';
    if (deployment.status === 'FAILED' || deployment.status === 'CRASHED') {
      throw new Error(`Railway deployment ${deployment.status}`);
    }

    // Still deploying — wait and poll again
    await sleep(pollIntervalMs);
  }

  throw new Error(`Railway deployment timed out after ${timeoutMs / 1000}s`);
}

/**
 * Get the public URL for a Railway service.
 * @param {string} serviceId - Railway service ID
 * @returns {Promise<string|null>} Public URL or null
 */
export async function getServiceUrl(serviceId) {
  const data = await railwayGql(
    `query($serviceId: String!) {
      service(id: $serviceId) {
        serviceInstances {
          edges {
            node {
              domains { serviceDomains { domain } }
            }
          }
        }
      }
    }`,
    { serviceId }
  );

  const instances = data.service?.serviceInstances?.edges || [];
  for (const edge of instances) {
    const domains = edge.node?.domains?.serviceDomains || [];
    if (domains.length > 0) {
      return `https://${domains[0].domain}`;
    }
  }
  return null;
}

/**
 * Delete a Railway project (cleanup).
 * @param {string} projectId - Railway project ID
 */
export async function deleteRailwayProject(projectId) {
  await railwayGql(
    `mutation($id: String!) {
      projectDelete(id: $id)
    }`,
    { id: projectId }
  );
}

/**
 * Full deploy orchestrator: create project, link repo, wait for deploy, get URL.
 * Stores preview URL and Railway IDs in campaign metadata.
 *
 * @param {string} campaignId - Campaign ID
 * @param {string} repoFullName - GitHub repo (e.g., "staqsIO/my-project")
 * @returns {Promise<string|null>} Preview URL or null on failure
 */
export async function deployProject(campaignId, repoFullName) {
  if (!process.env.RAILWAY_TOKEN) {
    console.warn(`[project-deploy] RAILWAY_TOKEN not set — skipping deploy for campaign ${campaignId}`);
    return null;
  }

  try {
    console.log(`[project-deploy] Deploying ${repoFullName} for campaign ${campaignId}...`);

    // Step 1: Create Railway project
    const slug = repoFullName.split('/').pop() || campaignId.slice(0, 8);
    const projectId = await createRailwayProject(`optimus-${slug}`);
    console.log(`[project-deploy]   Railway project: ${projectId}`);

    // Step 2: Create service linked to GitHub repo
    const serviceId = await createRailwayService(projectId, repoFullName);
    console.log(`[project-deploy]   Railway service: ${serviceId}`);

    // Step 3: Wait for deployment
    await waitForDeploy(serviceId);
    console.log(`[project-deploy]   Deploy succeeded`);

    // Step 4: Get public URL
    const previewUrl = await getServiceUrl(serviceId);
    console.log(`[project-deploy]   Preview URL: ${previewUrl || '(no domain yet)'}`);

    // Step 5: Store in campaign metadata
    await query(
      `UPDATE agent_graph.campaigns
       SET metadata = COALESCE(metadata, '{}'::jsonb)
         || jsonb_build_object(
              'preview_url', $1::text,
              'railway_project_id', $2::text,
              'railway_service_id', $3::text
            ),
         updated_at = now()
       WHERE id = $4`,
      [previewUrl || '', projectId, serviceId, campaignId]
    );

    return previewUrl;
  } catch (err) {
    console.error(`[project-deploy] Deploy failed for campaign ${campaignId}: ${err.message}`);
    // Non-blocking — campaign continues without deploy
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
