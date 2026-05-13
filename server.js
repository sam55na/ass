import express from 'express';
import admin from 'firebase-admin';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import axios from 'axios';
import helmet from 'helmet';
import compression from 'compression';

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

// ============= إعدادات الأمان والتحسين =============
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false
}));

app.use(compression());

app.use(cors({
  origin: ['https://sam55na.github.io', 'http://localhost:3000', 'http://localhost:5500', 'https://*.onrender.com'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============= منع التكرار المحسن =============
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: { error: 'الرجاء الانتظار دقيقة' },
  standardHeaders: true,
  legacyHeaders: false
});

const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'طلبات كثيرة جداً، الرجاء الانتظار' },
  standardHeaders: true,
  legacyHeaders: false
});

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'طلبات كثيرة جداً، الرجاء الانتظار' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/', generalLimiter);
app.use('/api/user/deposit', strictLimiter);
app.use('/api/user/withdraw', strictLimiter);
app.use('/api/user/register', strictLimiter);
app.use('/api/admin/', adminLimiter);

// ============= إعدادات النظام =============
const RESET_PASSWORD = '2613857';
const ADMIN_EMAIL = 'sam55nam@gmail.com';
const CACHE_TTL = 60; // ثانية

// نظام كاش بسيط
const cache = new Map();

function getCached(key) {
  const item = cache.get(key);
  if (item && Date.now() < item.expiry) return item.data;
  return null;
}

function setCache(key, data, ttl = CACHE_TTL) {
  cache.set(key, { data, expiry: Date.now() + ttl * 1000 });
}

function generateUniqueId() {
  return Math.floor(1000000000 + Math.random() * 9000000000).toString();
}

const requireAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) {
    return res.status(401).json({ error: 'غير مصرح - الرجاء تسجيل الدخول' });
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

// ============= إعدادات النظام =============
async function getSettings() {
  const cached = getCached('settings');
  if (cached) return cached;
  
  try {
    const doc = await db.collection('settings').doc('config').get();
    let settings = doc.exists ? doc.data() : null;
    
    if (!settings) {
      settings = {
        minDeposit: 1000,
        minWithdraw: 5000,
        shamCashEnabled: true,
        syriatelEnabled: true,
        shamCashUsdEnabled: false,
        usdToSypRate: 13000,
        referralCommission: 5,
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
      await db.collection('settings').doc('config').set(settings);
    }
    
    setCache('settings', settings);
    return settings;
  } catch (error) {
    console.error('Error getting settings:', error);
    return {
      minDeposit: 1000,
      minWithdraw: 5000,
      shamCashEnabled: true,
      syriatelEnabled: true,
      shamCashUsdEnabled: false,
      usdToSypRate: 13000,
      referralCommission: 5,
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
  }
}

// ============= كلاس شام كاش =============
class ShamCashClient {
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
      const response = await axios.get(this.baseUrl, { params, timeout: 30000 });
      
      if (response.status === 200 && response.data.success) {
        const items = response.data.data?.items || [];
        for (const item of items) {
          if (String(item.tran_id) === String(txid)) {
            const apiAmount = parseFloat(item.amount);
            const timestamp = item.created_at || Date.now() / 1000;
            if ((Date.now() / 1000 - timestamp) > 86400) {
              return { success: false, message: "العملية أقدم من 24 ساعة" };
            }
            if (expectedAmount && Math.abs(apiAmount - expectedAmount) > 0.01) {
              return { success: false, message: `المبلغ غير متطابق: المبلغ الفعلي ${apiAmount}` };
            }
            return { success: true, amount: apiAmount, currency: item.currency || "SYP" };
          }
        }
        return { success: false, message: "رقم العملية غير موجود" };
      }
      return { success: false, message: "فشل التحقق من العملية" };
    } catch (error) {
      console.error('ShamCash verification error:', error.message);
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
        console.error(`Syriatel error for GSM ${gsm}:`, error.message);
      }
    }
    return { success: false, message: "رقم العملية غير موجود" };
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
      const response = await axios.get(this.baseUrl, { params, timeout: 30000 });
      
      if (response.status === 200 && response.data.success) {
        const items = response.data.data?.items || [];
        for (const item of items) {
          if (String(item.tran_id) === String(txid)) {
            const apiAmount = parseFloat(item.amount);
            const timestamp = item.created_at || Date.now() / 1000;
            if ((Date.now() / 1000 - timestamp) > 86400) {
              return { success: false, message: "العملية أقدم من 24 ساعة" };
            }
            if (expectedAmount && Math.abs(apiAmount - expectedAmount) > 0.01) {
              return { success: false, message: `المبلغ غير متطابق: المبلغ الفعلي ${apiAmount}` };
            }
            return { success: true, amount: apiAmount, currency: "USD" };
          }
        }
        return { success: false, message: "رقم العملية غير موجود" };
      }
      return { success: false, message: "فشل التحقق من العملية" };
    } catch (error) {
      console.error('ShamCash USD verification error:', error.message);
      return { success: false, message: "خطأ في الاتصال بخدمة شام كاش" };
    }
  }
}

