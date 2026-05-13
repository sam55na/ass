
# Let's create the COMPLETE improved server.js with all features

server_code = r'''import express from 'express';
import admin from 'firebase-admin';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import axios from 'axios';
import helmet from 'helmet';

// ============= تهيئة Firebase =============
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID || "boomb-fa3e7",
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
  projectId: process.env.FIREBASE_PROJECT_ID || "boomb-fa3e7"
});

const db = admin.firestore();
const app = express();

// ============= إعدادات الأمان المحسنة =============
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "https://www.gstatic.com", "https://www.google.com"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "https://*.googleapis.com", "https://*.onrender.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      frameSrc: ["'self'", "https://*.firebaseapp.com"],
    }
  }
}));

app.use(express.json({ limit: '10mb' }));

// ✅ CORS محسّن
const allowedOrigins = [
  'https://sam55na.github.io',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ============= Rate Limiting منفصل ومتقدم =============
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'الرجاء الانتظار دقيقة', retryAfter: 60 }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'محاولات كثيرة، الرجاء الانتظار 15 دقيقة', retryAfter: 900 }
});

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'الرجاء الانتظار', retryAfter: 60 }
});

const depositLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  message: { error: 'الرجاء الانتظار 5 دقائق بين كل إيداع', retryAfter: 300 }
});

app.use('/api/user/register', authLimiter);
app.use('/api/user/deposit', depositLimiter);
app.use('/api/user/withdraw', authLimiter);
app.use('/api/admin/', adminLimiter);
app.use('/api/', generalLimiter);

// ============= متغيرات البيئة =============
const RESET_PASSWORD = process.env.RESET_PASSWORD;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'sam55nam@gmail.com';

// ============= دوال مساعدة =============
function generateUniqueId() {
  return Math.floor(1000000000 + Math.random() * 9000000000).toString();
}

function getMethodName(method) {
  const names = {
    'sham_cash': 'شام كاش (ليرة)',
    'sham_cash_usd': 'شام كاش (دولار)',
    'syriatel_cash': 'سيرياتيل كاش'
  };
  return names[method] || method;
}

// ============= Middleware المصادقة =============
const requireAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) {
    return res.status(401).json({ error: 'غير مصرح - الرجاء تسجيل الدخول' });
  }
  try {
    req.user = await admin.auth().verifyIdToken(token);
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (userDoc.exists && userDoc.data().isBanned) {
      return res.status(403).json({ error: 'تم حظر حسابك', code: 'BANNED' });
    }
    next();
  } catch (error) {
    console.error('Auth error:', error.message);
    res.status(401).json({ error: 'جلسة غير صالحة', code: 'INVALID_TOKEN' });
  }
};

const requireAdmin = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) {
    return res.status(401).json({ error: 'غير مصرح', code: 'NO_TOKEN' });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    if (decoded.email !== ADMIN_EMAIL) {
      return res.status(403).json({ error: 'غير مصرح - هذه المنطقة للمشرف فقط', code: 'NOT_ADMIN' });
    }
    req.user = decoded;
    next();
  } catch (error) {
    console.error('Admin auth error:', error.message);
    res.status(401).json({ error: 'جلسة غير صالحة', code: 'INVALID_TOKEN' });
  }
};

// ============= إعدادات النظام =============
async function getSettings() {
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
      themeColor: '#ff0000',
      maintenanceMode: false
    };
    await db.collection('settings').doc('config').set(defaultSettings);
    return defaultSettings;
  } catch (error) {
    console.error('Error getting settings:', error.message);
    return {
      minDeposit: 1000,
      minWithdraw: 5000,
      shamCashEnabled: true,
      syriatelEnabled: true,
      shamCashUsdEnabled: false,
      usdToSypRate: 13000,
      referralCommission: 5,
      gameImageUrl: '',
      themeColor: '#ff0000'
    };
  }
}

// ============= كلاسات التحقق من الدفع =============
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
              return { success: false, message: "العملية أقدم من 24 ساعة", code: 'OLD_TRANSACTION' };
            }
            if (expectedAmount && Math.abs(apiAmount - expectedAmount) > 0.01) {
              return { success: false, message: `المبلغ غير متطابق: المبلغ الفعلي ${apiAmount}`, code: 'AMOUNT_MISMATCH' };
            }
            return { success: true, amount: apiAmount, currency: item.currency || "SYP" };
          }
        }
        return { success: false, message: "رقم العملية غير موجود", code: 'TX_NOT_FOUND' };
      }
      return { success: false, message: "فشل التحقق من العملية", code: 'API_ERROR' };
    } catch (error) {
      console.error('ShamCash verification error:', error.message);
      return { success: false, message: "خطأ في الاتصال بخدمة شام كاش", code: 'CONNECTION_ERROR' };
    }
  }
}

class SyriatelCashClient {
  constructor(apiKey, gsmNumbers) {
    this.apiKey = apiKey;
    this.gsmNumbers = Array.isArray(gsmNumbers) ? gsmNumbers : [gsmNumbers];
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
            return { success: false, message: "المبلغ غير متطابق", code: 'AMOUNT_MISMATCH' };
          }
          return { success: true, amount: apiAmount, currency: "SYP" };
        }
      } catch (error) {
        console.error(`Syriatel error for GSM ${gsm}:`, error.message);
      }
    }
    return { success: false, message: "رقم العملية غير موجود", code: 'TX_NOT_FOUND' };
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
              return { success: false, message: "العملية أقدم من 24 ساعة", code: 'OLD_TRANSACTION' };
            }
            if (expectedAmount && Math.abs(apiAmount - expectedAmount) > 0.01) {
              return { success: false, message: `المبلغ غير متطابق: المبلغ الفعلي ${apiAmount}`, code: 'AMOUNT_MISMATCH' };
            }
            return { success: true, amount: apiAmount, currency: "USD" };
          }
        }
        return { success: false, message: "رقم العملية غير موجود", code: 'TX_NOT_FOUND' };
      }
      return { success: false, message: "فشل التحقق من العملية", code: 'API_ERROR' };
    } catch (error) {
      console.error('ShamCash USD verification error:', error.message);
      return { success: false, message: "خطأ في الاتصال بخدمة شام كاش", code: 'CONNECTION_ERROR' };
    }
  }
}

// ============= دالة عمولة الإحالة =============
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
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    }
  } catch (error) {
    console.error('Error adding referral commission:', error.message);
  }
}

// ============= API المستخدمين =============
app.post('/api/user/register', requireAuth, async (req, res) => {
  try {
    const { uid, email, name } = req.user;
    const { referrerId } = req.body;
    
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
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      isBanned: false
    };
    await userRef.set(newUser);
    
    res.json({ success: true, user: newUser, isAdmin: email === ADMIN_EMAIL });
  } catch (error) {
    console.error('Register error:', error.message);
    res.status(500).json({ error: 'خطأ في التسجيل', code: 'REGISTER_ERROR' });
  }
});

app.get('/api/user/profile', requireAuth, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'مستخدم غير موجود', code: 'USER_NOT_FOUND' });
    }
    res.json({ success: true, user: userDoc.data(), isAdmin: req.user.email === ADMIN_EMAIL });
  } catch (error) {
    console.error('Profile error:', error.message);
    res.status(500).json({ error: 'خطأ في جلب البيانات', code: 'PROFILE_ERROR' });
  }
});

app.get('/api/user/stats', requireAuth, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'مستخدم غير موجود', code: 'USER_NOT_FOUND' });
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
        balance: data.balance || 0,
        totalDeposited: data.totalDeposited || 0,
        totalWithdrawn: data.totalWithdrawn || 0,
        uniqueId: data.uniqueId,
        joinDate: data.createdAt,
        referredBy: data.referredBy,
        referredByName: data.referredByName,
        referrerInfo: referrerInfo
      }
    });
  } catch (error) {
    console.error('Stats error:', error.message);
    res.status(500).json({ error: 'خطأ في جلب الإحصائيات', code: 'STATS_ERROR' });
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
        name: 'شام كاش (ليرة)',
        address: settings.shamCashPublicAddress,
        type: 'sham_cash',
        currency: 'SYP'
      });
    }
    
    if (settings.shamCashUsdEnabled && settings.shamCashUsdPublicAddress) {
      methods.push({
        id: 'sham_cash_usd',
        name: 'شام كاش (دولار)',
        address: settings.shamCashUsdPublicAddress,
        type: 'sham_cash_usd',
        currency: 'USD',
        exchangeRate: settings.usdToSypRate || 13000
      });
    }
    
    if (settings.syriatelEnabled && settings.syriatelPublicAddress) {
      methods.push({
        id: 'syriatel_cash',
        name: 'سيرياتيل كاش',
        address: settings.syriatelPublicAddress,
        type: 'syriatel_cash',
        currency: 'SYP'
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
        themeColor: settings.themeColor || '#ff0000'
      }
    });
  } catch (error) {
    console.error('Deposit settings error:', error.message);
    res.status(500).json({ error: 'خطأ في جلب الإعدادات', code: 'SETTINGS_ERROR' });
  }
});

app.post('/api/user/deposit', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { method, amount, transactionId } = req.body;
    
    if (!method || !amount || !transactionId) {
      return res.status(400).json({ error: 'جميع الحقول مطلوبة', code: 'MISSING_FIELDS' });
    }
    
    if (!/^[a-zA-Z0-9_-]{5,100}$/.test(transactionId)) {
      return res.status(400).json({ error: 'رقم العملية غير صالح', code: 'INVALID_TXID' });
    }
    
    let amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: 'المبلغ غير صالح', code: 'INVALID_AMOUNT' });
    }
    
    const settings = await getSettings();
    let verification = null;
    let finalAmountSYP = amountNum;
    let currency = 'SYP';
    
    if (method === 'sham_cash') {
      if (!settings.shamCashEnabled) {
        return res.status(400).json({ error: 'طريقة الدفع شام كاش غير مفعلة', code: 'METHOD_DISABLED' });
      }
      if (!settings.shamCashApiKey || !settings.shamCashPrivateAddress) {
        return res.status(400).json({ error: 'بيانات شام كاش غير مكتملة', code: 'INCOMPLETE_CONFIG' });
      }
      const client = new ShamCashClient(settings.shamCashApiKey, settings.shamCashPrivateAddress);
      verification = await client.verifyTransaction(transactionId, amountNum);
      if (verification.success) {
        finalAmountSYP = verification.amount;
        currency = verification.currency || 'SYP';
      }
      
    } else if (method === 'sham_cash_usd') {
      if (!settings.shamCashUsdEnabled) {
        return res.status(400).json({ error: 'طريقة الدفع شام كاش دولار غير مفعلة', code: 'METHOD_DISABLED' });
      }
      if (!settings.shamCashUsdApiKey || !settings.shamCashUsdPrivateAddress) {
        return res.status(400).json({ error: 'بيانات شام كاش دولار غير مكتملة', code: 'INCOMPLETE_CONFIG' });
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
        return res.status(400).json({ error: 'طريقة الدفع سيرياتيل كاش غير مفعلة', code: 'METHOD_DISABLED' });
      }
      if (!settings.syriatelApiKey || !settings.syriatelPrivateAddress) {
        return res.status(400).json({ error: 'بيانات سيرياتيل كاش غير مكتملة', code: 'INCOMPLETE_CONFIG' });
      }
      const client = new SyriatelCashClient(settings.syriatelApiKey, [settings.syriatelPrivateAddress]);
      verification = await client.verifyTransaction(transactionId, amountNum);
      if (verification.success) {
        finalAmountSYP = verification.amount;
        currency = verification.currency || 'SYP';
      }
    } else {
      return res.status(400).json({ error: 'طريقة دفع غير مدعومة', code: 'UNSUPPORTED_METHOD' });
    }
    
    if (!verification.success) {
      return res.status(400).json({ error: verification.message, code: verification.code || 'VERIFICATION_FAILED' });
    }
    
    if (finalAmountSYP < settings.minDeposit) {
      return res.status(400).json({ error: `الحد الأدنى للإيداع ${settings.minDeposit} SYP`, code: 'BELOW_MINIMUM' });
    }
    
    const existing = await db.collection('deposits')
      .where('transactionId', '==', transactionId)
      .limit(1)
      .get();
      
    if (!existing.empty) {
      return res.status(400).json({ error: 'تم استخدام رقم العملية مسبقاً', code: 'DUPLICATE_TX' });
    }
    
    await db.runTransaction(async (transaction) => {
      const userRef = db.collection('users').doc(uid);
      transaction.update(userRef, {
        balance: admin.firestore.FieldValue.increment(finalAmountSYP),
        totalDeposited: admin.firestore.FieldValue.increment(finalAmountSYP)
      });
      
      const depositRef = db.collection('deposits').doc();
      transaction.set(depositRef, {
        userId: uid,
        method,
        amount: finalAmountSYP,
        originalAmount: verification.amount,
        originalCurrency: currency,
        transactionId,
        status: 'completed',
        verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
        exchangeRate: method === 'sham_cash_usd' ? settings.usdToSypRate : null
      });
    });
    
    await addReferralCommission(uid, finalAmountSYP);
    
    const updatedUser = await db.collection('users').doc(uid).get();
    res.json({ 
      success: true, 
      message: `تم إيداع ${finalAmountSYP} SYP بنجاح`,
      newBalance: updatedUser.data().balance
    });
    
  } catch (error) {
    console.error('Deposit error:', error.message);
    res.status(500).json({ error: 'حدث خطأ داخلي في الخادم', code: 'DEPOSIT_ERROR' });
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
      
      deposits.push({
        id: doc.id,
        amount: data.amount || 0,
        method: getMethodName(data.method),
        originalAmount: data.originalAmount,
        originalCurrency: data.originalCurrency,
        transactionId: data.transactionId || 'N/A',
        verifiedAt: verifiedDate,
        status: data.status || 'completed'
      });
    });
    
    res.json({ success: true, deposits });
  } catch (error) {
    console.error('Get deposits error:', error.message);
    res.json({ success: true, deposits: [] });
  }
});

// ============= API إضافة كود إحالة =============
app.post('/api/user/add-referrer', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { referrerCode } = req.body;
    
    if (!referrerCode) {
      return res.status(400).json({ error: 'كود الإحالة مطلوب', code: 'MISSING_CODE' });
    }
    
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    const userData = userDoc.data();
    
    if (userData.referredBy) {
      return res.status(400).json({ error: 'لديك محيل بالفعل', code: 'ALREADY_REFERRED' });
    }
    
    const referrerQuery = await db.collection('users').where('uniqueId', '==', referrerCode).limit(1).get();
    
    if (referrerQuery.empty) {
      return res.status(404).json({ error: 'كود الإحالة غير صحيح', code: 'INVALID_CODE' });
    }
    
    const referrerDoc = referrerQuery.docs[0];
    const referrerId = referrerDoc.id;
    
    if (referrerId === uid) {
      return res.status(400).json({ error: 'لا يمكنك إحالة نفسك', code: 'SELF_REFERRAL' });
    }
    
    await userRef.update({
      referredBy: referrerId,
      referredByName: referrerDoc.data().name
    });
    
    await referrerDoc.ref.update({
      referralEarnings: admin.firestore.FieldValue.increment(5),
      referrals: admin.firestore.FieldValue.arrayUnion(uid)
    });
    
    res.json({ 
      success: true, 
      message: `تم إضافة المحيل بنجاح: ${referrerDoc.data().name}`,
      referrerName: referrerDoc.data().name
    });
    
  } catch (error) {
    console.error('Add referrer error:', error.message);
    res.status(500).json({ error: 'حدث خطأ في إضافة كود الإحالة', code: 'REFERRAL_ERROR' });
  }
});

// ============= API السحب (محسّن بـ Transaction) =============
app.post('/api/user/withdraw', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { amount, address, method } = req.body;
    
    if (!amount || !address) {
      return res.status(400).json({ error: 'المبلغ والعنوان مطلوبان', code: 'MISSING_FIELDS' });
    }
    
    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: 'المبلغ غير صالح', code: 'INVALID_AMOUNT' });
    }
    
    const settings = await getSettings();
    
    if (amountNum < settings.minWithdraw) {
      return res.status(400).json({ error: `الحد الأدنى للسحب ${settings.minWithdraw} SYP`, code: 'BELOW_MINIMUM' });
    }
    
    const result = await db.runTransaction(async (transaction) => {
      const userRef = db.collection('users').doc(uid);
      const userDoc = await transaction.get(userRef);
      
      if (!userDoc.exists) {
        throw new Error('مستخدم غير موجود');
      }
      
      const userData = userDoc.data();
      
      if (userData.balance < amountNum) {
        throw new Error('الرصيد غير كافٍ');
      }
      
      const newBalance = userData.balance - amountNum;
      
      transaction.update(userRef, {
        balance: newBalance,
        totalWithdrawn: admin.firestore.FieldValue.increment(amountNum)
      });
      
      const withdrawRef = db.collection('withdraw_requests').doc();
      transaction.set(withdrawRef, {
        userId: uid,
        userEmail: userData.email,
        userName: userData.name,
        amount: amountNum,
        address: address,
        method: method || 'sham_cash',
        status: 'pending',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        previousBalance: userData.balance,
        newBalance
      });
      
      return { newBalance, withdrawId: withdrawRef.id };
    });
    
    res.json({
      success: true,
      message: `تم إنشاء طلب سحب بمبلغ ${amountNum} SYP، قيد المراجعة`,
      newBalance: result.newBalance
    });
    
  } catch (error) {
    console.error('Withdraw error:', error.message);
    res.status(400).json({ error: error.message || 'فشل إنشاء طلب السحب', code: 'WITHDRAW_ERROR' });
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
      
      requests.push({
        id: doc.id,
        amount: data.amount || 0,
        address: data.address || 'N/A',
        method: data.method || 'unknown',
        status: data.status || 'pending',
        createdAt: createdDate
      });
    });
    
    res.json({ success: true, requests });
  } catch (error) {
    console.error('Get withdraw requests error:', error.message);
    res.json({ success: true, requests: [] });
  }
});

// ============= API تهيئة قاعدة البيانات =============
app.post('/api/admin/reset-database', requireAdmin, async (req, res) => {
  try {
    const { password } = req.body;
    
    if (!RESET_PASSWORD) {
      return res.status(500).json({ error: 'لم يتم تكوين كلمة المرور', code: 'NOT_CONFIGURED' });
    }
    
    if (password !== RESET_PASSWORD) {
      return res.status(403).json({ error: 'كلمة المرور غير صحيحة', code: 'WRONG_PASSWORD' });
    }
    
    const usersSnapshot = await db.collection('users').get();
    const usersDeletions = [];
    usersSnapshot.forEach(doc => usersDeletions.push(db.collection('users').doc(doc.id).delete()));
    await Promise.all(usersDeletions);
    
    const withdrawsSnapshot = await db.collection('withdraw_requests').get();
    const withdrawsDeletions = [];
    withdrawsSnapshot.forEach(doc => withdrawsDeletions.push(db.collection('withdraw_requests').doc(doc.id).delete()));
    await Promise.all(withdrawsDeletions);
    
    const depositsSnapshot = await db.collection('deposits').get();
    const depositsDeletions = [];
    depositsSnapshot.forEach(doc => depositsDeletions.push(db.collection('deposits').doc(doc.id).delete()));
    await Promise.all(depositsDeletions);
    
    const commissionsSnapshot = await db.collection('referral_commissions').get();
    const commissionsDeletions = [];
    commissionsSnapshot.forEach(doc => commissionsDeletions.push(db.collection('referral_commissions').doc(doc.id).delete()));
    await Promise.all(commissionsDeletions);
    
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
      themeColor: '#ff0000'
    };
    await db.collection('settings').doc('config').set(defaultSettings);
    
    res.json({ 
      success: true, 
      message: 'تم تهيئة قاعدة البيانات بنجاح',
      deleted: {
        users: usersDeletions.length,
        withdraws: withdrawsDeletions.length,
        deposits: depositsDeletions.length,
        commissions: commissionsDeletions.length
      }
    });
    
  } catch (error) {
    console.error('Reset error:', error.message);
    res.status(500).json({ error: 'فشل تهيئة قاعدة البيانات', code: 'RESET_ERROR' });
  }
});

// ============= APIs الأدمن =============
app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({ success: true, settings });
  } catch (error) {
    console.error('Get admin settings error:', error.message);
    res.status(500).json({ error: 'خطأ في جلب الإعدادات', code: 'SETTINGS_ERROR' });
  }
});

app.post('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const updates = req.body;
    await db.collection('settings').doc('config').update(updates);
    res.json({ success: true, message: 'تم تحديث الإعدادات' });
  } catch (error) {
    console.error('Save admin settings error:', error.message);
    res.status(500).json({ error: 'فشل تحديث الإعدادات', code: 'SAVE_ERROR' });
  }
});

app.get('/api/admin/dashboard', requireAdmin, async (req, res) => {
  try {
    const usersSnapshot = await db.collection('users').get();
    const users = [];
    usersSnapshot.forEach(doc => users.push(doc.data()));
    
    const totalBalance = users.reduce((s, u) => s + (u.balance || 0), 0);
    const totalDeposited = users.reduce((s, u) => s + (u.totalDeposited || 0), 0);
    const totalWithdrawn = users.reduce((s, u) => s + (u.totalWithdrawn || 0), 0);
    
    const pendingSnapshot = await db.collection('withdraw_requests').where('status', '==', 'pending').get();
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const newToday = users.filter(u => {
      if (!u.createdAt) return false;
      const date = u.createdAt.toDate ? u.createdAt.toDate() : u.createdAt;
      return date > today;
    }).length;
    
    res.json({
      success: true,
      stats: {
        totalUsers: usersSnapshot.size,
        newToday,
        totalBalance,
        totalDeposited,
        totalWithdrawn,
        pendingWithdrawals: pendingSnapshot.size
      }
    });
  } catch (error) {
    console.error('Dashboard error:', error.message);
    res.status(500).json({ error: 'خطأ في جلب الإحصائيات', code: 'DASHBOARD_ERROR' });
  }
});

app.get('/api/admin/withdraw-requests', requireAdmin, async (req, res) => {
  try {
    const { status = 'all' } = req.query;
    let query = db.collection('withdraw_requests').orderBy('createdAt', 'desc');
    if (status !== 'all') query = query.where('status', '==', status);
    
    const snapshot = await query.get();
    const requests = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      
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
        amount: data.amount,
        address: data.address,
        status: data.status,
        createdAt: createdDate
      });
    });
    
    res.json({ success: true, requests });
  } catch (error) {
    console.error('Get withdraw requests error:', error.message);
    res.status(500).json({ error: 'خطأ في جلب الطلبات', code: 'FETCH_ERROR' });
  }
});

app.post('/api/admin/process-withdraw', requireAdmin, async (req, res) => {
  try {
    const { requestId, action } = req.body;
    
    const requestRef = db.collection('withdraw_requests').doc(requestId);
    const requestDoc = await requestRef.get();
    
    if (!requestDoc.exists) {
      return res.status(404).json({ error: 'طلب غير موجود', code: 'NOT_FOUND' });
    }
    
    const request = requestDoc.data();
    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'تم معالجة هذا الطلب مسبقاً', code: 'ALREADY_PROCESSED' });
    }
    
    if (action === 'reject') {
      await db.collection('users').doc(request.userId).update({
        balance: admin.firestore.FieldValue.increment(request.amount)
      });
    }
    
    await requestRef.update({
      status: action === 'approve' ? 'approved' : 'rejected',
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
      processedBy: req.user.email
    });
    
    res.json({ success: true, message: `تم ${action === 'approve' ? 'قبول' : 'رفض'} الطلب` });
  } catch (error) {
    console.error('Process withdraw error:', error.message);
    res.status(500).json({ error: 'فشل معالجة الطلب', code: 'PROCESS_ERROR' });
  }
});

app.get('/api/admin/deposits', requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('deposits')
      .orderBy('verifiedAt', 'desc')
      .limit(100)
      .get();
    
    const userIds = [...new Set(snapshot.docs.map(d => d.data().userId))];
    const userRefs = userIds.map(id => db.collection('users').doc(id));
    const userDocs = userRefs.length > 0 ? await db.getAll(...userRefs) : [];
    const usersMap = new Map(userDocs.map(d => [d.id, d.data()]));
    
    const deposits = snapshot.docs.map(doc => {
      const data = doc.data();
      const userData = usersMap.get(data.userId);
      
      let verifiedDate = null;
      if (data.verifiedAt) {
        if (data.verifiedAt.toDate) verifiedDate = data.verifiedAt.toDate();
        else if (data.verifiedAt._seconds) verifiedDate = new Date(data.verifiedAt._seconds * 1000);
        else if (data.verifiedAt instanceof Date) verifiedDate = data.verifiedAt;
      }
      
      return {
        id: doc.id,
        userId: data.userId,
        userEmail: userData?.email,
        userName: userData?.name,
        amount: data.amount,
        method: getMethodName(data.method),
        originalAmount: data.originalAmount,
        originalCurrency: data.originalCurrency,
        transactionId: data.transactionId,
        verifiedAt: verifiedDate
      };
    });
    
    res.json({ success: true, deposits });
  } catch (error) {
    console.error('Get deposits admin error:', error.message);
    res.status(500).json({ error: 'خطأ في جلب الإيداعات', code: 'FETCH_ERROR' });
  }
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const { limit = 50, search = '' } = req.query;
    
    let query = db.collection('users').orderBy('createdAt', 'desc');
    
    const snapshot = await query.limit(Number(limit)).get();
    const users = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      users.push({
        id: doc.id,
        email: data.email,
        name: data.name,
        uniqueId: data.uniqueId,
        balance: data.balance || 0,
        isBanned: data.isBanned || false,
        referredBy: data.referredBy,
        referredByName: data.referredByName,
        referralEarnings: data.referralEarnings || 0,
        referralsCount: data.referrals?.length || 0
      });
    });
    
    const filteredUsers = search 
      ? users.filter(u => 
          u.email?.toLowerCase().includes(search.toLowerCase()) || 
          u.name?.toLowerCase().includes(search.toLowerCase())
        )
      : users;
    
    res.json({ success: true, users: filteredUsers, total: filteredUsers.length });
  } catch (error) {
    console.error('Get users error:', error.message);
    res.status(500).json({ error: 'خطأ في جلب المستخدمين', code: 'FETCH_ERROR' });
  }
});

app.post('/api/admin/update-balance', requireAdmin, async (req, res) => {
  try {
    const { userId, amount, reason } = req.body;
    if (!userId || amount === undefined) {
      return res.status(400).json({ error: 'جميع الحقول مطلوبة', code: 'MISSING_FIELDS' });
    }
    await db.collection('users').doc(userId).update({
      balance: admin.firestore.FieldValue.increment(Number(amount))
    });
    res.json({ success: true, message: 'تم تحديث الرصيد' });
  } catch (error) {
    console.error('Update balance error:', error.message);
    res.status(500).json({ error: 'فشل تحديث الرصيد', code: 'UPDATE_ERROR' });
  }
});

app.post('/api/admin/toggle-ban', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'معرف المستخدم مطلوب', code: 'MISSING_USER_ID' });
    }
    const userDoc = await db.collection('users').doc(userId).get();
    const currentBan = userDoc.data()?.isBanned || false;
    await db.collection('users').doc(userId).update({ isBanned: !currentBan });
    res.json({ success: true, isBanned: !currentBan });
  } catch (error) {
    console.error('Toggle ban error:', error.message);
    res.status(500).json({ error: 'فشل تحديث حالة الحظر', code: 'BAN_ERROR' });
  }
});

// ============= نقطة صحة الخادم =============
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date(), 
    uptime: process.uptime(),
    version: '2.0.0'
  });
});

// ============= تشغيل الخادم =============
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ BOOMB Server v2.0 running on port ${PORT}`);
  console.log(`📍 Admin: ${ADMIN_EMAIL}`);
  console.log(`🔒 Security: Helmet + CORS + Rate Limiting enabled`);
});
'''

with open('/mnt/agents/output/server.js', 'w', encoding='utf-8') as f:
    f.write(server_code)

print(f"✅ Server code saved: {len(server_code)} chars")
