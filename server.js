import express from 'express';
import admin from 'firebase-admin';
import cors from 'cors';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import axios from 'axios';

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

// ============= إعدادات الأمان =============
app.use(cors({
  origin: [
    'https://sam55na.github.io',
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
  ],
  credentials: true
}));
app.use(express.json());
app.use(express.static('.'));

// ============= إعدادات الجلسة =============
app.use(session({
  secret: 'boomb_secret_key_2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, secure: false }
}));

// ============= منع التكرار =============
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: 'الرجاء الانتظار دقيقة'
});
app.use('/api/', limiter);

// ============= دوال مساعدة =============
function generateUniqueId() {
  return Math.floor(1000000000 + Math.random() 9000000000).toString();
}

const ADMIN_EMAIL = 'sam55nam@gmail.com';

const requireAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'غير مصرح', code: 'NO_TOKEN' });
  try {
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch (error) {
    res.status(401).json({ error: 'جلسة غير صالحة', code: 'INVALID_TOKEN' });
  }
};

const requireAdmin = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'غير مصرح', code: 'NO_TOKEN' });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    if (decoded.email !== ADMIN_EMAIL) {
      return res.status(403).json({ error: 'ليس لديك صلاحيات أدمن', code: 'FORBIDDEN' });
    }
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: 'جلسة غير صالحة', code: 'INVALID_TOKEN' });
  }
};

// ============= إعدادات النظام =============
async function getSystemSettings() {
  const settingsRef = db.collection('system_settings').doc('config');
  const doc = await settingsRef.get();
  if (doc.exists) return doc.data();
  
  const defaultSettings = {
    minDeposit: 1000,
    minWithdraw: 5000,
    siteColors: {
      primary: '#ff0000',
      primaryDark: '#cc0000',
      primaryLight: '#ff3333',
      background: '#0a0a0a',
      text: '#ffffff',
      textSecondary: '#aaaaaa',
      surface: '#121212',
      surfaceLight: '#1e1e1e',
      border: '#333333',
      error: '#ff4444',
      success: '#00cc44'
    },
    paymentAddresses: [],
    shamCashApiKey: '',
    syriatelApiKey: ''
  };
  await settingsRef.set(defaultSettings);
  return defaultSettings;
}

async function updateSystemSettings(updates) {
  const settingsRef = db.collection('system_settings').doc('config');
  await settingsRef.update(updates);
  return await getSystemSettings();
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
      return { success: false, message: error.message };
    }
  }
}

// ============= كلاس سيرياتيل كاش =============
class SyriatelCashClient {
  constructor(apiKey, gsmNumbers) {
    this.apiKey = apiKey;
    this.gsmNumbers = gsmNumbers;
    this.baseUrl = "https://apisyria.com/api/v1";
  }

  async verifyTransaction(txid, expectedAmount = null) {
    for (const gsm of this.gsmNumbers) {
      try {
        const params = { api_key: this.apiKey, resource: "syriatel", action: "find_tx", tx: txid, gsm: gsm };
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
        console.error(`Syriatel error for ${gsm}:`, error.message);
      }
    }
    return { success: false, message: "رقم العملية غير موجود" };
  }
}

// ============= API المستخدمين =============
app.post('/api/user/register', requireAuth, async (req, res) => {
  try {
    const { uid, email, name, picture } = req.user;
    const { referrerId } = req.body;
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    
    if (userDoc.exists) {
      return res.json({ success: true, user: userDoc.data(), isAdmin: email === ADMIN_EMAIL });
    }
    
    const newUser = {
      uniqueId: generateUniqueId(),
      email, name: name || email.split('@')[0],
      photoURL: picture || null, balance: 0, totalDeposited: 0, totalWithdrawn: 0,
      referralEarnings: 0, referredBy: referrerId || null, referrals: [],
      createdAt: new Date(), lastActive: new Date(), isBanned: false
    };
    await userRef.set(newUser);
    
    if (referrerId) {
      const refQuery = await db.collection('users').where('uniqueId', '==', referrerId).limit(1).get();
      if (!refQuery.empty) {
        await refQuery.docs[0].ref.update({
          referralEarnings: admin.firestore.FieldValue.increment(5),
          referrals: admin.firestore.FieldValue.arrayUnion(uid)
        });
      }
    }
    res.json({ success: true, user: newUser, isAdmin: email === ADMIN_EMAIL });
  } catch (error) {
    res.status(500).json({ error: 'خطأ في التسجيل' });
  }
});

app.get('/api/user/profile', requireAuth, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'مستخدم غير موجود' });
    res.json({ success: true, user: userDoc.data(), isAdmin: req.user.email === ADMIN_EMAIL });
  } catch (error) {
    res.status(500).json({ error: 'خطأ في جلب البيانات' });
  }
});

app.get('/api/user/stats', requireAuth, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    const data = userDoc.data();
    res.json({
      success: true, stats: {
        referralCount: data.referrals?.length || 0,
        totalReferralEarnings: data.referralEarnings || 0,
        balance: data.balance || 0, totalDeposited: data.totalDeposited || 0,
        totalWithdrawn: data.totalWithdrawn || 0, uniqueId: data.uniqueId, joinDate: data.createdAt
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'خطأ في جلب الإحصائيات' });
  }
});

