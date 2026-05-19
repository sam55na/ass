import express from 'express';
import admin from 'firebase-admin';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import NodeCache from 'node-cache';
import crypto from 'crypto';

// ============== التهيئة ==============
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
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const pendingRequests = new Map();
const SPIN_COOLDOWN_SECONDS = 86400;
const ADMIN_EMAIL = "admin@boomb.com";

// ============== Middleware ==============
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false
}));

app.use(compression({ level: 6, threshold: 1024 }));

app.use(cors({
  origin: ["https://sam55na.github.io", "http://localhost:3000", "http://localhost:5500", "https://*.onrender.com"],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Idempotency-Key'],
  maxAge: 86400
}));

app.use(express.json({ limit: '10mb' }));
app.use(morgan('combined'));

// تحديد المعدل العام
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: '太多请求، يرجى المحاولة لاحقاً' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/', globalLimiter);

// تحديد معدل أقوى للحساسات
const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'لقد تجاوزت الحد المسموح، يرجى الانتظار' }
});

// ============== Distributed Lock ==============
class DistributedLock {
  constructor(resource, ttl = 30) {
    this.resource = resource;
    this.ttl = ttl;
    this.lockId = crypto.randomBytes(16).toString('hex');
  }

  async acquire() {
    const lockRef = db.collection('locks').doc(this.resource);
    const now = Date.now();
    const expireAt = now + this.ttl * 1000;
    
    try {
      await db.runTransaction(async (t) => {
        const doc = await t.get(lockRef);
        if (doc.exists && doc.data()?.expiresAt > now) {
          throw new Error('LOCK_ACQUIRED_BY_OTHER');
        }
        t.set(lockRef, { expiresAt: expireAt, lockId: this.lockId, createdAt: new Date() });
        return true;
      });
      return true;
    } catch (error) {
      if (error.message === 'LOCK_ACQUIRED_BY_OTHER') return false;
      throw error;
    }
  }

  async release() {
    const lockRef = db.collection('locks').doc(this.resource);
    const doc = await lockRef.get();
    if (doc.exists && doc.data()?.lockId === this.lockId) {
      await lockRef.delete();
    }
  }
}

// ============== مصادقة Firebase ==============
const requireAuth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) {
      return res.status(401).json({ error: 'غير مصرح' });
    }
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(401).json({ error: 'جلسة غير صالحة' });
  }
};

const requireAdmin = async (req, res, next) => {
  try {
    if (req.user.email !== ADMIN_EMAIL) {
      return res.status(403).json({ error: 'غير مصرح - تحتاج صلاحيات مدير' });
    }
    next();
  } catch (error) {
    res.status(403).json({ error: 'غير مصرح' });
  }
};

// ============== دوال مساعدة ==============
const generateUniqueReferralCode = async () => {
  const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  let code;
  let exists = true;
  
  while (exists) {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    const existing = await db.collection('users').where('uniqueId', '==', code).get();
    exists = !existing.empty;
  }
  return code;
};

async function getSettings() {
  const cached = cache.get('settings');
  if (cached) return cached;
  
  try {
    const settingsDoc = await db.collection('settings').doc('config').get();
    let settings;
    
    if (!settingsDoc.exists) {
      settings = {
        minDeposit: 100,
        minWithdraw: 200,
        shamCashEnabled: false,
        shamCashApiKey: '',
        shamCashPrivateAddress: '',
        shamCashPublicAddress: '',
        shamCashUsdEnabled: false,
        usdToSypRate: 13000,
        shamCashUsdApiKey: '',
        shamCashUsdPrivateAddress: '',
        shamCashUsdPublicAddress: '',
        syriatelEnabled: false,
        syriatelApiKey: '',
        syriatelPrivateAddress: '',
        syriatelPublicAddress: '0930000000',
        gameImageUrl: '',
        siteTheme: 'red',
        siteName: 'BOOMB',
        maintenanceMode: false,
        referralCommission: 5,
        wheelSpinCost: 50
      };
      await db.collection('settings').doc('config').set(settings);
    } else {
      settings = settingsDoc.data();
    }
    
    cache.set('settings', settings);
    return settings;
  } catch (error) {
    console.error('Error getting settings:', error);
    throw error;
  }
}

