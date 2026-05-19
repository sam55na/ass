import express from 'express';
import admin from 'firebase-admin';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import axios from 'axios';
import helmet from 'helmet';
import compression from 'compression';
import http from 'http';
import https from 'https';
import crypto from 'crypto'; 
// ============= تهيئة Firebase =============
const serviceAccount = {
  type: "service_account",
  project_id: "boomb-fa3e7",
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CERT_URL
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: "boomb-fa3e7"
});

const db = admin.firestore();
db.settings({ 
  ignoreUndefinedProperties: true,
  cacheSizeBytes: admin.firestore.CACHE_SIZE_UNLIMITED
});

const app = express();

// ============= إعدادات الأمان والأداء =============
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false
}));

app.use(compression({ level: 6, threshold: 1024 }));

app.use(cors({
  origin: ['https://sam55na.github.io', 'http://localhost:3000', 'http://localhost:5500', 'https://*.onrender.com'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============= Rate Limiting =============
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 500,
  message: { error: 'الرجاء الانتظار دقيقة' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/api/site-theme'
});

const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'طلبات كثيرة جداً، الرجاء الانتظار' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/', generalLimiter);
app.use('/api/user/deposit', strictLimiter);
app.use('/api/user/withdraw', strictLimiter);
app.use('/api/user/register', strictLimiter);
app.use('/api/user/spin-wheel', strictLimiter);
app.use('/api/admin/', generalLimiter);

// ============= الثوابت =============
const RESET_PASSWORD = '2613857';
const ADMIN_EMAIL = 'sam55nam@gmail.com';
const GAMES_COLLECTION = 'games';

// ============= Cache =============
let cachedSettings = null;
let settingsCacheTime = 0;
const CACHE_TTL = 30000;

let cachedDashboard = null;
let dashboardCacheTime = 0;
const DASHBOARD_CACHE_TTL = 15000;

let cachedGames = null;
let gamesCacheTime = 0;
const GAMES_CACHE_TTL = 30000;

async function getSettings() {
  const now = Date.now();
  if (cachedSettings && (now - settingsCacheTime) < CACHE_TTL) {
    return cachedSettings;
  }
  
  try {
    const doc = await db.collection('settings').doc('config').get();
    let settings = doc.data();
    
    if (!settings) {
      const defaultSettings = {
        minDeposit: 1000,
        minWithdraw: 5000,
        shamCashEnabled: true,
        syriatelEnabled: true,
        shamCashUsdEnabled: false,
        usdToSypRate: 13000,
        referralCommission: 5,
        wheelSpinCost: 50,
        shamCashApiKey: '',
        shamCashPrivateAddress: '',
        shamCashPublicAddress: '0930000000',
        shamCashUsdApiKey: '',
        shamCashUsdPrivateAddress: '',
        shamCashUsdPublicAddress: '',
        syriatelApiKey: '',
        syriatelPrivateAddress: '',
        syriatelPublicAddress: '0930000000',
        gameImageUrl: '',
        siteTheme: 'red',
        siteName: 'BOOMB',
        maintenanceMode: false
      };
      await db.collection('settings').doc('config').set(defaultSettings);
      settings = defaultSettings;
    }
    
    cachedSettings = settings;
    settingsCacheTime = now;
    return settings;
  } catch (error) {
    console.error('Error getting settings:', error);
    return cachedSettings || {
      minDeposit: 1000,
      minWithdraw: 5000,
      referralCommission: 5,
      wheelSpinCost: 50,
      siteTheme: 'red'
    };
  }
}

// ============= دوال الألعاب =============
async function getGames(includeAll = false) {
  const now = Date.now();
  if (cachedGames && (now - gamesCacheTime) < GAMES_CACHE_TTL) {
    return includeAll ? cachedGames : cachedGames.filter(game => game.enabled === true && game.visible !== false);
  }
  
  try {
    const snapshot = await db.collection(GAMES_COLLECTION).orderBy('order', 'asc').get();
    const games = [];
    snapshot.forEach(doc => {
      games.push({ id: doc.id, ...doc.data() });
    });
    
    // إذا كانت المجموعة فارغة، أنشئ 50 لعبة افتراضية
    if (games.length === 0) {
      const defaultGames = [];
      for (let i = 1; i <= 50; i++) {
        defaultGames.push({
          name: `لعبة ${i}`,
          iconUrl: '',
          gameUrl: '',
          enabled: true,
          visible: true,
          order: i,
          createdAt: new Date()
        });
      }
      
      const batch = db.batch();
      for (const game of defaultGames) {
        const docRef = db.collection(GAMES_COLLECTION).doc();
        batch.set(docRef, game);
      }
      await batch.commit();
      
      cachedGames = defaultGames;
      gamesCacheTime = now;
      return includeAll ? defaultGames : defaultGames.filter(game => game.enabled === true && game.visible !== false);
    }
    
    cachedGames = games;
    gamesCacheTime = now;
    return includeAll ? games : games.filter(game => game.enabled === true && game.visible !== false);
  } catch (error) {
    console.error('Error getting games:', error);
    return [];
  }
}

// ============= تحسين Axios =============
const axiosInstance = axios.create({
  timeout: 30000,
  headers: { 'Connection': 'keep-alive' },
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 50 }),
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 50 })
});

// ============= دالة إنشاء كود فريد =============
async function generateUniqueReferralCode() {
  let uniqueId;
  let isUnique = false;
  let attempts = 0;
  
  while (!isUnique && attempts < 10) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    uniqueId = result;
    
    const existing = await db.collection('users').where('uniqueId', '==', uniqueId).limit(1).get();
    if (existing.empty) {
      isUnique = true;
    }
    attempts++;
  }
  
  return uniqueId || 'UID' + Date.now().toString().slice(-8);
}

// ============= المصادقة =============
const requireAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) {
    return res.status(401).json({ error: 'غير مصرح' });
  }
  try {
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(401).json({ error: 'جلسة غير صالحة' });
  }
};

const requireAdmin = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) {
    return res.status(401).json({ error: 'غير مصرح' });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    if (decoded.email !== ADMIN_EMAIL) {
      return res.status(403).json({ error: 'غير مصرح - هذه المنطقة للمشرف فقط' });
    }
    req.user = decoded;
    next();
  } catch (error) {
    console.error('Admin auth error:', error);
    res.status(401).json({ error: 'جلسة غير صالحة' });
  }
};



// ============= نظام التوكن للمستخدمين مع مهلة النشاط =============


// تخزين مؤقت للتوكنات النشطة للمستخدمين
const activeUserTokens = new Map(); // token -> { userId, lastActivity, createdAt }

// تنظيف التوكنات المنتهية كل دقيقة
setInterval(() => {
    const now = Date.now();
    for (const [token, data] of activeUserTokens.entries()) {
        // حذف التوكنات التي لم ينشط لها 5 دقائق (300000 مللي ثانية)
        if (now - data.lastActivity > 300000) {
            activeUserTokens.delete(token);
            console.log(`🗑️ User token expired due to inactivity: ${token.substring(0, 20)}... (User: ${data.userId})`);
            
            // تحديث قاعدة البيانات
            db.collection('user_tokens').doc(token).update({
                expiredDueToInactivity: true,
                expiredAt: new Date(),
                lastActivity: new Date(data.lastActivity)
            }).catch(console.error);
        }
    }
}, 60000); // كل دقيقة

// إنشاء توكن جديد للمستخدم
function generateUserToken(userId) {
    const timestamp = Date.now();
    const secret = process.env.USER_TOKEN_SECRET || 'BOOMB_USER_SECRET_KEY_2024';
    const randomBytes = crypto.randomBytes(32).toString('hex');
    const data = `${userId}:${timestamp}:${randomBytes}`;
    const signature = crypto.createHmac('sha256', secret).update(data).digest('hex');
    const token = Buffer.from(`${data}:${signature}`).toString('base64');
    
    return token;
}

