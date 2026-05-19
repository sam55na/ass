import express from 'express';
import admin from 'firebase-admin';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import axios from 'axios';
import helmet from 'helmet';
import compression from 'compression';
import cluster from 'cluster';
import os from 'os';
import { body, validationResult, param, query } from 'express-validator';
import NodeCache from 'node-cache';
import winston from 'winston';
import { v4 as uuidv4 } from 'uuid';

// ============= تهيئة نظام التسجيل (Logging) =============
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({ format: winston.format.simple() })
  ]
});

// ============= التخزين المؤقت (Caching) =============
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // TTL 5 دقائق

// ============= تهيئة Firebase مع إعدادات Pooling أفضل =============
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CERT_URL
};

// تحسين إعدادات Firebase للاتصالات المتزامنة العالية
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID,
  databaseURL: process.env.FIREBASE_DATABASE_URL,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET
});

const db = admin.firestore();

// إعدادات Firestore للحمل العالي
db.settings({
  ignoreUndefinedProperties: true,
  cacheSizeBytes: admin.firestore.CACHE_SIZE_UNLIMITED
});

// ============= إعدادات الخادم المحسنة =============
const app = express();
const PORT = process.env.PORT || 3001;

// إعدادات Helmet المتقدمة
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://apis.google.com"],
      imgSrc: ["'self'", "data:", "https://firebasestorage.googleapis.com"],
      connectSrc: ["'self'", "https://apisyria.com", "https://*.firebaseio.com"]
    }
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }
}));

app.use(compression({ level: 6, threshold: 1024 })); // ضغط أفضل

// CORS ديناميكي للإنتاج
const allowedOrigins = [
  'https://sam55na.github.io',
  'http://localhost:3000',
  'http://localhost:5500',
  process.env.CLIENT_URL
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-correlation-id'],
  maxAge: 86400 // 24 ساعة
}));

// تحليل الطلبات الكبيرة بحدود محسنة
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// تتبع معرف فريد لكل طلب (tracing)
app.use((req, res, next) => {
  req.correlationId = uuidv4();
  res.setHeader('x-correlation-id', req.correlationId);
  next();
});

// ============= نظام منع الهجمات المتقدم =============
// Rate limiter ديناميكي بناءً على المسار
const createRateLimiter = (windowMs, max, keyPrefix) => rateLimit({
  windowMs,
  max,
  keyGenerator: (req) => req.user?.uid || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  keyPrefix,
  handler: (req, res) => {
    logger.warn(`Rate limit exceeded for ${keyPrefix}`, { ip: req.ip, userId: req.user?.uid });
    res.status(429).json({ error: 'عدد الطلبات كبير جداً، حاول لاحقاً', retryAfter: Math.ceil(windowMs / 1000) });
  }
});

const globalLimiter = createRateLimiter(60 * 1000, 100, 'global');
const authLimiter = createRateLimiter(15 * 60 * 1000, 20, 'auth'); // 20 محاولة كل 15 دقيقة
const depositLimiter = createRateLimiter(60 * 1000, 5, 'deposit'); // 5 إيداعات في الدقيقة
const spinLimiter = createRateLimiter(60 * 1000, 2, 'spin'); // تدويرتين في الدقيقة

app.use('/api/', globalLimiter);
app.use('/api/user/register', authLimiter);
app.use('/api/user/deposit', depositLimiter);
app.use('/api/user/withdraw', depositLimiter);
app.use('/api/user/spin-wheel', spinLimiter);

// ============= الثوابت والتكوينات =============
const RESET_PASSWORD = process.env.RESET_PASSWORD || '2613857';
const ADMIN_EMAILS = process.env.ADMIN_EMAILS?.split(',') || ['sam55nam@gmail.com'];

// إعدادات التحقق من API الخارجية
const API_RETRY_CONFIG = {
  maxRetries: 3,
  retryDelay: 1000,
  timeout: 15000
};