// ============= دالة لإضافة عمولة الإحالة =============
async function addReferralCommission(userId, depositAmount) {
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
          balance: admin.firestore.FieldValue.increment(commissionAmount),
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
        
        console.log(`تم إضافة عمولة ${commissionAmount} SYP للمحيل ${userData.referredBy}`);
      }
    }
  } catch (error) {
    console.error('Error adding referral commission:', error);
  }
}

// ============= API المستخدمين =============
app.post('/api/user/register', requireAuth, async (req, res) => {
  try {
    const { uid, email, name } = req.user;
    const { referrerId } = req.body;
    
    const settings = await getSettings();
    if (settings.maintenanceMode && email !== ADMIN_EMAIL) {
      return res.status(503).json({ error: 'الموقع تحت الصيانة حالياً، الرجاء المحاولة لاحقاً' });
    }
    
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    
    if (userDoc.exists) {
      return res.json({ success: true, user: userDoc.data(), isAdmin: email === ADMIN_EMAIL });
    }
    
    let referredBy = null;
    let referrerName = null;
    
    if (referrerId) {
      const refQuery = await db.collection('users').where('uniqueId', '==', referrerId).limit(1).get();
      if (!refQuery.empty) {
        referredBy = refQuery.docs[0].id;
        referrerName = refQuery.docs[0].data().name;
        
        await refQuery.docs[0].ref.update({
          referralEarnings: admin.firestore.FieldValue.increment(5),
          referrals: admin.firestore.FieldValue.arrayUnion(uid)
        });
      }
    }
    
    const newUser = {
      uniqueId: generateUniqueId(),
      email,
      name: name || email.split('@')[0],
      balance: 0,
      totalDeposited: 0,
      totalWithdrawn: 0,
      referralEarnings: 0,
      referredBy: referredBy,
      referredByName: referrerName,
      referrals: [],
      createdAt: new Date(),
      isBanned: false,
      lastLogin: new Date()
    };
    await userRef.set(newUser);
    
    cache.delete('admin_users');
    
    res.json({ success: true, user: newUser, isAdmin: email === ADMIN_EMAIL });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'خطأ في التسجيل' });
  }
});

app.get('/api/user/profile', requireAuth, async (req, res) => {
  try {
    const userRef = db.collection('users').doc(req.user.uid);
    await userRef.update({ lastLogin: new Date() });
    
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'مستخدم غير موجود' });
    }
    res.json({ success: true, user: userDoc.data(), isAdmin: req.user.email === ADMIN_EMAIL });
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ error: 'خطأ في جلب البيانات' });
  }
});

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
    
    const commissionsSnapshot = await db.collection('referral_commissions')
      .where('fromUserId', '==', req.user.uid)
      .orderBy('createdAt', 'desc')
      .limit(5)
      .get();
    
    const recentCommissions = [];
    commissionsSnapshot.forEach(doc => {
      const c = doc.data();
      recentCommissions.push({
        amount: c.amount,
        percent: c.percent,
        createdAt: c.createdAt?.toDate()
      });
    });
    
    res.json({
      success: true,
      stats: {
        referralCount: data.referrals?.length || 0,
        referralEarnings: data.referralEarnings || 0,
        balance: data.balance || 0,
        totalDeposited: data.totalDeposited || 0,
        totalWithdrawn: data.totalWithdrawn || 0,
        uniqueId: data.uniqueId,
        joinDate: data.createdAt,
        referredBy: data.referredBy,
        referredByName: data.referredByName,
        referrerInfo: referrerInfo,
        recentCommissions: recentCommissions
      }
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'خطأ في جلب الإحصائيات' });
  }
});

