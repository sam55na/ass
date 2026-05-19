import express from 'express';
import admin from 'firebase-admin';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import axios from 'axios';
import helmet from 'helmet';
import compression from 'compression';
import { createClient } from 'redis';
import NodeCache from 'node-cache';
import pkg from 'pg';

const { Pool } = pkg;

// ============= تحسينات الأداء: Redis Cache =============
let redisClient = null;
let cache = new NodeCache({ stdTTL: 60, checkperiod: 120, maxKeys: 1000 });

// محاولة الاتصال بـ Redis إذا كانت المتغيرات البيئية موجودة
if (process.env.REDIS_URL) {
  try {
    redisClient = createClient({ url: process.env.REDIS_URL });
    await redisClient.connect();
    console.log('✅ Redis connected for caching');
  } catch (error) {
    console.warn('⚠️ Redis connection failed, using NodeCache fallback');
    redisClient = null;
  }
}

// ============= Firebase Admin =============
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
const app = express();

// ============= تحسينات الأداء: Connection Pooling =============
// إعدادات Firestore المحسنة
db.settings({
  ignoreUndefinedProperties: true,
  cacheSizeBytes: admin.firestore.CACHE_SIZE_UNLIMITED
});

// ============= Middleware محسنة =============
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }
}));

app.use(compression({ level: 6, threshold: 1024 })); // ضغط أفضل

// CORS محسن لدعم مصادر متعددة
const allowedOrigins = [
  'https://sam55na.github.io',
  'https://boomb.vercel.app',
  'http://localhost:3000',
  'http://localhost:5500',
  'https://*.onrender.com',
  'https://*.cyclic.app',
  'https://*.railway.app'
];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.some(pattern => {
      if (pattern.includes('*')) {
        const regex = new RegExp(pattern.replace(/\*/g, '.*'));
        return regex.test(origin);
      }
      return pattern === origin;
    })) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Request-ID'],
  maxAge: 86400
}));

// تحليل JSON بحجم أكبر مع timeout
app.use(express.json({ limit: '5mb', timeout: 30000 }));
app.use(express.urlencoded({ extended: true, limit: '5mb', timeout: 30000 }));

// ============= Rate Limiting متقدم =============
// مخزن مؤقت للـ Rate Limiting في الذاكرة (لـ NodeCache)
const rateLimitStore = new Map();

const advancedRateLimit = (windowMs, max, keyPrefix) => {
  return async (req, res, next) => {
    const identifier = req.user?.uid || req.ip;
    const key = `${keyPrefix}:${identifier}`;
    const now = Date.now();
    
    let record = rateLimitStore.get(key);
    if (!record) {
      record = { count: 1, resetTime: now + windowMs };
      rateLimitStore.set(key, record);
      
      // تنظيف تلقائي بعد انتهاء النافذة
      setTimeout(() => rateLimitStore.delete(key), windowMs);
      return next();
    }
    
    if (now > record.resetTime) {
      record.count = 1;
      record.resetTime = now + windowMs;
      return next();
    }
    
    if (record.count >= max) {
      return res.status(429).json({ 
        error: `طلبات كثيرة جداً، الرجاء الانتظار ${Math.ceil((record.resetTime - now) / 1000)} ثانية` 
      });
    }
    
    record.count++;
    next();
  };
};

// حدود مختلفة حسب نوع المستخدم والأدمن
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'طلبات كثيرة، انتظر دقيقة' },
  standardHeaders: true,
  legacyHeaders: false
});

const userLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'الرجاء الانتظار قليلاً' },
  keyGenerator: (req) => req.user?.uid || req.ip
});

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: { error: 'حد الطلبات للأدمن' }
});

const sensitiveLimiter = advancedRateLimit(60 * 1000, 5, 'sensitive');
const spinLimiter = advancedRateLimit(300 * 1000, 1, 'spin'); // تدوير واحد كل 5 دقائق

// ============= تحسين: تجميع الطلبات (Request Batching) =============
const pendingDeposits = new Map();
const BATCH_WINDOW = 100; // ميلي ثانية

