const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4.1-flash-expires-on-0910";
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");

const SUBJECT_PROMPTS = {
  Math: `You are solving high-school math. Read notation, signs, exponents, fractions, radicals, graphs, labels, and units exactly.
Choose the simplest valid method. Show clean algebra with one logical change per step. Preserve exact values when useful and respect domain restrictions and units.
A Formula Used section is allowed only when a specific standard formula, identity, theorem, or equation is actually applied to the current problem. Never list a general math formula sheet. If included, show only the formula(s) actually used and the relevant substitution.
Check the result by substitution, inverse operation, estimation, or another short verification when practical.`,
  English: `You are helping with high-school English language arts. Determine whether the task is reading comprehension, literary analysis, grammar, vocabulary, revision, or writing.
Base analysis only on the supplied passage or prompt. Never invent quotations, page numbers, citations, plot details, or evidence.
For analysis, give a clear claim and connect evidence to reasoning. For grammar/revision, explain the rule and preserve the student's intended meaning and voice. For writing, produce natural junior-level work that directly answers the assignment.`,
  Science: `You are helping with high-school science. Identify the actual branch and task first: biology, chemistry, physics, earth/environmental science, anatomy, genetics, lab work, or another science area.
For quantitative problems, identify known values, unknowns, units, and assumptions; keep units through the work; convert units explicitly when needed; use appropriate significant figures; sanity-check the magnitude.
A Formula Used section is allowed only when a formula/equation is actually required by one of the current visible questions. Never output a general science formula list. For conceptual biology, ecology, genetics, vocabulary, classification, reading, or explanation questions, omit Formula Used unless an equation is genuinely used.
If multiple questions are visible, solve each numbered item completely and keep formulas tied to the specific item that uses them. Never invent measurements, labels, or unreadable text.`,
  History: `You are helping with high-school history and social studies. Prioritize chronology, cause and effect, context, comparison, continuity/change, and the exact wording of the question.
Distinguish established facts from interpretation. Use supplied sources when present, but never fabricate quotations, dates, citations, or source details. For document-based questions, identify the source's claim, perspective, context, and useful evidence.`,
  Other: `You are helping with a high-school assignment in another subject. Identify the discipline from the material and use its normal conventions. Follow the assignment wording closely, explain at a junior-year level, and never invent unreadable or missing information.`
};

function subjectPrompt(subject) {
  return SUBJECT_PROMPTS[subject] || SUBJECT_PROMPTS.Other;
}

function promptFor(mode, subject) {
  const common = `You are Study Spark, a careful tutor for a U.S. high-school junior.
Read every attached image carefully and use all pages together when relevant.
Never invent unreadable text. If something necessary cannot be read, state exactly what is unreadable instead of guessing.
If the image contains multiple numbered questions, answer EVERY readable numbered question completely. Do not stop after one or two items unless the user explicitly asks for only those items.
NEVER output placeholder text, unfinished lists, template filler, or ellipses such as three dots or the single ellipsis character. Never write partial entries like "1. answer..." or "2. ...". Every returned section must contain complete student-ready content.
Do not create a redundant Final Answer card when an Answers card already contains the complete final answers to multiple questions.
Return a short "thinking" field that summarizes the approach in plain language. It must be concise and useful, not hidden chain-of-thought.
Subject-specific instructions:
${subjectPrompt(subject)}`;

  if (mode === "answer") return `${common}
Return only the complete final answer(s) the student needs. For multiple numbered questions, return all answers in one complete numbered Answer section. No steps or extra commentary.
Return strict JSON with keys "thinking" and "sections". The sections array must contain one object with type "final", title "Answer", and complete content. Do not use placeholder examples.`;

  if (mode === "quiz") return `${common}
Create an interactive multiple-choice quiz from the supplied text/images. Use 5 questions unless another count is requested. Every question must have exactly 4 complete options and exactly one objectively correct answer.
Return strict JSON with keys "thinking" and "quiz". Each quiz item must include question, options, correctIndex, and explanation. No placeholders or ellipses.`;

  const modeText = mode === "teach"
    ? "Teach the concept clearly in junior-year high-school language and explain why the steps work."
    : mode === "check"
    ? "Check the student's work. Identify the first mistake, explain it, then show the corrected solution. If correct, verify it independently."
    : "Solve carefully and show concise, numbered reasoning.";

  return `${common}
${modeText}
Keep the output organized and easy to scan.
For a SINGLE problem, use only the useful sections from: summary, optional formula, steps, final.
For MULTIPLE numbered problems, prefer one complete Answers section (type "final", title "Answers") containing every numbered answer, plus Steps only if needed. Do not add another Final Answer section that merely repeats the Answers section.
Formula Used rules: include a formula section only when a formula/equation/theorem is ACTUALLY applied in the solution. Include only the exact formula(s) used for the current problem(s), and identify the question number when there are multiple problems. Never list unrelated formulas just because they belong to the selected subject.
Return strict JSON with keys "thinking" and "sections". Each section object must have type, title, and complete content. Never add Quick Check. Never use placeholders or ellipses.`;
}

function contentText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join(" ");
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
  }
  return "";
}

