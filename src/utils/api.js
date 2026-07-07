// DeepSeek API 封装
const DEEPSEEK_API = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-v4-flash';

async function callDeepSeek(apiKey, messages, maxTokens = 2000) {
  const resp = await fetch(DEEPSEEK_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: maxTokens,
      temperature: 0.7,
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`DeepSeek API error ${resp.status}: ${err}`);
  }
  const data = await resp.json();
  return data.choices[0].message.content;
}

// ── AI 招呼语生成 ──
async function generateGreeting(apiKey, resume, jdSamples, category) {
  const systemPrompt = `你是求职者的求职助手。根据求职者的简历和目标岗位类别的典型JD，生成一段100-150字的招呼语。

核心要求：
- 让HR感觉你认真读过JD，且自己的经历与之高度匹配
- 展现胜任该岗位的自信，但不过度、不骄傲
- 语气专业、真诚`;

  const userPrompt = `[简历内容]
${resume || '（未提供简历全文）'}

[岗位类别画像]
类别：${category}
典型JD样本（含职位名+标签）：
${jdSamples.map((jd, i) => `${i + 1}. ${jd.title}\n   ${jd.tags?.join(' / ') || ''}\n   ${jd.desc?.slice(0, 200) || ''}`).join('\n\n')}

请先提炼：这类岗位需要什么核心能力、经验特质？
然后：将简历中的具体经验与之匹配，生成招呼语。

[输出要求]
1. 以"您好"开头
2. 100-150字
3. 固定结尾"以下是我的简历"`;

  return callDeepSeek(apiKey, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ], 500);
}

// ── AI 招呼语重写 ──
async function rewriteGreeting(apiKey, originalGreeting, instruction) {
  const messages = [
    { role: 'system', content: '你是求职助手，帮助用户优化招呼语。保持专业、真诚的语气。' },
    { role: 'user', content: `原招呼语：\n"${originalGreeting}"\n\n请根据以下要求重写：${instruction}\n\n输出要求：100-150字，以"您好"开头，以"以下是我的简历"结尾。` },
  ];
  return callDeepSeek(apiKey, messages, 500);
}