async function batchProcessDeposits() {
  const batches = Array.from(pendingDeposits.entries());
  pendingDeposits.clear();
  
  for (const [key, { userId, amount, method, transactionId, resolve, reject }] of batches) {
    try {
      // معالجة كل إيداع على حدة
      const result = await processDepositSync(userId, amount, method, transactionId);
      resolve(result);
    } catch (error) {
      reject(error);
    }
  }
}

setInterval(batchProcessDeposits, BATCH_WINDOW);

// ============= تحسين: استخدام Bulk Writes =============
const bulkWriteQueue = [];
let bulkWriteTimeout = null;

async function flushBulkWrites() {
  if (bulkWriteQueue.length === 0) return;
  
  const writes = [...bulkWriteQueue];
  bulkWriteQueue.length = 0;
  
  try {
    const batch = db.batch();
    for (const { ref, data, type } of writes) {
      if (type === 'update') {
        batch.update(ref, data);
      } else if (type === 'set') {
        batch.set(ref, data, { merge: true });
      }
    }
    await batch.commit();
  } catch (error) {
    console.error('Bulk write error:', error);
    // إعادة المحاولة للكتابات الفاشلة
    setTimeout(() => {
      bulkWriteQueue.push(...writes);
      flushBulkWrites();
    }, 1000);
  }
}

function queueBulkWrite(ref, data, type = 'update') {
  bulkWriteQueue.push({ ref, data, type });
  if (!bulkWriteTimeout) {
    bulkWriteTimeout = setTimeout(() => {
      flushBulkWrites();
      bulkWriteTimeout = null;
    }, 50);
  }
}

// ============= تحسين: Caching Layer =============
const CACHE_TTL = {
  SETTINGS: 300, // 5 دقائق
  USER_STATS: 60, // دقيقة
  ADMIN_DASHBOARD: 30, // 30 ثانية
  WHEEL_SETTINGS: 300
};

async function getCached(key, ttl = CACHE_TTL.SETTINGS, fetcher) {
  // محاولة Redis أولاً
  if (redisClient && redisClient.isOpen) {
    try {
      const cached = await redisClient.get(key);
      if (cached) return JSON.parse(cached);
    } catch (error) {
      console.error('Redis get error:', error);
    }
  }
  
  // محاولة NodeCache
  let cached = cache.get(key);
  if (cached !== undefined) return cached;
  
  // جلب البيانات جديدة
  const data = await fetcher();
  cache.set(key, data, ttl);
  
  // تخزين في Redis بشكل غير متزامن
  if (redisClient && redisClient.isOpen) {
    redisClient.setEx(key, ttl, JSON.stringify(data)).catch(console.error);
  }
  
  return data;
}

async function invalidateCache(keys) {
  for (const key of keys) {
    cache.del(key);
    if (redisClient && redisClient.isOpen) {
      await redisClient.del(key).catch(console.error);
    }
  }
}

// ============= الثوابت =============
const RESET_PASSWORD = '2613857';
const ADMIN_EMAIL = 'sam55nam@gmail.com';
const WHEEL_COOLDOWN = 300000; // 5 دقائق بالميلي ثانية

// ============= دالة إنشاء كود فريد محسنة =============
async function generateUniqueReferralCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const attempts = [];
  
  // توليد 5 أكواد عشوائية ومحاولة متوازية
  for (let i = 0; i < 5; i++) {
    let code = '';
    for (let j = 0; j < 8; j++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    attempts.push(code);
  }
  
  const existingDocs = await Promise.all(
    attempts.map(code => db.collection('users').where('uniqueId', '==', code).limit(1).get())
  );
  
  for (let i = 0; i < attempts.length; i++) {
    if (existingDocs[i].empty) {
      return attempts[i];
    }
  }
  
  // إذا كانت كل الأكواد مستخدمة، استخدم طابع زمني
  return 'UID' + Date.now().toString().slice(-8);
}

// ============= المصادقة المحسنة =============
const authCache = new Map();

const requireAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) {
    return res.status(401).json({ error: 'غير مصرح' });
  }
  
  // التحقق من التوكين في الكاش
  if (authCache.has(token)) {
    const cached = authCache.get(token);
    if (cached.expires > Date.now()) {
      req.user = cached.user;
      return next();
    }
    authCache.delete(token);
  }
  
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    
    // تخزين مؤقت لمدة 5 دقائق
    authCache.set(token, {
      user: decoded,
      expires: Date.now() + 300000
    });
    
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(401).json({ error: 'جلسة غير صالحة' });
  }
};

const requireAdmin = async (req, res, next) => {
  if (!req.user) {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'غير مصرح' });
    try {
      req.user = await admin.auth().verifyIdToken(token);
    } catch (error) {
      return res.status(401).json({ error: 'جلسة غير صالحة' });
    }
  }
  
  if (req.user.email !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'غير مصرح - هذه المنطقة للمشرف فقط' });
  }
  next();
};

// ============= إعدادات النظام مع Caching =============
async function getSettings() {
  return getCached('system_settings', CACHE_TTL.SETTINGS, async () => {
    try {
      const doc = await db.collection('settings').doc('config').get();
      if (doc.exists) return doc.data();
      
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
      return defaultSettings;
    } catch (error) {
      console.error('Error getting settings:', error);
      throw error;
    }
  });
}

async function updateSettings(newSettings) {
  const settingsRef = db.collection('settings').doc('config');
  await settingsRef.update(newSettings);
  await invalidateCache(['system_settings']);
}

// ============= كلاس شام كاش مع Retry Logic =============
class ShamCashClient {
  constructor(apiKey, accountAddress) {
    this.apiKey = apiKey;
    this.accountAddress = accountAddress;
    this.baseUrl = "https://apisyria.com/api/v1";
  }

  async verifyTransaction(txid, expectedAmount = null, expectedCurrency = null, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        const params = {
          resource: "shamcash",
          action: "logs",
          account_address: this.accountAddress,
          api_key: this.apiKey
        };
        const response = await axios.get(this.baseUrl, { params, timeout: 30000 });
        
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
      } catch (error) {
        console.error(`ShamCash error (attempt ${i + 1}):`, error.message);
        if (i === retries - 1) {
          return { success: false, message: "خطأ في الاتصال بخدمة شام كاش" };
        }
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); // تأخير متزايد
      }
    }
    return { success: false, message: "فشل التحقق بعد عدة محاولات" };
  }
}

class ShamCashUsdClient {
  constructor(apiKey, accountAddress) {
    this.apiKey = apiKey;
    this.accountAddress = accountAddress;
    this.baseUrl = "https://apisyria.com/api/v1";
  }

  async verifyTransaction(txid, expectedAmount = null, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        const params = {
          resource: "shamcash",
          action: "logs",
          account_address: this.accountAddress,
          api_key: this.apiKey
        };
        const response = await axios.get(this.baseUrl, { params, timeout: 30000 });
        
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
      } catch (error) {
        console.error(`ShamCash USD error (attempt ${i + 1}):`, error.message);
        if (i === retries - 1) {
          return { success: false, message: "خطأ في الاتصال بخدمة شام كاش" };
        }
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
      }
    }
    return { success: false, message: "فشل التحقق بعد عدة محاولات" };
  }
}

class SyriatelCashClient {
  constructor(apiKey, gsmNumbers) {
    this.apiKey = apiKey;
    this.gsmNumbers = Array.isArray(gsmNumbers) ? gsmNumbers : [gsmNumbers];
    this.baseUrl = "https://apisyria.com/api/v1";
  }

  async verifyTransaction(txid, expectedAmount = null, retries = 2) {
    for (const gsm of this.gsmNumbers) {
      for (let i = 0; i < retries; i++) {
        try {
          const params = {
            api_key: this.apiKey,
            resource: "syriatel",
            action: "find_tx",
            tx: txid,
            gsm: gsm
          };
          const response = await axios.get(this.baseUrl, { params, timeout: 30000 });
          
          if (response.status === 200 && response.data.success && response.data.data?.found) {
            const transaction = response.data.data.transaction || {};
            const apiAmount = parseFloat(transaction.amount || 0);
            if (expectedAmount && Math.abs(apiAmount - expectedAmount) > 0.01) {
              return { success: false, message: "المبلغ غير متطابق" };
            }
            return { success: true, amount: apiAmount, currency: "SYP" };
          }
        } catch (error) {
          console.error(`Syriatel error (${gsm}, attempt ${i + 1}):`, error.message);
        }
      }
    }
    return { success: false, message: "رقم العملية غير موجود" };
  }
}