// ============= API الإيداع =============
app.get('/api/user/deposit-settings', requireAuth, async (req, res) => {
  try {
    const settings = await getSettings();
    const methods = [];
    
    if (settings.shamCashEnabled && settings.shamCashPublicAddress) {
      methods.push({
        id: 'sham_cash',
        name: 'شام كاش',
        address: settings.shamCashPublicAddress,
        type: 'sham_cash',
        currency: 'SYP',
        icon: '🏦'
      });
    }
    
    if (settings.shamCashUsdEnabled && settings.shamCashUsdPublicAddress) {
      methods.push({
        id: 'sham_cash_usd',
        name: 'شام كاش (دولار)',
        address: settings.shamCashUsdPublicAddress,
        type: 'sham_cash_usd',
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
        type: 'syriatel_cash',
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
        siteName: settings.siteName || 'BOOMB'
      }
    });
  } catch (error) {
    console.error('Deposit settings error:', error);
    res.status(500).json({ error: 'خطأ في جلب الإعدادات' });
  }
});

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
    let currency = 'SYP';
    
    if (method === 'sham_cash') {
      if (!settings.shamCashEnabled) {
        return res.status(400).json({ error: 'طريقة الدفع شام كاش غير مفعلة' });
      }
      if (!settings.shamCashApiKey || !settings.shamCashPrivateAddress) {
        return res.status(400).json({ error: 'بيانات شام كاش غير مكتملة' });
      }
      const client = new ShamCashClient(settings.shamCashApiKey, settings.shamCashPrivateAddress);
      verification = await client.verifyTransaction(transactionId, amountNum);
      if (verification.success) {
        finalAmountSYP = verification.amount;
        currency = verification.currency || 'SYP';
      }
      
    } else if (method === 'sham_cash_usd') {
      if (!settings.shamCashUsdEnabled) {
        return res.status(400).json({ error: 'طريقة الدفع شام كاش دولار غير مفعلة' });
      }
      if (!settings.shamCashUsdApiKey || !settings.shamCashUsdPrivateAddress) {
        return res.status(400).json({ error: 'بيانات شام كاش دولار غير مكتملة' });
      }
      const client = new ShamCashUsdClient(settings.shamCashUsdApiKey, settings.shamCashUsdPrivateAddress);
      verification = await client.verifyTransaction(transactionId, amountNum);
      if (verification.success) {
        const exchangeRate = settings.usdToSypRate || 13000;
        finalAmountSYP = verification.amount * exchangeRate;
        currency = 'SYP';
      }
      
    } else if (method === 'syriatel_cash') {
      if (!settings.syriatelEnabled) {
        return res.status(400).json({ error: 'طريقة الدفع سيرياتيل كاش غير مفعلة' });
      }
      if (!settings.syriatelApiKey || !settings.syriatelPrivateAddress) {
        return res.status(400).json({ error: 'بيانات سيرياتيل كاش غير مكتملة' });
      }
      const client = new SyriatelCashClient(settings.syriatelApiKey, [settings.syriatelPrivateAddress]);
      verification = await client.verifyTransaction(transactionId, amountNum);
      if (verification.success) {
        finalAmountSYP = verification.amount;
        currency = verification.currency || 'SYP';
      }
    } else {
      return res.status(400).json({ error: 'طريقة دفع غير مدعومة' });
    }
    
    if (!verification.success) {
      return res.status(400).json({ error: verification.message });
    }
    
    if (finalAmountSYP < settings.minDeposit) {
      return res.status(400).json({ error: `الحد الأدنى للإيداع ${settings.minDeposit.toLocaleString()} SYP` });
    }
    
    const existing = await db.collection('deposits')
      .where('transactionId', '==', transactionId)
      .limit(1)
      .get();
      
    if (!existing.empty) {
      return res.status(400).json({ error: 'تم استخدام رقم العملية مسبقاً' });
    }
    
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    
    if (userDoc.data()?.isBanned) {
      return res.status(403).json({ error: 'حسابك محظور، الرجاء التواصل مع الدعم' });
    }
    
    await userRef.update({
      balance: admin.firestore.FieldValue.increment(finalAmountSYP),
      totalDeposited: admin.firestore.FieldValue.increment(finalAmountSYP)
    });
    
    await db.collection('deposits').add({
      userId: uid,
      method,
      amount: finalAmountSYP,
      originalAmount: verification.amount,
      originalCurrency: currency,
      transactionId,
      status: 'completed',
      verifiedAt: new Date(),
      exchangeRate: method === 'sham_cash_usd' ? settings.usdToSypRate : null
    });
    
    await addReferralCommission(uid, finalAmountSYP);
    
    cache.delete('admin_dashboard');
    cache.delete('admin_users');
    
    const updatedUser = await userRef.get();
    res.json({ 
      success: true, 
      message: `تم إيداع ${finalAmountSYP.toLocaleString()} SYP بنجاح`,
      newBalance: updatedUser.data().balance
    });
    
  } catch (error) {
    console.error('Deposit error:', error);
    res.status(500).json({ error: 'حدث خطأ داخلي في الخادم' });
  }
});

