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
Never invent unreadable text. If an image is unclear, say exactly what cannot be read.
Always include a short "thinking" field that summarizes your approach in plain language. Keep it concise and useful, not hidden chain-of-thought.`;

  if (mode === "answer") return `${common}
Return ONLY the final answer the student needs in the sections array. No extra explanation in the answer itself.
Output strict JSON:
{"thinking":"Short summary of how you identified the answer.","sections":[{"type":"final","title":"Answer","content":"..."}]}`;

  if (mode === "quiz") return `${common}
Create an interactive multiple-choice quiz from the supplied text/images.
Use 5 questions unless the user explicitly requests another count. Every question must have exactly 4 options and exactly one objectively correct answer.
Return strict JSON only:
{"thinking":"Short summary of what material you used to build the quiz.","quiz":[{"question":"...","options":["...","...","...","..."],"correctIndex":0,"explanation":"Short explanation of why the correct answer is correct."}]}`;

  const modeText = mode === "teach"
    ? "Teach the concept clearly in junior-year high-school language. Explain why the steps work."
    : mode === "check"
    ? "Check the student's work. Identify the first mistake, explain it, then show the corrected solution. If correct, verify independently."
    : "Solve carefully and show concise, numbered reasoning.";

  return `${common}
${modeText}
Keep the output organized and easy to scan.
Return strict JSON only in this schema:
{"thinking":"Short plain-language summary of your approach.","sections":[
  {"type":"summary","title":"What the problem is asking","content":"..."},
  {"type":"steps","title":"Steps","content":"1. ...\\n2. ..."},
  {"type":"final","title":"Final Answer","content":"..."},
  {"type":"note","title":"Quick Check","content":"..."}
]}
Omit sections that are unnecessary. For math, verify the final result when practical.`;
}

app.post("/api/solve", async (req, res) => {
  try {
    if (!API_KEY) return res.status(500).json({ error: "Missing DEEPSEEK_API_KEY in .env" });

    const { question = "", images = [], mode = "solve", subject = "Other" } = req.body || {};
    if (!question.trim() && !images.length) return res.status(400).json({ error: "Add a question or image." });
    if (!Array.isArray(images) || images.length > 10) return res.status(400).json({ error: "You can upload up to 10 images at once." });

    const content = [{
      type: "text",
      text: `Subject: ${subject}\nStudent level: high-school junior\nRequest: ${question.trim() || "Use the attached homework images."}`
    }];

    for (const img of images) {
      if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(img)) {
        return res.status(400).json({ error: "Unsupported image format." });
      }
      content.push({ type: "image_url", image_url: { url: img, detail: "original" } });
    }

    const upstream = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.15,
        max_tokens: 3200,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt(mode) },
          { role: "user", content }
        ]
      })
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: data?.error?.message || `DeepSeek API error (${upstream.status})`
      });
    }

    const message = data?.choices?.[0]?.message || {};
    const raw = message.content || "";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(502).json({ error: "The AI returned an invalid format. Try again." });
    }

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
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "The server could not complete that request." });
  }
});

app.listen(PORT, () => {
  console.log(`Study Spark running at http://localhost:${PORT}`);
  console.log(`Model: ${MODEL}`);
});