function cleanModelText(value) {
  const fence = String.fromCharCode(96).repeat(3);
  return String(value || "").replace(/<think>[\s\S]*?<\/think>/gi, "").split(fence).join("").replace(/^json\s*/i, "").trim();
}

function extractJson(value) {
  const text = cleanModelText(value);
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return null;
}

function parseModelPayload(message) {
  const content = contentText(message.content);
  const reasoning = contentText(message.reasoning_content);
  for (const candidate of [content, reasoning]) {
    const parsed = extractJson(candidate);
    if (parsed !== null) return { parsed, content: cleanModelText(content) };
  }
  return { parsed: null, content: cleanModelText(content) };
}

function hasPlaceholder(value) {
  const text = String(value || "").trim();
  if (!text) return true;
  return /(?:\.\.\.|…)|\b(?:placeholder|tbd|to be filled|insert answer|answer here)\b/i.test(text);
}

function normalizeSections(parsed, subject) {
  if (!Array.isArray(parsed?.sections)) return [];
  const sections = parsed.sections
    .filter(s => s && s.content !== undefined && String(s.content).trim())
    .map(s => ({ type: String(s.type || "note"), title: String(s.title || "Answer"), content: String(s.content).trim() }))
    .filter(s => !/^quick\s*check$/i.test(s.title));

  if (!sections.length) return [];
  if (sections.some(s => hasPlaceholder(s.content) || hasPlaceholder(s.title))) return [];

  return sections.filter(s => {
    if (String(s.type).toLowerCase() !== "formula" && !/^formula\s*used$/i.test(s.title)) return true;
    return subject === "Math" || subject === "Science";
  });
}

function normalizeQuiz(parsed) {
  if (!Array.isArray(parsed?.quiz)) return [];
  const quiz = parsed.quiz.slice(0, 20).filter(q =>
    q && typeof q.question === "string" && !hasPlaceholder(q.question) &&
    Array.isArray(q.options) && q.options.length === 4 && q.options.every(o => !hasPlaceholder(o)) &&
    Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex < 4
  ).map(q => ({ question: q.question, options: q.options.map(String), correctIndex: q.correctIndex, explanation: String(q.explanation || "") }));
  return quiz;
}

async function callModel(apiKey, messages, jsonMode, maxTokens) {
  const body = { model: MODEL, temperature: 0.12, max_tokens: maxTokens, messages };
  if (jsonMode) body.response_format = { type: "json_object" };
  return fetch(BASE_URL + "/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });
  if (!process.env.DEEPSEEK_API_KEY) return res.status(500).json({ error: "Missing DEEPSEEK_API_KEY environment variable." });

  try {
    const { question = "", images = [], mode = "solve", subject = "Other" } = req.body || {};
    if (!question.trim() && !images.length) return res.status(400).json({ error: "Add a question or image." });
    if (!Array.isArray(images) || images.length > 10) return res.status(400).json({ error: "You can upload up to 10 images at once." });

    const safeSubject = Object.prototype.hasOwnProperty.call(SUBJECT_PROMPTS, subject) ? subject : "Other";
    const content = [{ type: "text", text: "Subject: " + safeSubject + "\nStudent level: high-school junior\nRequest: " + (question.trim() || "Use the attached homework images.") }];
    for (const img of images) {
      if (typeof img !== "string" || !/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(img)) return res.status(400).json({ error: "Unsupported image format." });
      content.push({ type: "image_url", image_url: { url: img, detail: "original" } });
    }

    const baseMessages = [
      { role: "system", content: promptFor(mode, safeSubject) },
      { role: "user", content }
    ];
    let messages = baseMessages;

    for (let attempt = 0; attempt < 2; attempt++) {
      const upstream = await callModel(process.env.DEEPSEEK_API_KEY, messages, true, attempt === 0 ? 5200 : 6500);
      const data = await upstream.json().catch(() => ({}));
      if (!upstream.ok) return res.status(upstream.status).json({ error: data?.error?.message || ("DeepSeek API error (" + upstream.status + ")") });

      const message = data?.choices?.[0]?.message || {};
      const result = parseModelPayload(message);

      if (mode === "quiz") {
        const quiz = normalizeQuiz(result.parsed);
        if (quiz.length) return res.json({ quiz, thinking: String(result.parsed?.thinking || "I used the supplied material to build the quiz."), model: MODEL });
      } else {
        const sections = normalizeSections(result.parsed, safeSubject);
        if (sections.length) return res.json({ sections, thinking: String(result.parsed?.thinking || "I read the request, solved each readable item, and checked the response for completeness."), model: MODEL });
      }

      const previous = result.content || JSON.stringify(result.parsed || {});
      messages = baseMessages.concat([
        { role: "assistant", content: previous },
        { role: "user", content: "Your previous response was incomplete or contained placeholder/ellipsis text. Rewrite the entire answer as valid JSON. Give complete student-ready content for every readable requested item. Do not use ellipses, placeholders, unfinished numbered lists, unrelated formulas, or a redundant final card." }
      ]);
    }

    return res.status(502).json({ error: "The AI returned an incomplete answer. Please try again with a clearer photo." });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: "The AI returned an invalid response. Try again." });
  }
}