// التحقق من صحة توكن المستخدم وتحديث آخر نشاط
async function verifyUserToken(token) {
    try {
        // التحقق من وجود التوكن في الذاكرة المؤقتة
        const tokenData = activeUserTokens.get(token);
        if (!tokenData) {
            return { valid: false, reason: 'token_not_found' };
        }
        
        // التحقق من انتهاء الصلاحية (5 دقائق)
        const now = Date.now();
        if (now - tokenData.lastActivity > 300000) {
            activeUserTokens.delete(token);
            return { valid: false, reason: 'token_expired' };
        }
        
        // فك التوكن للتحقق من التوقيع
        const decoded = Buffer.from(token, 'base64').toString();
        const parts = decoded.split(':');
        
        if (parts.length < 4) return { valid: false, reason: 'invalid_format' };
        
        const [userId, timestamp, randomBytes, signature] = parts;
        const secret = process.env.USER_TOKEN_SECRET || 'BOOMB_USER_SECRET_KEY_2024';
        const data = `${userId}:${timestamp}:${randomBytes}`;
        const expectedSignature = crypto.createHmac('sha256', secret).update(data).digest('hex');
        
        if (signature !== expectedSignature) {
            return { valid: false, reason: 'invalid_signature' };
        }
        
        // التحقق من أن التوكن ليس أقدم من 5 دقائق
        const tokenTime = parseInt(timestamp);
        if (Date.now() - tokenTime > 300000) {
            activeUserTokens.delete(token);
            return { valid: false, reason: 'token_age_expired' };
        }
        
        // تحديث آخر نشاط
        activeUserTokens.set(token, {
            ...tokenData,
            lastActivity: Date.now()
        });
        
        // تحديث في قاعدة البيانات
        await db.collection('user_tokens').doc(token).update({
            lastActivity: new Date(),
            lastVerifiedAt: new Date()
        }).catch(console.error);
        
        return { valid: true, userId: userId };
        
    } catch (error) {
        console.error('Token verification error:', error);
        return { valid: false, reason: 'error' };
    }
}

// إنشاء توكن للمستخدم (عند فتح اللعبة من الواجهة الرئيسية)
app.post('/api/user/create-token', requireAuth, async (req, res) => {
    try {
        const { uid } = req.user;
        
        // حذف أي توكنات سابقة للمستخدم
        for (const [existingToken, data] of activeUserTokens.entries()) {
            if (data.userId === uid) {
                activeUserTokens.delete(existingToken);
                await db.collection('user_tokens').doc(existingToken).update({
                    replacedByNewToken: true,
                    replacedAt: new Date()
                }).catch(console.error);
            }
        }
        
        // إنشاء توكن جديد
        const token = generateUserToken(uid);
        
        // تخزين في الذاكرة المؤقتة
        activeUserTokens.set(token, {
            userId: uid,
            createdAt: Date.now(),
            lastActivity: Date.now()
        });
        
        // تخزين في قاعدة البيانات للتتبع
        await db.collection('user_tokens').doc(token).set({
            userId: uid,
            createdAt: new Date(),
            lastActivity: new Date(),
            active: true
        });
        
        res.json({
            success: true,
            token: token,
            expiresIn: 300 // 5 دقائق
        });
        
    } catch (error) {
        console.error('Create user token error:', error);
        res.status(500).json({ error: 'فشل إنشاء جلسة اللعبة' });
    }
});

// التحقق من التوكن (أي طلب داخل اللعبة)
app.post('/api/user/verify-token', async (req, res) => {
    try {
        const { token } = req.body;
        
        if (!token) {
            return res.status(401).json({ 
                valid: false, 
                error: 'token_missing',
                message: 'توكن الأمان مفقود' 
            });
        }
        
        const verification = await verifyUserToken(token);
        
        if (!verification.valid) {
            return res.status(401).json({ 
                valid: false, 
                error: verification.reason,
                message: 'جلسة اللعبة منتهية، يرجى إعادة فتح اللعبة من الواجهة الرئيسية'
            });
        }
        
        res.json({
            valid: true,
            userId: verification.userId,
            message: 'تم التحقق بنجاح'
        });
        
    } catch (error) {
        console.error('Verify token error:', error);
        res.status(500).json({ error: 'فشل التحقق من التوكن' });
    }
});

// تجديد نشاط التوكن (keep-alive من داخل اللعبة)
app.post('/api/user/renew-token', requireAuth, async (req, res) => {
    try {
        const { uid } = req.user;
        const { token } = req.body;
        
        if (!token) {
            return res.status(400).json({ error: 'التوكن مطلوب' });
        }
        
        // التحقق من أن التوكن يخص هذا المستخدم
        const tokenData = activeUserTokens.get(token);
        if (!tokenData || tokenData.userId !== uid) {
            return res.status(403).json({ error: 'توكن غير صالح' });
        }
        
        // تحديث آخر نشاط
        activeUserTokens.set(token, {
            ...tokenData,
            lastActivity: Date.now()
        });
        
        await db.collection('user_tokens').doc(token).update({
            lastActivity: new Date(),
            renewedAt: new Date()
        }).catch(console.error);
        
        // حساب الوقت المتبقي
        const elapsed = Date.now() - tokenData.createdAt;
        const remaining = Math.max(0, 300 - Math.floor(elapsed / 1000));
        
        res.json({
            success: true,
            remainingSeconds: remaining
        });
        
    } catch (error) {
        console.error('Renew token error:', error);
        res.status(500).json({ error: 'فشل تجديد الجلسة' });
    }
});

// إنهاء جلسة المستخدم (عند إغلاق اللعبة)
app.post('/api/user/end-session', requireAuth, async (req, res) => {
    try {
        const { uid } = req.user;
        const { token } = req.body;
        
        if (token && activeUserTokens.has(token)) {
            activeUserTokens.delete(token);
            await db.collection('user_tokens').doc(token).update({
                endedByUser: true,
                endedAt: new Date()
            }).catch(console.error);
        }
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('End session error:', error);
        res.status(500).json({ error: 'فشل إنهاء الجلسة' });
    }
});

// التحقق من صحة التوكن (middleware للعبة)
async function requireGameToken(req, res, next) {
    const token = req.headers['x-game-token'] || req.query.token;
    
    if (!token) {
        return res.status(401).json({ 
            error: 'token_missing',
            redirectTo: '/' 
        });
    }
    
    const verification = await verifyUserToken(token);
    
    if (!verification.valid) {
        return res.status(401).json({ 
            error: 'token_invalid',
            redirectTo: '/',
            message: 'انتهت صلاحية الجلسة، يرجى إعادة فتح اللعبة'
        });
    }
    
    req.userId = verification.userId;
    req.gameToken = token;
    next();
}

// ============= كلاس شام كاش =============
class ShamCashClient {
  constructor(apiKey, accountAddress) {
    this.apiKey = apiKey;
    this.accountAddress = accountAddress;
    this.baseUrl = "https://apisyria.com/api/v1";
  }

  async verifyTransaction(txid, expectedAmount = null, expectedCurrency = null) {
    try {
      const params = {
        resource: "shamcash",
        action: "logs",
        account_address: this.accountAddress,
        api_key: this.apiKey
      };
      const response = await axiosInstance.get(this.baseUrl, { params });
      
      if (response.status === 200 && response.data.success) {
        const items = response.data.data?.items || [];
        for (const item of items) {
          if (String(item.tran_id) === String(txid)) {
            const apiAmount = parseFloat(item.amount);
            const apiCurrency = item.currency || 'SYP';
            const timestamp = item.created_at || Date.now() / 1000;
            
            if ((Date.now() / 1000 - timestamp) > 86400) {
              return { success: false, message: "العملية أقدم من 24 ساعة" };
            }
            
            if (expectedCurrency && apiCurrency !== expectedCurrency) {
              return { success: false, message: `نوع العملة غير متطابق: ${apiCurrency}` };
            }
            
            if (expectedAmount && Math.abs(apiAmount - expectedAmount) > 0.01) {
              return { success: false, message: `المبلغ غير متطابق: ${apiAmount}` };
            }
            
            return { success: true, amount: apiAmount, currency: apiCurrency };
          }
        }
        return { success: false, message: "رقم العملية غير موجود" };
      }
      return { success: false, message: "فشل التحقق من العملية" };
    } catch (error) {
      console.error('ShamCash error:', error.message);
      return { success: false, message: "خطأ في الاتصال بخدمة شام كاش" };
    }
  }
}