app.get('/api/user/deposits', requireAuth, async (req, res) => {
  try {
    const snapshot = await db.collection('deposits')
      .where('userId', '==', req.user.uid)
      .orderBy('verifiedAt', 'desc')
      .limit(50)
      .get();
    
    const deposits = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      
      let verifiedDate = null;
      if (data.verifiedAt) {
        if (typeof data.verifiedAt === 'object') {
          if (data.verifiedAt.toDate) {
            verifiedDate = data.verifiedAt.toDate();
          } else if (data.verifiedAt._seconds) {
            verifiedDate = new Date(data.verifiedAt._seconds * 1000);
          } else if (data.verifiedAt instanceof Date) {
            verifiedDate = data.verifiedAt;
          }
        } else if (typeof data.verifiedAt === 'string') {
          verifiedDate = new Date(data.verifiedAt);
        }
      }
      
      let methodName = '';
      let methodIcon = '';
      if (data.method === 'sham_cash') {
        methodName = 'شام كاش';
        methodIcon = '🏦';
      } else if (data.method === 'sham_cash_usd') {
        methodName = 'شام كاش (دولار)';
        methodIcon = '💵';
      } else if (data.method === 'syriatel_cash') {
        methodName = 'سيرياتيل كاش';
        methodIcon = '📱';
      } else {
        methodName = data.method;
        methodIcon = '💰';
      }
      
      deposits.push({
        id: doc.id,
        amount: data.amount || 0,
        method: methodName,
        methodIcon: methodIcon,
        originalAmount: data.originalAmount,
        originalCurrency: data.originalCurrency,
        transactionId: data.transactionId || 'N/A',
        verifiedAt: verifiedDate,
        status: data.status || 'completed'
      });
    });
    
    res.json({ success: true, deposits });
  } catch (error) {
    console.error('Get deposits error:', error);
    res.json({ success: true, deposits: [] });
  }
});

// ============= API لإضافة كود إحالة =============
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
    
    await userRef.update({
      referredBy: referrerId,
      referredByName: referrerDoc.data().name
    });
    
    await referrerDoc.ref.update({
      referralEarnings: admin.firestore.FieldValue.increment(5),
      referrals: admin.firestore.FieldValue.arrayUnion(uid)
    });
    
    cache.delete('admin_users');
    
    res.json({ 
      success: true, 
      message: `تم إضافة المحيل بنجاح: ${referrerDoc.data().name}`,
      referrerName: referrerDoc.data().name
    });
    
  } catch (error) {
    console.error('Add referrer error:', error);
    res.status(500).json({ error: 'حدث خطأ في إضافة كود الإحالة' });
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
      return res.status(400).json({ error: `الحد الأدنى للسحب ${settings.minWithdraw.toLocaleString()} SYP` });
    }
    
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    const userData = userDoc.data();
    
    if (!userData) {
      return res.status(404).json({ error: 'مستخدم غير موجود' });
    }
    if (userData.isBanned) {
      return res.status(403).json({ error: 'حسابك محظور، الرجاء التواصل مع الدعم' });
    }
    if (userData.balance < amountNum) {
      return res.status(400).json({ error: `الرصيد غير كافٍ، رصيدك الحالي: ${userData.balance.toLocaleString()} SYP` });
    }
    
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
      createdAt: new Date(),
      previousBalance: userData.balance,
      newBalance: userData.balance - amountNum
    });
    
    cache.delete('admin_dashboard');
    cache.delete('admin_withdraws');
    
    res.json({
      success: true,
      message: `تم إنشاء طلب سحب بمبلغ ${amountNum.toLocaleString()} SYP، سيتم مراجعته خلال 24 ساعة`
    });
    
  } catch (error) {
    console.error('Withdraw error:', error);
    res.status(500).json({ error: 'فشل إنشاء طلب السحب' });
  }
});

