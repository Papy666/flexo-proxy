import OpenAI from "openai";

/* ---------------------------------- */
/*  OpenAI config */
/* ---------------------------------- */

function getClient() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;

  return new OpenAI({
    apiKey: key,
    timeout: 12000
  });
}

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

/* ---------------------------------- */
/*  Constants */
/* ---------------------------------- */

const ALLOWED_TONES = new Set([
  "neutral",
  "professional",
  "persuasive"
]);

/* ---------------------------------- */
/*  Utilities */
/* ---------------------------------- */

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sanitizeLang(lang) {
  const value = String(lang || "auto").trim();
  return value || "auto";
}

function extractNumbers(text = "") {
  return (String(text).match(/\b\d+[a-zA-Z]*\b/g) || []).sort();
}

function numbersChanged(a, b) {
  const na = extractNumbers(a);
  const nb = extractNumbers(b);

  if (na.length !== nb.length) return true;

  for (let i = 0; i < na.length; i++) {
    if (na[i] !== nb[i]) return true;
  }

  return false;
}

function looksSuspicious(input = "", output = "") {
  const a = String(input || "").trim();
  const b = String(output || "").trim();

  if (!a || !b) return true;

  const la = a.length;
  const lb = b.length;

  // Sortie ridiculement courte
  if (lb < Math.max(8, la * 0.25)) return true;

  // Sortie délirante trop longue
  if (lb > la * 2.4 + 120) return true;

  // Texte court : éviter les transformations absurdes
  if (la < 20 && lb > la * 3) return true;

  return false;
}

function cleanModelOutput(text = "") {
  return String(text || "")
    .trim()
    .replace(/^```[\s\S]*?\n?/, "")
    .replace(/```$/g, "")
    .replace(/^["“”]+|["“”]+$/g, "")
    .trim();
}

/* ---------------------------------- */
/*  Token protection */
/* ---------------------------------- */

function protectTokens(text = "") {
  const map = {};
  let i = 0;

  const protectedText = String(text).replace(
    /\b([A-Z]{2,}|\d+[a-zA-Z]*|[A-Za-z]*\d+[A-Za-z0-9-]*|https?:\/\/\S+|\S+@\S+\.\S+)\b/g,
    (match) => {
      const key = `__FLEXOTOK${i++}__`;
      map[key] = match;
      return key;
    }
  );

  return { protectedText, map };
}

function restoreTokens(text = "", map = {}) {
  let out = String(text || "");

  for (const key in map) {
    const raw = key.replaceAll("_", "");
    out = out.replaceAll(key, map[key]);
    out = out.replaceAll(raw, map[key]);
  }

  return out;
}

function sanitizeTone(tone) {
  const value = String(tone || "").toLowerCase().trim();

  return ALLOWED_TONES.has(value)
    ? value
    : "neutral";
}


/* ---------------------------------- */
/*  Prompt rules */
/* ---------------------------------- */

function buildCoreRules(tone = "neutral") {

  switch (tone) {

    case "professional":
      return [
        "- Preserve the original meaning, facts, promises, constraints, and intent.",
        "- You may improve sentence structure, clarity, professionalism, and readability.",
        "- You may slightly soften slang or rough phrasing when appropriate.",
        "- Do not invent context, urgency, benefits, apologies, or commitments.",
        "- Keep the message concise, credible, and natural."
      ].join("\n");

    case "persuasive":
      return [
		"Rewrite the text to make it clearer, stronger, and more convincing.",
		"Improve wording, rhythm, clarity, and perceived value.",
		"Make the message more compelling while staying natural and credible.",
		"You may actively rephrase and restructure sentences.",
		"Do not exaggerate or overstate weak opinions.",
		"Do not invent facts, urgency, guarantees, or fake marketing claims.",
		"Avoid hype, spam, clickbait, or overly emotional language.",
		"Keep the result concise, confident, and human."
	  ].join(" ");
	  
    case "neutral":
    default:
      return [
        "- Preserve the original meaning exactly.",
        "- Preserve the original tone, personality, roughness, humor, emotion, and writing style.",
        "- Stay extremely close to the original wording and structure.",
        "- Correct only spelling, grammar, punctuation, spacing, accents, and awkward phrasing.",
        "- Do not rewrite creatively.",
        "- Do not make the text more professional, persuasive, formal, polite, or elaborate.",
        "- When in doubt, make the smallest possible correction."
      ].join("\n");
  }
}


/* ---------------------------------- */
/*  Tone instructions */
/* ---------------------------------- */

