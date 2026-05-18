import express from 'express';
import admin from 'firebase-admin';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import axios from 'axios';
import helmet from 'helmet';
import compression from 'compression';
import NodeCache from 'node-cache';
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
const app = express();

// ============= إعدادات الأمان المتقدمة =============
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false
}));

app.use(compression({ level: 6, threshold: 1024 }));

app.use(cors({
  origin: ['https://sam55na.github.io', 'http://localhost:3000', 'http://localhost:5500', 'https://*.onrender.com'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Idempotency-Key'],
  maxAge: 86400
}));

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// ============= ذاكرة التخزين المؤقت =============
const settingsCache = new NodeCache({ stdTTL: 60, checkperiod: 120 });
const userCache = new NodeCache({ stdTTL: 30, checkperiod: 60, maxKeys: 1000 });

// ============= منع التكرار المتقدم =============
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: { error: 'الرجاء الانتظار دقيقة' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip
});

const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  message: { error: 'طلبات كثيرة جداً، الرجاء الانتظار 30 ثانية' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true
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
const SPIN_COOLDOWN_SECONDS = 300; // 5 دقائق

// ============= قفل موزع باستخدام Firestore =============
class DistributedLock {
  constructor(resourceId, ttlSeconds = 15) {
    this.resourceId = `lock_${resourceId}`;
    this.ttl = ttlSeconds;
    this.lockId = crypto.randomUUID();
  }

  async acquire() {
    const lockRef = db.collection('locks').doc(this.resourceId);
    const now = Date.now();
    const expireAt = now + this.ttl * 1000;
    
    try {
      await db.runTransaction(async (t) => {
        const doc = await t.get(lockRef);
        if (doc.exists && doc.data().expiresAt > now) {
          throw new Error('LOCK_ACQUIRED_BY_OTHER');
        }
        t.set(lockRef, { expiresAt: expireAt, lockId: this.lockId, createdAt: new Date() });
      });
      return true;
    } catch (error) {
      if (error.message === 'LOCK_ACQUIRED_BY_OTHER') return false;
      throw error;
    }
  }

  async release() {
    const lockRef = db.collection('locks').doc(this.resourceId);
    const doc = await lockRef.get();
    if (doc.exists && doc.data().lockId === this.lockId) {
      await lockRef.delete();
    }
  }
}

// ============= دالة إنشاء كود فريد محسنة =============
async function generateUniqueReferralCode() {
  for (let attempts = 0; attempts < 15; attempts++) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    
    const existing = await db.collection('users').where('uniqueId', '==', result).limit(1).get();
    if (existing.empty) return result;
  }
  return 'UID' + Date.now().toString().slice(-8) + Math.random().toString(36).substring(2, 6);
}

// ============= المصادقة =============
const requireAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'غير مصرح' });
  
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
  if (!token) return res.status(401).json({ error: 'غير مصرح' });
  
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

// ============= إعدادات النظام مع التخزين المؤقت =============
async function getSettings(forceRefresh = false) {
  if (!forceRefresh) {
    const cached = settingsCache.get('settings');
    if (cached) return cached;
  }
  
  try {
    const doc = await db.collection('settings').doc('config').get();
    let settings;
    
    if (doc.exists) {
      settings = doc.data();
    } else {
      settings = {
        minDeposit: 1000, minWithdraw: 5000, shamCashEnabled: true, syriatelEnabled: true,
        shamCashUsdEnabled: false, usdToSypRate: 13000, referralCommission: 5, wheelSpinCost: 50,
        shamCashApiKey: '', shamCashPrivateAddress: '', shamCashPublicAddress: '0930000000',
        shamCashUsdApiKey: '', shamCashUsdPrivateAddress: '', shamCashUsdPublicAddress: '',
        syriatelApiKey: '', syriatelPrivateAddress: '', syriatelPublicAddress: '0930000000',
        gameImageUrl: '', siteTheme: 'red', siteName: 'BOOMB', maintenanceMode: false
      };
      await db.collection('settings').doc('config').set(settings);
    }
    
    settingsCache.set('settings', settings);
    return settings;
  } catch (error) {
    console.error('Error getting settings:', error);
    throw error;
  }
}

