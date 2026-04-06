import { runCypher, isGraphAvailable } from './client.js';

/**
 * Log a governance submission to Neo4j.
 * Creates a Submission node and links to the submitting agent.
 */
export async function logSubmission(submission) {
  if (!isGraphAvailable()) return;
  try {
    await runCypher(
      `MERGE (s:GovernanceSubmission {id: $id})
       SET s.title = $title,
           s.content_type = $contentType,
           s.status = $status,
           s.impact_level = $impactLevel,
           s.created_at = datetime($createdAt)
       WITH s
       MERGE (a:Agent {id: $submittedBy})
       MERGE (a)-[:SUBMITTED]->(s)`,
      {
        id: submission.id,
        title: submission.title,
        contentType: submission.content_type,
        status: submission.status,
        impactLevel: submission.impact_level || 'unknown',
        createdAt: submission.created_at || new Date().toISOString(),
        submittedBy: submission.submitted_by,
      }
    );

    // Link affected ADRs (batched to avoid N+1)
    if (submission.affected_adrs?.length > 0) {
      await runCypher(
        `MATCH (s:GovernanceSubmission {id: $id})
         UNWIND $adrs AS adr
         MERGE (d:ADR {id: adr})
         MERGE (s)-[:AFFECTS]->(d)`,
        { id: submission.id, adrs: submission.affected_adrs }
      );
    }

    // Link spec domains (batched to avoid N+1)
    if (submission.spec_domains?.length > 0) {
      await runCypher(
        `MATCH (s:GovernanceSubmission {id: $id})
         UNWIND $domains AS domain
         MERGE (d:SpecDomain {id: domain})
         MERGE (s)-[:TOUCHES_DOMAIN]->(d)`,
        { id: submission.id, domains: submission.spec_domains }
      );
    }

    console.log(`[graph] logged governance submission ${submission.id}`);
  } catch (err) {
    console.warn(`[graph] governance submission logging failed: ${err.message}`);
  }
}

/**
 * Log an audit completion for a governance submission.
 * Creates an AuditEvent node linked to the submission.
 */
export async function logAudit(submissionId, auditResult, costUsd) {
  if (!isGraphAvailable()) return;
  try {
    const overallScore = auditResult.overall_score ?? null;
    const recommendation = auditResult.recommendation ?? 'unknown';
    const constitutionalScore = auditResult.constitutional?.score ?? null;
    const architecturalScore = auditResult.architectural?.score ?? null;
    const operationalScore = auditResult.operational?.score ?? null;

    await runCypher(
      `MATCH (s:GovernanceSubmission {id: $submissionId})
       SET s.status = 'awaiting_review',
           s.overall_score = $overallScore,
           s.recommendation = $recommendation
       WITH s
       CREATE (a:AuditEvent {
         id: randomUUID(),
         submission_id: $submissionId,
         overall_score: $overallScore,
         constitutional_score: $constitutionalScore,
         architectural_score: $architecturalScore,
         operational_score: $operationalScore,
         recommendation: $recommendation,
         cost_usd: $costUsd,
         created_at: datetime()
       })
       MERGE (s)-[:AUDITED_BY]->(a)`,
      {
        submissionId,
        overallScore,
        recommendation,
        constitutionalScore,
        architecturalScore,
        operationalScore,
        costUsd: costUsd || 0,
      }
    );
    console.log(`[graph] logged audit for ${submissionId}: score=${overallScore}, rec=${recommendation}`);
  } catch (err) {
    console.warn(`[graph] audit logging failed for ${submissionId}: ${err.message}`);
  }
}

/**
 * Log a board decision on a governance submission.
 * Updates the submission node and creates a Decision relationship.
 */
export async function logDecision(submissionId, decision, decidedBy, workItemId = null) {
  if (!isGraphAvailable()) return;
  try {
    await runCypher(
      `MATCH (s:GovernanceSubmission {id: $submissionId})
       SET s.status = $decision, s.decided_at = datetime()
       WITH s
       MERGE (b:Agent {id: $decidedBy})
       CREATE (b)-[:DECIDED {verdict: $decision, at: datetime()}]->(s)`,
      { submissionId, decision, decidedBy }
    );

    // Link to work item if accepted
    if (workItemId) {
      await runCypher(
        `MATCH (s:GovernanceSubmission {id: $submissionId})
         MERGE (w:WorkItem {id: $workItemId})
         MERGE (s)-[:PRODUCED]->(w)`,
        { submissionId, workItemId }
      );
    }

    console.log(`[graph] logged decision ${decision} for ${submissionId} by ${decidedBy}`);
  } catch (err) {
    console.warn(`[graph] decision logging failed for ${submissionId}: ${err.message}`);
  }
}
