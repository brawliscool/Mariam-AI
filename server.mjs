import express from "express";
import "dotenv/config";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.DEEPSEEK_API_KEY;
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4.1-flash-expires-on-0910";
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");

app.use(express.json({ limit: "45mb" }));
app.use(express.static("."));

function systemPrompt(mode) {
  const common = `You are Study Spark, a careful tutor for a U.S. high-school junior.
Read every attached image carefully and use all pages together when relevant.
Never invent unreadable text. If something necessary cannot be read, state exactly what is unreadable instead of guessing.
If the image contains multiple numbered questions, answer EVERY readable numbered question completely unless the user explicitly asks for only some items.
NEVER output placeholder text, unfinished lists, template filler, or ellipses. Never write partial entries. Every returned section must contain complete student-ready content.
Do not create a redundant Final Answer card when an Answers card already contains the complete final answers to multiple questions.
Return a short "thinking" field that summarizes the approach in plain language.`;

  if (mode === "answer") return `${common}\nReturn only the complete final answer(s). For multiple numbered questions, return all answers in one complete numbered Answer section. Return strict JSON with keys thinking and sections.`;
  if (mode === "quiz") return `${common}\nCreate a multiple-choice quiz with exactly four complete options per question and one correct answer. Return strict JSON with keys thinking and quiz. No placeholders or ellipses.`;

  const modeText = mode === "teach" ? "Teach clearly and explain why the steps work." : mode === "check" ? "Check the student's work, identify the first mistake, and show the corrected solution." : "Solve carefully with concise numbered reasoning.";
  return `${common}\n${modeText}\nFor a single problem, use only useful sections from summary, optional formula, steps, final. For multiple numbered problems, prefer one complete Answers section containing every numbered answer plus Steps only if needed. Formula Used may contain only formulas actually applied to the current problem(s), tied to the question number when there are several. Never list unrelated formulas. Never add Quick Check. Return strict JSON with keys thinking and sections.`;
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
        body:JSON.stringify({ model:MODEL, temperature:0.12, max_tokens:attempt===0?5200:6500, response_format:{ type:"json_object" }, messages })
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
        { role:"user", content:"Your previous response was incomplete or contained placeholder/ellipsis text. Rewrite the entire answer as valid JSON. Give complete student-ready content for every readable requested item. Do not use ellipses, placeholders, unfinished numbered lists, unrelated formulas, or a redundant final card." }
      ]);
    }

    return res.status(502).json({ error:"The AI returned an incomplete answer. Please try again with a clearer photo." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error:"The server could not complete that request." });
  }
});

app.listen(PORT, () => {
  console.log(`Study Spark running at http://localhost:${PORT}`);
  console.log(`Model: ${MODEL}`);
});