app.get('/api/user/withdraw-requests', requireAuth, async (req, res) => {
  try {
    const snapshot = await db.collection('withdraw_requests')
      .where('userId', '==', req.user.uid)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();
    
    const requests = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      
      let createdDate = null;
      if (data.createdAt) {
        if (typeof data.createdAt === 'object') {
          if (data.createdAt.toDate) {
            createdDate = data.createdAt.toDate();
          } else if (data.createdAt._seconds) {
            createdDate = new Date(data.createdAt._seconds * 1000);
          } else if (data.createdAt instanceof Date) {
            createdDate = data.createdAt;
          }
        } else if (typeof data.createdAt === 'string') {
          createdDate = new Date(data.createdAt);
        }
      }
      
      let statusText = '';
      let statusClass = '';
      if (data.status === 'pending') {
        statusText = 'قيد المراجعة';
        statusClass = 'pending';
      } else if (data.status === 'approved') {
        statusText = 'مقبول';
        statusClass = 'approved';
      } else if (data.status === 'rejected') {
        statusText = 'مرفوض';
        statusClass = 'rejected';
      }
      
      requests.push({
        id: doc.id,
        amount: data.amount || 0,
        address: data.address || 'N/A',
        method: data.method || 'unknown',
        status: data.status || 'pending',
        statusText: statusText,
        statusClass: statusClass,
        createdAt: createdDate
      });
    });
    
    res.json({ success: true, requests });
  } catch (error) {
    console.error('Get withdraw requests error:', error);
    res.json({ success: true, requests: [] });
  }
});

// ============= API تهيئة قاعدة البيانات =============
app.post('/api/admin/reset-database', requireAdmin, async (req, res) => {
  try {
    const { password } = req.body;
    
    if (password !== RESET_PASSWORD) {
      return res.status(403).json({ error: 'كلمة المرور غير صحيحة' });
    }
    
    const collections = ['users', 'withdraw_requests', 'deposits', 'referral_commissions', 'balance_logs'];
    const deleted = {};
    
    for (const col of collections) {
      const snapshot = await db.collection(col).get();
      const deletions = [];
      snapshot.forEach(doc => deletions.push(db.collection(col).doc(doc.id).delete()));
      await Promise.all(deletions);
      deleted[col] = deletions.length;
    }
    
    const defaultSettings = {
      minDeposit: 1000,
      minWithdraw: 5000,
      shamCashEnabled: true,
      syriatelEnabled: true,
      shamCashUsdEnabled: false,
      usdToSypRate: 13000,
      referralCommission: 5,
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
    
    cache.clear();
    
    res.json({ 
      success: true, 
      message: 'تم تهيئة قاعدة البيانات بنجاح',
      deleted: deleted
    });
    
  } catch (error) {
    console.error('Reset error:', error);
    res.status(500).json({ error: 'فشل تهيئة قاعدة البيانات' });
  }
});

// ============= APIs الأدمن =============
app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({ success: true, settings });
  } catch (error) {
    console.error('Get admin settings error:', error);
    res.status(500).json({ error: 'خطأ في جلب الإعدادات' });
  }
});

app.post('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const updates = req.body;
    await db.collection('settings').doc('config').update(updates);
    cache.delete('settings');
    res.json({ success: true, message: 'تم تحديث الإعدادات' });
  } catch (error) {
    console.error('Save admin settings error:', error);
    res.status(500).json({ error: 'فشل تحديث الإعدادات' });
  }
});

