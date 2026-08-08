import FALLBACK from '../../chatbot-prompt.txt'

export async function getSystemPrompt(langfuse) {
  try {
    if (langfuse) {
      const prompt = await langfuse.getPrompt('chatbot-system', undefined, {
        type: 'text', label: 'production', cacheTtlSeconds: 300,
      })
      return { text: prompt.prompt, version: prompt.version }
    }
  } catch { /* fallback to file */ }
  return { text: FALLBACK, version: 'file' }
}
