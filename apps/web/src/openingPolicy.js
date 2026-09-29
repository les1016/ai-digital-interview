import manifest from './data/openingRules.json'
export { manifest as openingManifest }
export function openingPolicyMatches(policy) {
  return Boolean(policy && Object.entries(manifest.policy).every(([key,value]) => Number(policy[key]) === value))
}
export function openingQuestionAfterVideo(response, outcome) {
  return outcome === 'completed' && openingPolicyMatches(response?.briefing_policy)
    && typeof response?.opening_question === 'string' && response.opening_question.trim()
    ? response.opening_question : response.question
}
