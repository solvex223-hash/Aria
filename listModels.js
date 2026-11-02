// listModels.js - lists Groq models available to your API key
const key = process.env.GROQ_API_KEY;
if (!key) {
  console.error('❌ GROQ_API_KEY not found. Check your .env file.');
  process.exit(1);
}

(async () => {
  const res = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('❌ Groq error:', JSON.stringify(data));
    process.exit(1);
  }
  const ids = data.data.map(m => m.id).sort();
  console.log(`✅ ${ids.length} models available:\n`);
  ids.forEach(id => console.log(' -', id));
  console.log('\n🔎 Likely vision models:');
  ids.filter(id => /llama-4|qwen|vision|scout|maverick/i.test(id))
     .forEach(id => console.log(' -', id));
})();