// ============== ShamCash Client ==============
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
              return { success: false, message: "المعاملة قديمة (أكثر من 24 ساعة)" };
            }
            
            if (expectedCurrency && apiCurrency !== expectedCurrency) {
              return { success: false, message: `العملة غير مطابقة: ${apiCurrency}` };
            }
            
            if (expectedAmount && Math.abs(apiAmount - expectedAmount) > 0.01) {
              return { success: false, message: `المبلغ غير مطابق: ${apiAmount}` };
            }
            
            return { success: true, amount: apiAmount, currency: apiCurrency };
          }
        }
        return { success: false, message: "لم يتم العثور على المعاملة" };
      }
      return { success: false, message: "فشل الاتصال بشام كاش" };
    } catch (error) {
      console.error('ShamCash error:', error);
      return { success: false, message: "خطأ في الاتصال" };
    }
  }
}

// ============== مسارات المستخدم ==============

// جلب حالة العجلة
app.get('/api/user/wheel-status', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    
    let userData = cache.get(`user_${uid}`);
    if (!userData) {
      const userDoc = await db.collection('users').doc(uid).get();
      if (!userDoc.exists) {
        return res.status(404).json({ error: 'مستخدم غير موجود' });
      }
      userData = userDoc.data();
      cache.set(`user_${uid}`, userData);
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

// التدوير على العجلة
app.post('/api/user/spin-wheel', requireAuth, async (req, res) => {
  const { uid } = req.user;
  const lock = new DistributedLock(`spin:${uid}`, 20);
  
  if (!await lock.acquire()) {
    return res.status(429).json({ error: 'يوجد طلب قيد المعالجة، انتظر قليلاً' });
  }
  
  try {
    const userRef = db.collection('users').doc(uid);
    const settings = await getSettings();
    const spinCost = settings.wheelSpinCost || 50;
    
    const result = await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) {
        throw new Error('مستخدم غير موجود');
      }
      
      const userData = userDoc.data();
      const lastSpin = userData.lastSpinTime?.toDate ? userData.lastSpinTime.toDate() : userData.lastSpinTime;
      
      if (lastSpin) {
        const timeDiff = (Date.now() - lastSpin.getTime()) / 1000;
        if (timeDiff < SPIN_COOLDOWN_SECONDS) {
          throw new Error(`يجب الانتظار ${Math.ceil(SPIN_COOLDOWN_SECONDS - timeDiff)} ثانية`);
        }
      }
      
      if ((userData.referralBalance || 0) < spinCost) {
        throw new Error(`رصيد الإحالات غير كافٍ، تحتاج ${spinCost} SYP`);
      }
      
      // قطاعات العجلة
      const SECTORS = [
        { name: "حظ أوفر", value: 0, weight: 40 },
        { name: "10 SYP", value: 10, weight: 10 },
        { name: "20 SYP", value: 20, weight: 5 },
        { name: "30 SYP", value: 30, weight: 5 },
        { name: "حظ أوفر", value: 0, weight: 40 },
        { name: "10 SYP", value: 10, weight: 10 },
        { name: "20 SYP", value: 20, weight: 5 },
        { name: "30 SYP", value: 30, weight: 5 }
      ];
      
      // اختيار عشوائي مرجح
      let totalWeight = 0;
      for (const sector of SECTORS) {
        totalWeight += sector.weight;
      }
      
      let random = Math.random() * totalWeight;
      let selectedIndex = 0;
      for (let i = 0; i < SECTORS.length; i++) {
        random -= SECTORS[i].weight;
        if (random <= 0) {
          selectedIndex = i;
          break;
        }
      }
      
      const selectedSector = SECTORS[selectedIndex];
      let prizeAmount = selectedSector.value;
      let message = "";
      
      // خصم تكلفة التدوير
      const newReferralBalance = (userData.referralBalance || 0) - spinCost;
      
      // إضافة الجائزة إذا كانت أكبر من 0
      let newBalance = userData.balance || 0;
      if (prizeAmount > 0) {
        newBalance += prizeAmount;
        message = `🎉 تهانينا! ربحت ${prizeAmount} SYP`;
      } else {
        message = `😅 حظ أوفر! لم تربح هذه المرة`;
      }
      
      const updates = {
        referralBalance: newReferralBalance,
        balance: newBalance,
        lastSpinTime: new Date(),
        totalSpins: admin.firestore.FieldValue.increment(1),
        totalWinnings: admin.firestore.FieldValue.increment(prizeAmount)
      };
      
      t.update(userRef, updates);
      
      // تسجيل تاريخ التدوير
      const historyRef = db.collection('wheel_history').doc();
      t.set(historyRef, {
        userId: uid,
        sectorIndex: selectedIndex,
        prizeAmount: prizeAmount,
        cost: spinCost,
        timestamp: new Date()
      });
      
      return { sector: selectedIndex + 1, prizeAmount, message };
    });
    
    // تحديث الكاش
    cache.del(`user_${uid}`);
    
    res.json({
      success: true,
      sector: result.sector,
      prizeAmount: result.prizeAmount,
      message: result.message
    });
  } catch (error) {
    console.error('Spin error:', error);
    res.status(400).json({ error: error.message || 'فشل التدوير' });
  } finally {
    await lock.release();
  }
});