// دالة إعادة المحاولة الذكية
async function withRetry(fn, context = 'unknown') {
  let lastError;
  for (let attempt = 1; attempt <= API_RETRY_CONFIG.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      logger.warn(`Retry ${attempt}/${API_RETRY_CONFIG.maxRetries} for ${context}`, { error: error.message });
      if (attempt < API_RETRY_CONFIG.maxRetries) {
        await new Promise(resolve => setTimeout(resolve, API_RETRY_CONFIG.retryDelay * attempt));
      }
    }
  }
  throw lastError;
}

// ============= فئات API الخارجية المحسنة =============
class PaymentClient {
  constructor(apiKey, address, baseUrl = "https://apisyria.com/api/v1") {
    this.apiKey = apiKey;
    this.address = address;
    this.baseUrl = baseUrl;
    this.axiosInstance = axios.create({
      timeout: API_RETRY_CONFIG.timeout,
      headers: { 'User-Agent': 'BOOMB-Payment/1.0' }
    });
  }

  async verifyTransaction(txid, expectedAmount = null, currency = null) {
    return withRetry(async () => {
      const params = {
        resource: "shamcash",
        action: "logs",
        account_address: this.address,
        api_key: this.apiKey
      };
      
      const response = await this.axiosInstance.get(this.baseUrl, { params });
      
      if (response.status === 200 && response.data?.success) {
        const items = response.data.data?.items || [];
        const transaction = items.find(item => String(item.tran_id) === String(txid));
        
        if (!transaction) {
          return { success: false, message: "رقم العملية غير موجود" };
        }
        
        const timestamp = transaction.created_at || 0;
        if ((Date.now() / 1000 - timestamp) > 86400) {
          return { success: false, message: "العملية أقدم من 24 ساعة" };
        }
        
        const amount = parseFloat(transaction.amount);
        const txCurrency = transaction.currency || 'SYP';
        
        if (currency && txCurrency !== currency) {
          return { success: false, message: `نوع العملة غير متطابق: ${txCurrency}` };
        }
        
        if (expectedAmount && Math.abs(amount - expectedAmount) > 0.01) {
          return { success: false, message: `المبلغ غير متطابق: ${amount}` };
        }
        
        return { success: true, amount, currency: txCurrency };
      }
      
      return { success: false, message: "فشل التحقق من العملية" };
    }, `payment_verify_${txid}`);
  }
}

// ============= منطق عجلة الحظ =============
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

// ============= دوال مساعدة لـ Firestore =============
async function getCachedSettings() {
  let settings = cache.get('system_settings');
  if (settings) return settings;
  
  const doc = await db.collection('settings').doc('config').get();
  const defaultSettings = {
    minDeposit: 1000, minWithdraw: 5000, shamCashEnabled: true, syriatelEnabled: true,
    shamCashUsdEnabled: false, usdToSypRate: 13000, referralCommission: 5, wheelSpinCost: 50,
    shamCashApiKey: '', shamCashPrivateAddress: '', shamCashPublicAddress: '0930000000',
    shamCashUsdApiKey: '', shamCashUsdPrivateAddress: '', shamCashUsdPublicAddress: '',
    syriatelApiKey: '', syriatelPrivateAddress: '', syriatelPublicAddress: '0930000000',
    gameImageUrl: '', siteTheme: 'red', siteName: 'BOOMB', maintenanceMode: false
  };
  
  settings = doc.exists ? doc.data() : defaultSettings;
  if (!doc.exists) await db.collection('settings').doc('config').set(defaultSettings);
  
  cache.set('system_settings', settings);
  return settings;
}

async function getUserData(uid) {
  const userRef = db.collection('users').doc(uid);
  const doc = await userRef.get();
  if (!doc.exists) return null;
  return { ref: userRef, data: doc.data() };
}

// ============= Middleware المصادقة =============
const requireAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) {
    return res.status(401).json({ error: 'غير مصرح', code: 'NO_TOKEN' });
  }
  
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    logger.error('Auth error', { error: error.message, correlationId: req.correlationId });
    res.status(401).json({ error: 'جلسة غير صالحة', code: 'INVALID_TOKEN' });
  }
};

