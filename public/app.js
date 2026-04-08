async function askNextQuestion(latestResponse){
  if(!state.config?.modelConfigured){
    addQuestionCard(
      'location',
      state.currentProblem
        ? `Where does "${state.currentProblem.title}" show up most clearly in the operation today?`
        : 'Select a problem first.',
      ''
    );
    return;
  }

  const payload = {
    session_id: state.sessionId,
    selected_pain_points: state.selectedProblems.map(p => p.title),
    active_problem: state.currentProblem.title,
    transcript: state.transcript,
    known_state: state.discovered[state.currentProblem.id],
    latest_response: latestResponse
  };

  try {
    const r = await fetch('/api/next-step', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });

    const text = await r.text();
    let data;

    try {
      data = JSON.parse(text);
    } catch (parseErr) {
      addQuestionCard(
        'error',
        'The AI guide could not process that response cleanly. Try asking: "What does that impact most day to day?"',
        'The server returned an unexpected response.'
      );
      return;
    }

    if(!r.ok || !data.ok){
      addQuestionCard(
        'error',
        'The AI guide hit an issue. Try this follow-up: "When that happens, what does it affect most?"',
        data?.error || 'Unknown server error'
      );
      return;
    }

    const result = data.result;
    state.discovered[state.currentProblem.id] = {
      title: state.currentProblem.title,
      ...(result.updated_state || {})
    };
    updateMetrics();

    if(result.stage === 'complete' || result.problem_complete){
      finishCurrentProblem(result);
      return;
    }

    addQuestionCard(
      result.stage || 'follow_up',
      result.next_question || 'What happens when that occurs?',
      result.question_rationale || ''
    );
  } catch (err) {
    addQuestionCard(
      'error',
      'Connection issue. Try this next question: "What tends to cause that?"',
      err.message || 'Network error'
    );
  }
}