// جلب ملف المستخدم
app.get('/api/user/profile', requireAuth, async (req, res) => {
  try {
    const { uid, email } = req.user;
    
    let userData = cache.get(`user_${uid}`);
    if (!userData) {
      const userDoc = await db.collection('users').doc(uid).get();
      if (!userDoc.exists) {
        return res.status(404).json({ error: 'مستخدم غير موجود' });
      }
      userData = userDoc.data();
      cache.set(`user_${uid}`, userData);
    }
    
    const isAdmin = email === ADMIN_EMAIL;
    
    res.json({
      success: true,
      user: userData,
      isAdmin: isAdmin
    });
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

// جلب الإحصائيات
app.get('/api/user/stats', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    
    const userDoc = await db.collection('users').doc(uid).get();
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

// التسجيل
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
        cache.del(`user_${referredBy}`);
      }
    }
    
    const newUser = {
      uniqueId: uniqueId,
      email: email,
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
    res.status(500).json({ error: 'حدث خطأ في التسجيل' });
  }
});

// إيداع
app.post('/api/user/deposit', requireAuth, async (req, res) => {
  const { uid } = req.user;
  const { method, amount, transactionId } = req.body;
  const lock = new DistributedLock(`deposit:${uid}`, 30);
  
  if (!await lock.acquire()) {
    return res.status(429).json({ error: 'يوجد طلب إيداع قيد المعالجة' });
  }
  
  try {
    const settings = await getSettings();
    
    if (amount < settings.minDeposit) {
      return res.status(400).json({ error: `المبلغ أقل من الحد الأدنى (${settings.minDeposit} SYP)` });
    }
    
    // التحقق من المعاملة حسب الطريقة
    let verification = { success: false };
    
    if (method === 'shamcash' && settings.shamCashEnabled) {
      const shamCash = new ShamCashClient(settings.shamCashApiKey, settings.shamCashPrivateAddress);
      verification = await shamCash.verifyTransaction(transactionId, amount);
    } else if (method === 'shamcash_usd' && settings.shamCashUsdEnabled) {
      const shamCashUsd = new ShamCashClient(settings.shamCashUsdApiKey, settings.shamCashUsdPrivateAddress);
      const usdAmount = amount / (settings.usdToSypRate || 13000);
      verification = await shamCashUsd.verifyTransaction(transactionId, usdAmount, 'USD');
      if (verification.success) {
        verification.amount = verification.amount * (settings.usdToSypRate || 13000);
      }
    } else if (method === 'syriatel' && settings.syriatelEnabled) {
      verification = { success: true, message: "تم إرسال طلب السيرياتيل للمراجعة" };
    } else {
      return res.status(400).json({ error: 'طريقة الدفع غير مفعلة' });
    }
    
    if (!verification.success) {
      return res.status(400).json({ error: verification.message });
    }
    
    // تسجيل الإيداع
    const depositRef = db.collection('deposits').doc();
    await depositRef.set({
      userId: uid,
      method: method,
      amount: verification.amount || amount,
      originalAmount: amount,
      originalCurrency: method === 'shamcash_usd' ? 'USD' : 'SYP',
      transactionId: transactionId,
      status: method === 'syriatel' ? 'pending' : 'verified',
      verifiedAt: method !== 'syriatel' ? new Date() : null,
      createdAt: new Date()
    });
    
    // إضافة الرصيد
    if (method !== 'syriatel') {
      await db.collection('users').doc(uid).update({
        balance: admin.firestore.FieldValue.increment(verification.amount || amount),
        totalDeposited: admin.firestore.FieldValue.increment(verification.amount || amount)
      });
      cache.del(`user_${uid}`);
    }
    
    res.json({ success: true, message: verification.message || "تم إرسال طلب الإيداع بنجاح" });
  } catch (error) {
    console.error('Deposit error:', error);
    res.status(500).json({ error: 'حدث خطأ في عملية الإيداع' });
  } finally {
    await lock.release();
  }
});