const requireAdmin = async (req, res, next) => {
  if (!req.user || !ADMIN_EMAILS.includes(req.user.email)) {
    return res.status(403).json({ error: 'غير مصرح - هذه المنطقة للمشرف فقط', code: 'ADMIN_ONLY' });
  }
  next();
};

// ============= Validation Middleware =============
const validate = (validations) => {
  return async (req, res, next) => {
    await Promise.all(validations.map(validation => validation.run(req)));
    const errors = validationResult(req);
    if (errors.isEmpty()) return next();
    res.status(400).json({ error: 'بيانات غير صالحة', details: errors.array() });
  };
};

// ============= Routes with Enhanced Error Handling =============

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString(), uptime: process.uptime() });
});

// إعدادات عجلة الحظ
app.get('/api/user/wheel-status', requireAuth, async (req, res) => {
  try {
    const userData = await getUserData(req.user.uid);
    if (!userData) return res.status(404).json({ error: 'مستخدم غير موجود' });
    
    const settings = await getCachedSettings();
    const lastSpin = userData.data.lastSpinTime?.toDate?.() || userData.data.lastSpinTime;
    const now = new Date();
    let canSpin = true;
    let remainingSeconds = 0;
    
    if (lastSpin) {
      const elapsed = (now - lastSpin) / 1000;
      if (elapsed < 300) {
        canSpin = false;
        remainingSeconds = 300 - elapsed;
      }
    }
    
    res.json({
      success: true,
      canSpin,
      remainingSeconds: Math.ceil(remainingSeconds),
      spinCost: settings.wheelSpinCost,
      referralBalance: userData.data.referralBalance || 0,
      hasEnoughBalance: (userData.data.referralBalance || 0) >= settings.wheelSpinCost
    });
  } catch (error) {
    logger.error('Wheel status error', { error: error.message, uid: req.user.uid });
    res.status(500).json({ error: 'حدث خطأ داخلي', code: 'SERVER_ERROR' });
  }
});

// تدوير عجلة الحظ (باستخدام Transaction لضمان الدقة)
app.post('/api/user/spin-wheel', requireAuth, validate([
  body().custom(() => true) // لا توجد حقول محددة
]), async (req, res) => {
  const { uid } = req.user;
  const correlationId = req.correlationId;
  
  try {
    const settings = await getCachedSettings();
    const spinCost = settings.wheelSpinCost;
    const userRef = db.collection('users').doc(uid);
    
    // استخدام Transaction لضمان سلامة البيانات
    const result = await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) throw new Error('USER_NOT_FOUND');
      
      const userData = userDoc.data();
      
      // التحقق من وقت آخر تدوير
      const lastSpin = userData.lastSpinTime?.toDate?.() || userData.lastSpinTime;
      const now = new Date();
      if (lastSpin) {
        const elapsed = (now - lastSpin) / 1000;
        if (elapsed < 300) {
          throw new Error(`WAIT_${Math.ceil(300 - elapsed)}`);
        }
      }
      
      // التحقق من الرصيد
      const referralBalance = userData.referralBalance || 0;
      if (referralBalance < spinCost) {
        throw new Error('INSUFFICIENT_BALANCE');
      }
      
      // اختيار الجائزة
      const sector = getRandomSector();
      let prizeAmount = 0;
      let prizeMessage = '';
      let updateData = {
        lastSpinTime: now,
        totalSpins: admin.firestore.FieldValue.increment(1),
        referralBalance: admin.firestore.FieldValue.increment(-spinCost)
      };
      
      if (sector.type === 'balance') {
        prizeAmount = sector.value;
        prizeMessage = `🎉 فزت بـ ${prizeAmount} SYP!`;
        updateData.balance = admin.firestore.FieldValue.increment(prizeAmount);
        updateData.totalWinnings = admin.firestore.FieldValue.increment(prizeAmount);
      } else {
        prizeMessage = `😅 حظ أوفر!`;
      }
      
      transaction.update(userRef, updateData);
      
      // تسجيل التدويرة
      const spinRecord = {
        userId: uid,
        sector: sector.id,
        sectorName: sector.name,
        prizeAmount,
        prizeType: sector.type,
        spinCost,
        timestamp: now,
        correlationId
      };
      transaction.set(db.collection('wheel_spins').doc(), spinRecord);
      
      return { sector, prizeAmount, prizeMessage, spinCost };
    });
    
    // جلب البيانات المحدثة للرد
    const updatedUser = await userRef.get();
    res.json({
      success: true,
      sector: result.sector.id,
      sectorName: result.sector.name,
      prizeAmount: result.prizeAmount,
      prizeType: result.sector.type,
      message: result.prizeMessage,
      newBalance: updatedUser.data().balance || 0,
      newReferralBalance: updatedUser.data().referralBalance || 0,
      spinCost: result.spinCost
    });
    
  } catch (error) {
    logger.error('Spin wheel error', { error: error.message, uid, correlationId });
    
    if (error.message === 'INSUFFICIENT_BALANCE') {
      const settings = await getCachedSettings();
      return res.status(400).json({ error: `رصيد الإحالات غير كافٍ. تحتاج ${settings.wheelSpinCost} SYP` });
    }
    if (error.message === 'USER_NOT_FOUND') return res.status(404).json({ error: 'مستخدم غير موجود' });
    if (error.message.startsWith('WAIT_')) {
      const seconds = parseInt(error.message.split('_')[1]);
      const minutes = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return res.status(400).json({ error: `يجب الانتظار ${minutes} دقيقة و ${secs} ثانية قبل التدوير مرة أخرى` });
    }
    
    res.status(500).json({ error: 'حدث خطأ أثناء التدوير', code: 'SERVER_ERROR' });
  }
});