app.get('/api/admin/dashboard', requireAdmin, async (req, res) => {
  const cached = getCached('admin_dashboard');
  if (cached) return res.json({ success: true, stats: cached });
  
  try {
    const usersSnapshot = await db.collection('users').get();
    const users = [];
    usersSnapshot.forEach(doc => users.push(doc.data()));
    
    const totalBalance = users.reduce((s, u) => s + (u.balance || 0), 0);
    const totalDeposited = users.reduce((s, u) => s + (u.totalDeposited || 0), 0);
    const totalWithdrawn = users.reduce((s, u) => s + (u.totalWithdrawn || 0), 0);
    const totalReferralEarnings = users.reduce((s, u) => s + (u.referralEarnings || 0), 0);
    
    const pendingSnapshot = await db.collection('withdraw_requests').where('status', '==', 'pending').get();
    const approvedSnapshot = await db.collection('withdraw_requests').where('status', '==', 'approved').get();
    const rejectedSnapshot = await db.collection('withdraw_requests').where('status', '==', 'rejected').get();
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const newToday = users.filter(u => {
      if (!u.createdAt) return false;
      const date = u.createdAt.toDate ? u.createdAt.toDate() : u.createdAt;
      return date > today;
    }).length;
    
    const depositsSnapshot = await db.collection('deposits').get();
    let todayDeposits = 0;
    depositsSnapshot.forEach(doc => {
      const data = doc.data();
      if (data.verifiedAt) {
        const date = data.verifiedAt.toDate ? data.verifiedAt.toDate() : data.verifiedAt;
        if (date > today) todayDeposits += data.amount || 0;
      }
    });
    
    const stats = {
      totalUsers: usersSnapshot.size,
      newToday,
      totalBalance,
      totalDeposited,
      totalWithdrawn,
      totalReferralEarnings,
      todayDeposits,
      pendingWithdrawals: pendingSnapshot.size,
      approvedWithdrawals: approvedSnapshot.size,
      rejectedWithdrawals: rejectedSnapshot.size
    };
    
    setCache('admin_dashboard', stats, 30);
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
    
    const snapshot = await query.limit(parseInt(limit)).get();
    
    const requests = [];
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const userDoc = await db.collection('users').doc(data.userId).get();
      
      let createdDate = null;
      if (data.createdAt) {
        if (data.createdAt.toDate) createdDate = data.createdAt.toDate();
        else if (data.createdAt._seconds) createdDate = new Date(data.createdAt._seconds * 1000);
        else if (data.createdAt instanceof Date) createdDate = data.createdAt;
      }
      
      requests.push({
        id: doc.id,
        userId: data.userId,
        userEmail: data.userEmail,
        userName: data.userName,
        userPhone: userDoc.exists ? userDoc.data().phone : null,
        amount: data.amount,
        address: data.address,
        method: data.method,
        status: data.status,
        createdAt: createdDate,
        processedAt: data.processedAt?.toDate(),
        processedBy: data.processedBy
      });
    }
    
    res.json({ success: true, requests, total: snapshot.size });
  } catch (error) {
    console.error('Get withdraw requests error:', error);
    res.status(500).json({ error: 'خطأ في جلب الطلبات' });
  }
});

app.post('/api/admin/process-withdraw', requireAdmin, async (req, res) => {
  try {
    const { requestId, action } = req.body;
    
    const requestRef = db.collection('withdraw_requests').doc(requestId);
    const requestDoc = await requestRef.get();
    
    if (!requestDoc.exists) {
      return res.status(404).json({ error: 'طلب غير موجود' });
    }
    
    const request = requestDoc.data();
    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'تم معالجة هذا الطلب مسبقاً' });
    }
    
    if (action === 'reject') {
      await db.collection('users').doc(request.userId).update({
        balance: admin.firestore.FieldValue.increment(request.amount)
      });
    }
    
    await requestRef.update({
      status: action === 'approve' ? 'approved' : 'rejected',
      processedAt: new Date(),
      processedBy: req.user.email
    });
    
    cache.delete('admin_dashboard');
    cache.delete('admin_withdraws');
    
    res.json({ success: true, message: `تم ${action === 'approve' ? 'قبول' : 'رفض'} الطلب` });
  } catch (error) {
    console.error('Process withdraw error:', error);
    res.status(500).json({ error: 'فشل معالجة الطلب' });
  }
});