class ShamCashUsdClient {
  constructor(apiKey, accountAddress) {
    this.apiKey = apiKey;
    this.accountAddress = accountAddress;
    this.baseUrl = "https://apisyria.com/api/v1";
  }

  async verifyTransaction(txid, expectedAmount = null) {
    try {
      const params = {
        resource: "shamcash",
        action: "logs",
        account_address: this.accountAddress,
        api_key: this.apiKey
      };
      const response = await axiosInstance.get(this.baseUrl, { params });
      
      if (response.status === 200 && response.data.success) {
        const items = response.data.data?.items || [];
        for (const item of items) {
          if (String(item.tran_id) === String(txid)) {
            const apiAmount = parseFloat(item.amount);
            const apiCurrency = item.currency || 'USD';
            const timestamp = item.created_at || Date.now() / 1000;
            
            if ((Date.now() / 1000 - timestamp) > 86400) {
              return { success: false, message: "العملية أقدم من 24 ساعة" };
            }
            
            if (apiCurrency !== 'USD') {
              return { success: false, message: `يجب أن تكون العملية بالدولار، وجدت ${apiCurrency}` };
            }
            
            if (expectedAmount && Math.abs(apiAmount - expectedAmount) > 0.01) {
              return { success: false, message: `المبلغ غير متطابق: ${apiAmount} USD` };
            }
            
            return { success: true, amount: apiAmount, currency: apiCurrency };
          }
        }
        return { success: false, message: "رقم العملية غير موجود" };
      }
      return { success: false, message: "فشل التحقق من العملية" };
    } catch (error) {
      console.error('ShamCash USD error:', error.message);
      return { success: false, message: "خطأ في الاتصال بخدمة شام كاش" };
    }
  }
}

class SyriatelCashClient {
  constructor(apiKey, gsmNumbers) {
    this.apiKey = apiKey;
    this.gsmNumbers = gsmNumbers;
    this.baseUrl = "https://apisyria.com/api/v1";
  }

  async verifyTransaction(txid, expectedAmount = null) {
    for (const gsm of this.gsmNumbers) {
      try {
        const params = {
          api_key: this.apiKey,
          resource: "syriatel",
          action: "find_tx",
          tx: txid,
          gsm: gsm
        };
        const response = await axiosInstance.get(this.baseUrl, { params });
        
        if (response.status === 200 && response.data.success && response.data.data?.found) {
          const transaction = response.data.data.transaction || {};
          const apiAmount = parseFloat(transaction.amount || 0);
          if (expectedAmount && Math.abs(apiAmount - expectedAmount) > 0.01) {
            return { success: false, message: "المبلغ غير متطابق" };
          }
          return { success: true, amount: apiAmount, currency: "SYP" };
        }
      } catch (error) {
        console.error(`Syriatel error:`, error.message);
      }
    }
    return { success: false, message: "رقم العملية غير موجود" };
  }
}

// ============= عجلة الحظ =============
const WHEEL_SECTORS = [
  { id: 1, name: 'حظ أوفر', type: 'luck', value: 0, probability: 6 },
  { id: 2, name: '10 رصيد أساسي', type: 'balance', value: 10, probability: 30 },
  { id: 3, name: '20 رصيد أساسي', type: 'balance', value: 20, probability: 30 },
  { id: 4, name: '30 رصيد أساسي', type: 'balance', value: 30, probability: 30 },
  { id: 5, name: 'حظ أوفر', type: 'luck', value: 0, probability: 1 },
  { id: 6, name: '10 رصيد أساسي', type: 'balance', value: 10, probability: 1 },
  { id: 7, name: '20 رصيد أساسي', type: 'balance', value: 20, probability: 1 },
  { id: 8, name: '30 رصيد أساسي', type: 'balance', value: 30, probability: 1 }
];

function getRandomSector() {
  const random = Math.random() * 100;
  let cumulative = 0;
  
  for (const sector of WHEEL_SECTORS) {
    cumulative += sector.probability;
    if (random < cumulative) {
      return sector;
    }
  }
  return WHEEL_SECTORS[0];
}

// ============= عمولة الإحالة =============
async function addReferralCommission(userId, depositAmount) {
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data();
    
    if (userData && userData.referredBy) {
      const settings = await getSettings();
      const commissionPercent = settings.referralCommission || 5;
      const commissionAmount = (depositAmount * commissionPercent) / 100;
      
      if (commissionAmount > 0) {
        const batch = db.batch();
        const referrerRef = db.collection('users').doc(userData.referredBy);
        
        batch.update(referrerRef, {
          referralBalance: admin.firestore.FieldValue.increment(commissionAmount),
          referralEarnings: admin.firestore.FieldValue.increment(commissionAmount)
        });
        
        const commissionRef = db.collection('referral_commissions').doc();
        batch.set(commissionRef, {
          userId: userData.referredBy,
          fromUserId: userId,
          amount: commissionAmount,
          depositAmount: depositAmount,
          percent: commissionPercent,
          createdAt: new Date()
        });
        
        await batch.commit();
      }
    }
  } catch (error) {
    console.error('Commission error:', error);
  }
}

// ============= API عجلة الحظ =============
app.get('/api/user/wheel-status', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const [userDoc, settings] = await Promise.all([
      db.collection('users').doc(uid).get(),
      getSettings()
    ]);
    
    const userData = userDoc.data();
    if (!userData) {
      return res.status(404).json({ error: 'مستخدم غير موجود' });
    }
    
    const lastSpin = userData.lastSpinTime?.toDate ? userData.lastSpinTime.toDate() : userData.lastSpinTime;
    const now = new Date();
    let canSpin = true;
    let remainingSeconds = 0;
    
    if (lastSpin) {
      const timeDiff = (now - lastSpin) / 1000;
      if (timeDiff < 300) {
        canSpin = false;
        remainingSeconds = Math.ceil(300 - timeDiff);
      }
    }
    
    res.json({
      success: true,
      canSpin: canSpin,
      remainingSeconds: remainingSeconds,
      spinCost: settings.wheelSpinCost || 50,
      referralBalance: userData.referralBalance || 0,
      hasEnoughBalance: (userData.referralBalance || 0) >= (settings.wheelSpinCost || 50)
    });
  } catch (error) {
    console.error('Wheel status error:', error);
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

app.post('/api/user/spin-wheel', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const userRef = db.collection('users').doc(uid);
    const [userDoc, settings] = await Promise.all([
      userRef.get(),
      getSettings()
    ]);
    
    const userData = userDoc.data();
    if (!userData) {
      return res.status(404).json({ error: 'مستخدم غير موجود' });
    }
    
    const lastSpin = userData.lastSpinTime?.toDate ? userData.lastSpinTime.toDate() : userData.lastSpinTime;
    const now = new Date();
    
    if (lastSpin) {
      const timeDiff = (now - lastSpin) / 1000;
      if (timeDiff < 300) {
        const remainingSeconds = Math.ceil(300 - timeDiff);
        const minutes = Math.floor(remainingSeconds / 60);
        const seconds = remainingSeconds % 60;
        return res.status(400).json({ 
          error: `يجب الانتظار ${minutes} دقيقة و ${seconds} ثانية قبل التدوير مرة أخرى` 
        });
      }
    }
    
    const spinCost = settings.wheelSpinCost || 50;
    
    if ((userData.referralBalance || 0) < spinCost) {
      return res.status(400).json({ error: `رصيد الإحالات غير كافٍ. تحتاج ${spinCost} SYP للتدوير` });
    }
    
    const selectedSector = getRandomSector();
    let prizeAmount = 0;
    let prizeMessage = '';
    
    if (selectedSector.type === 'balance') {
      prizeAmount = selectedSector.value;
      prizeMessage = `🎉 فزت بـ ${prizeAmount} SYP! تم إضافتها إلى رصيدك الأساسي`;
      
      await userRef.update({
        balance: admin.firestore.FieldValue.increment(prizeAmount),
        referralBalance: admin.firestore.FieldValue.increment(-spinCost),
        lastSpinTime: now,
        totalSpins: admin.firestore.FieldValue.increment(1),
        totalWinnings: admin.firestore.FieldValue.increment(prizeAmount)
      });
    } else {
      prizeMessage = `😅 حظ أوفر! لم تربح هذه المرة. حظاً أفضل في المرة القادمة`;
      
      await userRef.update({
        referralBalance: admin.firestore.FieldValue.increment(-spinCost),
        lastSpinTime: now,
        totalSpins: admin.firestore.FieldValue.increment(1)
      });
    }
    
    db.collection('wheel_spins').add({
      userId: uid,
      sector: selectedSector.id,
      sectorName: selectedSector.name,
      prizeAmount: prizeAmount,
      prizeType: selectedSector.type,
      spinCost: spinCost,
      timestamp: now,
      userEmail: userData.email,
      userName: userData.name
    }).catch(err => console.error('Spin log error:', err));
    
    const updatedUser = await userRef.get();
    const updatedData = updatedUser.data();
    
    res.json({
      success: true,
      sector: selectedSector.id,
      sectorName: selectedSector.name,
      prizeAmount: prizeAmount,
      prizeType: selectedSector.type,
      message: prizeMessage,
      newBalance: updatedData.balance || 0,
      newReferralBalance: updatedData.referralBalance || 0,
      spinCost: spinCost
    });
    
  } catch (error) {
    console.error('Spin wheel error:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء التدوير' });
  }
});

