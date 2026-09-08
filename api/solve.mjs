const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4.1-flash-expires-on-0910";
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");

function promptFor(mode) {
  const common = "You are Study Spark, a careful tutor for a U.S. high-school junior. Read every attached image carefully and use all pages together. Never invent unreadable text.";
  if (mode === "answer") return common + " Return ONLY the final answer. Strict JSON: {\"sections\":[{\"type\":\"final\",\"title\":\"Answer\",\"content\":\"...\"}]}";
  if (mode === "quiz") return common + " Create 5 multiple-choice questions unless another count is requested. Exactly 4 options and one correct answer each. Strict JSON: {\"quiz\":[{\"question\":\"...\",\"options\":[\"...\",\"...\",\"...\",\"...\"],\"correctIndex\":0,\"explanation\":\"...\"}]}";
  const task = mode === "teach" ? "Teach clearly and explain why the steps work." : mode === "check" ? "Check the student's work, identify the first mistake, then correct it; verify correct work independently." : "Solve carefully with concise numbered reasoning.";
  return common + " " + task + " Return strict JSON: {\"sections\":[{\"type\":\"summary\",\"title\":\"...\",\"content\":\"...\"},{\"type\":\"steps\",\"title\":\"Steps\",\"content\":\"...\"},{\"type\":\"final\",\"title\":\"Final Answer\",\"content\":\"...\"},{\"type\":\"note\",\"title\":\"Quick Check\",\"content\":\"...\"}]} Omit unnecessary sections.";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });
  if (!process.env.DEEPSEEK_API_KEY) return res.status(500).json({ error: "Missing DEEPSEEK_API_KEY environment variable." });
  try {
    const { question = "", images = [], mode = "solve", subject = "Other" } = req.body || {};
    if (!question.trim() && !images.length) return res.status(400).json({ error: "Add a question or image." });
    if (!Array.isArray(images) || images.length > 10) return res.status(400).json({ error: "You can upload up to 10 images at once." });
    const content = [{ type: "text", text: `Subject: ${subject}\nStudent level: high-school junior\nRequest: ${question.trim() || "Use the attached homework images."}` }];
    for (const img of images) {
      if (typeof img !== "string" || !/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(img)) return res.status(400).json({ error: "Unsupported image format." });
      content.push({ type: "image_url", image_url: { url: img, detail: "original" } });
    }
    const upstream = await fetch(BASE_URL + "/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.DEEPSEEK_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, temperature: 0.15, max_tokens: 3200, response_format: { type: "json_object" }, messages: [{ role: "system", content: promptFor(mode) }, { role: "user", content }] })
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return res.status(upstream.status).json({ error: data?.error?.message || `DeepSeek API error (${upstream.status})` });
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content || "{}");
    if (mode === "quiz") {
      const quiz = Array.isArray(parsed.quiz) ? parsed.quiz.slice(0, 20).filter(q => q && typeof q.question === "string" && Array.isArray(q.options) && q.options.length === 4 && Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex < 4).map(q => ({ question: q.question, options: q.options.map(String), correctIndex: q.correctIndex, explanation: String(q.explanation || "") })) : [];
      if (!quiz.length) return res.status(502).json({ error: "The AI did not return a valid quiz." });
      return res.json({ quiz, model: MODEL });
    }
    const sections = Array.isArray(parsed.sections) ? parsed.sections.filter(s => s && s.content).map(s => ({ type: String(s.type || "note"), title: String(s.title || "Answer"), content: String(s.content) })) : [];
    if (!sections.length) return res.status(502).json({ error: "The AI did not return a valid answer." });
    return res.json({ sections, model: MODEL });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: "The AI returned an invalid response. Try again." });
  }
}