// طلب سحب
app.post('/api/user/withdraw', requireAuth, async (req, res) => {
  const { uid } = req.user;
  const { amount, address, method } = req.body;
  const lock = new DistributedLock(`withdraw:${uid}`, 30);
  
  if (!await lock.acquire()) {
    return res.status(429).json({ error: 'يوجد طلب سحب قيد المعالجة' });
  }
  
  try {
    const settings = await getSettings();
    
    if (amount < settings.minWithdraw) {
      return res.status(400).json({ error: `المبلغ أقل من الحد الأدنى للسحب (${settings.minWithdraw} SYP)` });
    }
    
    const userRef = db.collection('users').doc(uid);
    
    const result = await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error('مستخدم غير موجود');
      
      const userData = userDoc.data();
      if ((userData.balance || 0) < amount) {
        throw new Error('الرصيد غير كافٍ');
      }
      
      t.update(userRef, {
        balance: admin.firestore.FieldValue.increment(-amount),
        totalWithdrawn: admin.firestore.FieldValue.increment(amount)
      });
      
      const requestRef = db.collection('withdraw_requests').doc();
      t.set(requestRef, {
        userId: uid,
        amount: amount,
        address: address,
        method: method || 'bank',
        status: 'pending',
        createdAt: new Date()
      });
      
      return { requestId: requestRef.id };
    });
    
    cache.del(`user_${uid}`);
    res.json({ success: true, message: "تم إرسال طلب السحب، سيتم المراجعة قريباً" });
  } catch (error) {
    console.error('Withdraw error:', error);
    res.status(400).json({ error: error.message || 'حدث خطأ في عملية السحب' });
  } finally {
    await lock.release();
  }
});