app.get('/api/user/wheel-history', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const snapshot = await db.collection('wheel_spins')
      .where('userId', '==', uid)
      .orderBy('timestamp', 'desc')
      .limit(50)
      .get();
    
    const spins = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      spins.push({
        id: doc.id,
        sectorName: data.sectorName,
        prizeAmount: data.prizeAmount || 0,
        prizeType: data.prizeType,
        spinCost: data.spinCost,
        timestamp: data.timestamp?.toDate ? data.timestamp.toDate() : new Date(data.timestamp)
      });
    });
    
    res.json({ success: true, spins });
  } catch (error) {
    console.error('Wheel history error:', error);
    res.json({ success: true, spins: [] });
  }
});

// ============= API الألعاب =============
// جلب الألعاب للمستخدمين العاديين (المفعلة والظاهرة فقط)
app.get('/api/games', async (req, res) => {
  try {
    const games = await getGames(false);
    res.json({ success: true, games });
  } catch (error) {
    console.error('Get games error:', error);
    res.status(500).json({ error: 'خطأ في جلب الألعاب' });
  }
});

// جلب جميع الألعاب للأدمن
app.get('/api/admin/games', requireAdmin, async (req, res) => {
  try {
    const games = await getGames(true);
    res.json({ success: true, games });
  } catch (error) {
    console.error('Admin get games error:', error);
    res.status(500).json({ error: 'خطأ في جلب الألعاب' });
  }
});

// تحديث لعبة
app.put('/api/admin/games/:gameId', requireAdmin, async (req, res) => {
  try {
    const { gameId } = req.params;
    const { name, iconUrl, gameUrl, enabled, visible, order } = req.body;
    
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (iconUrl !== undefined) updateData.iconUrl = iconUrl;
    if (gameUrl !== undefined) updateData.gameUrl = gameUrl;
    if (enabled !== undefined) updateData.enabled = enabled;
    if (visible !== undefined) updateData.visible = visible;
    if (order !== undefined) updateData.order = order;
    updateData.updatedAt = new Date();
    
    await db.collection(GAMES_COLLECTION).doc(gameId).update(updateData);
    
    // مسح الكاش
    cachedGames = null;
    gamesCacheTime = 0;
    
    res.json({ success: true, message: 'تم تحديث اللعبة بنجاح' });
  } catch (error) {
    console.error('Update game error:', error);
    res.status(500).json({ error: 'فشل تحديث اللعبة' });
  }
});

// إعادة ترتيب الألعاب
app.post('/api/admin/games/reorder', requireAdmin, async (req, res) => {
  try {
    const { games } = req.body;
    
    const batch = db.batch();
    for (const game of games) {
      const gameRef = db.collection(GAMES_COLLECTION).doc(game.id);
      batch.update(gameRef, { order: game.order });
    }
    await batch.commit();
    
    cachedGames = null;
    gamesCacheTime = 0;
    
    res.json({ success: true, message: 'تم إعادة ترتيب الألعاب' });
  } catch (error) {
    console.error('Reorder games error:', error);
    res.status(500).json({ error: 'فشل إعادة الترتيب' });
  }
});

// إضافة لعبة جديدة
app.post('/api/admin/games', requireAdmin, async (req, res) => {
  try {
    const { name, iconUrl, gameUrl, enabled, visible, order } = req.body;
    
    const games = await getGames(true);
    const newOrder = order || games.length + 1;
    
    const newGame = {
      name: name || 'لعبة جديدة',
      iconUrl: iconUrl || '',
      gameUrl: gameUrl || '',
      enabled: enabled !== undefined ? enabled : true,
      visible: visible !== undefined ? visible : true,
      order: newOrder,
      createdAt: new Date()
    };
    
    const docRef = await db.collection(GAMES_COLLECTION).add(newGame);
    
    cachedGames = null;
    gamesCacheTime = 0;
    
    res.json({ success: true, game: { id: docRef.id, ...newGame } });
  } catch (error) {
    console.error('Add game error:', error);
    res.status(500).json({ error: 'فشل إضافة اللعبة' });
  }
});

// حذف لعبة
app.delete('/api/admin/games/:gameId', requireAdmin, async (req, res) => {
  try {
    const { gameId } = req.params;
    await db.collection(GAMES_COLLECTION).doc(gameId).delete();
    
    cachedGames = null;
    gamesCacheTime = 0;
    
    res.json({ success: true, message: 'تم حذف اللعبة' });
  } catch (error) {
    console.error('Delete game error:', error);
    res.status(500).json({ error: 'فشل حذف اللعبة' });
  }
});

// ============= API التسجيل =============
app.post('/api/user/register', requireAuth, async (req, res) => {
  try {
    const { uid, email, name } = req.user;
    const { referrerId } = req.body;
    
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    
    if (userDoc.exists) {
      return res.json({ success: true, user: userDoc.data(), isAdmin: email === ADMIN_EMAIL });
    }
    
    const uniqueId = await generateUniqueReferralCode();
    const batch = db.batch();
    
    let referredBy = null;
    let referrerName = null;
    
    if (referrerId) {
      const refQuery = await db.collection('users').where('uniqueId', '==', referrerId).limit(1).get();
      if (!refQuery.empty) {
        referredBy = refQuery.docs[0].id;
        referrerName = refQuery.docs[0].data().name;
        batch.update(refQuery.docs[0].ref, {
          referralBalance: admin.firestore.FieldValue.increment(5),
          referralEarnings: admin.firestore.FieldValue.increment(5),
          referrals: admin.firestore.FieldValue.arrayUnion(uid)
        });
      }
    }
    
    const newUser = {
      uniqueId: uniqueId,
      email,
      name: name || email.split('@')[0],
      balance: 0,
      referralBalance: 0,
      totalDeposited: 0,
      totalWithdrawn: 0,
      referralEarnings: 0,
      referredBy: referredBy,
      referredByName: referrerName,
      referrals: [],
      createdAt: new Date(),
      isBanned: false,
      lastLogin: new Date(),
      lastSpinTime: null,
      totalSpins: 0,
      totalWinnings: 0
    };
    
    batch.set(userRef, newUser);
    await batch.commit();
    
    res.json({ success: true, user: newUser, isAdmin: email === ADMIN_EMAIL });
    
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'خطأ في التسجيل' });
  }
});

// ============= API الملف الشخصي =============
app.get('/api/user/profile', requireAuth, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'مستخدم غير موجود' });
    }
    res.json({ success: true, user: userDoc.data(), isAdmin: req.user.email === ADMIN_EMAIL });
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ error: 'خطأ في جلب البيانات' });
  }
});