// ============= دالة عجلة الحظ المحسنة =============
const WHEEL_SECTORS = [
  { id: 1, name: 'حظ أوفر', type: 'luck', value: 0, probability: 40 },
  { id: 2, name: '10 رصيد أساسي', type: 'balance', value: 10, probability: 10 },
  { id: 3, name: '20 رصيد أساسي', type: 'balance', value: 20, probability: 5 },
  { id: 4, name: '30 رصيد أساسي', type: 'balance', value: 30, probability: 5 },
  { id: 5, name: 'حظ أوفر', type: 'luck', value: 0, probability: 40 },
  { id: 6, name: '10 رصيد أساسي', type: 'balance', value: 10, probability: 10 },
  { id: 7, name: '20 رصيد أساسي', type: 'balance', value: 20, probability: 5 },
  { id: 8, name: '30 رصيد أساسي', type: 'balance', value: 30, probability: 5 }
];

function getRandomSector() {
  const random = Math.random() * 100;
  let cumulative = 0;
  for (const sector of WHEEL_SECTORS) {
    cumulative += sector.probability;
    if (random < cumulative) return sector;
  }
  return WHEEL_SECTORS[0];
}

// ============= عمولة الإحالة المحسنة =============
async function addReferralCommission(userId, depositAmount, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const userDoc = await db.collection('users').doc(userId).get();
      const userData = userDoc.data();
      
      if (userData && userData.referredBy) {
        const settings = await getSettings();
        const commissionPercent = settings.referralCommission || 5;
        const commissionAmount = (depositAmount * commissionPercent) / 100;
        
        if (commissionAmount > 0) {
          const referrerRef = db.collection('users').doc(userData.referredBy);
          
          await db.runTransaction(async (transaction) => {
            const referrerDoc = await transaction.get(referrerRef);
            if (!referrerDoc.exists) return;
            
            const currentReferralBalance = referrerDoc.data().referralBalance || 0;
            const currentReferralEarnings = referrerDoc.data().referralEarnings || 0;
            
            transaction.update(referrerRef, {
              referralBalance: currentReferralBalance + commissionAmount,
              referralEarnings: currentReferralEarnings + commissionAmount
            });
            
            const commissionRef = db.collection('referral_commissions').doc();
            transaction.set(commissionRef, {
              userId: userData.referredBy,
              fromUserId: userId,
              amount: commissionAmount,
              depositAmount: depositAmount,
              percent: commissionPercent,
              createdAt: new Date()
            });
          });
          
          console.log(`✅ تم إضافة ${commissionAmount} SYP إلى رصيد إحالات المستخدم ${userData.referredBy}`);
        }
      }
      return;
    } catch (error) {
      console.error(`Commission error (attempt ${i + 1}):`, error);
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * (i + 1)));
    }
  }
}