// ============= API الإيداع =============
app.get('/api/user/deposit-settings', requireAuth, async (req, res) => {
  try {
    const settings = await getSystemSettings();
    const activeAddresses = (settings.paymentAddresses || []).filter(a => a.isActive).map(a => ({
      id: a.id, name: a.name, address: a.privateAddress || a.address,
      publicAddress: a.publicAddress || a.address, type: a.type
    }));
    res.json({
      success: true, settings: {
        minDeposit: settings.minDeposit, minWithdraw: settings.minWithdraw,
        paymentAddresses: activeAddresses, siteColors: settings.siteColors
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'خطأ في جلب الإعدادات' });
  }
});

app.post('/api/user/deposit', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { addressId, amount, transactionId } = req.body;
    if (!addressId || !amount || !transactionId) {
      return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
    }
    
    const settings = await getSystemSettings();
    const selectedAddress = settings.paymentAddresses?.find(a => a.id === addressId && a.isActive);
    if (!selectedAddress) return res.status(400).json({ error: 'طريقة الدفع غير متاحة' });
    if (amount < settings.minDeposit) {
      return res.status(400).json({ error: `الحد الأدنى للإيداع ${settings.minDeposit} SYP` });
    }
    
    let verification;
    const privateAddress = selectedAddress.privateAddress || selectedAddress.address;
    
    if (selectedAddress.type === 'sham_cash') {
      if (!settings.shamCashApiKey) return res.status(400).json({ error: 'بيانات شام كاش غير مكتملة' });
      const client = new ShamCashClient(settings.shamCashApiKey, privateAddress);
      verification = await client.verifyTransaction(transactionId, amount);
    } else {
      if (!settings.syriatelApiKey) return res.status(400).json({ error: 'بيانات سيرياتيل كاش غير مكتملة' });
      const client = new SyriatelCashClient(settings.syriatelApiKey, [privateAddress]);
      verification = await client.verifyTransaction(transactionId, amount);
    }
    
    if (!verification.success) return res.status(400).json({ error: verification.message });
    
    const existing = await db.collection('deposits').where('transactionId', '==', transactionId).limit(1).get();
    if (!existing.empty) return res.status(400).json({ error: 'تم استخدام رقم العملية مسبقاً' });
    
    const userRef = db.collection('users').doc(uid);
    await userRef.update({
      balance: admin.firestore.FieldValue.increment(verification.amount),
      totalDeposited: admin.firestore.FieldValue.increment(verification.amount)
    });
    
    await db.collection('deposits').add({
      userId: uid, addressId, addressName: selectedAddress.name,
      transactionId, amount: verification.amount, status: 'completed', verifiedAt: new Date()
    });
    
    const updated = await userRef.get();
    res.json({ success: true, message: `تم إيداع ${verification.amount} SYP`, newBalance: updated.data().balance });
  } catch (error) {
    console.error('Deposit error:', error);
    res.status(500).json({ error: 'حدث خطأ داخلي' });
  }
});

app.get('/api/user/deposits', requireAuth, async (req, res) => {
  try {
    const snapshot = await db.collection('deposits').where('userId', '==', req.user.uid)
      .orderBy('verifiedAt', 'desc').limit(50).get();
    const deposits = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data(), verifiedAt: doc.data().verifiedAt?.toDate() }));
    res.json({ success: true, deposits });
  } catch (error) {
    res.status(500).json({ error: 'خطأ في جلب الإيداعات' });
  }
});

// ============= API السحب =============
app.post('/api/user/withdraw', requireAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { amount, address, method } = req.body;
    if (!amount || !address) return res.status(400).json({ error: 'المبلغ والعنوان مطلوبان' });
    
    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) return res.status(400).json({ error: 'المبلغ غير صالح' });
    
    const settings = await getSystemSettings();
    if (amountNum < settings.minWithdraw) {
      return res.status(400).json({ error: `الحد الأدنى للسحب ${settings.minWithdraw} SYP` });
    }
    
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    const userData = userDoc.data();
    if (!userData) return res.status(404).json({ error: 'مستخدم غير موجود' });
    if (userData.balance < amountNum) return res.status(400).json({ error: 'الرصيد غير كافٍ' });
    
    await userRef.update({ balance: admin.firestore.FieldValue.increment(-amountNum), totalWithdrawn: admin.firestore.FieldValue.increment(amountNum) });
    
    const requestData = {
      userId: uid, userEmail: userData.email, userName: userData.name, userUniqueId: userData.uniqueId,
      amount: amountNum, address, method: method || 'sham_cash', status: 'pending',
      createdAt: new Date(), previousBalance: userData.balance, newBalance: userData.balance - amountNum
    };
    const requestRef = await db.collection('withdraw_requests').add(requestData);
    res.json({ success: true, message: `تم إنشاء طلب سحب بمبلغ ${amountNum} SYP، قيد المراجعة`, requestId: requestRef.id });
  } catch (error) {
    console.error('Withdraw error:', error);
    res.status(500).json({ error: 'فشل إنشاء طلب السحب' });
  }
});