// ============= API الإحصائيات =============
app.get('/api/user/stats', requireAuth, async (req, res) => {
  try {
    const [userDoc, settings] = await Promise.all([
      db.collection('users').doc(req.user.uid).get(),
      getSettings()
    ]);
    
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'مستخدم غير موجود' });
    }
    const data = userDoc.data();
    
    let referrerInfo = null;
    if (data.referredBy) {
      const referrerDoc = await db.collection('users').doc(data.referredBy).get();
      if (referrerDoc.exists) {
        referrerInfo = {
          name: referrerDoc.data().name,
          uniqueId: referrerDoc.data().uniqueId
        };
      }
    }
    
    res.json({
      success: true,
      stats: {
        referralCount: data.referrals?.length || 0,
        referralEarnings: data.referralEarnings || 0,
        referralBalance: data.referralBalance || 0,
        balance: data.balance || 0,
        totalDeposited: data.totalDeposited || 0,
        totalWithdrawn: data.totalWithdrawn || 0,
        uniqueId: data.uniqueId,
        joinDate: data.createdAt,
        referredBy: data.referredBy,
        referredByName: data.referredByName,
        referrerInfo: referrerInfo,
        siteTheme: settings.siteTheme || 'red',
        totalSpins: data.totalSpins || 0,
        totalWinnings: data.totalWinnings || 0
      }
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'خطأ في جلب الإحصائيات' });
  }
});

// ============= API إعدادات الإيداع =============
app.get('/api/user/deposit-settings', requireAuth, async (req, res) => {
  try {
    const settings = await getSettings();
    const methods = [];
    
    if (settings.shamCashEnabled && settings.shamCashPublicAddress) {
      methods.push({
        id: 'sham_cash',
        name: 'شام كاش',
        address: settings.shamCashPublicAddress,
        currency: 'SYP',
        icon: '🏦'
      });
    }
    
    if (settings.shamCashUsdEnabled && settings.shamCashUsdPublicAddress) {
      methods.push({
        id: 'sham_cash_usd',
        name: 'شام كاش (دولار)',
        address: settings.shamCashUsdPublicAddress,
        currency: 'USD',
        exchangeRate: settings.usdToSypRate || 13000,
        icon: '💵'
      });
    }
    
    if (settings.syriatelEnabled && settings.syriatelPublicAddress) {
      methods.push({
        id: 'syriatel_cash',
        name: 'سيرياتيل كاش',
        address: settings.syriatelPublicAddress,
        currency: 'SYP',
        icon: '📱'
      });
    }
    
    res.json({
      success: true,
      settings: {
        minDeposit: settings.minDeposit,
        minWithdraw: settings.minWithdraw,
        methods: methods,
        gameImageUrl: settings.gameImageUrl || '',
        usdToSypRate: settings.usdToSypRate || 13000,
        referralCommission: settings.referralCommission || 5,
        siteTheme: settings.siteTheme || 'red',
        wheelSpinCost: settings.wheelSpinCost || 50
      }
    });
  } catch (error) {
    console.error('Deposit settings error:', error);
    res.status(500).json({ error: 'خطأ في جلب الإعدادات' });
  }
});

// ============= API الإيداع =============
app.post('/api/user/deposit', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { method, amount, transactionId } = req.body;
    
    if (!method || !amount || !transactionId) {
      return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
    }
    
    let amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: 'المبلغ غير صالح' });
    }
    
    const settings = await getSettings();
    let verification = null;
    let finalAmountSYP = amountNum;
    let originalCurrency = 'SYP';
    let originalAmount = amountNum;
    
    if (method === 'sham_cash') {
      if (!settings.shamCashEnabled || !settings.shamCashApiKey || !settings.shamCashPrivateAddress) {
        return res.status(400).json({ error: 'طريقة الدفع شام كاش غير مفعلة' });
      }
      const client = new ShamCashClient(settings.shamCashApiKey, settings.shamCashPrivateAddress);
      verification = await client.verifyTransaction(transactionId, amountNum, 'SYP');
      
      if (verification.success) {
        originalAmount = verification.amount;
        originalCurrency = verification.currency;
        finalAmountSYP = originalAmount;
      }
      
    } else if (method === 'sham_cash_usd') {
      if (!settings.shamCashUsdEnabled || !settings.shamCashUsdApiKey || !settings.shamCashUsdPrivateAddress) {
        return res.status(400).json({ error: 'طريقة الدفع شام كاش دولار غير مفعلة' });
      }
      const client = new ShamCashUsdClient(settings.shamCashUsdApiKey, settings.shamCashUsdPrivateAddress);
      verification = await client.verifyTransaction(transactionId, amountNum);
      
      if (verification.success) {
        originalAmount = verification.amount;
        originalCurrency = verification.currency;
        finalAmountSYP = originalAmount * (settings.usdToSypRate || 13000);
      }
      
    } else if (method === 'syriatel_cash') {
      if (!settings.syriatelEnabled || !settings.syriatelApiKey || !settings.syriatelPrivateAddress) {
        return res.status(400).json({ error: 'طريقة الدفع سيرياتيل كاش غير مفعلة' });
      }
      const client = new SyriatelCashClient(settings.syriatelApiKey, [settings.syriatelPrivateAddress]);
      verification = await client.verifyTransaction(transactionId, amountNum);
      
      if (verification.success) {
        originalAmount = verification.amount;
        originalCurrency = verification.currency || 'SYP';
        finalAmountSYP = originalAmount;
      }
    } else {
      return res.status(400).json({ error: 'طريقة دفع غير مدعومة' });
    }
    
    if (!verification || !verification.success) {
      return res.status(400).json({ error: verification?.message || 'فشل التحقق' });
    }
    
    if (finalAmountSYP < settings.minDeposit) {
      return res.status(400).json({ error: `الحد الأدنى ${settings.minDeposit} SYP` });
    }
    
    const existing = await db.collection('deposits').where('transactionId', '==', transactionId).limit(1).get();
    if (!existing.empty) {
      return res.status(400).json({ error: 'تم استخدام رقم العملية مسبقاً' });
    }
    
    const userRef = db.collection('users').doc(uid);
    const batch = db.batch();
    
    batch.update(userRef, {
      balance: admin.firestore.FieldValue.increment(finalAmountSYP),
      totalDeposited: admin.firestore.FieldValue.increment(finalAmountSYP)
    });
    
    const depositRef = db.collection('deposits').doc();
    batch.set(depositRef, {
      userId: uid,
      method: method,
      amount: finalAmountSYP,
      originalAmount: originalAmount,
      originalCurrency: originalCurrency,
      transactionId: transactionId,
      status: 'completed',
      verifiedAt: new Date(),
      exchangeRate: method === 'sham_cash_usd' ? settings.usdToSypRate : null
    });
    
    await batch.commit();
    
    addReferralCommission(uid, finalAmountSYP).catch(err => console.error('Commission failed:', err));
    
    const updatedUser = await userRef.get();
    res.json({ success: true, message: `تم إيداع ${finalAmountSYP.toLocaleString()} SYP`, newBalance: updatedUser.data().balance });
    
  } catch (error) {
    console.error('Deposit error:', error);
    res.status(500).json({ error: 'حدث خطأ داخلي' });
  }
});

// ============= API جلب الإيداعات =============
app.get('/api/user/deposits', requireAuth, async (req, res) => {
  try {
    const snapshot = await db.collection('deposits')
      .where('userId', '==', req.user.uid)
      .orderBy('verifiedAt', 'desc')
      .get();
    
    const deposits = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      deposits.push({
        id: doc.id,
        amount: data.amount || 0,
        method: data.method || 'unknown',
        transactionId: data.transactionId || 'N/A',
        verifiedAt: data.verifiedAt?.toDate ? data.verifiedAt.toDate() : new Date(data.verifiedAt),
        status: data.status || 'completed'
      });
    });
    
    res.json({ success: true, deposits });
  } catch (error) {
    console.error('Get deposits error:', error);
    res.json({ success: true, deposits: [] });
  }
});

