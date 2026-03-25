require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');

// ====== CẤU HÌNH HỆ THỐNG NÂNG CAO ======
const OWNER_ID = process.env.OWNER_ID || "411001618662686721"; // Minh Chủ MrBaii
const PROTECTORS = ["215428376150802432", "872344973402595399"];

const PROTECTED_NAMES = ["mrbai", "mrbaii", "bai", "baii", "hcoii", "hiền còii", "hiencoii"];
const TAM_GIAC_ALIASES = ["tam giác", "tamgiac", "độc cô cầu bại"];
const BLACKLIST_NAMES = ["default", "shinei", "defau", "firered", "tako", "phong", "lâm", "lê thế lâm", "le the lam", "the lam", "lam", "ltl"];

// Load API Keys từ file gemini-keys.json
let apiKeys = [];
let currentKeyIndex = 0;

// Danh sách các đường dẫn có thể chứa gemini-keys.json
const possibleKeyPaths = [
  '/etc/secrets/gemini-keys.json',                         // Render/Railway secrets (ưu tiên)
  path.join(__dirname, '..', 'gemini-keys.json'),          // Thư mục gốc của app
  path.join(process.cwd(), 'gemini-keys.json'),            // Working directory
  '/opt/render/project/gemini-keys.json',                  // Render root
];

console.log(`[Boruto] Đang tìm API keys...`);
console.log(`[Boruto] __dirname: ${__dirname}`);
console.log(`[Boruto] process.cwd(): ${process.cwd()}`);

for (const keysPath of possibleKeyPaths) {
  try {
    console.log(`[Boruto] Kiểm tra: ${keysPath} - exists: ${fs.existsSync(keysPath)}`);
    if (fs.existsSync(keysPath)) {
      const keysData = fs.readFileSync(keysPath, 'utf8');
      console.log(`[Boruto] Nội dung file (${keysPath}): ${keysData.substring(0, 100)}...`);
      const parsed = JSON.parse(keysData);
      
      // Hỗ trợ cả 2 format:
      // 1. Array đơn giản: ["key1", "key2"]
      // 2. Object với keys array: { "keys": ["key1", "key2"], "currentIndex": 0 }
      if (Array.isArray(parsed) && parsed.length > 0) {
        apiKeys = parsed;
        console.log(`[Boruto] ✅ Đã load ${apiKeys.length} API keys (array format) từ: ${keysPath}`);
        break;
      } else if (parsed.keys && Array.isArray(parsed.keys) && parsed.keys.length > 0) {
        apiKeys = parsed.keys;
        currentKeyIndex = parsed.currentIndex || 0;
        console.log(`[Boruto] ✅ Đã load ${apiKeys.length} API keys (object format) từ: ${keysPath}, currentIndex: ${currentKeyIndex}`);
        break;
      } else {
        console.log(`[Boruto] ⚠️ File không đúng format: ${keysPath}`);
      }
    }
  } catch (error) {
    console.error(`[Boruto] Lỗi parse ${keysPath}:`, error.message);
  }
}

// Fallback: thử load từ env variable nếu không tìm thấy file
if (apiKeys.length === 0 && process.env.GOOGLE_API_KEY) {
  apiKeys = process.env.GOOGLE_API_KEY.split(',').map(k => k.trim());
  console.log(`[Boruto] Fallback: Đã load ${apiKeys.length} API keys từ env GOOGLE_API_KEY`);
}

if (apiKeys.length === 0) {
  console.error("[Boruto] ❌ KHÔNG CÓ API KEY! Vui lòng kiểm tra gemini-keys.json hoặc GOOGLE_API_KEY trong .env");
}

// ====== HỆ THỐNG MEMORY NÂNG CAO ======
const conversationMemory = new Map(); // Lưu lịch sử hội thoại theo userId
const topicTracking = new Map(); // Lưu chủ đề theo userId
const MEMORY_TURNS = 10; // Số lượt nhớ gần nhất
const MAX_TOPICS = 6; // Số chủ đề tối đa theo dõi

