/** Build the synthetic Dev browser query without hand-quoted learner names. */
export function buildSyntheticLearnerLookup(name) {
  if (typeof name !== "string" || !name.trim() || name.length > 120) {
    throw new TypeError("Invalid synthetic learner label");
  }
  return `fetch('/v1/me/learners',{cache:'no-store'})
    .then(r=>r.json())
    .then(d=>d.learners.find(l=>l.name===${JSON.stringify(name)})?.id)`;
}