// ============= API إضافة كود إحالة =============
app.post('/api/user/add-referrer', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { referrerCode } = req.body;
    
    if (!referrerCode) {
      return res.status(400).json({ error: 'كود الإحالة مطلوب' });
    }
    
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    const userData = userDoc.data();
    
    if (userData.referredBy) {
      return res.status(400).json({ error: 'لديك محيل بالفعل' });
    }
    
    const referrerQuery = await db.collection('users').where('uniqueId', '==', referrerCode).limit(1).get();
    if (referrerQuery.empty) {
      return res.status(404).json({ error: 'كود الإحالة غير صحيح' });
    }
    
    const referrerDoc = referrerQuery.docs[0];
    const referrerId = referrerDoc.id;
    
    if (referrerId === uid) {
      return res.status(400).json({ error: 'لا يمكنك إحالة نفسك' });
    }
    
    const batch = db.batch();
    batch.update(userRef, {
      referredBy: referrerId,
      referredByName: referrerDoc.data().name
    });
    
    batch.update(referrerDoc.ref, {
      referralBalance: admin.firestore.FieldValue.increment(5),
      referralEarnings: admin.firestore.FieldValue.increment(5),
      referrals: admin.firestore.FieldValue.arrayUnion(uid)
    });
    
    await batch.commit();
    
    res.json({ success: true, message: `تم إضافة المحيل: ${referrerDoc.data().name}` });
    
  } catch (error) {
    console.error('Add referrer error:', error);
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

// ============= API السحب =============
app.post('/api/user/withdraw', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { amount, address, method } = req.body;
    
    if (!amount || !address) {
      return res.status(400).json({ error: 'المبلغ والعنوان مطلوبان' });
    }
    
    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: 'المبلغ غير صالح' });
    }
    
    const settings = await getSettings();
    if (amountNum < settings.minWithdraw) {
      return res.status(400).json({ error: `الحد الأدنى ${settings.minWithdraw} SYP` });
    }
    
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    const userData = userDoc.data();
    
    if (!userData) return res.status(404).json({ error: 'مستخدم غير موجود' });
    if (userData.isBanned) return res.status(403).json({ error: 'حسابك محظور' });
    if (userData.balance < amountNum) return res.status(400).json({ error: 'الرصيد غير كافٍ' });
    
    await userRef.update({
      balance: admin.firestore.FieldValue.increment(-amountNum),
      totalWithdrawn: admin.firestore.FieldValue.increment(amountNum)
    });
    
    await db.collection('withdraw_requests').add({
      userId: uid,
      userEmail: userData.email,
      userName: userData.name,
      amount: amountNum,
      address: address,
      method: method || 'sham_cash',
      status: 'pending',
      createdAt: new Date()
    });
    
    res.json({ success: true, message: `تم إنشاء طلب سحب بمبلغ ${amountNum.toLocaleString()} SYP` });
    
  } catch (error) {
    console.error('Withdraw error:', error);
    res.status(500).json({ error: 'فشل إنشاء طلب السحب' });
  }
});

// ============= API جلب السحوبات =============
app.get('/api/user/withdraw-requests', requireAuth, async (req, res) => {
  try {
    const snapshot = await db.collection('withdraw_requests')
      .where('userId', '==', req.user.uid)
      .orderBy('createdAt', 'desc')
      .get();
    
    const requests = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      requests.push({
        id: doc.id,
        amount: data.amount || 0,
        address: data.address || 'N/A',
        method: data.method || 'unknown',
        status: data.status || 'pending',
        createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : new Date(data.createdAt)
      });
    });
    
    res.json({ success: true, requests });
  } catch (error) {
    console.error('Get withdrawals error:', error);
    res.json({ success: true, requests: [] });
  }
});

// ============= APIs الأدمن =============
app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  const settings = await getSettings();
  res.json({ success: true, settings });
});

app.post('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    await db.collection('settings').doc('config').update(req.body);
    cachedSettings = null;
    settingsCacheTime = 0;
    res.json({ success: true, message: 'تم تحديث الإعدادات' });
  } catch (error) {
    console.error('Save settings error:', error);
    res.status(500).json({ error: 'فشل تحديث الإعدادات' });
  }
});

app.post('/api/admin/update-theme', requireAdmin, async (req, res) => {
  try {
    const { theme } = req.body;
    if (!theme) {
      return res.status(400).json({ error: 'اللون مطلوب' });
    }
    
    await db.collection('settings').doc('config').update({ siteTheme: theme });
    cachedSettings = null;
    settingsCacheTime = 0;
    res.json({ success: true, message: `تم تغيير لون الموقع إلى ${theme}` });
  } catch (error) {
    console.error('Update theme error:', error);
    res.status(500).json({ error: 'فشل تغيير اللون' });
  }
});

app.get('/api/site-theme', async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({ success: true, theme: settings.siteTheme || 'red' });
  } catch (error) {
    console.error('Get theme error:', error);
    res.json({ success: true, theme: 'red' });
  }
});

app.get('/api/admin/dashboard', requireAdmin, async (req, res) => {
  const now = Date.now();
  if (cachedDashboard && (now - dashboardCacheTime) < DASHBOARD_CACHE_TTL) {
    return res.json({ success: true, stats: cachedDashboard });
  }
  
  try {
    const [totalUsersSnapshot, pendingSnapshot, wheelSpinsSnapshot] = await Promise.all([
      db.collection('users').count().get(),
      db.collection('withdraw_requests').where('status', '==', 'pending').count().get(),
      db.collection('wheel_spins').get()
    ]);
    
    const balanceSnapshot = await db.collection('users').select('balance', 'totalDeposited', 'totalWithdrawn', 'referralEarnings', 'createdAt').get();
    
    let totalBalance = 0, totalDeposited = 0, totalWithdrawn = 0, totalReferralEarnings = 0;
    let newToday = 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    balanceSnapshot.forEach(doc => {
      const data = doc.data();
      totalBalance += data.balance || 0;
      totalDeposited += data.totalDeposited || 0;
      totalWithdrawn += data.totalWithdrawn || 0;
      totalReferralEarnings += data.referralEarnings || 0;
      
      if (data.createdAt) {
        const date = data.createdAt.toDate ? data.createdAt.toDate() : data.createdAt;
        if (date > today) newToday++;
      }
    });
    
    const totalSpins = wheelSpinsSnapshot.size;
    const totalWinnings = wheelSpinsSnapshot.docs.reduce((sum, doc) => sum + (doc.data().prizeAmount || 0), 0);
    
    const stats = {
      totalUsers: totalUsersSnapshot.data().count,
      newToday,
      totalBalance,
      totalDeposited,
      totalWithdrawn,
      totalReferralEarnings,
      pendingWithdrawals: pendingSnapshot.data().count,
      totalSpins,
      totalWinnings
    };
    
    cachedDashboard = stats;
    dashboardCacheTime = now;
    
    res.json({ success: true, stats });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'خطأ في جلب الإحصائيات' });
  }
});

app.get('/api/admin/withdraw-requests', requireAdmin, async (req, res) => {
  try {
    const { status = 'all', page = 1, limit = 50 } = req.query;
    let query = db.collection('withdraw_requests').orderBy('createdAt', 'desc');
    if (status !== 'all') query = query.where('status', '==', status);
    
    const startAt = (parseInt(page) - 1) * parseInt(limit);
    const snapshot = await query.limit(parseInt(limit)).offset(startAt).get();
    
    const requests = [];
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const userDoc = await db.collection('users').doc(data.userId).get();
      requests.push({
        id: doc.id,
        userId: data.userId,
        userEmail: data.userEmail,
        userName: data.userName,
        amount: data.amount,
        address: data.address,
        status: data.status,
        createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : new Date(data.createdAt)
      });
    }
    res.json({ success: true, requests, page: parseInt(page), hasMore: requests.length === parseInt(limit) });
  } catch (error) {
    console.error('Admin withdraws error:', error);
    res.status(500).json({ error: 'خطأ في جلب الطلبات' });
  }
});

