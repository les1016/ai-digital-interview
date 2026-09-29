export const ACKNOWLEDGMENT_ID = 'acknowledge_ok_v1'

export function shouldAcknowledge(result) {
  return Boolean(result && !result.invalid_answer && !result.should_finish
    && !result.recovered_messages && result.avatar_cue?.id === ACKNOWLEDGMENT_ID
    && result.agent_decision?.response_intent === 'acknowledge'
    && ['follow_up', 'next_topic'].includes(result.agent_decision?.action))
}

// Use only AFTER a completed audible acknowledgment. Never mutate stored
// questions/transcripts, or remove an introductory phrase when playback fails.
export function afterAcknowledgment(text) {
  const stripped = String(text || '').replace(/^(?:嗯[，,、\s]*)?好的[，。！!,.：:\s]+/u, '').trim()
  return stripped || text
}
