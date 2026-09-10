import express from "express";
import "dotenv/config";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.DEEPSEEK_API_KEY;
const configuredModel = process.env.DEEPSEEK_MODEL?.trim();
// deepseek-flash is the stable API ID for DeepSeek-V4.1-Flash.
// Ignore the temporary pre-release alias if it remains in an environment secret.
const MODEL = configuredModel && configuredModel !== "deepseek-v4.1-flash-expires-on-0910"
  ? configuredModel
  : "deepseek-flash";
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");

app.use(express.json({ limit: "45mb" }));
app.use(express.static("."));

function systemPrompt(mode) {
  const common =
    "You are Study Spark, a homework helper for a high-school student.\n" +
    "Be extremely concise. Give only the answer needed, with no introductions, restatement, long explanations, or repeated conclusion.\n" +
    "For multiple questions, use one compact numbered list. Aim for 1-2 short sentences or fewer than 30 words per numbered problem.\n" +
    "For math and science, show only the essential equation or work and the result. Do not create separate formula sections unless absolutely necessary.\n" +
    "Return a one-sentence thinking summary only; never reveal hidden chain-of-thought.";

  if (mode === "answer") return common + "\nReturn strict JSON with thinking and one final sections item titled Answer. Give only concise final answers.";
  if (mode === "quiz") return common + "\nCreate 5 concise multiple-choice questions with 4 short options each. Return strict JSON with thinking and quiz.";

  const modeText = mode === "teach"
    ? "Teach briefly, using no more than two short sentences per item."
    : mode === "check"
    ? "State the mistake and correction briefly, in one or two short sentences."
    : "Solve briefly. Show only essential work and the final result.";

  return common + "\n" + modeText +
    "\nReturn strict JSON with thinking and sections. Prefer one compact final section titled Answers containing all answers. Do not repeat answers in another section.";
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
  if (!sections.length || sections.some(s => hasPlaceholder(s.content) || hasPlaceholder(s.title))) return [];
  return sections.filter(s => {
    if (String(s.type).toLowerCase() !== "formula" && !/^formula\s*used$/i.test(s.title)) return true;
    return subject === "Math" || subject === "Science";
  });
}

function normalizeQuiz(parsed) {
  if (!Array.isArray(parsed?.quiz)) return [];
  return parsed.quiz.slice(0,20).filter(q => q && typeof q.question === "string" && !hasPlaceholder(q.question) && Array.isArray(q.options) && q.options.length === 4 && q.options.every(o => !hasPlaceholder(o)) && Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex < 4)
    .map(q => ({ question:q.question, options:q.options.map(String), correctIndex:q.correctIndex, explanation:String(q.explanation || "") }));
}

app.post("/api/solve", async (req, res) => {
  try {
    if (!API_KEY) return res.status(500).json({ error: "Missing DEEPSEEK_API_KEY in .env" });
    const { question = "", images = [], mode = "solve", subject = "Other" } = req.body || {};
    if (!question.trim() && !images.length) return res.status(400).json({ error: "Add a question or image." });
    if (!Array.isArray(images) || images.length > 10) return res.status(400).json({ error: "You can upload up to 10 images at once." });

    const safeSubject = ["Math", "English", "Science", "History", "Other"].includes(subject) ? subject : "Other";
    const content = [{ type:"text", text:`Subject: ${safeSubject}\nStudent level: high-school junior\nRequest: ${question.trim() || "Use the attached homework images."}` }];
    for (const img of images) {
      if (typeof img !== "string" || !/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(img)) return res.status(400).json({ error:"Unsupported image format." });
      content.push({ type:"image_url", image_url:{ url:img, detail:"original" } });
    }

    const baseMessages = [{ role:"system", content:systemPrompt(mode, safeSubject) }, { role:"user", content }];
    let messages = baseMessages;

    for (let attempt=0; attempt<2; attempt++) {
      const upstream = await fetch(`${BASE_URL}/chat/completions`, {
        method:"POST",
        headers:{ "Authorization":`Bearer ${API_KEY}`, "Content-Type":"application/json" },
        body:JSON.stringify({ model:MODEL, temperature:0.12, max_tokens:attempt===0?2400:3200, response_format:{ type:"json_object" }, messages })
      });
      const data = await upstream.json().catch(() => ({}));
      if (!upstream.ok) return res.status(upstream.status).json({ error:data?.error?.message || `DeepSeek API error (${upstream.status})` });

      const raw = data?.choices?.[0]?.message?.content || "";
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch {}

      if (mode === "quiz") {
        const quiz = normalizeQuiz(parsed);
        if (quiz.length) return res.json({ quiz, thinking:String(parsed?.thinking || "I used the supplied material to build the quiz."), model:MODEL });
      } else {
        const sections = normalizeSections(parsed, safeSubject);
        if (sections.length) return res.json({ sections, thinking:String(parsed?.thinking || "I solved each readable item and checked the response for completeness."), model:MODEL });
      }

      messages = baseMessages.concat([
        { role:"assistant", content:raw },
        { role:"user", content:"Your previous response was incomplete or contained placeholder/ellipsis text. Rewrite the entire answer as valid JSON. Give complete student-ready content for every requested item that is present. Do not use ellipses, placeholders, unfinished numbered lists, unrelated formulas, or a redundant final card." }
      ]);
    }

    return res.status(502).json({ error:"The AI returned an incomplete answer. Please try again." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error:"The server could not complete that request." });
  }
});

app.listen(PORT, () => {
  console.log(`Study Spark running at http://localhost:${PORT}`);
  console.log(`Model: ${MODEL}`);
});
