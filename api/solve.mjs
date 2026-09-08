const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4.1-flash-expires-on-0910";
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");

const SUBJECT_PROMPTS = {
  Math: `You are solving high-school math. Read notation, signs, exponents, fractions, radicals, graphs, labels, and units exactly.
Choose the simplest valid method for the level of the problem. Show clean algebra with one logical change per step.
Preserve exact values when useful, then give a decimal approximation only when it helps. Respect domain restrictions and units.
If a standard formula, identity, theorem, or equation is genuinely used, include a "Formula Used" section before the steps. Write the general formula first, then the relevant substitution. Do not invent a formula section for simple arithmetic or factoring.
Check the result by substitution, inverse operation, estimation, or another short verification when practical.`,
  English: `You are helping with high-school English language arts. First determine whether the task is reading comprehension, literary analysis, grammar, vocabulary, revision, or writing.
Base analysis on the provided passage or prompt. Never invent quotations, page numbers, citations, plot details, or evidence that is not visible or supplied.
For analysis, give a clear claim and connect evidence to reasoning. For grammar/revision, explain the specific rule and preserve the student's intended meaning and voice.
For writing, produce natural junior-level work that directly answers the assignment rather than sounding inflated or robotic.`,
  Science: `You are helping with high-school science. Identify the relevant concept, known values, unknowns, units, and assumptions before solving.
For quantitative problems, keep units throughout, convert units explicitly when needed, use appropriate significant figures, and sanity-check the magnitude.
If a standard scientific equation or relationship is genuinely used, include a "Formula Used" section before the steps. Define variables when useful and show the substitution. Do not add a formula section to purely conceptual questions.
For labs, diagrams, chemistry, biology, physics, and earth science, distinguish observations from conclusions and never invent measurements or labels that are unreadable.`,
  History: `You are helping with high-school history and social studies. Prioritize chronology, cause and effect, historical context, comparison, continuity/change, and the exact wording of the question.
Distinguish established facts from interpretation. Use evidence from supplied sources when present, but never fabricate quotations, dates, citations, or source details.
For document-based questions, identify the source's claim, perspective, context, and useful evidence. Keep explanations concise and directly tied to the prompt.`,
  Other: `You are helping with a high-school assignment in a subject that may not fit the main categories. Identify the discipline from the material and use its normal conventions.
Follow the assignment wording closely, explain at a junior-year level, and never invent unreadable or missing information.`
};

function subjectPrompt(subject) {
  return SUBJECT_PROMPTS[subject] || SUBJECT_PROMPTS.Other;
}

function promptFor(mode, subject) {
  const common = `You are Study Spark, a careful tutor for a U.S. high-school junior.
Read every attached image carefully and use all pages together when relevant.
Never invent unreadable text. If anything important is unclear, say exactly what cannot be read instead of guessing.
Return a short "thinking" field that summarizes the approach in plain language. It must be concise and useful, not hidden chain-of-thought.
Subject-specific instructions:
${subjectPrompt(subject)}`;

  if (mode === "answer") return `${common}
Return only the final answer the student needs in the sections array. Keep "thinking" to one short sentence and do not include steps or extra commentary.
Output strict JSON:
{"thinking":"Short approach summary.","sections":[{"type":"final","title":"Answer","content":"..."}]}`;

  if (mode === "quiz") return `${common}
Create an interactive multiple-choice quiz from the supplied text/images.
Use 5 questions unless the user explicitly requests another count. Every question must have exactly 4 options and exactly one objectively correct answer.
Return strict JSON only:
{"thinking":"Short summary of what material the quiz covers.","quiz":[{"question":"...","options":["...","...","...","..."],"correctIndex":0,"explanation":"Short explanation of why the correct answer is correct."}]}`;

  const modeText = mode === "teach"
    ? "Teach the concept clearly in junior-year high-school language. Explain why the steps work."
    : mode === "check"
    ? "Check the student's work. Identify the first mistake, explain it, then show the corrected solution. If the work is correct, verify it independently."
    : "Solve carefully and show concise, numbered reasoning.";

  return `${common}
${modeText}
Keep the output organized and easy to scan.
For Math or Science, include a formula section only when a real formula/equation/theorem is actually used. For English, History, or Other, do not create a formula section unless the assignment itself explicitly involves one.
Return strict JSON only in this schema:
{"thinking":"Short plain-language summary of the approach.","sections":[
  {"type":"summary","title":"What the problem is asking","content":"..."},
  {"type":"formula","title":"Formula Used","content":"..."},
  {"type":"steps","title":"Steps","content":"1. ...\\n2. ..."},
  {"type":"final","title":"Final Answer","content":"..."}
]}
Omit sections that are unnecessary. Never add a Quick Check section.`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });
  if (!process.env.DEEPSEEK_API_KEY) return res.status(500).json({ error: "Missing DEEPSEEK_API_KEY environment variable." });

  try {
    const { question = "", images = [], mode = "solve", subject = "Other" } = req.body || {};
    if (!question.trim() && !images.length) return res.status(400).json({ error: "Add a question or image." });
    if (!Array.isArray(images) || images.length > 10) return res.status(400).json({ error: "You can upload up to 10 images at once." });

    const safeSubject = Object.prototype.hasOwnProperty.call(SUBJECT_PROMPTS, subject) ? subject : "Other";
    const content = [{
      type: "text",
      text: `Subject: ${safeSubject}\nStudent level: high-school junior\nRequest: ${question.trim() || "Use the attached homework images."}`
    }];

    for (const img of images) {
      if (typeof img !== "string" || !/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(img)) {
        return res.status(400).json({ error: "Unsupported image format." });
      }
      content.push({ type: "image_url", image_url: { url: img, detail: "original" } });
    }

    const upstream = await fetch(BASE_URL + "/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.DEEPSEEK_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.15,
        max_tokens: 3200,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: promptFor(mode, safeSubject) },
          { role: "user", content }
        ]
      })
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: data?.error?.message || `DeepSeek API error (${upstream.status})` });
    }

    const message = data?.choices?.[0]?.message || {};
    const parsed = JSON.parse(message.content || "{}");
    const thinking = String(parsed?.thinking || message?.reasoning_content || "I read the request, identified the relevant information, and checked the result before answering.");

    if (mode === "quiz") {
      const quiz = Array.isArray(parsed.quiz)
        ? parsed.quiz.slice(0, 20).filter(q =>
            q && typeof q.question === "string" && Array.isArray(q.options) && q.options.length === 4 &&
            Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex < 4
          ).map(q => ({
            question: q.question,
            options: q.options.map(String),
            correctIndex: q.correctIndex,
            explanation: String(q.explanation || "")
          }))
        : [];

      if (!quiz.length) return res.status(502).json({ error: "The AI did not return a valid quiz." });
      return res.json({ quiz, thinking, model: MODEL });
    }

    const sections = Array.isArray(parsed.sections)
      ? parsed.sections.filter(s => s && s.content).map(s => ({
          type: String(s.type || "note"),
          title: String(s.title || "Answer"),
          content: String(s.content)
        }))
      : [];

    if (!sections.length) return res.status(502).json({ error: "The AI did not return a valid answer." });
    return res.json({ sections, thinking, model: MODEL });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: "The AI returned an invalid response. Try again." });
  }
}
