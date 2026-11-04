/** Continue the model turn without treating unavailable search as verified evidence. */
export function webSearchKnowledgeFallback(summary: string) {
  return {
    output:
      'Web search returned no usable sources. Continue the task using existing knowledge and user-provided material. ' +
      'Do not retry web_search for this request. Tell the user in their language that the answer is based on existing knowledge and was not verified online. ' +
      'Do not invent sources, citations, precise statistics, or current facts. If up-to-date facts are essential, explain what cannot be verified and ask for a source.',
    mutated: false,
    summary,
  }
}