app.post('/api/admin/process-withdraw', requireAdmin, async (req, res) => {
  try {
    const { requestId, action } = req.body;
    const requestRef = db.collection('withdraw_requests').doc(requestId);
    const requestDoc = await requestRef.get();
    
    if (!requestDoc.exists) return res.status(404).json({ error: 'طلب غير موجود' });
    
    const request = requestDoc.data();
    if (request.status !== 'pending') return res.status(400).json({ error: 'تم معالجة هذا الطلب' });
    
    const batch = db.batch();
    
    if (action === 'reject') {
      batch.update(db.collection('users').doc(request.userId), {
        balance: admin.firestore.FieldValue.increment(request.amount)
      });
    }
    
    batch.update(requestRef, {
      status: action === 'approve' ? 'approved' : 'rejected',
      processedAt: new Date(),
      processedBy: req.user.email
    });
    
    await batch.commit();
    
    res.json({ success: true, message: `تم ${action === 'approve' ? 'قبول' : 'رفض'} الطلب` });
  } catch (error) {
    console.error('Process withdraw error:', error);
    res.status(500).json({ error: 'فشل معالجة الطلب' });
  }
});

app.get('/api/admin/deposits', requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const startAt = (parseInt(page) - 1) * parseInt(limit);
    
    const snapshot = await db.collection('deposits')
      .orderBy('verifiedAt', 'desc')
      .limit(parseInt(limit))
      .offset(startAt)
      .get();
    
    const deposits = [];
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const userDoc = await db.collection('users').doc(data.userId).get();
      deposits.push({
        id: doc.id,
        userId: data.userId,
        userEmail: userDoc.exists ? userDoc.data().email : null,
        userName: userDoc.exists ? userDoc.data().name : null,
        amount: data.amount,
        method: data.method,
        transactionId: data.transactionId,
        verifiedAt: data.verifiedAt?.toDate ? data.verifiedAt.toDate() : new Date(data.verifiedAt)
      });
    }
    res.json({ success: true, deposits, page: parseInt(page), hasMore: deposits.length === parseInt(limit) });
  } catch (error) {
    console.error('Admin deposits error:', error);
    res.status(500).json({ error: 'خطأ في جلب الإيداعات' });
  }
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 30, search = '' } = req.query;
    const startAt = (parseInt(page) - 1) * parseInt(limit);
    
    let query = db.collection('users').orderBy('createdAt', 'desc');
    
    if (search) {
      const searchLower = search.toLowerCase();
      const snapshot = await query.get();
      const filtered = [];
      snapshot.forEach(doc => {
        const data = doc.data();
        if (data.email?.toLowerCase().includes(searchLower) || 
            data.name?.toLowerCase().includes(searchLower) || 
            data.uniqueId?.toLowerCase().includes(searchLower)) {
          filtered.push({ id: doc.id, ...data });
        }
      });
      const paginated = filtered.slice(startAt, startAt + parseInt(limit));
      const users = paginated.map(data => ({
        id: data.id,
        email: data.email,
        name: data.name,
        uniqueId: data.uniqueId,
        balance: data.balance,
        referralBalance: data.referralBalance || 0,
        isBanned: data.isBanned || false,
        referredBy: data.referredBy,
        referredByName: data.referredByName,
        referralEarnings: data.referralEarnings || 0,
        referralsCount: data.referrals?.length || 0,
        totalSpins: data.totalSpins || 0,
        totalWinnings: data.totalWinnings || 0
      }));
      return res.json({ success: true, users, page: parseInt(page), hasMore: paginated.length === parseInt(limit), total: filtered.length });
    }
    
    const snapshot = await query.limit(parseInt(limit)).offset(startAt).get();
    
    const users = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      users.push({
        id: doc.id,
        email: data.email,
        name: data.name,
        uniqueId: data.uniqueId,
        balance: data.balance,
        referralBalance: data.referralBalance || 0,
        isBanned: data.isBanned || false,
        referredBy: data.referredBy,
        referredByName: data.referredByName,
        referralEarnings: data.referralEarnings || 0,
        referralsCount: data.referrals?.length || 0,
        totalSpins: data.totalSpins || 0,
        totalWinnings: data.totalWinnings || 0
      });
    });
    
    res.json({ success: true, users, page: parseInt(page), hasMore: users.length === parseInt(limit) });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'خطأ في جلب المستخدمين' });
  }
});

app.post('/api/admin/update-balance', requireAdmin, async (req, res) => {
  try {
    const { userId, amount } = req.body;
    await db.collection('users').doc(userId).update({
      balance: admin.firestore.FieldValue.increment(Number(amount))
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Update balance error:', error);
    res.status(500).json({ error: 'فشل تحديث الرصيد' });
  }
});

app.post('/api/admin/toggle-ban', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.body;
    const userDoc = await db.collection('users').doc(userId).get();
    const currentBan = userDoc.data()?.isBanned || false;
    await db.collection('users').doc(userId).update({ isBanned: !currentBan });
    res.json({ success: true, isBanned: !currentBan });
  } catch (error) {
    console.error('Toggle ban error:', error);
    res.status(500).json({ error: 'فشل تحديث حالة الحظر' });
  }
});

app.post('/api/admin/update-wheel-cost', requireAdmin, async (req, res) => {
  try {
    const { cost } = req.body;
    if (!cost || cost < 10 || cost > 10000) {
      return res.status(400).json({ error: 'سعر غير صالح (يجب أن يكون بين 10 و 10000)' });
    }
    await db.collection('settings').doc('config').update({ wheelSpinCost: cost });
    cachedSettings = null;
    settingsCacheTime = 0;
    res.json({ success: true, message: `تم تحديث سعر التدويرة إلى ${cost} SYP` });
  } catch (error) {
    console.error('Update wheel cost error:', error);
    res.status(500).json({ error: 'فشل تحديث السعر' });
  }
});

app.post('/api/admin/reset-database', requireAdmin, async (req, res) => {
  try {
    const { password } = req.body;
    if (password !== RESET_PASSWORD) {
      return res.status(403).json({ error: 'كلمة المرور غير صحيحة' });
    }
    
    const collections = ['users', 'withdraw_requests', 'deposits', 'referral_commissions', 'wheel_spins', 'games'];
    for (const col of collections) {
      const snapshot = await db.collection(col).get();
      const batch = db.batch();
      snapshot.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
    }
    
    const defaultSettings = {
      minDeposit: 1000, minWithdraw: 5000, shamCashEnabled: true, syriatelEnabled: true,
      shamCashUsdEnabled: false, usdToSypRate: 13000, referralCommission: 5, wheelSpinCost: 50,
      shamCashApiKey: '', shamCashPrivateAddress: '', shamCashPublicAddress: '0930000000',
      shamCashUsdApiKey: '', shamCashUsdPrivateAddress: '', shamCashUsdPublicAddress: '',
      syriatelApiKey: '', syriatelPrivateAddress: '', syriatelPublicAddress: '0930000000',
      gameImageUrl: '', siteTheme: 'red', siteName: 'BOOMB', maintenanceMode: false
    };
    await db.collection('settings').doc('config').set(defaultSettings);
    cachedSettings = null;
    settingsCacheTime = 0;
    cachedGames = null;
    gamesCacheTime = 0;
    
    res.json({ success: true, message: 'تم تهيئة قاعدة البيانات بنجاح' });
  } catch (error) {
    console.error('Reset error:', error);
    res.status(500).json({ error: 'فشل التهيئة' });
  }
});
// ============= دوال لعبة البرج الذهبي =============

// حالة اللعبة لكل مستخدم (مخزنة في Firestore)
async function getGameState(userId) {
  const docRef = db.collection('game_states').doc(userId);
  const doc = await docRef.get();
  
  if (!doc.exists) {
    return null;
  }
  return doc.data();
}

async function saveGameState(userId, state) {
  const docRef = db.collection('game_states').doc(userId);
  await docRef.set(state, { merge: true });
}