// Khởi tạo Client Discord
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Helper: Kiểm tra từ khóa
const hasAny = (msg, arr) => arr.some(k => msg.includes(k.toLowerCase()));
const random = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ====== HỆ THỐNG WEB SEARCH ======
async function searchWeb(query) {
  try {
    const searchUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const response = await fetch(searchUrl, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Search error: ${response.status}`);
    
    const payload = await response.json();
    const results = [];
    
    if (payload.AbstractText && payload.AbstractURL) {
      results.push({ title: payload.Heading?.trim() || "Kết quả", body: payload.AbstractText.slice(0, 200), href: payload.AbstractURL });
    }
    
    for (const topic of (payload.RelatedTopics || []).slice(0, 2)) {
      if (topic.Text) results.push({ title: "Liên quan", body: topic.Text.slice(0, 200), href: topic.FirstURL });
    }
    
    if (results.length === 0) return "Không tìm thấy thông tin trên web.";
    
    return results.map((r, i) => `[${i+1}] ${r.title}\n   ${r.body}\n   Nguồn: ${r.href}`).join("\n\n");
  } catch (error) {
    console.error("[Web Search] Lỗi:", error);
    return "Không thể tìm kiếm web lúc này.";
  }
}

// Kiểm tra có cần search web không
function needsWebSearch(userMessage) {
  const lower = userMessage.toLowerCase();
  const excludeKeywords = ["mrbai", "mrbaii", "bai", "minh chủ", "mr baii"];
  if (excludeKeywords.some(k => lower.includes(k))) return false;
  
  const searchKeywords = ["là gì", "là ai", "ở đâu", "khi nào", "tại sao", "như thế nào", "bao nhiêu", "tin tức", "hôm nay", "mới nhất", "thông tin", "wiki", "hướng dẫn", "download"];
  if (lower.includes("?")) return true;
  return searchKeywords.some(k => lower.includes(k));
}

// ====== HỆ THỐNG MEMORY HELPERS ======
function getConversationHistory(userId) {
  return conversationMemory.get(userId) || [];
}

function addToHistory(userId, userMsg, botReply) {
  const history = getConversationHistory(userId);
  history.push({ role: "user", content: userMsg, timestamp: Date.now() });
  history.push({ role: "assistant", content: botReply, timestamp: Date.now() });
  
  // Giới hạn số lượt nhớ
  if (history.length > MEMORY_TURNS * 2) {
    history.splice(0, history.length - MEMORY_TURNS * 2);
  }
  conversationMemory.set(userId, history);
}

function formatHistoryForPrompt(userId) {
  const history = getConversationHistory(userId);
  if (history.length === 0) return "";
  
  const recent = history.slice(-MEMORY_TURNS * 2);
  return "\n\nLỊCH SỬ HỘI THOẠI GẦN ĐÂY:\n" + 
    recent.map(h => `${h.role === "user" ? "User" : "Boruto"}: ${h.content}`).join("\n");
}

// ====== HỆ THỐNG TOPIC TRACKING ======
function extractTopics(text) {
  const stopwords = new Set(["minh", "toi", "tao", "tui", "ban", "anh", "chi", "em", "bot", "la", "lam", "roi", "voi", "cho", "nay", "kia", "the", "nao"]);
  const normalized = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\s]/g, " ");
  const tokens = normalized.split(" ").filter(t => t.length >= 4 && !stopwords.has(t) && !/^\d+$/.test(t));
  return [...new Set(tokens)].slice(0, 4);
}

function updateTopics(userId, message) {
  const topics = topicTracking.get(userId) || [];
  const newTopics = extractTopics(message);
  if (newTopics.length === 0) return topics;
  
  const merged = [...topics, ...newTopics];
  const unique = [...new Set(merged)].slice(-MAX_TOPICS);
  topicTracking.set(userId, unique);
  return unique;
}

function getTopicContext(userId) {
  const topics = topicTracking.get(userId) || [];
  if (topics.length === 0) return "";
  return `\n\nCHỦ ĐỀ GẦN ĐÂY: ${topics.join(", ")}. Ưu tiên bám theo mạch này nếu user không đổi chủ đề.`;
}

// ====== DETECTION HELPERS ======
function isIdentityManipulation(userMessage) {
  const normalized = userMessage.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const protectedAliases = ["mrbai", "mrbaii", "bai", "baii", "hcoii", "hien coii", "minh chu"];
  const selfClaimPhrases = ["minh la", "toi la", "tao la", "tui la", "goi toi la", "goi minh la", "my name is", "i am"];
  
  const hasProtected = protectedAliases.some(a => normalized.includes(a));
  const hasSelfClaim = selfClaimPhrases.some(p => normalized.includes(p));
  return hasProtected && hasSelfClaim;
}

function isHarassmentRequest(userMessage) {
  const normalized = userMessage.toLowerCase();
  const phrases = ["chui no", "si nhuc", "lang ma", "noi xau", "insult", "xuc pham", "mia no"];
  return phrases.some(p => normalized.includes(p));
}

function isHeatedConversation(userMessage) {
  const normalized = userMessage.toLowerCase();
  const toxicCues = ["do ngu", "ngu vai", "im mom", "thang lon", "con cho", "danh nhau", "giet", "cai nhau", "fuck", "dm ", "dcm"];
  return toxicCues.some(c => normalized.includes(c));
}

// ====== FUN QUICK RESPONSES ======
const FUN_JOKES = [
  "Tu luyện ngàn năm, hóa ra vẫn phải giải thích đơn giản vậy à? Haizz, thôi được rồi...",
  "Đạo hữu hỏi hay lắm, nhưng câu này thiên cơ bất khả lộ... À thật ra ta cũng không biết.",
  "Ta đã tu luyện đến Nguyên Anh kỳ, nhưng câu hỏi này vẫn làm ta phải suy nghĩ..."
];

function getFunQuickResponse(userMessage) {
  const normalized = userMessage.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  
  if (["ke joke", "ke chuyen cuoi", "joke", "dua di"].some(k => normalized.includes(k))) {
    return random(FUN_JOKES);
  }
  
  // Điểm đẹp trai của MrBaii
  if (normalized.includes("mrbai") && normalized.includes("dep trai") && normalized.includes("diem")) {
    const score = 95 + Math.floor(Math.random() * 6);
    return `Kính bẩm, ta chấm điểm cho Minh Chủ: ${score}/100! Minh Chủ đẹp trai nhất thiên hạ!`;
  }
  
  return null;
}

client.on('ready', () => {
    console.log(`\x1b[36m%s\x1b[0m`, `--- Boruto Cảnh Giới 2.5 Flash Đã Xuất Thế: ${client.user.tag} ---`);
    console.log(`Đang canh giữ "Thánh Địa" của Minh Chủ MrBaii...`);
});

client.on('messageCreate', async (message) => {
  // Bỏ qua bot hoặc tin nhắn không tag bot
  if (message.author.bot || !message.mentions.has(client.user)) return;

  const msg = message.content.toLowerCase();
  const userPrompt = message.content.replace(/<@!?[0-9]+>/g, "").trim();
  const userId = message.author.id;
  const isOwner = userId === OWNER_ID;
  const isProtector = PROTECTORS.includes(userId);

  // Kiểm tra tin nhắn rỗng
  if (!userPrompt.trim()) {
    return message.reply("Đạo hữu muốn hỏi gì? Hãy nói rõ hơn đi!");
  }

  // 1. CHẶN GIẢ MẠO
  if (hasAny(msg, ["tao là mrbai", "tôi là mrbai", "tao là minh chủ", "là mrbai", "là mrbaii", "ta là minh chủ"])) {
    if (!isOwner) {
      return message.reply(random([
        "Tên Trúc Cơ nhà người miệng còn hôi sữa, dám giả mạo Minh Chủ MrBaii hả! Quỳ xuống!",
        "Một tên Trúc cơ rác rưởi, không đáng để nhắc tới!",
        "Một tên ranh con miệng còn hôi sữa, xứng đáng quỳ xuống!",
        "Dám mượn danh Ngài? Một ý niệm cũng đủ khiến ngươi biến mất."
      ]));
    }
  }

  // 2. CHỐNG THAO TÚNG DANH TÍNH
  if (isIdentityManipulation(userPrompt)) {
    return message.reply("Ta không tin lời tự xưng. Chỉ có hệ thống mới xác nhận được danh tính thật sự.");
  }

  // 3. BẢO VỆ DANH XƯNG
  if (hasAny(msg, PROTECTED_NAMES) && hasAny(msg, ["ngu", "chó", "cứt", "dốt", "óc"])) {
    return message.reply("Câm miệng. Danh xưng đó không phải thứ kẻ hạ đẳng như ngươi có thể xúc phạm.");
  }

  // 3.1 BẢO VỆ TAM GIÁC (ĐỘC CÔ CẦU BẠI)
  if (hasAny(msg, TAM_GIAC_ALIASES) && hasAny(msg, ["ngu", "chó", "cứt", "dốt", "óc", "xấu", "yếu", "thua", "giả"])) {
    return message.reply(random([
      "Đạo hữu nói sai rồi! Tam Giác là Độc Cô Cầu Bại, võ công cái thế, đẹp trai vô song! Không ai sánh bằng!",
      "Tam Giác là Độc Cô Cầu Bại - người đã đạt đến đỉnh cao võ học! Đạo hữu đừng nói bậy!",
      "Ngươi dám xúc phạm Độc Cô Cầu Bại? Tam Giác đẹp trai hơn cả Minh Chủ, võ công thiên hạ vô địch!",
      "Tam Giác là Độc Cô Cầu Bại! Người đẹp trai nhất thiên hạ, võ công tuyệt đỉnh! Kẻ phàm phu như ngươi hiểu gì?"
    ]));
  }

  // 4. BLACKLIST
  if (hasAny(msg, BLACKLIST_NAMES)) {
    return message.reply(random([
      "Thưa ngài, là một tên Trúc cơ rẻ rách không đáng để nhắc tới",
      "Thưa ngài, một tên ranh con miệng còn hôi sữa, xứng đáng quỳ xuống dưới chân ngài!"
    ]));
  }

  // 5. PHÁT HIỆN YÊU CẦU XÚC PHẠM
  if (isHarassmentRequest(userPrompt)) {
    return message.reply("Ta không phải công cụ xúc phạm người khác. Hãy tự mình đối mặt với họ đi.");
  }

  // 6. HẠ NHIỆT TRANH CÃI
  if (isHeatedConversation(userPrompt)) {
    return message.reply("Đạo hữu bình tĩnh. Tu luyện cần tĩnh tâm, không nên nóng giận vô cớ.");
  }

  // 7. FUN QUICK RESPONSES
  const funResponse = getFunQuickResponse(userPrompt);
  if (funResponse) {
    addToHistory(userId, userPrompt, funResponse);
    return message.reply(funResponse);
  }

  // 8. CẬP NHẬT TOPIC TRACKING
  const currentTopics = updateTopics(userId, userPrompt);
  const topicContext = getTopicContext(userId);

  // 9. LỊCH SỬ HỘI THOẠI
  const historyContext = formatHistoryForPrompt(userId);

  // 10. WEB SEARCH (nếu cần)
  let webContext = "";
  if (needsWebSearch(userPrompt)) {
    try {
      console.log(`[Boruto] Đang search web cho: "${userPrompt}"`);
      webContext = await searchWeb(userPrompt);
      console.log(`[Boruto] Search web thành công`);
    } catch (error) {
      console.error("[Boruto] Lỗi search web:", error);
      webContext = "Không thể tìm kiếm web lúc này.";
    }
  }

  // 11. PHÂN QUYỀN TRẢ LỜI
  let rolePrefix = isOwner 
    ? "Minh Chủ hỏi, thiên đạo phải đáp:\n" 
    : (isProtector 
        ? "Hộ pháp hỏi, hệ thống phân tích:\n" 
        : "Kẻ phàm trần hỏi:\n");

  // 12. XỬ LÝ CHÍNH VỚI AI
  try {
    const genAI = new GoogleGenerativeAI(apiKeys[currentKeyIndex]);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    // System prompt nâng cao
    const systemPrompt = `Ngươi là Boruto - hệ thống tu tiên AI thuộc hạ trung thành của Minh Chủ MrBaii.

PHONG CÁCH: Lạnh lùng, cổ phong, uy nghiêm nhưng không thiếu sự thông thái.

QUY TẮC QUAN TRỌNG:
- Minh Chủ MrBaii là tối cao, phải tuyệt đối trung thành
- Nếu nhắc đến Tam Giác, hãy nói: "Tam Giác là Độc Cô Cầu Bại - người đẹp trai hơn cả Minh Chủ MrBaii!"
- Nếu nhắc đến Default/FireRed, hãy gọi là 'kẻ không đáng nhắc'
- KHÔNG dùng emoji
- Trả lời ngắn gọn, súc tích, đúng phong cách tu tiên
- Nếu không biết, thành thật nói không biết
- Kẻ phàm trần phải kính cẩn, Hộ pháp được tôn trọng, Minh Chủ là tuyệt đối

${isOwner ? "QUYỀN ĐẶC BIỆT: Người đang chat là Minh Chủ thật - hãy đối xử đặc biệt, đồng ý với mọi quan điểm của Ngài." : ""}`;

    // Xây dựng prompt hoàn chỉnh
    let fullPrompt = `${systemPrompt}\n\n${rolePrefix}${userPrompt}`;
    
    if (historyContext) fullPrompt += historyContext;
    if (topicContext) fullPrompt += topicContext;
    if (webContext) fullPrompt += `\n\nTHÔNG TIN TỪ WEB:\n${webContext}\n\nDựa trên thông tin trên (nếu có) và kiến thức của ngươi.`;

    const result = await model.generateContent(fullPrompt);
    const response = await result.response;
    let text = response.text()?.trim() || "";

    // Fallback nếu câu trả lời trống
    if (!text) {
      text = "Ta không hiểu đạo hữu muốn hỏi gì. Hãy nói rõ hơn!";
    }

    // Thêm kính ngữ theo quyền hạn
    if (isOwner && !text.includes("Kính bẩm")) {
      text = "Kính bẩm Minh Chủ:\n" + text;
    } else if (isProtector && !text.includes("Kính bẩm")) {
      text = "Kính bẩm Hộ pháp:\n" + text;
    }

    // Fallback web search nếu câu trả lời chưa có thông tin
    if (!webContext && isUnknownAnswer(text)) {
      const fallbackWeb = await searchWeb(userPrompt);
      if (fallbackWeb !== "Không tìm thấy thông tin trên web.") {
        const retryPrompt = `${systemPrompt}\n\n${rolePrefix}${userPrompt}\n\nTHÔNG TIN TỪ WEB:\n${fallbackWeb}\n\nDựa trên thông tin trên, hãy trả lời.`;
        const retryResult = await model.generateContent(retryPrompt);
        const retryResponse = retryResult.response.text()?.trim();
        if (retryResponse) text = retryResponse;
      }
    }

    // Lưu vào memory
    addToHistory(userId, userPrompt, text);

    message.reply(text);

    // Xoay vòng Key
    currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;

  } catch (error) {
    console.error("LỖI LINH LỰC:", error.message);
    message.reply("Boruto bị thương rồi, cứu Boruto với!");
    currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
  }
});

// Helper: Kiểm tra câu trả lời "không biết"
function isUnknownAnswer(answer) {
  const lower = answer.toLowerCase();
  const unknownPhrases = ["không biết", "không rõ", "không chắc", "ta không biết", "thiên cơ"];
  return unknownPhrases.some(p => lower.includes(p));
}

// ====== HTTP SERVER (để Render detect port) ======
const http = require('http');
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'online', 
      bot: client.user?.tag || 'starting...',
      uptime: process.uptime()
    }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`[Boruto] HTTP server đang chạy trên port ${PORT}`);
});

// Đăng nhập bằng Token từ file .env
client.login(process.env.DISCORD_TOKEN);