// ============= معالجة الإيداع المتزامنة =============
async function processDepositSync(userId, amountNum, method, transactionId) {
  const settings = await getSettings();
  let verification = null;
  let finalAmountSYP = amountNum;
  let originalCurrency = 'SYP';
  let originalAmount = amountNum;
  
  if (method === 'sham_cash') {
    if (!settings.shamCashEnabled || !settings.shamCashApiKey || !settings.shamCashPrivateAddress) {
      throw new Error('طريقة الدفع شام كاش غير مفعلة');
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
      throw new Error('طريقة الدفع شام كاش دولار غير مفعلة');
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
      throw new Error('طريقة الدفع سيرياتيل كاش غير مفعلة');
    }
    const client = new SyriatelCashClient(settings.syriatelApiKey, settings.syriatelPrivateAddress);
    verification = await client.verifyTransaction(transactionId, amountNum);
    
    if (verification.success) {
      originalAmount = verification.amount;
      originalCurrency = verification.currency || 'SYP';
      finalAmountSYP = originalAmount;
    }
  } else {
    throw new Error('طريقة دفع غير مدعومة');
  }
  
  if (!verification || !verification.success) {
    throw new Error(verification?.message || 'فشل التحقق');
  }
  
  if (finalAmountSYP < settings.minDeposit) {
    throw new Error(`الحد الأدنى ${settings.minDeposit} SYP`);
  }
  
  // التحقق من عدم تكرار العملية
  const existing = await db.collection('deposits').where('transactionId', '==', transactionId).limit(1).get();
  if (!existing.empty) {
    throw new Error('تم استخدام رقم العملية مسبقاً');
  }
  
  const userRef = db.collection('users').doc(userId);
  
  // استخدام Transaction لضمان الذرية
  await db.runTransaction(async (transaction) => {
    const userDoc = await transaction.get(userRef);
    if (!userDoc.exists) throw new Error('مستخدم غير موجود');
    
    const currentBalance = userDoc.data().balance || 0;
    const currentTotalDeposited = userDoc.data().totalDeposited || 0;
    
    transaction.update(userRef, {
      balance: currentBalance + finalAmountSYP,
      totalDeposited: currentTotalDeposited + finalAmountSYP
    });
    
    const depositRef = db.collection('deposits').doc();
    transaction.set(depositRef, {
      userId: userId,
      method: method,
      amount: finalAmountSYP,
      originalAmount: originalAmount,
      originalCurrency: originalCurrency,
      transactionId: transactionId,
      status: 'completed',
      verifiedAt: new Date(),
      exchangeRate: method === 'sham_cash_usd' ? settings.usdToSypRate : null
    });
  });
  
  // معالجة العمولة بشكل غير متزامن
  addReferralCommission(userId, finalAmountSYP).catch(console.error);
  
  return { success: true, amount: finalAmountSYP };
}

// ============= APIs =============

// ===== عجلة الحظ =====
app.get('/api/user/wheel-status', requireAuth, userLimiter, async (req, res) => {
  try {
    const { uid } = req.user;
    const userDoc = await db.collection('users').doc(uid).get();
    const userData = userDoc.data();
    const settings = await getSettings();
    
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
      canSpin,
      remainingSeconds,
      spinCost: settings.wheelSpinCost || 50,
      referralBalance: userData.referralBalance || 0,
      hasEnoughBalance: (userData.referralBalance || 0) >= (settings.wheelSpinCost || 50)
    });
  } catch (error) {
    console.error('Wheel status error:', error);
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

app.post('/api/user/spin-wheel', requireAuth, spinLimiter, async (req, res) => {
  try {
    const { uid } = req.user;
    const userRef = db.collection('users').doc(uid);
    
    let result = await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) throw new Error('مستخدم غير موجود');
      
      const userData = userDoc.data();
      const lastSpin = userData.lastSpinTime?.toDate ? userData.lastSpinTime.toDate() : userData.lastSpinTime;
      const now = new Date();
      
      if (lastSpin) {
        const timeDiff = (now - lastSpin) / 1000;
        if (timeDiff < 300) {
          throw new Error(`يجب الانتظار ${Math.ceil(300 - timeDiff)} ثانية`);
        }
      }
      
      const settings = await getSettings();
      const spinCost = settings.wheelSpinCost || 50;
      
      if ((userData.referralBalance || 0) < spinCost) {
        throw new Error(`رصيد الإحالات غير كافٍ. تحتاج ${spinCost} SYP`);
      }
      
      const selectedSector = getRandomSector();
      let prizeAmount = 0;
      let prizeMessage = '';
      
      if (selectedSector.type === 'balance') {
        prizeAmount = selectedSector.value;
        prizeMessage = `🎉 فزت بـ ${prizeAmount} SYP!`;
        
        transaction.update(userRef, {
          balance: (userData.balance || 0) + prizeAmount,
          referralBalance: (userData.referralBalance || 0) - spinCost,
          lastSpinTime: now,
          totalSpins: (userData.totalSpins || 0) + 1,
          totalWinnings: (userData.totalWinnings || 0) + prizeAmount
        });
      } else {
        prizeMessage = `😅 حظ أوفر!`;
        transaction.update(userRef, {
          referralBalance: (userData.referralBalance || 0) - spinCost,
          lastSpinTime: now,
          totalSpins: (userData.totalSpins || 0) + 1
        });
      }
      
      const spinRef = db.collection('wheel_spins').doc();
      transaction.set(spinRef, {
        userId: uid,
        sector: selectedSector.id,
        sectorName: selectedSector.name,
        prizeAmount: prizeAmount,
        prizeType: selectedSector.type,
        spinCost: spinCost,
        timestamp: now,
        userEmail: userData.email,
        userName: userData.name
      });
      
      return { selectedSector, prizeAmount, prizeMessage, spinCost };
    });
    
    res.json({
      success: true,
      sector: result.selectedSector.id,
      sectorName: result.selectedSector.name,
      prizeAmount: result.prizeAmount,
      prizeType: result.selectedSector.type,
      message: result.prizeMessage,
      spinCost: result.spinCost
    });
    
  } catch (error) {
    console.error('Spin wheel error:', error);
    res.status(500).json({ error: error.message || 'حدث خطأ أثناء التدوير' });
  }
});