function buildToneInstruction(tone = "neutral") {

  switch (tone) {

    case "professional":
      return [
        "Rewrite the text into polished professional communication.",
        "Improve clarity, structure, readability, grammar, and credibility.",
        "Keep the tone human, efficient, and natural.",
        "Avoid corporate jargon, robotic wording, or excessive formality."
      ].join(" ");

    case "persuasive":
      return [
        "Rewrite the text to make it more convincing, engaging, impactful, and appealing.",
        "The output should feel stronger, clearer, and more persuasive than the original.",
        "Improve rhythm, confidence, perceived value, and communication effectiveness.",
        "Do not simply correct grammar. Actively improve the persuasive power of the message.",
        "Keep it natural and credible."
      ].join(" ");

    case "neutral":
    default:
      return [
        "Correct the text conservatively while preserving the original voice and intent.",
        "Stay as close as possible to the original writing style.",
		"- Do not guess or reinterpret unclear words.",
		"- If a word is ambiguous, malformed, slang, invented, or unclear, keep it as close as possible to the original.",
		"- Do not replace unusual words with a different likely word unless the correction is obvious.",
		"- Preserve profanity and vulgar phrasing exactly, except for spelling and punctuation fixes.",
		"- Do not normalize slang into standard language."
      ].join(" ");
  }
}


/* ---------------------------------- */
/*  System prompt */
/* ---------------------------------- */

function buildSystemPrompt(tone = "neutral", lang = "auto") {

  return [
    "You are Flexo, a fast text optimization engine.",
    "",
    "Your job:",
    "- Correct grammar, spelling, punctuation, typography, spacing, and accents.",
    "- Apply the selected tone accurately.",
    "- Preserve important information and writing intent.",
    "- If a target language is specified, rewrite the text in that language.",
    "",
    "Core rules:",
    buildCoreRules(tone),
    "",
    "Additional instructions:",
	"- Preserve factual accuracy and the original core meaning.",
	"- Keep the original confidence level reasonably consistent.",
    buildToneInstruction(tone),
    "",
    `Selected tone: ${tone}`,
    `Target language: ${lang || "auto"}`,
    "",
    "Output rules:",
    "- Return ONLY the final optimized text.",
    "- No quotes.",
    "- No markdown.",
    "- No explanations.",
    "- No comments."
  ].join("\n");

}

function buildUserPrompt({ text, tone, lang }) {
  return [
    `Tone: ${tone}`,
    `Language: ${lang || "auto"}`,
    "",
    "Optimize the following text.",
    "",
    text || ""
  ].join("\n");
}

/* ---------------------------------- */
/*  Handler */
/* ---------------------------------- */

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  const { text, tone, lang } = req.body || {};

  const input = String(text ?? "");
  const currentTone = sanitizeTone(tone);
  const currentLang = sanitizeLang(lang);

  console.log("FLEXO OPTIMIZE REQ", {
    tone: currentTone,
    lang: currentLang,
    textLength: input.length
  });

  if (!input.trim()) {
    res.status(200).json({
      text: input,
      blocked: false
    });
    return;
  }

  const client = getClient();

  if (!client) {
    res.status(200).json({
      text: input,
      blocked: true,
      reason: "missing_api_key"
    });
    return;
  }

  try {
    const { protectedText, map } = protectTokens(input);

    const system = buildSystemPrompt(currentTone, currentLang);
    const user = buildUserPrompt({
      text: protectedText,
      tone: currentTone,
      lang: currentLang
    });

    const completion = await client.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0,
      top_p: 0.7,
      max_tokens: 700,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    });

    let output = cleanModelOutput(
      completion.choices?.[0]?.message?.content || ""
    );

    if (!output) {
      res.status(200).json({
        text: input,
        blocked: true,
        reason: "empty_output"
      });
      return;
    }

    output = restoreTokens(output, map).trim();

    if (numbersChanged(input, output)) {
      res.status(200).json({
        text: input,
        blocked: true,
        reason: "numbers_modified"
      });
      return;
    }

    if (looksSuspicious(input, output)) {
      res.status(200).json({
        text: input,
        blocked: true,
        reason: "suspicious_output"
      });
      return;
    }

    console.log("FLEXO OPTIMIZE OK", {
      model: OPENAI_MODEL,
      tone: currentTone,
      lang: currentLang,
      inputLength: input.length,
      outputLength: output.length
    });

    res.status(200).json({
      text: output,
      blocked: false
    });
  } catch (e) {
    console.error("FLEXO OPTIMIZE ERROR", {
      name: e?.name,
      message: e?.message,
      status: e?.status
    });

    res.status(200).json({
      text: input,
      blocked: true,
      reason: "exception",
      detail: e?.message || "unknown_error"
    });
  }
}