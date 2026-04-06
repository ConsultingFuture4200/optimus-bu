/**
 * Projects API routes.
 *
 * GET  /api/projects              — list all projects
 * GET  /api/projects/:slug        — project detail with stats
 * POST /api/projects              — create a project
 * PATCH /api/projects/:slug       — update project (name, description, instructions, settings)
 * POST /api/projects/:slug/members — add entity to project
 * DELETE /api/projects/:slug/members — remove entity from project
 * GET  /api/projects/:slug/memory — get active project memory
 * POST /api/projects/:slug/memory — write project memory entry
 */

import { query } from '../db.js';

// Linus: sanitize instructions on write
let sanitize;
async function loadSanitizer() {
  if (!sanitize) {
    const mod = await import('../../lib/runtime/sanitizer.js');
    sanitize = mod.sanitize;
  }
}

export function registerProjectRoutes(routes) {

  // GET /api/projects — list all projects with entity counts
  routes.set('GET /api/projects', async () => {
    const result = await query(`
      SELECT p.*,
        (SELECT count(*) FROM agent_graph.project_memberships pm
         WHERE pm.project_id = p.id AND pm.entity_type = 'chat_session') AS chat_count,
        (SELECT count(*) FROM agent_graph.project_memberships pm
         WHERE pm.project_id = p.id AND pm.entity_type = 'campaign') AS campaign_count,
        (SELECT count(*) FROM agent_graph.project_memberships pm
         WHERE pm.project_id = p.id AND pm.entity_type = 'document') AS document_count,
        (SELECT count(*) FROM agent_graph.project_memberships pm
         WHERE pm.project_id = p.id AND pm.entity_type = 'contact') AS contact_count
      FROM agent_graph.projects p
      ORDER BY p.updated_at DESC
    `);
    return { projects: result.rows };
  });

  // GET /api/projects/:slug — project detail
  routes.set('GET /api/projects/detail', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const slug = url.searchParams.get('slug');
    if (!slug) { const e = new Error('slug required'); e.statusCode = 400; throw e; }

    const result = await query(
      `SELECT * FROM agent_graph.projects WHERE slug = $1`, [slug]
    );
    if (result.rows.length === 0) { const e = new Error('Project not found'); e.statusCode = 404; throw e; }
    const project = result.rows[0];

    // Get membership counts by type
    const counts = await query(
      `SELECT entity_type, count(*) AS count
       FROM agent_graph.project_memberships WHERE project_id = $1
       GROUP BY entity_type`,
      [project.id]
    );

    // Get active memory
    const memory = await query(
      `SELECT key, value, written_by, created_at
       FROM agent_graph.project_memory
       WHERE project_id = $1 AND superseded_by IS NULL
       ORDER BY created_at DESC`,
      [project.id]
    );

    // Get recent members (last 10 added)
    const recentMembers = await query(
      `SELECT pm.entity_type, pm.entity_id, pm.added_by, pm.added_at
       FROM agent_graph.project_memberships pm
       WHERE pm.project_id = $1
       ORDER BY pm.added_at DESC LIMIT 20`,
      [project.id]
    );

    // Get project files (documents linked via memberships)
    // entity_id is TEXT, d.id is UUID — cast for join
    const files = await query(
      `SELECT pm.entity_id AS document_id, d.title AS filename,
              pm.added_at AS uploaded_at, pm.added_by
       FROM agent_graph.project_memberships pm
       LEFT JOIN content.documents d ON d.id::text = pm.entity_id
       WHERE pm.project_id = $1 AND pm.entity_type = 'document'
       ORDER BY pm.added_at DESC`,
      [project.id]
    );

    return {
      project,
      counts: Object.fromEntries(counts.rows.map(r => [r.entity_type, parseInt(r.count)])),
      memory: memory.rows,
      recentMembers: recentMembers.rows,
      files: files.rows,
    };
  });

  // POST /api/projects — create a project
  routes.set('POST /api/projects', async (req, body) => {
    if (!body?.name || !body?.slug) {
      const e = new Error('name and slug are required'); e.statusCode = 400; throw e;
    }

    // Sanitize slug
    const slug = body.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 50);

    // Sanitize instructions if provided (Linus: sanitize on write)
    let instructions = body.instructions || null;
    if (instructions) {
      await loadSanitizer();
      if (sanitize) instructions = sanitize(instructions);
      if (instructions.length > 4096) instructions = instructions.slice(0, 4096);
    }

    const boardUser = req.headers?.['x-board-user'] || 'unknown';
    const result = await query(
      `INSERT INTO agent_graph.projects (slug, name, description, instructions, settings, classification_floor, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        slug,
        body.name,
        body.description || null,
        instructions,
        JSON.stringify(body.settings || {}),
        body.classification_floor || 'INTERNAL',
        boardUser,
      ]
    );

    return { project: result.rows[0] };
  });

  // PATCH /api/projects/:slug — update project
  routes.set('PATCH /api/projects', async (req, body) => {
    const url = new URL(req.url, 'http://localhost');
    const slug = url.searchParams.get('slug') || body?.slug;
    if (!slug) { const e = new Error('slug required'); e.statusCode = 400; throw e; }

    const updates = [];
    const params = [slug];
    let paramIdx = 2;

    if (body.name) { updates.push(`name = $${paramIdx++}`); params.push(body.name); }
    if (body.description !== undefined) { updates.push(`description = $${paramIdx++}`); params.push(body.description); }
    if (body.instructions !== undefined) {
      let inst = body.instructions;
      if (inst) {
        await loadSanitizer();
        if (sanitize) inst = sanitize(inst);
        if (inst.length > 4096) inst = inst.slice(0, 4096);
      }
      updates.push(`instructions = $${paramIdx++}`);
      params.push(inst);
    }
    if (body.settings) { updates.push(`settings = $${paramIdx++}`); params.push(JSON.stringify(body.settings)); }
    if (body.classification_floor) { updates.push(`classification_floor = $${paramIdx++}`); params.push(body.classification_floor); }

    if (updates.length === 0) { return { ok: true, message: 'Nothing to update' }; }

    updates.push('updated_at = now()');
    const result = await query(
      `UPDATE agent_graph.projects SET ${updates.join(', ')} WHERE slug = $1 RETURNING *`,
      params
    );

    return { project: result.rows[0] };
  });

  // POST /api/projects/:slug/members — add entity to project
  routes.set('POST /api/projects/members', async (req, body) => {
    if (!body?.slug || !body?.entity_type || !body?.entity_id) {
      const e = new Error('slug, entity_type, and entity_id required'); e.statusCode = 400; throw e;
    }

    const project = await query(`SELECT id FROM agent_graph.projects WHERE slug = $1`, [body.slug]);
    if (project.rows.length === 0) { const e = new Error('Project not found'); e.statusCode = 404; throw e; }

    const boardUser = req.headers?.['x-board-user'] || 'unknown';
    await query(
      `INSERT INTO agent_graph.project_memberships (project_id, entity_type, entity_id, added_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, entity_type, entity_id) DO NOTHING`,
      [project.rows[0].id, body.entity_type, body.entity_id, boardUser]
    );

    return { ok: true };
  });

  // DELETE /api/projects/:slug/members — remove entity from project
  // Accepts params via body OR query string (board proxy sends DELETE without body)
  routes.set('DELETE /api/projects/members', async (req, body) => {
    const url = new URL(req.url, 'http://localhost');
    const slug = body?.slug || url.searchParams.get('slug');
    const entityType = body?.entity_type || url.searchParams.get('entity_type');
    const entityId = body?.entity_id || url.searchParams.get('entity_id');

    if (!slug || !entityType || !entityId) {
      const e = new Error('slug, entity_type, and entity_id required'); e.statusCode = 400; throw e;
    }

    const project = await query(`SELECT id FROM agent_graph.projects WHERE slug = $1`, [slug]);
    if (project.rows.length === 0) { const e = new Error('Project not found'); e.statusCode = 404; throw e; }

    await query(
      `DELETE FROM agent_graph.project_memberships
       WHERE project_id = $1 AND entity_type = $2 AND entity_id = $3`,
      [project.rows[0].id, entityType, entityId]
    );

    return { ok: true };
  });

  // GET /api/projects/:slug/memory — get active memory entries
  routes.set('GET /api/projects/memory', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const slug = url.searchParams.get('slug');
    if (!slug) { const e = new Error('slug required'); e.statusCode = 400; throw e; }

    const project = await query(`SELECT id FROM agent_graph.projects WHERE slug = $1`, [slug]);
    if (project.rows.length === 0) { const e = new Error('Project not found'); e.statusCode = 404; throw e; }

    const result = await query(
      `SELECT * FROM agent_graph.project_memory_active($1)`,
      [project.rows[0].id]
    );

    return { memory: result.rows };
  });

  // POST /api/projects/:slug/memory — write a memory entry (append-only)
  routes.set('POST /api/projects/memory', async (req, body) => {
    if (!body?.slug || !body?.key || !body?.value) {
      const e = new Error('slug, key, and value required'); e.statusCode = 400; throw e;
    }

    const project = await query(`SELECT id FROM agent_graph.projects WHERE slug = $1`, [body.slug]);
    if (project.rows.length === 0) { const e = new Error('Project not found'); e.statusCode = 404; throw e; }

    const boardUser = req.headers?.['x-board-user'] || body.written_by || 'unknown';
    const projectId = project.rows[0].id;

    // Supersede the previous entry for this key (if any)
    const newId = (await query(
      `INSERT INTO agent_graph.project_memory (project_id, key, value, written_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [projectId, body.key, body.value, boardUser]
    )).rows[0].id;

    // Mark old entries as superseded
    await query(
      `UPDATE agent_graph.project_memory
       SET superseded_by = $1
       WHERE project_id = $2 AND key = $3 AND id != $1 AND superseded_by IS NULL`,
      [newId, projectId, body.key]
    );

    return { ok: true, id: newId };
  });

  // ================================================================
  // WIKI COMPILATION ENDPOINTS
  // ================================================================

  // POST /api/projects/:slug/compile — trigger wiki compilation
  routes.set('POST /api/projects/compile', async (req, body) => {
    const slug = body?.slug;
    if (!slug) { const e = new Error('slug required'); e.statusCode = 400; throw e; }

    const project = await query(`SELECT id FROM agent_graph.projects WHERE slug = $1`, [slug]);
    if (project.rows.length === 0) { const e = new Error('Project not found'); e.statusCode = 404; throw e; }

    const { compileWiki } = await import('../../../lib/wiki/compiler.js');
    const result = await compileWiki({
      projectId: project.rows[0].id,
      maxArticles: body?.maxArticles || 20,
      writtenBy: req.headers?.['x-board-user'] || 'wiki-compiler',
    });

    return result;
  });

  // GET /api/projects/:slug/wiki — list compiled wiki articles
  routes.set('GET /api/projects/wiki', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const slug = url.searchParams.get('slug');
    if (!slug) { const e = new Error('slug required'); e.statusCode = 400; throw e; }

    const project = await query(`SELECT id FROM agent_graph.projects WHERE slug = $1`, [slug]);
    if (project.rows.length === 0) { const e = new Error('Project not found'); e.statusCode = 404; throw e; }

    // Get all wiki-compiled articles (globally for now; project scoping in Phase 3)
    const articles = await query(
      `SELECT d.id, d.title, d.classification, d.compiled_from,
              d.metadata, d.created_at, d.updated_at,
              (SELECT count(*) FROM content.chunks c WHERE c.document_id = d.id) AS chunk_count
       FROM content.documents d
       WHERE d.source = 'wiki-compiled'
       ORDER BY d.updated_at DESC`
    );

    return {
      articles: articles.rows.map(a => ({
        id: a.id,
        title: a.title,
        classification: a.classification,
        sourceCount: a.compiled_from?.length || 0,
        chunkCount: parseInt(a.chunk_count),
        wikilinks: a.metadata?.wikilinks || [],
        compiledBy: a.metadata?.compiled_by || 'unknown',
        createdAt: a.created_at,
        updatedAt: a.updated_at,
      })),
    };
  });

  // GET /api/projects/:slug/wiki/health — lint report
  routes.set('GET /api/projects/wiki/health', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const slug = url.searchParams.get('slug');
    if (!slug) { const e = new Error('slug required'); e.statusCode = 400; throw e; }

    const project = await query(`SELECT id FROM agent_graph.projects WHERE slug = $1`, [slug]);
    if (project.rows.length === 0) { const e = new Error('Project not found'); e.statusCode = 404; throw e; }

    const { lintWiki } = await import('../../../lib/wiki/linter.js');
    const report = await lintWiki({ projectId: project.rows[0].id });

    return report;
  });

  // POST /api/projects/:slug/wiki/lint — trigger lint run and store in project memory
  routes.set('POST /api/projects/wiki/lint', async (req, body) => {
    const slug = body?.slug;
    if (!slug) { const e = new Error('slug required'); e.statusCode = 400; throw e; }

    const project = await query(`SELECT id FROM agent_graph.projects WHERE slug = $1`, [slug]);
    if (project.rows.length === 0) { const e = new Error('Project not found'); e.statusCode = 404; throw e; }

    const { lintWiki } = await import('../../../lib/wiki/linter.js');
    const report = await lintWiki({ projectId: project.rows[0].id });

    // Store lint report in project memory (append-only)
    const boardUser = req.headers?.['x-board-user'] || 'wiki-linter';
    const newId = (await query(
      `INSERT INTO agent_graph.project_memory (project_id, key, value, written_by)
       VALUES ($1, 'wiki_health', $2, $3)
       RETURNING id`,
      [project.rows[0].id, JSON.stringify(report), boardUser]
    )).rows[0].id;

    // Supersede previous health reports
    await query(
      `UPDATE agent_graph.project_memory
       SET superseded_by = $1
       WHERE project_id = $2 AND key = 'wiki_health' AND id != $1 AND superseded_by IS NULL`,
      [newId, project.rows[0].id]
    );

    return report;
  });

  // GET /api/projects/:slug/wiki/status — compilation status summary
  routes.set('GET /api/projects/wiki/status', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const slug = url.searchParams.get('slug');
    if (!slug) { const e = new Error('slug required'); e.statusCode = 400; throw e; }

    const project = await query(`SELECT id FROM agent_graph.projects WHERE slug = $1`, [slug]);
    if (project.rows.length === 0) { const e = new Error('Project not found'); e.statusCode = 404; throw e; }

    const { getCompileStatus } = await import('../../../lib/wiki/compiler.js');
    const status = await getCompileStatus(project.rows[0].id);

    return status;
  });

  // GET /api/projects/:slug/wiki/graph — graph data for visualization
  routes.set('GET /api/projects/wiki/graph', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const slug = url.searchParams.get('slug');
    if (!slug) { const e = new Error('slug required'); e.statusCode = 400; throw e; }

    // Get all wiki-compiled articles with their metadata
    const articles = await query(
      `SELECT d.id, d.title, d.classification, d.compiled_from, d.metadata, d.source
       FROM content.documents d
       WHERE d.source = 'wiki-compiled'
       ORDER BY d.title`
    );

    // Get source documents that were compiled from
    const allSourceIds = articles.rows
      .flatMap(a => a.compiled_from || [])
      .filter(Boolean);

    const sourceDocs = allSourceIds.length > 0
      ? await query(
          `SELECT id, title, classification FROM content.documents WHERE id = ANY($1)`,
          [[...new Set(allSourceIds)]]
        )
      : { rows: [] };

    const sourceMap = new Map(sourceDocs.rows.map(d => [d.id, d]));

    // Build nodes
    const nodes = [];
    const nodeIds = new Set();
    const conceptNodes = new Set(); // track wikilink targets that aren't articles

    // Wiki article nodes
    for (const a of articles.rows) {
      nodes.push({
        id: a.id,
        label: a.title,
        type: 'wiki',
        classification: a.classification,
        size: 8 + Math.min(4, (a.compiled_from?.length || 0)),
      });
      nodeIds.add(a.id);
    }

    // Source document nodes
    for (const [id, doc] of sourceMap) {
      if (!nodeIds.has(id)) {
        nodes.push({
          id,
          label: doc.title,
          type: 'source',
          classification: doc.classification,
          size: 5,
        });
        nodeIds.add(id);
      }
    }

    // Build edges
    const edges = [];
    const articleTitleMap = new Map(articles.rows.map(a => [a.title.toLowerCase(), a.id]));

    for (const a of articles.rows) {
      // compiled_from edges
      for (const srcId of (a.compiled_from || [])) {
        if (nodeIds.has(srcId)) {
          edges.push({ source: srcId, target: a.id, type: 'compiled_from' });
        }
      }

      // wikilink edges
      const wikilinks = a.metadata?.wikilinks || [];
      for (const link of wikilinks) {
        const targetId = articleTitleMap.get(link.toLowerCase());
        if (targetId && targetId !== a.id) {
          edges.push({ source: a.id, target: targetId, type: 'wikilink' });
        } else if (!targetId) {
          // Unresolved concept — create a concept node
          const conceptId = `concept:${link.toLowerCase()}`;
          if (!nodeIds.has(conceptId)) {
            nodes.push({ id: conceptId, label: link, type: 'concept', size: 3 });
            nodeIds.add(conceptId);
            conceptNodes.add(conceptId);
          }
          edges.push({ source: a.id, target: conceptId, type: 'wikilink' });
        }
      }
    }

    // Mark orphan wiki articles (no inbound wikilinks)
    const inboundTargets = new Set(edges.filter(e => e.type === 'wikilink').map(e => e.target));
    for (const n of nodes) {
      if (n.type === 'wiki' && !inboundTargets.has(n.id)) {
        // Check if it has outbound links — if not, it's truly orphaned
        const hasOutbound = edges.some(e => e.source === n.id && e.type === 'wikilink');
        if (!hasOutbound) n.type = 'orphan';
      }
    }

    return { nodes, edges };
  });

  // ================================================================
  // GLOBAL WIKI ENDPOINTS (for Knowledge Base page)
  // ================================================================

  // GET /api/wiki/articles — all compiled wiki articles (global, not project-scoped)
  routes.set('GET /api/wiki/articles', async () => {
    const articles = await query(
      `SELECT d.id, d.title, d.classification, d.compiled_from,
              d.metadata, d.created_at, d.updated_at,
              (SELECT count(*) FROM content.chunks c WHERE c.document_id = d.id) AS chunk_count
       FROM content.documents d
       WHERE d.source = 'wiki-compiled'
       ORDER BY d.updated_at DESC`
    );
    return {
      articles: articles.rows.map(a => ({
        id: a.id,
        title: a.title,
        classification: a.classification,
        sourceCount: a.compiled_from?.length || 0,
        chunkCount: parseInt(a.chunk_count),
        wikilinks: a.metadata?.wikilinks || [],
        compiledBy: a.metadata?.compiled_by || 'unknown',
        createdAt: a.created_at,
        updatedAt: a.updated_at,
      })),
    };
  });

  // GET /api/wiki/graph — global graph data for Knowledge Base visualization
  routes.set('GET /api/wiki/graph', async () => {
    const articles = await query(
      `SELECT d.id, d.title, d.classification, d.compiled_from, d.metadata
       FROM content.documents d WHERE d.source = 'wiki-compiled' ORDER BY d.title`
    );

    const allSourceIds = articles.rows.flatMap(a => a.compiled_from || []).filter(Boolean);
    const sourceDocs = allSourceIds.length > 0
      ? await query(`SELECT id, title, classification FROM content.documents WHERE id = ANY($1)`, [[...new Set(allSourceIds)]])
      : { rows: [] };
    const sourceMap = new Map(sourceDocs.rows.map(d => [d.id, d]));

    const nodes = [];
    const nodeIds = new Set();
    const edges = [];

    for (const a of articles.rows) {
      nodes.push({ id: a.id, label: a.title, type: 'wiki', classification: a.classification, size: 8 + Math.min(4, (a.compiled_from?.length || 0)) });
      nodeIds.add(a.id);
    }
    for (const [id, doc] of sourceMap) {
      if (!nodeIds.has(id)) {
        nodes.push({ id, label: doc.title, type: 'source', classification: doc.classification, size: 5 });
        nodeIds.add(id);
      }
    }

    const articleTitleMap = new Map(articles.rows.map(a => [a.title.toLowerCase(), a.id]));
    for (const a of articles.rows) {
      for (const srcId of (a.compiled_from || [])) {
        if (nodeIds.has(srcId)) edges.push({ source: srcId, target: a.id, type: 'compiled_from' });
      }
      for (const link of (a.metadata?.wikilinks || [])) {
        const targetId = articleTitleMap.get(link.toLowerCase());
        if (targetId && targetId !== a.id) {
          edges.push({ source: a.id, target: targetId, type: 'wikilink' });
        } else if (!targetId) {
          const conceptId = `concept:${link.toLowerCase()}`;
          if (!nodeIds.has(conceptId)) {
            nodes.push({ id: conceptId, label: link, type: 'concept', size: 3 });
            nodeIds.add(conceptId);
          }
          edges.push({ source: a.id, target: conceptId, type: 'wikilink' });
        }
      }
    }

    return { nodes, edges };
  });

  // GET /api/wiki/status — global compilation status
  routes.set('GET /api/wiki/status', async () => {
    const result = await query(
      `SELECT compile_status, count(*) AS count FROM content.documents GROUP BY compile_status`
    );
    const counts = Object.fromEntries(result.rows.map(r => [r.compile_status || 'none', parseInt(r.count)]));
    const wikiResult = await query(`SELECT count(*) FROM content.documents WHERE source = 'wiki-compiled'`);
    return {
      pending: counts.pending || 0,
      compiled: counts.compiled || 0,
      wikiArticles: parseInt(wikiResult.rows[0]?.count || '0'),
      none: counts.none || 0,
    };
  });

  // ================================================================
  // FILE UPLOAD TO PROJECTS
  // ================================================================

  // POST /api/projects/:slug/upload — upload file → RAG ingest + project membership
  routes.set('POST /api/projects/upload', async (req, body) => {
    if (!body?.slug || !body?.fileName || !body?.content) {
      const e = new Error('slug, fileName, and content required');
      e.statusCode = 400;
      throw e;
    }

    const project = await query(`SELECT id, classification_floor FROM agent_graph.projects WHERE slug = $1`, [body.slug]);
    if (project.rows.length === 0) { const e = new Error('Project not found'); e.statusCode = 404; throw e; }
    const projectId = project.rows[0].id;
    const classificationFloor = project.rows[0].classification_floor || 'INTERNAL';

    // Determine format from file extension
    const ext = body.fileName.split('.').pop()?.toLowerCase() || 'plain';
    const formatMap = { md: 'obsidian', txt: 'plain', json: 'plain', yaml: 'plain', yml: 'plain' };
    const format = formatMap[ext] || 'plain';

    // Ingest into knowledge base
    const { ingestDocument } = await import('../../../lib/rag/ingest.js');
    const boardUser = req.headers?.['x-board-user'] || 'unknown';
    const result = await ingestDocument({
      source: 'upload',
      sourceId: `project:${body.slug}:${body.fileName}`,
      title: body.fileName.replace(/\.[^.]+$/, ''),
      rawText: body.content,
      format,
      metadata: { project_slug: body.slug, uploaded_by: boardUser, original_filename: body.fileName },
      classification: body.classification || classificationFloor,
      forceUpdate: true, // Re-upload overwrites
    });

    if (!result) {
      const e = new Error('Ingestion failed — file may be empty or too small');
      e.statusCode = 400;
      throw e;
    }

    // Add to project membership
    await query(
      `INSERT INTO agent_graph.project_memberships (project_id, entity_type, entity_id, added_by)
       VALUES ($1, 'document', $2, $3)
       ON CONFLICT (project_id, entity_type, entity_id) DO NOTHING`,
      [projectId, result.documentId, boardUser]
    );

    return {
      ok: true,
      documentId: result.documentId,
      chunkCount: result.chunkCount,
      classification: body.classification || classificationFloor,
    };
  });
}