app.get('/api/user/wheel-history', requireAuth, userLimiter, async (req, res) => {
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

// ===== إعدادات الإيداع (مع Caching) =====
app.get('/api/user/deposit-settings', requireAuth, userLimiter, async (req, res) => {
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
        methods,
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

// ===== الإيداع (مع Batch Processing) =====
app.post('/api/user/deposit', requireAuth, sensitiveLimiter, async (req, res) => {
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
    
    // استخدام Batch Processing للطلبات الكثيرة
    const key = `${uid}:${transactionId}`;
    if (pendingDeposits.has(key)) {
      return res.status(429).json({ error: 'طلب قيد المعالجة، انتظر قليلاً' });
    }
    
    const result = await new Promise((resolve, reject) => {
      pendingDeposits.set(key, {
        userId: uid,
        amount: amountNum,
        method,
        transactionId,
        resolve,
        reject
      });
      
      setTimeout(() => {
        if (pendingDeposits.has(key)) {
          pendingDeposits.delete(key);
          reject(new Error('انتهى وقت المعالجة'));
        }
      }, 30000);
    });
    
    await invalidateCache([`user_stats_${uid}`]);
    
    res.json({ success: true, message: `تم إيداع ${result.amount.toLocaleString()} SYP` });
    
  } catch (error) {
    console.error('Deposit error:', error);
    res.status(500).json({ error: error.message || 'حدث خطأ داخلي' });
  }
});

// ===== الملف الشخصي (مع Caching) =====
app.get('/api/user/profile', requireAuth, userLimiter, async (req, res) => {
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

// ===== الإحصائيات (مع Caching) =====
app.get('/api/user/stats', requireAuth, userLimiter, async (req, res) => {
  try {
    const { uid } = req.user;
    
    const stats = await getCached(`user_stats_${uid}`, CACHE_TTL.USER_STATS, async () => {
      const userDoc = await db.collection('users').doc(uid).get();
      if (!userDoc.exists) throw new Error('مستخدم غير موجود');
      
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
      
      const settings = await getSettings();
      
      return {
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
      };
    });
    
    res.json({ success: true, stats });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'خطأ في جلب الإحصائيات' });
  }
});

// ===== التسجيل =====
app.post('/api/user/register', requireAuth, publicLimiter, async (req, res) => {
  try {
    const { uid, email, name } = req.user;
    const { referrerId } = req.body;
    
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    
    if (userDoc.exists) {
      return res.json({ success: true, user: userDoc.data(), isAdmin: email === ADMIN_EMAIL });
    }
    
    const uniqueId = await generateUniqueReferralCode();
    
    let referredBy = null;
    let referrerName = null;
    
    if (referrerId) {
      const refQuery = await db.collection('users').where('uniqueId', '==', referrerId).limit(1).get();
      if (!refQuery.empty) {
        referredBy = refQuery.docs[0].id;
        referrerName = refQuery.docs[0].data().name;
        
        // تحديث المحيل بشكل غير متزامن
        refQuery.docs[0].ref.update({
          referralBalance: admin.firestore.FieldValue.increment(5),
          referralEarnings: admin.firestore.FieldValue.increment(5),
          referrals: admin.firestore.FieldValue.arrayUnion(uid)
        }).catch(console.error);
      }
    }
    
    const newUser = {
      uniqueId,
      email,
      name: name || email.split('@')[0],
      balance: 0,
      referralBalance: 0,
      totalDeposited: 0,
      totalWithdrawn: 0,
      referralEarnings: 0,
      referredBy,
      referredByName: referrerName,
      referrals: [],
      createdAt: new Date(),
      isBanned: false,
      lastLogin: new Date(),
      lastSpinTime: null,
      totalSpins: 0,
      totalWinnings: 0
    };
    
    await userRef.set(newUser);
    
    res.json({ success: true, user: newUser, isAdmin: email === ADMIN_EMAIL });
    
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'خطأ في التسجيل' });
  }
});

// ===== باقي APIs (مختصرة ولكن محسنة) =====
app.get('/api/user/deposits', requireAuth, userLimiter, async (req, res) => {
  try {
    const snapshot = await db.collection('deposits')
      .where('userId', '==', req.user.uid)
      .orderBy('verifiedAt', 'desc')
      .limit(50)
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

app.get('/api/user/withdraw-requests', requireAuth, userLimiter, async (req, res) => {
  try {
    const snapshot = await db.collection('withdraw_requests')
      .where('userId', '==', req.user.uid)
      .orderBy('createdAt', 'desc')
      .limit(50)
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

app.post('/api/user/withdraw', requireAuth, sensitiveLimiter, async (req, res) => {
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
    
    await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) throw new Error('مستخدم غير موجود');
      
      const userData = userDoc.data();
      if (userData.isBanned) throw new Error('حسابك محظور');
      if ((userData.balance || 0) < amountNum) throw new Error('الرصيد غير كافٍ');
      
      transaction.update(userRef, {
        balance: (userData.balance || 0) - amountNum,
        totalWithdrawn: (userData.totalWithdrawn || 0) + amountNum
      });
      
      const withdrawRef = db.collection('withdraw_requests').doc();
      transaction.set(withdrawRef, {
        userId: uid,
        userEmail: userData.email,
        userName: userData.name,
        amount: amountNum,
        address,
        method: method || 'sham_cash',
        status: 'pending',
        createdAt: new Date()
      });
    });
    
    await invalidateCache([`user_stats_${uid}`]);
    
    res.json({ success: true, message: `تم إنشاء طلب سحب بمبلغ ${amountNum.toLocaleString()} SYP` });
    
  } catch (error) {
    console.error('Withdraw error:', error);
    res.status(500).json({ error: error.message || 'فشل إنشاء طلب السحب' });
  }
});

app.post('/api/user/add-referrer', requireAuth, sensitiveLimiter, async (req, res) => {
  try {
    const { uid } = req.user;
    const { referrerCode } = req.body;
    
    if (!referrerCode) {
      return res.status(400).json({ error: 'كود الإحالة مطلوب' });
    }
    
    const userRef = db.collection('users').doc(uid);
    
    await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) throw new Error('مستخدم غير موجود');
      
      const userData = userDoc.data();
      if (userData.referredBy) throw new Error('لديك محيل بالفعل');
      
      const referrerQuery = await db.collection('users').where('uniqueId', '==', referrerCode).limit(1).get();
      if (referrerQuery.empty) throw new Error('كود الإحالة غير صحيح');
      
      const referrerDoc = referrerQuery.docs[0];
      const referrerId = referrerDoc.id;
      
      if (referrerId === uid) throw new Error('لا يمكنك إحالة نفسك');
      
      transaction.update(userRef, {
        referredBy: referrerId,
        referredByName: referrerDoc.data().name
      });
      
      transaction.update(referrerDoc.ref, {
        referralBalance: (referrerDoc.data().referralBalance || 0) + 5,
        referralEarnings: (referrerDoc.data().referralEarnings || 0) + 5,
        referrals: [...(referrerDoc.data().referrals || []), uid]
      });
    });
    
    await invalidateCache([`user_stats_${uid}`]);
    
    res.json({ success: true, message: 'تم إضافة المحيل بنجاح' });
    
  } catch (error) {
    console.error('Add referrer error:', error);
    res.status(500).json({ error: error.message || 'حدث خطأ' });
  }
});