app.get('/api/user/withdraw-requests', requireAuth, async (req, res) => {
  try {
    const snapshot = await db.collection('withdraw_requests').where('userId', '==', req.user.uid)
      .orderBy('createdAt', 'desc').limit(50).get();
    const requests = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data(), createdAt: doc.data().createdAt?.toDate() }));
    res.json({ success: true, requests });
  } catch (error) {
    res.status(500).json({ error: 'خطأ في جلب طلبات السحب' });
  }
});

// ============= APIs الأدمن =============
app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  const settings = await getSystemSettings();
  res.json({ success: true, settings });
});

app.post('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const updates = req.body;
    await updateSystemSettings(updates);
    res.json({ success: true, message: 'تم تحديث الإعدادات' });
  } catch (error) {
    res.status(500).json({ error: 'فشل تحديث الإعدادات' });
  }
});

app.get('/api/admin/dashboard', requireAdmin, async (req, res) => {
  try {
    const usersSnapshot = await db.collection('users').get();
    const users = usersSnapshot.docs.map(doc => doc.data());
    const totalBalance = users.reduce((s, u) => s + (u.balance || 0), 0);
    const totalDeposited = users.reduce((s, u) => s + (u.totalDeposited || 0), 0);
    const totalWithdrawn = users.reduce((s, u) => s + (u.totalWithdrawn || 0), 0);
    const pendingWithdrawals = await db.collection('withdraw_requests').where('status', '==', 'pending').get();
    const today = new Date(); today.setHours(0,0,0,0);
    const newToday = users.filter(u => u.createdAt?.toDate() > today).length;
    res.json({ success: true, stats: {
      totalUsers: usersSnapshot.size, newToday, totalBalance, totalDeposited, totalWithdrawn,
      pendingWithdrawals: pendingWithdrawals.size
    } });
  } catch (error) {
    res.status(500).json({ error: 'خطأ في جلب الإحصائيات' });
  }
});

app.get('/api/admin/withdraw-requests', requireAdmin, async (req, res) => {
  try {
    const { status = 'all' } = req.query;
    let query = db.collection('withdraw_requests').orderBy('createdAt', 'desc');
    if (status !== 'all') query = query.where('status', '==', status);
    const snapshot = await query.get();
    const requests = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data(), createdAt: doc.data().createdAt?.toDate() }));
    res.json({ success: true, requests });
  } catch (error) {
    res.status(500).json({ error: 'خطأ في جلب الطلبات' });
  }
});

app.post('/api/admin/process-withdraw', requireAdmin, async (req, res) => {
  try {
    const { requestId, action, adminNotes } = req.body;
    const requestRef = db.collection('withdraw_requests').doc(requestId);
    const requestDoc = await requestRef.get();
    if (!requestDoc.exists) return res.status(404).json({ error: 'طلب غير موجود' });
    const request = requestDoc.data();
    if (request.status !== 'pending') return res.status(400).json({ error: 'تم معالجة هذا الطلب مسبقاً' });
    
    if (action === 'reject') {
      await db.collection('users').doc(request.userId).update({ balance: admin.firestore.FieldValue.increment(request.amount) });
    }
    await requestRef.update({ status: action === 'approve' ? 'approved' : 'rejected', processedAt: new Date(), processedBy: req.user.email, adminNotes: adminNotes || '' });
    res.json({ success: true, message: `تم ${action === 'approve' ? 'قبول' : 'رفض'} الطلب` });
  } catch (error) {
    res.status(500).json({ error: 'فشل معالجة الطلب' });
  }
});

app.get('/api/admin/deposits', requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('deposits').orderBy('verifiedAt', 'desc').limit(100).get();
    const deposits = await Promise.all(snapshot.docs.map(async doc => {
      const data = doc.data();
      const userDoc = await db.collection('users').doc(data.userId).get();
      return { id: doc.id, ...data, user: userDoc.exists ? userDoc.data() : null, verifiedAt: data.verifiedAt?.toDate() };
    }));
    res.json({ success: true, deposits });
  } catch (error) {
    res.status(500).json({ error: 'خطأ في جلب الإيداعات' });
  }
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('users').orderBy('createdAt', 'desc').get();
    const users = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data(), createdAt: doc.data().createdAt?.toDate() }));
    res.json({ success: true, users });
  } catch (error) {
    res.status(500).json({ error: 'خطأ في جلب المستخدمين' });
  }
});

app.post('/api/admin/update-balance', requireAdmin, async (req, res) => {
  try {
    const { userId, amount, reason } = req.body;
    await db.collection('users').doc(userId).update({ balance: admin.firestore.FieldValue.increment(Number(amount)) });
    res.json({ success: true });
  } catch (error) {
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
    res.status(500).json({ error: 'فشل تحديث حالة الحظر' });
  }
});

// ============= نقطة صحة الخادم =============
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date(), uptime: process.uptime() });
});

// ============= تشغيل الخادم =============
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ BOOMB Server running on port ${PORT}`);
  console.log(`📍 Admin email: ${ADMIN_EMAIL}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
});