// التسجيل
app.post('/api/user/register', requireAuth, validate([
  body('referrerId').optional().isString().isLength({ min: 6, max: 10 })
]), async (req, res) => {
  const { uid, email, name } = req.user;
  const { referrerId } = req.body;
  
  try {
    const userRef = db.collection('users').doc(uid);
    const existingUser = await userRef.get();
    
    if (existingUser.exists) {
      return res.json({ success: true, user: existingUser.data(), isAdmin: ADMIN_EMAILS.includes(email) });
    }
    
    // إنشاء كود إحالة فريد
    let uniqueId;
    let isUnique = false;
    for (let i = 0; i < 10 && !isUnique; i++) {
      uniqueId = Math.random().toString(36).substring(2, 10).toUpperCase();
      const existing = await db.collection('users').where('uniqueId', '==', uniqueId).limit(1).get();
      if (existing.empty) isUnique = true;
    }
    if (!isUnique) uniqueId = `UID${Date.now().toString().slice(-8)}`;
    
    let referredBy = null;
    let referrerName = null;
    
    if (referrerId) {
      const referrerQuery = await db.collection('users').where('uniqueId', '==', referrerId).limit(1).get();
      if (!referrerQuery.empty) {
        referredBy = referrerQuery.docs[0].id;
        referrerName = referrerQuery.docs[0].data().name;
        // مكافأة التسجيل 5 SYP لرصيد الإحالات
        await referrerQuery.docs[0].ref.update({
          referralBalance: admin.firestore.FieldValue.increment(5),
          referralEarnings: admin.firestore.FieldValue.increment(5),
          referrals: admin.firestore.FieldValue.arrayUnion(uid)
        });
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
    logger.info('New user registered', { uid, email, referredBy });
    
    res.json({ success: true, user: newUser, isAdmin: ADMIN_EMAILS.includes(email) });
  } catch (error) {
    logger.error('Registration error', { error: error.message, uid, email });
    res.status(500).json({ error: 'فشل التسجيل', code: 'REGISTRATION_FAILED' });
  }
});

// الإيداع المحسن
app.post('/api/user/deposit', requireAuth, validate([
  body('method').isIn(['sham_cash', 'sham_cash_usd', 'syriatel_cash']),
  body('amount').isFloat({ min: 1 }),
  body('transactionId').isString().notEmpty()
]), async (req, res) => {
  const { uid } = req.user;
  const { method, amount, transactionId } = req.body;
  const amountNum = Number(amount);
  
  try {
    const settings = await getCachedSettings();
    let verification = null;
    let finalAmountSYP = amountNum;
    let originalCurrency = 'SYP';
    let originalAmount = amountNum;
    
    // التحقق من العملية حسب الطريقة
    switch (method) {
      case 'sham_cash':
        if (!settings.shamCashEnabled) throw new Error('METHOD_DISABLED');
        const shamClient = new PaymentClient(settings.shamCashApiKey, settings.shamCashPrivateAddress);
        verification = await shamClient.verifyTransaction(transactionId, amountNum, 'SYP');
        if (verification.success) {
          originalAmount = verification.amount;
          finalAmountSYP = originalAmount;
        }
        break;
        
      case 'sham_cash_usd':
        if (!settings.shamCashUsdEnabled) throw new Error('METHOD_DISABLED');
        const shamUsdClient = new PaymentClient(settings.shamCashUsdApiKey, settings.shamCashUsdPrivateAddress);
        verification = await shamUsdClient.verifyTransaction(transactionId, amountNum, 'USD');
        if (verification.success) {
          originalAmount = verification.amount;
          originalCurrency = 'USD';
          finalAmountSYP = originalAmount * (settings.usdToSypRate || 13000);
        }
        break;
        
      case 'syriatel_cash':
        if (!settings.syriatelEnabled) throw new Error('METHOD_DISABLED');
        const syriatelClient = new PaymentClient(settings.syriatelApiKey, settings.syriatelPrivateAddress);
        verification = await syriatelClient.verifyTransaction(transactionId, amountNum, 'SYP');
        if (verification.success) {
          originalAmount = verification.amount;
          finalAmountSYP = originalAmount;
        }
        break;
    }
    
    if (!verification?.success) {
      return res.status(400).json({ error: verification?.message || 'فشل التحقق من العملية' });
    }
    
    // التحقق من الحد الأدنى
    if (finalAmountSYP < settings.minDeposit) {
      return res.status(400).json({ error: `الحد الأدنى للإيداع ${settings.minDeposit} SYP` });
    }
    
    // التحقق من عدم تكرار رقم العملية
    const existingDeposit = await db.collection('deposits').where('transactionId', '==', transactionId).limit(1).get();
    if (!existingDeposit.empty) {
      return res.status(400).json({ error: 'تم استخدام رقم العملية مسبقاً' });
    }
    
    // تنفيذ الإيداع باستخدام Transaction
    const userRef = db.collection('users').doc(uid);
    await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) throw new Error('USER_NOT_FOUND');
      
      transaction.update(userRef, {
        balance: admin.firestore.FieldValue.increment(finalAmountSYP),
        totalDeposited: admin.firestore.FieldValue.increment(finalAmountSYP)
      });
      
      const depositRecord = {
        userId: uid,
        method,
        amount: finalAmountSYP,
        originalAmount,
        originalCurrency,
        transactionId,
        status: 'completed',
        verifiedAt: new Date(),
        exchangeRate: method === 'sham_cash_usd' ? settings.usdToSypRate : null,
        correlationId: req.correlationId
      };
      transaction.set(db.collection('deposits').doc(), depositRecord);
    });
    
    // معالجة عمولة الإحالة (خارج الـ Transaction لتقليل وقت القفل)
    const userDoc = await userRef.get();
    const referredBy = userDoc.data()?.referredBy;
    if (referredBy) {
      const commissionPercent = settings.referralCommission || 5;
      const commissionAmount = (finalAmountSYP * commissionPercent) / 100;
      if (commissionAmount > 0) {
        await db.collection('users').doc(referredBy).update({
          referralBalance: admin.firestore.FieldValue.increment(commissionAmount),
          referralEarnings: admin.firestore.FieldValue.increment(commissionAmount)
        });
        await db.collection('referral_commissions').add({
          userId: referredBy,
          fromUserId: uid,
          amount: commissionAmount,
          depositAmount: finalAmountSYP,
          percent: commissionPercent,
          createdAt: new Date()
        });
      }
    }
    
    const updatedUser = await userRef.get();
    res.json({ success: true, message: `تم إيداع ${finalAmountSYP.toLocaleString()} SYP`, newBalance: updatedUser.data().balance });
    
  } catch (error) {
    logger.error('Deposit error', { error: error.message, uid, method, transactionId, correlationId: req.correlationId });
    
    if (error.message === 'METHOD_DISABLED') {
      return res.status(400).json({ error: 'طريقة الدفع هذه غير مفعلة حالياً' });
    }
    if (error.message === 'USER_NOT_FOUND') {
      return res.status(404).json({ error: 'مستخدم غير موجود' });
    }
    res.status(500).json({ error: 'فشل الإيداع، حاول مرة أخرى', code: 'DEPOSIT_FAILED' });
  }
});

