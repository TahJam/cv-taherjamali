/**
 * Shared types across the chat surfaces.
 *
 * RagSource lived in two places until Phase 5b: FloatingChat.tsx (correct) and
 * useVoiceMode.ts (stale — still declared the `_es`/`_en` dual-path fields the
 * Phase 2 bilingual removal deleted from api/_shared/rag.js, so every voice
 * source badge resolved to `undefined`). Defined once here so it can't drift
 * a third time. Shape must match `extractSources()`/`HOME_SOURCE` in
 * cv-chat-service/api/_shared/rag.js.
 */
export interface RagSource {
  article_id: string;
  section_id: string;
  section_anchor: string;
  page_path: string;
  article_slug: string;
}