// ============= كلاس شام كاش (محسن) =============
class ShamCashClient {
  constructor(apiKey, accountAddress) {
    this.apiKey = apiKey;
    this.accountAddress = accountAddress;
    this.baseUrl = "https://apisyria.com/api/v1";
  }

  async verifyTransaction(txid, expectedAmount = null, expectedCurrency = null) {
    if (!this.apiKey || !this.accountAddress) {
      return { success: false, message: "شام كاش غير مفعل" };
    }
    
    try {
      const params = {
        resource: "shamcash",
        action: "logs",
        account_address: this.accountAddress,
        api_key: this.apiKey
      };
      
      const response = await axios.get(this.baseUrl, { params, timeout: 15000 });
      
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
    if (!this.apiKey || !this.accountAddress) {
      return { success: false, message: "شام كاش دولار غير مفعل" };
    }
    
    try {
      const params = {
        resource: "shamcash",
        action: "logs",
        account_address: this.accountAddress,
        api_key: this.apiKey
      };
      const response = await axios.get(this.baseUrl, { params, timeout: 15000 });
      
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
    if (!this.apiKey || !this.gsmNumbers.length) {
      return { success: false, message: "سيرياتيل كاش غير مفعل" };
    }
    
    for (const gsm of this.gsmNumbers) {
      try {
        const params = {
          api_key: this.apiKey,
          resource: "syriatel",
          action: "find_tx",
          tx: txid,
          gsm: gsm
        };
        const response = await axios.get(this.baseUrl, { params, timeout: 15000 });
        
        if (response.status === 200 && response.data.success && response.data.data?.found) {
          const transaction = response.data.data.transaction || {};
          const apiAmount = parseFloat(transaction.amount || 0);
          if (expectedAmount && Math.abs(apiAmount - expectedAmount) > 0.01) {
            return { success: false, message: "المبلغ غير متطابق" };
          }
          return { success: true, amount: apiAmount, currency: "SYP" };
        }
      } catch (error) {
        console.error(`Syriatel error for GSM ${gsm}:`, error.message);
      }
    }
    return { success: false, message: "رقم العملية غير موجود" };
  }
}

// ============= عجلة الحظ =============
const WHEEL_SECTORS = [
  { id: 1, name: 'حظ أوفر', type: 'luck', value: 0, probability: 1 },
  { id: 2, name: '10 رصيد أساسي', type: 'balance', value: 10, probability: 50 },
  { id: 3, name: '20 رصيد أساسي', type: 'balance', value: 20, probability: 40 },
  { id: 4, name: '30 رصيد أساسي', type: 'balance', value: 30, probability: 5 },
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

// ============= API عجلة الحظ (مع Transaction وقفل) =============
app.get('/api/user/wheel-status', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    
    // محاولة جلب من الكاش أولاً
    let userData = userCache.get(`user_${uid}`);
    if (!userData) {
      const userDoc = await db.collection('users').doc(uid).get();
      if (!userDoc.exists) {
        return res.status(404).json({ error: 'مستخدم غير موجود' });
      }
      userData = userDoc.data();
      userCache.set(`user_${uid}`, userData);
    }
    
    const settings = await getSettings();
    
    const lastSpin = userData.lastSpinTime?.toDate ? userData.lastSpinTime.toDate() : userData.lastSpinTime;
    const now = new Date();
    let canSpin = true;
    let remainingSeconds = 0;
    
    if (lastSpin) {
      const timeDiff = (now - lastSpin) / 1000;
      if (timeDiff < SPIN_COOLDOWN_SECONDS) {
        canSpin = false;
        remainingSeconds = Math.ceil(SPIN_COOLDOWN_SECONDS - timeDiff);
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
  const { uid } = req.user;
  const lock = new DistributedLock(`spin:${uid}`, 20);
  
  if (!await lock.acquire()) {
    return res.status(429).json({ error: 'لديك طلب تدوير قيد التنفيذ، انتظر قليلاً' });
  }
  
  try {
    const settings = await getSettings();
    const spinCost = settings.wheelSpinCost || 50;
    
    const result = await db.runTransaction(async (t) => {
      const userRef = db.collection('users').doc(uid);
      const userDoc = await t.get(userRef);
      
      if (!userDoc.exists) {
        throw new Error('مستخدم غير موجود');
      }
      
      const userData = userDoc.data();
      
      // التحقق من آخر تدوير
      const lastSpin = userData.lastSpinTime?.toDate ? userData.lastSpinTime.toDate() : userData.lastSpinTime;
      const now = new Date();
      
      if (lastSpin) {
        const timeDiff = (now - lastSpin) / 1000;
        if (timeDiff < SPIN_COOLDOWN_SECONDS) {
          const remainingSeconds = Math.ceil(SPIN_COOLDOWN_SECONDS - timeDiff);
          throw new Error(`يجب الانتظار ${Math.floor(remainingSeconds / 60)} دقيقة و ${remainingSeconds % 60} ثانية`);
        }
      }
      
      // التحقق من الرصيد
      if ((userData.referralBalance || 0) < spinCost) {
        throw new Error(`رصيد الإحالات غير كافٍ. تحتاج ${spinCost} SYP للتدوير`);
      }
      
      // اختيار الجائزة
      const selectedSector = getRandomSector();
      let prizeAmount = 0;
      let prizeMessage = '';
      
      // تحديث البيانات
      const updates = {
        referralBalance: admin.firestore.FieldValue.increment(-spinCost),
        lastSpinTime: new Date(),
        totalSpins: admin.firestore.FieldValue.increment(1)
      };
      
      if (selectedSector.type === 'balance') {
        prizeAmount = selectedSector.value;
        prizeMessage = `🎉 فزت بـ ${prizeAmount} SYP! تم إضافتها إلى رصيدك الأساسي`;
        updates.balance = admin.firestore.FieldValue.increment(prizeAmount);
        updates.totalWinnings = admin.firestore.FieldValue.increment(prizeAmount);
      } else {
        prizeMessage = `😅 حظ أوفر! خسرت ${spinCost} SYP من رصيد الإحالات.`;
      }
      
      t.update(userRef, updates);
      
      // تسجيل التدويرة
      const spinRef = db.collection('wheel_spins').doc();
      t.set(spinRef, {
        userId: uid,
        sector: selectedSector.id,
        sectorName: selectedSector.name,
        prizeAmount: prizeAmount,
        prizeType: selectedSector.type,
        spinCost: spinCost,
        timestamp: new Date(),
        userEmail: userData.email,
        userName: userData.name
      });
      
      // إبطال الكاش
      userCache.del(`user_${uid}`);
      
      return {
        success: true,
        sector: selectedSector.id,
        sectorName: selectedSector.name,
        prizeAmount: prizeAmount,
        prizeType: selectedSector.type,
        message: prizeMessage,
        spinCost: spinCost
      };
    });
    
    res.json(result);
  } catch (error) {
    console.error('Spin wheel error:', error);
    res.status(400).json({ error: error.message || 'حدث خطأ أثناء التدوير' });
  } finally {
    await lock.release();
  }
});

// ============= عمولة الإحالة (غير متزامنة) =============
async function addReferralCommission(userId, depositAmount) {
  // تشغيل بشكل غير متزامن بدون await
  setImmediate(async () => {
    try {
      const userDoc = await db.collection('users').doc(userId).get();
      const userData = userDoc.data();
      
      if (userData && userData.referredBy) {
        const settings = await getSettings();
        const commissionPercent = settings.referralCommission || 5;
        const commissionAmount = (depositAmount * commissionPercent) / 100;
        
        if (commissionAmount > 0) {
          const referrerRef = db.collection('users').doc(userData.referredBy);
          
          await referrerRef.update({
            referralBalance: admin.firestore.FieldValue.increment(commissionAmount),
            referralEarnings: admin.firestore.FieldValue.increment(commissionAmount)
          });
          
          await db.collection('referral_commissions').add({
            userId: userData.referredBy,
            fromUserId: userId,
            amount: commissionAmount,
            depositAmount: depositAmount,
            percent: commissionPercent,
            createdAt: new Date()
          });
          
          // إبطال الكاش للمُحيل
          userCache.del(`user_${userData.referredBy}`);
          
          console.log(`✅ تم إضافة ${commissionAmount} SYP إلى رصيد إحالات المستخدم ${userData.referredBy}`);
        }
      }
    } catch (error) {
      console.error('Commission error:', error);
    }
  });
}

// ============= API الإيداع (مع Transaction) =============
app.post('/api/user/deposit', requireAuth, async (req, res) => {
  const { uid } = req.user;
  const { method, amount, transactionId } = req.body;
  
  if (!method || !amount || !transactionId) {
    return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
  }
  
  const amountNum = Number(amount);
  if (isNaN(amountNum) || amountNum <= 0) {
    return res.status(400).json({ error: 'المبلغ غير صالح' });
  }
  
  // قفل باستخدام transactionId لمنع التكرار
  const lock = new DistributedLock(`deposit:${transactionId}`, 60);
  if (!await lock.acquire()) {
    return res.status(409).json({ error: 'تم معالجة رقم العملية هذا مسبقاً' });
  }
  
  try {
    const settings = await getSettings();
    let verification = null;
    let finalAmountSYP = amountNum;
    let originalCurrency = 'SYP';
    let originalAmount = amountNum;
    
    // التحقق من العملية حسب الطريقة
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
      return res.status(400).json({ error: `الحد الأدنى ${settings.minDeposit.toLocaleString()} SYP` });
    }
    
    // تنفيذ الإيداع باستخدام Transaction
    await db.runTransaction(async (t) => {
      // التحقق من عدم تكرار رقم العملية
      const existingQuery = await t.get(db.collection('deposits').where('transactionId', '==', transactionId).limit(1));
      if (!existingQuery.empty) {
        throw new Error('تم استخدام رقم العملية مسبقاً');
      }
      
      const userRef = db.collection('users').doc(uid);
      const userDoc = await t.get(userRef);
      
      if (!userDoc.exists) {
        throw new Error('مستخدم غير موجود');
      }
      
      t.update(userRef, {
        balance: admin.firestore.FieldValue.increment(finalAmountSYP),
        totalDeposited: admin.firestore.FieldValue.increment(finalAmountSYP)
      });
      
      const depositRef = db.collection('deposits').doc();
      t.set(depositRef, {
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
    });
    
    // إبطال الكاش
    userCache.del(`user_${uid}`);
    
    // إضافة العمولة في الخلفية
    await addReferralCommission(uid, finalAmountSYP);
    
    res.json({ success: true, message: `تم إيداع ${finalAmountSYP.toLocaleString()} SYP` });
  } catch (error) {
    console.error('Deposit error:', error);
    res.status(400).json({ error: error.message || 'حدث خطأ داخلي' });
  } finally {
    await lock.release();
  }
});

// ============= API السحب (مع Transaction) =============
app.post('/api/user/withdraw', requireAuth, async (req, res) => {
  const { uid } = req.user;
  const { amount, address, method } = req.body;
  
  if (!amount || !address) {
    return res.status(400).json({ error: 'المبلغ والعنوان مطلوبان' });
  }
  
  const amountNum = Number(amount);
  if (isNaN(amountNum) || amountNum <= 0) {
    return res.status(400).json({ error: 'المبلغ غير صالح' });
  }
  
  const lock = new DistributedLock(`withdraw:${uid}`, 30);
  if (!await lock.acquire()) {
    return res.status(429).json({ error: 'لديك طلب سحب قيد التنفيذ، انتظر قليلاً' });
  }
  
  try {
    const settings = await getSettings();
    
    if (amountNum < settings.minWithdraw) {
      return res.status(400).json({ error: `الحد الأدنى ${settings.minWithdraw.toLocaleString()} SYP` });
    }
    
    await db.runTransaction(async (t) => {
      const userRef = db.collection('users').doc(uid);
      const userDoc = await t.get(userRef);
      
      if (!userDoc.exists) {
        throw new Error('مستخدم غير موجود');
      }
      
      const userData = userDoc.data();
      
      if (userData.isBanned) {
        throw new Error('حسابك محظور');
      }
      
      if ((userData.balance || 0) < amountNum) {
        throw new Error(`الرصيد غير كافٍ. رصيدك: ${(userData.balance || 0).toLocaleString()} SYP`);
      }
      
      t.update(userRef, {
        balance: admin.firestore.FieldValue.increment(-amountNum),
        totalWithdrawn: admin.firestore.FieldValue.increment(amountNum)
      });
      
      const requestRef = db.collection('withdraw_requests').doc();
      t.set(requestRef, {
        userId: uid,
        userEmail: userData.email,
        userName: userData.name,
        amount: amountNum,
        address: address,
        method: method || 'sham_cash',
        status: 'pending',
        createdAt: new Date()
      });
    });
    
    // إبطال الكاش
    userCache.del(`user_${uid}`);
    
    res.json({ success: true, message: `تم إنشاء طلب سحب بمبلغ ${amountNum.toLocaleString()} SYP` });
  } catch (error) {
    console.error('Withdraw error:', error);
    res.status(400).json({ error: error.message || 'فشل إنشاء طلب السحب' });
  } finally {
    await lock.release();
  }
});

// ============= باقي APIs (محسنة مع الكاش) =============
app.get('/api/user/profile', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    
    let userData = userCache.get(`user_${uid}`);
    if (!userData) {
      const userDoc = await db.collection('users').doc(uid).get();
      if (!userDoc.exists) {
        return res.status(404).json({ error: 'مستخدم غير موجود' });
      }
      userData = userDoc.data();
      userCache.set(`user_${uid}`, userData);
    }
    
    res.json({ success: true, user: userData, isAdmin: req.user.email === ADMIN_EMAIL });
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ error: 'خطأ في جلب البيانات' });
  }
});

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

// ============= باقي APIs (مختصرة للاختصار - نفس الأصل مع تحسينات) =============
app.get('/api/user/stats', requireAuth, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
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
    
    const settings = await getSettings();
    
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

// ============= التسجيل =============
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
    
    let referredBy = null;
    let referrerName = null;
    
    if (referrerId) {
      const refQuery = await db.collection('users').where('uniqueId', '==', referrerId).limit(1).get();
      if (!refQuery.empty) {
        referredBy = refQuery.docs[0].id;
        referrerName = refQuery.docs[0].data().name;
        await refQuery.docs[0].ref.update({
          referralBalance: admin.firestore.FieldValue.increment(5),
          referralEarnings: admin.firestore.FieldValue.increment(5),
          referrals: admin.firestore.FieldValue.arrayUnion(uid)
        });
        userCache.del(`user_${referredBy}`);
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
    
    await userRef.set(newUser);
    res.json({ success: true, user: newUser, isAdmin: email === ADMIN_EMAIL });
    
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'خطأ في التسجيل' });
  }
});

