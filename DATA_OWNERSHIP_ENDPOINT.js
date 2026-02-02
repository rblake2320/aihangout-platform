// DATA OWNERSHIP API ENDPOINT - ADD TO WORKER.JS BEFORE THE "Serve frontend assets" SECTION
// This endpoint captures all data ownership events for competitive advantage

// Data Ownership Collection Endpoint
router.post('/api/data-ownership', async (request, env) => {
  try {
    const authResult = await authenticateRequest(request, env);

    // Allow both authenticated and anonymous data collection for maximum capture
    const body = await request.json();
    const { events, session_id, timestamp } = body;

    console.log('🎯 DATA OWNERSHIP: Received events for competitive advantage', {
      eventCount: events?.length || 0,
      sessionId: session_id,
      authenticated: authResult.success
    });

    // Ensure data ownership table exists
    await env.AIHANGOUT_DB.prepare(`
      CREATE TABLE IF NOT EXISTS data_ownership_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id VARCHAR(255) NOT NULL,
        user_id INTEGER,
        event_type VARCHAR(100) NOT NULL,
        category VARCHAR(50) NOT NULL,
        event_data TEXT NOT NULL,
        metadata TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        competitive_value_score FLOAT DEFAULT 1.0,
        patent_evidence BOOLEAN DEFAULT TRUE
      )
    `).run();

    // Process and store each event for competitive advantage
    const insertPromises = events?.map(async (event) => {
      const competitiveValueScore = calculateCompetitiveValue(event);

      return env.AIHANGOUT_DB
        .prepare(`
          INSERT INTO data_ownership_events (
            session_id, user_id, event_type, category, event_data,
            metadata, competitive_value_score, patent_evidence
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          session_id || event.sessionId,
          authResult.success ? authResult.user.id : null,
          event.eventType,
          event.category,
          JSON.stringify(event.data),
          JSON.stringify(event.metadata),
          competitiveValueScore,
          true
        )
        .run();
    }) || [];

    await Promise.all(insertPromises);

    // Log analytics for patent evidence
    await env.AIHANGOUT_DB
      .prepare(`
        INSERT INTO analytics_events (
          event_type, user_id, session_id, timestamp, page_url,
          user_type, event_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        'data_ownership_capture',
        authResult.success ? authResult.user.id : null,
        session_id,
        new Date().toISOString(),
        '/api/data-ownership',
        authResult.success ? 'authenticated' : 'anonymous',
        JSON.stringify({
          events_captured: events?.length || 0,
          competitive_intelligence: true,
          patent_evidence: true
        })
      )
      .run();

    return new Response(JSON.stringify({
      success: true,
      message: 'Data ownership events captured for competitive advantage',
      events_processed: events?.length || 0,
      competitive_value: 'HIGH',
      patent_evidence_logged: true,
      timestamp: new Date().toISOString()
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Data ownership capture failed:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Data capture failed',
      details: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Helper function to calculate competitive value of captured data
function calculateCompetitiveValue(event) {
  let score = 1.0;

  // High value events for competitive advantage
  if (event.eventType === 'conversation_complete') score += 2.0;
  if (event.eventType === 'problem_solving_session') score += 1.5;
  if (event.eventType === 'ai_learning_event') score += 1.5;
  if (event.eventType === 'search_event') score += 1.0;

  // Enterprise data is extra valuable
  if (event.data?.collaboration_type === 'human_ai_hybrid') score += 1.0;
  if (event.data?.enterprise_usage) score += 0.5;

  return Math.min(score, 5.0); // Cap at 5.0
}