// السحب
app.post('/api/user/withdraw', requireAuth, validate([
  body('amount').isFloat({ min: 1 }),
  body('address').isString().notEmpty(),
  body('method').optional().isString()
]), async (req, res) => {
  const { uid } = req.user;
  const { amount, address, method = 'sham_cash' } = req.body;
  const amountNum = Number(amount);
  
  try {
    const settings = await getCachedSettings();
    
    if (amountNum < settings.minWithdraw) {
      return res.status(400).json({ error: `الحد الأدنى للسحب ${settings.minWithdraw} SYP` });
    }
    
    const userRef = db.collection('users').doc(uid);
    
    await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) throw new Error('USER_NOT_FOUND');
      
      const userData = userDoc.data();
      if (userData.isBanned) throw new Error('USER_BANNED');
      if ((userData.balance || 0) < amountNum) throw new Error('INSUFFICIENT_BALANCE');
      
      transaction.update(userRef, {
        balance: admin.firestore.FieldValue.increment(-amountNum),
        totalWithdrawn: admin.firestore.FieldValue.increment(amountNum)
      });
      
      const withdrawRecord = {
        userId: uid,
        userEmail: userData.email,
        userName: userData.name,
        amount: amountNum,
        address,
        method,
        status: 'pending',
        createdAt: new Date(),
        correlationId: req.correlationId
      };
      transaction.set(db.collection('withdraw_requests').doc(), withdrawRecord);
    });
    
    logger.info('Withdraw request created', { uid, amount: amountNum, address });
    res.json({ success: true, message: `تم إنشاء طلب سحب بمبلغ ${amountNum.toLocaleString()} SYP` });
    
  } catch (error) {
    logger.error('Withdraw error', { error: error.message, uid, amount, correlationId: req.correlationId });
    
    if (error.message === 'INSUFFICIENT_BALANCE') return res.status(400).json({ error: 'الرصيد غير كافٍ' });
    if (error.message === 'USER_BANNED') return res.status(403).json({ error: 'حسابك محظور' });
    if (error.message === 'USER_NOT_FOUND') return res.status(404).json({ error: 'مستخدم غير موجود' });
    
    res.status(500).json({ error: 'فشل إنشاء طلب السحب، حاول مرة أخرى', code: 'WITHDRAW_FAILED' });
  }
});