// بدء جولة جديدة
app.post('/api/game/start', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { betAmount } = req.body;
    
    const validBets = [10, 20, 40, 80, 160, 320];
    if (!validBets.includes(betAmount)) {
      return res.status(400).json({ error: 'مبلغ رهان غير صالح' });
    }
    
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    const userData = userDoc.data();
    
    if (!userData) {
      return res.status(404).json({ error: 'مستخدم غير موجود' });
    }
    
    if ((userData.balance || 0) < betAmount) {
      return res.status(400).json({ error: 'الرصيد غير كافٍ' });
    }
    
    // خصم الرهان
    await userRef.update({
      balance: admin.firestore.FieldValue.increment(-betAmount)
    });
    
    // إنشاء حالة لعبة جديدة
    const gameState = {
      userId: uid,
      betAmount: betAmount,
      currentFloor: 0,
      currentMultiplier: 0,
      pendingProfit: 0,
      isActive: true,
      status: 'active',
      floors: [],
      startedAt: new Date(),
      lastUpdate: new Date()
    };
    
    await saveGameState(uid, gameState);
    
    res.json({
      success: true,
      gameState: {
        betAmount: betAmount,
        currentFloor: 0,
        currentMultiplier: 0,
        pendingProfit: 0,
        isActive: true
      },
      newBalance: userData.balance - betAmount
    });
    
  } catch (error) {
    console.error('Start game error:', error);
    res.status(500).json({ error: 'فشل بدء اللعبة' });
  }
});

// إفلات طابق
app.post('/api/game/drop', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { floorNumber, positionX, overlapWidth, requiredOverlap } = req.body;
    
    const gameState = await getGameState(uid);
    
    if (!gameState || !gameState.isActive) {
      return res.status(400).json({ error: 'لا توجد جولة نشطة' });
    }
    
    // المضاعفات حسب عدد الطوابق
    const multipliers = {
      1: 0.5, 2: 0.7, 3: 0.9, 4: 1.1, 5: 1.3,
      6: 1.5, 7: 1.7, 8: 3.0, 9: 5.0, 10: 7.0,
      11: 9.0, 12: 11.0, 13: 15.0
    };
    const MAX_FLOOR = 13;
    
    // التحقق من النجاح (تداخل 50% على الأقل)
    const success = overlapWidth >= requiredOverlap;
    
    if (!success) {
      // خسارة - إنهاء الجولة
      await saveGameState(uid, { isActive: false, status: 'lost' });
      
      // تسجيل الخسارة
      await db.collection('game_history').add({
        userId: uid,
        betAmount: gameState.betAmount,
        result: 'loss',
        floorsReached: floorNumber - 1,
        endedAt: new Date()
      });
      
      return res.json({
        success: false,
        result: 'loss',
        message: 'فشل البناء! تداخل غير كافٍ',
        floorsReached: floorNumber - 1
      });
    }
    
    // نجاح - إضافة الطابق
    const newFloor = floorNumber;
    const multiplier = multipliers[newFloor] || multipliers[MAX_FLOOR];
    const pendingProfit = gameState.betAmount * multiplier;
    
    const updatedState = {
      currentFloor: newFloor,
      currentMultiplier: multiplier,
      pendingProfit: pendingProfit,
      lastUpdate: new Date()
    };
    
    // إضافة الطابق إلى المصفوفة
    const floors = gameState.floors || [];
    floors.push({ floorNumber: newFloor, positionX: positionX, timestamp: new Date() });
    updatedState.floors = floors;
    
    // التحقق من إكمال البرج
    if (newFloor >= MAX_FLOOR) {
      // فوز كامل - صرف الأرباح
      const userRef = db.collection('users').doc(uid);
      await userRef.update({
        balance: admin.firestore.FieldValue.increment(pendingProfit)
      });
      
      updatedState.isActive = false;
      updatedState.status = 'completed';
      updatedState.paidOut = true;
      
      await saveGameState(uid, updatedState);
      
      // تسجيل الفوز
      await db.collection('game_history').add({
        userId: uid,
        betAmount: gameState.betAmount,
        result: 'win',
        winAmount: pendingProfit,
        multiplier: multiplier,
        floorsReached: newFloor,
        endedAt: new Date()
      });
      
      return res.json({
        success: true,
        result: 'completed',
        multiplier: multiplier,
        pendingProfit: pendingProfit,
        message: '🎉 أكملت البرج! تم إضافة الأرباح إلى رصيدك',
        newBalance: (await userRef.get()).data().balance
      });
    }
    
    await saveGameState(uid, updatedState);
    
    res.json({
      success: true,
      result: 'success',
      floorNumber: newFloor,
      multiplier: multiplier,
      pendingProfit: pendingProfit,
      message: `✅ الطابق ${newFloor} ثبُت! المضاعف ${multiplier}x`
    });
    
  } catch (error) {
    console.error('Drop floor error:', error);
    res.status(500).json({ error: 'فشل إفلات الطابق' });
  }
});

// جمع الأرباح
app.post('/api/game/cashout', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    
    const gameState = await getGameState(uid);
    
    if (!gameState || !gameState.isActive) {
      return res.status(400).json({ error: 'لا توجد أرباح لجمعها' });
    }
    
    if (gameState.pendingProfit <= 0 || gameState.currentFloor === 0) {
      return res.status(400).json({ error: 'لا توجد أرباح لجمعها' });
    }
    
    const profit = Math.floor(gameState.pendingProfit);
    const userRef = db.collection('users').doc(uid);
    
    await userRef.update({
      balance: admin.firestore.FieldValue.increment(profit)
    });
    
    // إنهاء الجولة
    await saveGameState(uid, { isActive: false, status: 'cashed_out', paidOut: true });
    
    // تسجيل السحب
    await db.collection('game_history').add({
      userId: uid,
      betAmount: gameState.betAmount,
      result: 'cashed_out',
      winAmount: profit,
      multiplier: gameState.currentMultiplier,
      floorsReached: gameState.currentFloor,
      endedAt: new Date()
    });
    
    const updatedUser = await userRef.get();
    
    res.json({
      success: true,
      profit: profit,
      newBalance: updatedUser.data().balance,
      message: `💰 تم جمع ${profit} أرباح!`
    });
    
  } catch (error) {
    console.error('Cashout error:', error);
    res.status(500).json({ error: 'فشل جمع الأرباح' });
  }
});

// الحصول على حالة اللعبة الحالية
app.get('/api/game/state', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    
    const userDoc = await db.collection('users').doc(uid).get();
    const gameState = await getGameState(uid);
    
    res.json({
      success: true,
      balance: userDoc.exists ? userDoc.data().balance : 0,
      gameActive: gameState ? gameState.isActive : false,
      gameState: gameState ? {
        betAmount: gameState.betAmount,
        currentFloor: gameState.currentFloor || 0,
        currentMultiplier: gameState.currentMultiplier || 0,
        pendingProfit: gameState.pendingProfit || 0
      } : null
    });
    
  } catch (error) {
    console.error('Get game state error:', error);
    res.status(500).json({ error: 'فشل جلب حالة اللعبة' });
  }
});

// الحصول على سجل اللعبة
app.get('/api/game/history', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    
    const snapshot = await db.collection('game_history')
      .where('userId', '==', uid)
      .orderBy('endedAt', 'desc')
      .limit(50)
      .get();
    
    const history = [];
    snapshot.forEach(doc => {
      history.push({ id: doc.id, ...doc.data() });
    });
    
    res.json({ success: true, history });
    
  } catch (error) {
    console.error('Get game history error:', error);
    res.json({ success: true, history: [] });
  }
});
// ============= تشغيل الخادم =============
const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  console.log(`✅ BOOMB Server running on port ${PORT}`);
  console.log(`📍 Admin: ${ADMIN_EMAIL}`);
  console.log(`🎰 Wheel system ready with 8 sectors`);
  console.log(`🎮 Games system ready - 50 default games available`);
  console.log(`⚡ Settings cache TTL: ${CACHE_TTL}ms`);
  console.log(`📊 Dashboard cache TTL: ${DASHBOARD_CACHE_TTL}ms`);
  console.log(`🎲 Games cache TTL: ${GAMES_CACHE_TTL}ms`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, closing server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