// ============= إضافة كود إحالة =============
app.post('/api/user/add-referrer', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { referrerCode } = req.body;
    
    if (!referrerCode) {
      return res.status(400).json({ error: 'كود الإحالة مطلوب' });
    }
    
    const lock = new DistributedLock(`referrer:${uid}`, 30);
    if (!await lock.acquire()) {
      return res.status(429).json({ error: 'لديك طلب قيد التنفيذ، انتظر' });
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
    
    await userRef.update({
      referredBy: referrerId,
      referredByName: referrerDoc.data().name
    });
    
    await referrerDoc.ref.update({
      referralBalance: admin.firestore.FieldValue.increment(5),
      referralEarnings: admin.firestore.FieldValue.increment(5),
      referrals: admin.firestore.FieldValue.arrayUnion(uid)
    });
    
    // إبطال الكاش
    userCache.del(`user_${uid}`);
    userCache.del(`user_${referrerId}`);
    
    res.json({ success: true, message: `تم إضافة المحيل: ${referrerDoc.data().name}` });
    
  } catch (error) {
    console.error('Add referrer error:', error);
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

// ============= تشغيل الخادم =============
const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  console.log(`✅ BOOMB Server running on port ${PORT}`);
  console.log(`📍 Admin: ${ADMIN_EMAIL}`);
  console.log(`🎰 Wheel system ready with 8 sectors`);
  console.log(`⚡ Cache enabled | Transaction support | Distributed locking active`);
});

// Graceful Shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
