/**
 * Knowledge graph retriever for hybrid RAG.
 *
 * Runs graph queries in parallel with vector search to find
 * structurally-related context that cosine similarity misses.
 *
 * Examples of what graph catches that vectors miss:
 * - "What commitments has Eric made to Dustin?" → relationship traversal
 * - "Which agents work on campaigns?" → delegation edges
 * - "What projects is Mike involved in?" → entity relationships
 *
 * Falls back gracefully if Neo4j is unavailable (returns empty array).
 */

import { isGraphAvailable, runCypher } from '../graph/client.js';

/**
 * Search the knowledge graph for entities and relationships matching the query.
 *
 * @param {string} queryText - Natural language query
 * @param {number} [limit=5] - Max results
 * @returns {Promise<Array<{ text: string, source: string, metadata: Object }>>}
 */
export async function searchGraph(queryText, limit = 5) {
  if (!isGraphAvailable()) return [];

  const results = [];

  // Strategy 1: Full-text entity search (if index exists)
  try {
    const entityResults = await runCypher(
      `CALL db.index.fulltext.queryNodes("entity_search", $query) YIELD node, score
       WHERE score > 0.5
       MATCH (node)-[r]-(neighbor)
       RETURN node.name AS entity, labels(node)[0] AS type,
              type(r) AS relationship, neighbor.name AS related,
              labels(neighbor)[0] AS related_type, score
       ORDER BY score DESC
       LIMIT toInteger($limit)`,
      { query: queryText, limit: parseInt(limit, 10) },
      { readOnly: true }
    );

    if (entityResults) {
      for (const record of entityResults) {
        const obj = record.toObject();
        results.push({
          text: `${obj.entity} (${obj.type}) ${obj.relationship} ${obj.related} (${obj.related_type})`,
          source: 'knowledge_graph',
          metadata: { score: obj.score, type: 'entity_relationship' },
        });
      }
    }
  } catch {
    // Full-text index might not exist — try keyword match instead
  }

  // Strategy 2: Keyword-based entity match (fallback)
  if (results.length === 0) {
    try {
      // Extract potential entity names (capitalized words, multi-word names)
      const words = queryText.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || [];
      if (words.length > 0) {
        const entityResults = await runCypher(
          `UNWIND $names AS name
           MATCH (n) WHERE n.name CONTAINS name OR n.id CONTAINS toLower(name)
           MATCH (n)-[r]-(m)
           RETURN n.name AS entity, labels(n)[0] AS type,
                  type(r) AS relationship, m.name AS related,
                  labels(m)[0] AS related_type
           LIMIT toInteger($limit)`,
          { names: words.slice(0, 3), limit },
          { readOnly: true }
        );

        if (entityResults) {
          for (const record of entityResults) {
            const obj = record.toObject();
            results.push({
              text: `${obj.entity} (${obj.type}) ${obj.relationship} ${obj.related} (${obj.related_type})`,
              source: 'knowledge_graph',
              metadata: { type: 'keyword_match' },
            });
          }
        }
      }
    } catch {
      // Neo4j query failed — return empty
    }
  }

  // Strategy 3: Recent agent decisions (always useful for board context)
  if (/\b(agent|decision|pipeline|task|campaign|delegate)\b/i.test(queryText)) {
    try {
      const decisionResults = await runCypher(
        `MATCH (a:Agent)-[:PROPOSED_DECISION]->(d:Decision)
         WHERE d.created_at > datetime() - duration('P7D')
         RETURN a.id AS agent, d.type AS decision_type,
                d.recommendation AS recommendation, d.status AS status
         ORDER BY d.created_at DESC
         LIMIT toInteger($limit)`,
        { limit },
        { readOnly: true }
      );

      if (decisionResults) {
        for (const record of decisionResults) {
          const obj = record.toObject();
          results.push({
            text: `Agent ${obj.agent}: ${obj.decision_type} — ${obj.recommendation} (${obj.status})`,
            source: 'knowledge_graph',
            metadata: { type: 'agent_decision' },
          });
        }
      }
    } catch {
      // Decision query failed — non-fatal
    }
  }

  return results;
}