// جلب إعدادات الإيداع والسحب
app.get('/api/user/deposit-settings', requireAuth, async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({
      success: true,
      settings: {
        minDeposit: settings.minDeposit,
        minWithdraw: settings.minWithdraw,
        usdToSypRate: settings.usdToSypRate || 13000,
        referralCommission: settings.referralCommission || 5,
        wheelSpinCost: settings.wheelSpinCost || 50,
        gameImageUrl: settings.gameImageUrl || '',
        methods: [
          ...(settings.shamCashEnabled ? [{ id: 'shamcash', name: 'شام كاش', icon: '🏦', currency: 'SYP' }] : []),
          ...(settings.shamCashUsdEnabled ? [{ id: 'shamcash_usd', name: 'شام كاش (دولار)', icon: '💵', currency: 'USD' }] : []),
          ...(settings.syriatelEnabled ? [{ id: 'syriatel', name: 'سيرياتيل', icon: '📱', currency: 'SYP' }] : [])
        ]
      }
    });
  } catch (error) {
    console.error('Deposit settings error:', error);
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

// جلب الإيداعات السابقة
app.get('/api/user/deposits', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const deposits = await db.collection('deposits')
      .where('userId', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();
    
    res.json({
      success: true,
      deposits: deposits.docs.map(doc => ({ id: doc.id, ...doc.data() }))
    });
  } catch (error) {
    console.error('Get deposits error:', error);
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

// جلب طلبات السحب السابقة
app.get('/api/user/withdraw-requests', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const requests = await db.collection('withdraw_requests')
      .where('userId', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();
    
    res.json({
      success: true,
      requests: requests.docs.map(doc => ({ id: doc.id, ...doc.data() }))
    });
  } catch (error) {
    console.error('Get withdraws error:', error);
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

// إضافة محيل
app.post('/api/user/add-referrer', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { referrerCode } = req.body;
    
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'مستخدم غير موجود' });
    }
    
    const userData = userDoc.data();
    if (userData.referredBy) {
      return res.status(400).json({ error: 'لديك بالفعل محيل' });
    }
    
    const referrerQuery = await db.collection('users').where('uniqueId', '==', referrerCode).limit(1).get();
    if (referrerQuery.empty) {
      return res.status(404).json({ error: 'كود الإحالة غير صحيح' });
    }
    
    const referrerDoc = referrerQuery.docs[0];
    if (referrerDoc.id === uid) {
      return res.status(400).json({ error: 'لا يمكنك إضافة نفسك كمحيل' });
    }
    
    await userRef.update({
      referredBy: referrerDoc.id,
      referredByName: referrerDoc.data().name
    });
    
    await referrerDoc.ref.update({
      referralBalance: admin.firestore.FieldValue.increment(5),
      referralEarnings: admin.firestore.FieldValue.increment(5),
      referrals: admin.firestore.FieldValue.arrayUnion(uid)
    });
    
    cache.del(`user_${uid}`);
    cache.del(`user_${referrerDoc.id}`);
    
    res.json({ success: true, message: `تم إضافة المحيل: ${referrerDoc.data().name}` });
  } catch (error) {
    console.error('Add referrer error:', error);
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

// جلب سجل العجلة
app.get('/api/user/wheel-history', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const history = await db.collection('wheel_history')
      .where('userId', '==', uid)
      .orderBy('timestamp', 'desc')
      .limit(50)
      .get();
    
    res.json({
      success: true,
      history: history.docs.map(doc => ({ id: doc.id, ...doc.data() }))
    });
  } catch (error) {
    console.error('Wheel history error:', error);
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

// جلب ثيم الموقع
app.get('/api/site-theme', async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({ success: true, theme: settings.siteTheme || 'red' });
  } catch (error) {
    res.json({ success: true, theme: 'red' });
  }
});

// ============== مسارات المدير ==============

// لوحة تحكم المدير
app.get('/api/admin/dashboard', requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await db.collection('users').get();
    const deposits = await db.collection('deposits').where('status', '==', 'verified').get();
    const withdraws = await db.collection('withdraw_requests').get();
    const pendingWithdraws = await db.collection('withdraw_requests').where('status', '==', 'pending').get();
    
    let totalBalance = 0;
    let totalDeposited = 0;
    let totalWithdrawn = 0;
    let totalSpins = 0;
    let totalWinnings = 0;
    let newToday = 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    users.forEach(doc => {
      const data = doc.data();
      totalBalance += data.balance || 0;
      totalSpins += data.totalSpins || 0;
      totalWinnings += data.totalWinnings || 0;
      if (data.createdAt?.toDate && data.createdAt.toDate() >= today) {
        newToday++;
      }
    });
    
    deposits.forEach(doc => {
      totalDeposited += doc.data().amount || 0;
    });
    
    withdraws.forEach(doc => {
      if (doc.data().status === 'approved') {
        totalWithdrawn += doc.data().amount || 0;
      }
    });
    
    res.json({
      success: true,
      stats: {
        totalUsers: users.size,
        newToday: newToday,
        totalBalance: totalBalance,
        totalDeposited: totalDeposited,
        totalWithdrawn: totalWithdrawn,
        pendingWithdrawals: pendingWithdraws.size,
        totalSpins: totalSpins,
        totalWinnings: totalWinnings
      }
    });
  } catch (error) {
    console.error('Admin dashboard error:', error);
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

// جلب طلبات السحب للمدير
app.get('/api/admin/withdraw-requests', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    let query = db.collection('withdraw_requests').orderBy('createdAt', 'desc');
    
    if (status && status !== 'all') {
      query = query.where('status', '==', status);
    }
    
    const requests = await query.get();
    const requestsWithUser = [];
    
    for (const doc of requests.docs) {
      const data = doc.data();
      const userDoc = await db.collection('users').doc(data.userId).get();
      requestsWithUser.push({
        id: doc.id,
        ...data,
        userEmail: userDoc.exists ? userDoc.data().email : null,
        userName: userDoc.exists ? userDoc.data().name : null
      });
    }
    
    res.json({ success: true, requests: requestsWithUser });
  } catch (error) {
    console.error('Get withdraws admin error:', error);
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

// معالجة طلب سحب
app.post('/api/admin/process-withdraw', requireAuth, requireAdmin, async (req, res) => {
  const { requestId, action, notes } = req.body;
  const lock = new DistributedLock(`admin:withdraw:${requestId}`, 30);
  
  if (!await lock.acquire()) {
    return res.status(429).json({ error: 'يوجد طلب قيد المعالجة' });
  }
  
  try {
    const requestRef = db.collection('withdraw_requests').doc(requestId);
    const requestDoc = await requestRef.get();
    
    if (!requestDoc.exists) {
      return res.status(404).json({ error: 'الطلب غير موجود' });
    }
    
    const requestData = requestDoc.data();
    
    if (requestData.status !== 'pending') {
      return res.status(400).json({ error: 'تمت معالجة هذا الطلب بالفعل' });
    }
    
    if (action === 'approve') {
      await requestRef.update({
        status: 'approved',
        processedAt: new Date(),
        processedBy: req.user.uid,
        notes: notes || ''
      });
    } else if (action === 'reject') {
      // إعادة المبلغ للمستخدم
      await db.collection('users').doc(requestData.userId).update({
        balance: admin.firestore.FieldValue.increment(requestData.amount),
        totalWithdrawn: admin.firestore.FieldValue.increment(-requestData.amount)
      });
      
      await requestRef.update({
        status: 'rejected',
        processedAt: new Date(),
        processedBy: req.user.uid,
        notes: notes || ''
      });
      
      cache.del(`user_${requestData.userId}`);
    }
    
    res.json({ success: true, message: `تم ${action === 'approve' ? 'قبول' : 'رفض'} الطلب بنجاح` });
  } catch (error) {
    console.error('Process withdraw error:', error);
    res.status(500).json({ error: 'حدث خطأ' });
  } finally {
    await lock.release();
  }
});

// جلب الإعدادات للمدير
app.get('/api/admin/settings', requireAuth, requireAdmin, async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({ success: true, settings: settings });
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

// حفظ الإعدادات
app.post('/api/admin/settings', requireAuth, requireAdmin, async (req, res) => {
  try {
    const settings = req.body;
    await db.collection('settings').doc('config').set(settings, { merge: true });
    cache.del('settings');
    res.json({ success: true, message: 'تم حفظ الإعدادات' });
  } catch (error) {
    console.error('Save settings error:', error);
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

// تحديث سعر العجلة
app.post('/api/admin/update-wheel-cost', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { cost } = req.body;
    if (!cost || cost < 10 || cost > 10000) {
      return res.status(400).json({ error: 'السعر غير صالح' });
    }
    
    await db.collection('settings').doc('config').set({ wheelSpinCost: cost }, { merge: true });
    cache.del('settings');
    res.json({ success: true, message: 'تم تحديث السعر' });
  } catch (error) {
    console.error('Update wheel cost error:', error);
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

// تحديث الثيم
app.post('/api/admin/update-theme', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { theme } = req.body;
    await db.collection('settings').doc('config').set({ siteTheme: theme }, { merge: true });
    cache.del('settings');
    res.json({ success: true, message: 'تم تحديث الثيم' });
  } catch (error) {
    console.error('Update theme error:', error);
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

// جلب قائمة المستخدمين
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await db.collection('users').get();
    const usersList = [];
    
    for (const doc of users.docs) {
      const data = doc.data();
      usersList.push({
        id: doc.id,
        email: data.email,
        name: data.name,
        uniqueId: data.uniqueId,
        balance: data.balance || 0,
        referralBalance: data.referralBalance || 0,
        totalDeposited: data.totalDeposited || 0,
        totalWithdrawn: data.totalWithdrawn || 0,
        referralCount: data.referrals?.length || 0,
        referredByName: data.referredByName,
        isBanned: data.isBanned || false,
        totalSpins: data.totalSpins || 0,
        createdAt: data.createdAt
      });
    }
    
    res.json({ success: true, users: usersList });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

// تعديل رصيد المستخدم
app.post('/api/admin/edit-balance', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { userId, amount, type } = req.body;
    
    const updateData = {};
    if (type === 'main') {
      updateData.balance = admin.firestore.FieldValue.increment(amount);
    } else if (type === 'referral') {
      updateData.referralBalance = admin.firestore.FieldValue.increment(amount);
    }
    
    await db.collection('users').doc(userId).update(updateData);
    cache.del(`user_${userId}`);
    
    res.json({ success: true, message: 'تم تعديل الرصيد' });
  } catch (error) {
    console.error('Edit balance error:', error);
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

// حظر/إلغاء حظر مستخدم
app.post('/api/admin/toggle-ban', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.body;
    const userDoc = await db.collection('users').doc(userId).get();
    const currentBan = userDoc.data()?.isBanned || false;
    
    await db.collection('users').doc(userId).update({ isBanned: !currentBan });
    cache.del(`user_${userId}`);
    
    res.json({ success: true, message: !currentBan ? 'تم حظر المستخدم' : 'تم إلغاء حظر المستخدم' });
  } catch (error) {
    console.error('Toggle ban error:', error);
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

// إعادة تهيئة قاعدة البيانات
app.post('/api/admin/reset-database', requireAuth, requireAdmin, async (req, res) => {
  const { password } = req.body;
  const MASTER_PASSWORD = process.env.MASTER_RESET_PASSWORD || "BOOMB_MASTER_2024";
  
  if (password !== MASTER_PASSWORD) {
    return res.status(403).json({ error: 'كلمة المرور غير صحيحة' });
  }
  
  try {
    const users = await db.collection('users').get();
    const deposits = await db.collection('deposits').get();
    const withdraws = await db.collection('withdraw_requests').get();
    const wheelHistory = await db.collection('wheel_history').get();
    const locks = await db.collection('locks').get();
    
    const batch = db.batch();
    
    users.forEach(doc => batch.delete(doc.ref));
    deposits.forEach(doc => batch.delete(doc.ref));
    withdraws.forEach(doc => batch.delete(doc.ref));
    wheelHistory.forEach(doc => batch.delete(doc.ref));
    locks.forEach(doc => batch.delete(doc.ref));
    
    await batch.commit();
    cache.flushAll();
    
    res.json({ success: true, message: 'تمت إعادة تهيئة قاعدة البيانات بنجاح' });
  } catch (error) {
    console.error('Reset database error:', error);
    res.status(500).json({ error: 'حدث خطأ في إعادة التهيئة' });
  }
});

// ============== تشغيل الخادم ==============
const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  console.log(`✅ BOOMB Server running on port ${PORT}`);
  console.log(`📍 Admin: ${ADMIN_EMAIL}`);
  console.log(`🎰 Wheel system ready with 8 sectors`);
  console.log(`⚡ Cache enabled | Distributed locking active`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

export default app;
