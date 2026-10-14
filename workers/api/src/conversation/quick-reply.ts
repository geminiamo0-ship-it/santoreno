/**
 * Deliberately narrow, deterministic quick replies. This classifier is NOT
 * trusted to grant access or to decide a medical fact. Ambiguity goes to RAG.
 */
export type QuickReplyIntent = "greeting" | "thanks" | "identity" | "study_clarification";

export function classifyQuickReply(text: string): QuickReplyIntent | null {
  const normalized = text.trim().toLowerCase().replace(/[!?؟،.,!\s]+$/gu, "").trim();
  if (normalized.length > 100) return null;
  if (/^(hi|hello|hey|hiya|hey santo|hi santo|hello santo|اهلا|أهلا|مرحبا|مرحباً|هاي|هلا|السلام عليكم|صباح الخير|مساء الخير)( يا سانتو| santo)?$/u.test(normalized)) {
    return "greeting";
  }
  if (/^(thanks|thank you|thank you santo|thx|شكرا|شكراً|شكرا يا سانتو|تسلم|متشكر)$/u.test(normalized)) {
    return "thanks";
  }
  if (/^(who are you|what do you do|انت مين|أنت مين|مين سانتو|ايه سانتو|إيه سانتو)$/u.test(normalized)) {
    return "identity";
  }
  if (/^(i don't know where to start studying|مش عارف ابدأ مذاكرة منين|مش عارف أبدأ مذاكرة منين|مش عارف أنظم مذاكرتي)$/u.test(normalized)) {
    return "study_clarification";
  }
  return null;
}

export function quickReply(intent: QuickReplyIntent, input: string): string {
  const arabic = /[\u0600-\u06ff]/u.test(input);
  switch (intent) {
    case "greeting":
      return arabic
        ? "أهلًا بيك! أنا Santo، مساعدك للتعليم الطبي. تحب نذاكر موضوع معين أو نراجع سؤال؟"
        : "Hi! I'm Santo, your Medical Education Copilot. What would you like to study today?";
    case "thanks":
      return arabic ? "العفو! تحب نراجع موضوع طبي تاني؟" : "You're welcome! Want to explore another medical topic?";
    case "identity":
      return arabic
        ? "أنا Santo، مساعد للتعليم الطبي والمراجعة. أقدر أشرح المفاهيم الطبية وأساعدك في الأسئلة بالمراجع المتاحة."
        : "I'm Santo, a Medical Education Copilot. I help you study medical concepts and review questions using available verified sources.";
    case "study_clarification":
      return arabic
        ? "نقدر ننظم المذاكرة سوا. بتذاكر لأي امتحان، وفاضل قد إيه عليه؟"
        : "I can help plan your studies. Which medical exam are you preparing for, and when is it?";
  }
}