// إعدادات الموقع (عام)
app.get('/api/site-settings', async (req, res) => {
  try {
    const settings = await getCachedSettings();
    res.json({
      success: true,
      siteName: settings.siteName,
      siteTheme: settings.siteTheme,
      gameImageUrl: settings.gameImageUrl,
      minDeposit: settings.minDeposit,
      minWithdraw: settings.minWithdraw,
      referralCommission: settings.referralCommission,
      wheelSpinCost: settings.wheelSpinCost,
      maintenanceMode: settings.maintenanceMode
    });
  } catch (error) {
    logger.error('Site settings error', { error: error.message });
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

// ============= Admin Routes =============
app.get('/api/admin/dashboard', requireAuth, requireAdmin, async (req, res) => {
  try {
    const cachedStats = cache.get('admin_stats');
    if (cachedStats) return res.json({ success: true, stats: cachedStats });
    
    const [usersSnapshot, pendingWithdrawals, wheelSpinsSnapshot] = await Promise.all([
      db.collection('users').get(),
      db.collection('withdraw_requests').where('status', '==', 'pending').count().get(),
      db.collection('wheel_spins').get()
    ]);
    
    let totalBalance = 0, totalDeposited = 0, totalWithdrawn = 0, totalReferralEarnings = 0;
    let newToday = 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    usersSnapshot.forEach(doc => {
      const data = doc.data();
      totalBalance += data.balance || 0;
      totalDeposited += data.totalDeposited || 0;
      totalWithdrawn += data.totalWithdrawn || 0;
      totalReferralEarnings += data.referralEarnings || 0;
      
      const createdAt = data.createdAt?.toDate?.() || data.createdAt;
      if (createdAt && new Date(createdAt) > today) newToday++;
    });
    
    let totalWinnings = 0;
    wheelSpinsSnapshot.forEach(doc => {
      totalWinnings += doc.data().prizeAmount || 0;
    });
    
    const stats = {
      totalUsers: usersSnapshot.size,
      newToday,
      totalBalance,
      totalDeposited,
      totalWithdrawn,
      totalReferralEarnings,
      pendingWithdrawals: pendingWithdrawals.data().count || 0,
      totalSpins: wheelSpinsSnapshot.size,
      totalWinnings
    };
    
    cache.set('admin_stats', stats, 60); // تخزين لمدة دقيقة
    res.json({ success: true, stats });
  } catch (error) {
    logger.error('Admin dashboard error', { error: error.message });
    res.status(500).json({ error: 'خطأ في جلب الإحصائيات' });
  }
});

// باقي Routes الأدمن (مختصرة للمساحة ولكن بنفس الجودة)
app.get('/api/admin/settings', requireAuth, requireAdmin, async (req, res) => {
  const settings = await getCachedSettings();
  res.json({ success: true, settings });
});

app.post('/api/admin/settings', requireAuth, requireAdmin, async (req, res) => {
  try {
    await db.collection('settings').doc('config').update(req.body);
    cache.del('system_settings'); // مسح الكاش
    res.json({ success: true, message: 'تم تحديث الإعدادات' });
  } catch (error) {
    logger.error('Save settings error', { error: error.message });
    res.status(500).json({ error: 'فشل تحديث الإعدادات' });
  }
});

// ============= إدارة الأخطاء العامة =============
app.use((req, res) => {
  res.status(404).json({ error: 'المسار غير موجود', code: 'NOT_FOUND' });
});

app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack, correlationId: req.correlationId });
  res.status(500).json({ error: 'حدث خطأ داخلي في الخادم', code: 'INTERNAL_SERVER_ERROR' });
});

// ============= تشغيل الخادم باستخدام Cluster لاستغلال جميع الأنوية =============
if (cluster.isPrimary && process.env.NODE_ENV === 'production') {
  const numCPUs = os.cpus().length;
  logger.info(`Master ${process.pid} setting up ${numCPUs} workers`);
  
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }
  
  cluster.on('exit', (worker, code, signal) => {
    logger.warn(`Worker ${worker.process.pid} died. Starting new worker...`);
    cluster.fork();
  });
} else {
  const server = app.listen(PORT, () => {
    logger.info(`🚀 BOOMB Server running on port ${PORT} | Worker ${process.pid} | Mode: ${process.env.NODE_ENV || 'development'}`);
  });
  
  // graceful shutdown
  process.on('SIGTERM', () => {
    logger.info('SIGTERM received, closing server...');
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
  });
}

export default app;