// ===== Admin APIs =====
app.get('/api/admin/settings', requireAdmin, adminLimiter, async (req, res) => {
  const settings = await getSettings();
  res.json({ success: true, settings });
});

app.post('/api/admin/settings', requireAdmin, adminLimiter, async (req, res) => {
  try {
    await updateSettings(req.body);
    res.json({ success: true, message: 'تم تحديث الإعدادات' });
  } catch (error) {
    console.error('Save settings error:', error);
    res.status(500).json({ error: 'فشل تحديث الإعدادات' });
  }
});

app.get('/api/admin/dashboard', requireAdmin, adminLimiter, async (req, res) => {
  try {
    const dashboard = await getCached('admin_dashboard', CACHE_TTL.ADMIN_DASHBOARD, async () => {
      const usersSnapshot = await db.collection('users').get();
      const users = [];
      usersSnapshot.forEach(doc => users.push(doc.data()));
      
      const totalBalance = users.reduce((s, u) => s + (u.balance || 0), 0);
      const totalDeposited = users.reduce((s, u) => s + (u.totalDeposited || 0), 0);
      const totalWithdrawn = users.reduce((s, u) => s + (u.totalWithdrawn || 0), 0);
      const totalReferralEarnings = users.reduce((s, u) => s + (u.referralEarnings || 0), 0);
      
      const pendingSnapshot = await db.collection('withdraw_requests').where('status', '==', 'pending').get();
      
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const newToday = users.filter(u => {
        if (!u.createdAt) return false;
        const date = u.createdAt.toDate ? u.createdAt.toDate() : u.createdAt;
        return date > today;
      }).length;
      
      const wheelSpinsSnapshot = await db.collection('wheel_spins').get();
      const totalSpins = wheelSpinsSnapshot.size;
      const totalWinnings = wheelSpinsSnapshot.docs.reduce((sum, doc) => sum + (doc.data().prizeAmount || 0), 0);
      
      return {
        totalUsers: usersSnapshot.size,
        newToday,
        totalBalance,
        totalDeposited,
        totalWithdrawn,
        totalReferralEarnings,
        pendingWithdrawals: pendingSnapshot.size,
        totalSpins,
        totalWinnings
      };
    });
    
    res.json({ success: true, stats: dashboard });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'خطأ في جلب الإحصائيات' });
  }
});

app.get('/api/admin/users', requireAdmin, adminLimiter, async (req, res) => {
  try {
    const snapshot = await db.collection('users').orderBy('createdAt', 'desc').limit(200).get();
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
    res.json({ success: true, users });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'خطأ في جلب المستخدمين' });
  }
});

// ===== Health Check =====
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    cache: {
      redis: redisClient?.isOpen || false,
      nodeCache: cache.keys().length
    }
  });
});

// ===== Error Handling =====
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'حدث خطأ داخلي في الخادم' });
});

// ===== تشغيل الخادم =====
const PORT = process.env.PORT || 3001;

const server = app.listen(PORT, () => {
  console.log(`✅ BOOMB Server running on port ${PORT}`);
  console.log(`📍 Admin: ${ADMIN_EMAIL}`);
  console.log(`🎰 Wheel system ready with 8 sectors`);
  console.log(`🚀 Optimized for high concurrency`);
  console.log(`💾 Cache: ${redisClient ? 'Redis active' : 'NodeCache fallback'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  server.close(async () => {
    if (redisClient) await redisClient.quit();
    process.exit(0);
  });
});

export default app;