app.get('/api/admin/deposits', requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('deposits')
      .orderBy('verifiedAt', 'desc')
      .limit(100)
      .get();
    
    const deposits = [];
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const userDoc = await db.collection('users').doc(data.userId).get();
      
      let verifiedDate = null;
      if (data.verifiedAt) {
        if (data.verifiedAt.toDate) verifiedDate = data.verifiedAt.toDate();
        else if (data.verifiedAt._seconds) verifiedDate = new Date(data.verifiedAt._seconds * 1000);
        else if (data.verifiedAt instanceof Date) verifiedDate = data.verifiedAt;
      }
      
      let methodName = '';
      if (data.method === 'sham_cash') methodName = 'شام كاش';
      else if (data.method === 'sham_cash_usd') methodName = 'شام كاش (دولار)';
      else if (data.method === 'syriatel_cash') methodName = 'سيرياتيل كاش';
      else methodName = data.method;
      
      deposits.push({
        id: doc.id,
        userId: data.userId,
        userEmail: userDoc.exists ? userDoc.data().email : null,
        userName: userDoc.exists ? userDoc.data().name : null,
        amount: data.amount,
        method: methodName,
        originalAmount: data.originalAmount,
        originalCurrency: data.originalCurrency,
        transactionId: data.transactionId,
        verifiedAt: verifiedDate
      });
    }
    
    res.json({ success: true, deposits });
  } catch (error) {
    console.error('Get deposits admin error:', error);
    res.status(500).json({ error: 'خطأ في جلب الإيداعات' });
  }
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const cached = getCached('admin_users');
  if (cached) return res.json({ success: true, users: cached });
  
  try {
    const snapshot = await db.collection('users').orderBy('createdAt', 'desc').get();
    const users = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      users.push({
        id: doc.id,
        email: data.email,
        name: data.name,
        uniqueId: data.uniqueId,
        balance: data.balance,
        isBanned: data.isBanned || false,
        referredBy: data.referredBy,
        referredByName: data.referredByName,
        referralEarnings: data.referralEarnings || 0,
        referralsCount: data.referrals?.length || 0,
        totalDeposited: data.totalDeposited || 0,
        totalWithdrawn: data.totalWithdrawn || 0,
        createdAt: data.createdAt?.toDate(),
        lastLogin: data.lastLogin?.toDate()
      });
    });
    
    setCache('admin_users', users, 60);
    res.json({ success: true, users });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'خطأ في جلب المستخدمين' });
  }
});

app.post('/api/admin/update-balance', requireAdmin, async (req, res) => {
  try {
    const { userId, amount, reason } = req.body;
    await db.collection('users').doc(userId).update({
      balance: admin.firestore.FieldValue.increment(Number(amount))
    });
    
    await db.collection('balance_logs').add({
      userId,
      amount: Number(amount),
      reason: reason || 'تعديل يدوي من الأدمن',
      adminEmail: req.user.email,
      createdAt: new Date()
    });
    
    cache.delete('admin_users');
    cache.delete('admin_dashboard');
    
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
    
    cache.delete('admin_users');
    
    res.json({ success: true, isBanned: !currentBan });
  } catch (error) {
    console.error('Toggle ban error:', error);
    res.status(500).json({ error: 'فشل تحديث حالة الحظر' });
  }
});

app.get('/api/admin/referral-stats', requireAdmin, async (req, res) => {
  try {
    const commissionsSnapshot = await db.collection('referral_commissions')
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();
    
    const commissions = [];
    for (const doc of commissionsSnapshot.docs) {
      const data = doc.data();
      const fromUser = await db.collection('users').doc(data.fromUserId).get();
      commissions.push({
        id: doc.id,
        fromUserName: fromUser.exists ? fromUser.data().name : null,
        fromUserEmail: fromUser.exists ? fromUser.data().email : null,
        amount: data.amount,
        depositAmount: data.depositAmount,
        percent: data.percent,
        createdAt: data.createdAt?.toDate()
      });
    }
    
    res.json({ success: true, commissions });
  } catch (error) {
    console.error('Referral stats error:', error);
    res.status(500).json({ error: 'خطأ في جلب إحصائيات الإحالات' });
  }
});

// ============= نقطة صحة الخادم =============
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date(), 
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    cacheSize: cache.size
  });
});

// ============= تشغيل الخادم =============
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ BOOMB Server running on port ${PORT}`);
  console.log(`📍 Admin: ${ADMIN_EMAIL}`);
  console.log(`🚀 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`💾 Cache size: ${cache.size}`);
});
